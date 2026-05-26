import { db, settings, eq } from '@agenthub/db'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'

const CLIENT_ID = Bun.env.CODEX_CHATGPT_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann'
const ISSUER = (Bun.env.CODEX_CHATGPT_ISSUER || 'https://auth.openai.com').replace(/\/$/, '')
const DEVICE_AUTH_BASE = `${ISSUER}/api/accounts`
const DEVICE_URL = `${ISSUER}/codex/device`
const DEVICE_CALLBACK_URL = `${ISSUER}/deviceauth/callback`
const TOKEN_URL = `${ISSUER}/oauth/token`
const CODEX_BACKEND_BASE = (Bun.env.CODEX_CHATGPT_BACKEND_BASE || 'https://chatgpt.com/backend-api/codex').replace(/\/$/, '')
const TOKENS_SETTING_KEY = 'codex_tokens'
const MAX_LOGIN_AGE_MS = 15 * 60 * 1000
const EXPIRY_SKEW_MS = 5 * 60 * 1000
const AUTH_REQUEST_TIMEOUT_MS = 20 * 1000

interface PendingDeviceLogin {
  loginId: string
  deviceAuthId: string
  userCode: string
  interval: number
  expiresAt: number
  createdAt: number
}

interface CodexTokenData {
  access_token: string
  refresh_token: string
  expires_at: number
  id_token?: string
  account_id?: string | null
  validation_failed?: boolean
  validation_error?: string | null
  created_at: number
  updated_at: number
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

const pendingLogins = new Map<string, PendingDeviceLogin>()

export async function startCodexLogin() {
  const res = await fetchWithTimeout(`${DEVICE_AUTH_BASE}/deviceauth/usercode`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(formatAuthHttpError('device code request failed', res.status, res.statusText, text))
  }

  const body = await readJsonResponse<{
    device_auth_id?: string
    user_code?: string
    usercode?: string
    interval?: string | number
  }>(res, 'device code response')
  const deviceAuthId = body.device_auth_id
  const userCode = body.user_code || body.usercode
  const interval = Number(body.interval || 5)

  if (!deviceAuthId || !userCode || !Number.isFinite(interval)) {
    throw new Error('device code response was missing required fields')
  }

  const login: PendingDeviceLogin = {
    loginId: randomBytes(16).toString('hex'),
    deviceAuthId,
    userCode,
    interval: Math.max(1, interval),
    createdAt: Date.now(),
    expiresAt: Date.now() + MAX_LOGIN_AGE_MS,
  }
  pendingLogins.set(login.loginId, login)

  return {
    ok: true,
    status: 'pending' as const,
    loginId: login.loginId,
    verificationUrl: DEVICE_URL,
    userCode: login.userCode,
    interval: login.interval,
    expiresAt: new Date(login.expiresAt).toISOString(),
    message: `Open ${DEVICE_URL} and enter code ${login.userCode}`,
  }
}

export async function openCodexDeviceAuthPage() {
  await openExternalUrl(DEVICE_URL)
  return {
    ok: true,
    message: 'Opened ChatGPT authorization page in the system browser',
  }
}

export async function pollCodexLogin(loginId: string) {
  const login = pendingLogins.get(loginId)
  if (!login) {
    return { ok: false, status: 'failed' as const, message: 'Login session was not found or has expired' }
  }

  if (Date.now() > login.expiresAt) {
    pendingLogins.delete(loginId)
    return { ok: false, status: 'failed' as const, message: 'device auth timed out after 15 minutes' }
  }

  let poll: Response
  try {
    poll = await fetchWithTimeout(`${DEVICE_AUTH_BASE}/deviceauth/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_auth_id: login.deviceAuthId,
        user_code: login.userCode,
      }),
    })
  } catch (error: any) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        status: 'pending' as const,
        interval: login.interval,
        message: '授权轮询超时，仍在等待浏览器授权',
      }
    }
    throw error
  }

  if (poll.status === 403 || poll.status === 404) {
    return {
      ok: false,
      status: 'pending' as const,
      interval: login.interval,
      message: 'Waiting for browser authorization',
    }
  }

  if (!poll.ok) {
    const text = await poll.text().catch(() => '')
    return {
      ok: false,
      status: 'failed' as const,
      message: formatAuthHttpError('device auth failed', poll.status, poll.statusText, text),
    }
  }

  const codeResp = await readJsonResponse<{
    authorization_code?: string
    code_verifier?: string
  }>(poll, 'device auth response')

  if (!codeResp.authorization_code || !codeResp.code_verifier) {
    return { ok: false, status: 'failed' as const, message: 'device auth response was missing token exchange fields' }
  }

  const tokens = await exchangeAuthorizationCode(codeResp.authorization_code, codeResp.code_verifier)
  await saveCodexTokens(tokens)
  const cliAuth = await syncCodexCliAuth(tokens.access_token)
  pendingLogins.delete(loginId)

  return {
    ok: true,
    status: 'completed' as const,
    cliAuthSynced: cliAuth.ok,
    cliAuthMessage: cliAuth.message,
    message: cliAuth.ok
      ? 'ChatGPT account login completed and synced to Codex CLI'
      : `ChatGPT account login completed, but Codex CLI sync failed: ${cliAuth.message}`,
  }
}

export async function getCodexAuthStatus() {
  const tokens = await loadCodexTokens()
  if (!tokens) {
    return {
      loggedIn: false,
      authMode: 'none' as const,
      status: 'logged-out' as const,
      accountId: null,
      validationFailed: false,
      validationError: null,
      message: 'Not logged in',
    }
  }

  return {
    loggedIn: true,
    authMode: 'chatgpt' as const,
    status: 'logged-in' as const,
    accountId: tokens.account_id ?? null,
    validationFailed: Boolean(tokens.validation_failed),
    validationError: tokens.validation_error ?? null,
    message: tokens.validation_failed
      ? `Token validation failed: ${tokens.validation_error || 'unknown error'}`
      : 'ChatGPT account token is stored locally',
  }
}

export async function retryCodexAuth() {
  try {
    await refreshCodexTokens(true)
    return { ok: true, message: 'Token refresh completed' }
  } catch (error: any) {
    return { ok: false, message: error?.message || 'Token refresh failed' }
  }
}

export async function logoutCodexAuth() {
  await deleteSetting(TOKENS_SETTING_KEY)
  pendingLogins.clear()
  return { ok: true, message: 'Logged out' }
}

export async function getCodexAccessToken() {
  const tokens = await refreshCodexTokens(false)
  return tokens.access_token
}

export async function buildCodexBackendHeaders() {
  const tokens = await refreshCodexTokens(false)
  return {
    Authorization: `Bearer ${tokens.access_token}`,
    ...(tokens.account_id ? { 'ChatGPT-Account-ID': tokens.account_id } : {}),
    originator: 'opencode',
    version: Bun.env.npm_package_version || '0.1.0',
  }
}

export async function fetchCodexBackend(path: string, init: RequestInit = {}) {
  const url = path.startsWith('http') ? path : `${CODEX_BACKEND_BASE}/${path.replace(/^\//, '')}`
  const first = await fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(await buildCodexBackendHeaders()),
      ...(init.headers as Record<string, string> | undefined),
    },
  })

  if (first.status !== 401) return first

  await refreshCodexTokens(true)
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(await buildCodexBackendHeaders()),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

export async function getCodexModels() {
  const res = await fetchCodexBackend(`models?client_version=${encodeURIComponent(Bun.env.npm_package_version || '0.1.0')}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text.slice(0, 240) || `Codex models request failed with status ${res.status}`)
  }
  return readJsonResponse(res, 'Codex models response')
}

async function exchangeAuthorizationCode(code: string, codeVerifier: string) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: DEVICE_CALLBACK_URL,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  })

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(formatAuthHttpError('token endpoint failed', res.status, res.statusText, text))
  }

  return normalizeTokenResponse(await readJsonResponse<TokenResponse>(res, 'token endpoint response'))
}

async function refreshCodexTokens(force: boolean) {
  const current = await loadCodexTokens()
  if (!current) throw new Error('ChatGPT account is not logged in')
  if (!force && current.expires_at - Date.now() > EXPIRY_SKEW_MS && !current.validation_failed) return current

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: CLIENT_ID,
  })

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const failed: CodexTokenData = {
      ...current,
      validation_failed: true,
      validation_error: formatAuthHttpError('token refresh failed', res.status, res.statusText, text),
      updated_at: Date.now(),
    }
    await saveCodexTokens(failed)
    throw new Error(failed.validation_error || 'Token refresh failed')
  }

  const refreshed = normalizeTokenResponse(await readJsonResponse<TokenResponse>(res, 'token refresh response'), current)
  await saveCodexTokens(refreshed)
  return refreshed
}

async function syncCodexCliAuth(accessToken: string) {
  if (!shouldSyncCodexCliAuth()) {
    return { ok: true, message: 'Codex CLI auth sync is disabled' }
  }

  const codexHome = Bun.env.CODEX_HOME?.trim()
  if (!codexHome) {
    return { ok: false, message: 'CODEX_HOME is not configured' }
  }

  try {
    mkdirSync(codexHome, { recursive: true })
    const proc = Bun.spawn(['codex', 'login', '--with-access-token'], {
      env: { ...Bun.env, CODEX_HOME: codexHome },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    proc.stdin.write(`${accessToken}\n`)
    proc.stdin.end()
    const timed = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(124), 60_000)),
    ])
    if (timed === 124) {
      try {
        proc.kill()
      } catch {
        // The process may have exited between timeout and kill.
      }
      return { ok: false, message: 'codex login timed out' }
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ''),
      new Response(proc.stderr).text().catch(() => ''),
    ])
    if (timed !== 0) {
      return {
        ok: false,
        message: sanitizeAuthOutput([stdout.trim(), stderr.trim()].filter(Boolean).join('\n')) || `codex login exited with code ${timed}`,
      }
    }

    return { ok: true, message: `Codex CLI auth synced to ${codexHome}` }
  } catch (error: any) {
    return { ok: false, message: sanitizeAuthOutput(error?.message || 'codex login failed') }
  }
}

function shouldSyncCodexCliAuth() {
  const value = Bun.env.SYNC_CODEX_CLI_AUTH?.trim().toLowerCase()
  return Boolean(Bun.env.CODEX_HOME?.trim()) && !['0', 'false', 'no', 'off'].includes(value || '')
}

function normalizeTokenResponse(response: TokenResponse, previous?: CodexTokenData): CodexTokenData {
  const now = Date.now()
  const idToken = response.id_token || previous?.id_token
  const accountId = inferAccountId(idToken) ?? previous?.account_id ?? null
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token || previous?.refresh_token || '',
    id_token: idToken,
    account_id: accountId,
    expires_at: now + Math.max(1, response.expires_in || 3600) * 1000,
    validation_failed: false,
    validation_error: null,
    created_at: previous?.created_at || now,
    updated_at: now,
  }
}

function formatAuthHttpError(prefix: string, status: number, statusText: string, body: string) {
  const normalized = normalizeAuthErrorBody(body)
  if (/route error/i.test(normalized) && /invalid content type/i.test(normalized)) {
    return `${prefix} with status ${status} ${statusText}: OpenAI 授权页返回了 Route Error（HTML 内容类型不匹配）。请在普通浏览器或无痕窗口打开 https://auth.openai.com/codex/device，先确认 ChatGPT 已登录，再输入新的验证码。`
  }
  const suffix = normalized ? `: ${normalized.slice(0, 240)}` : ''
  return `${prefix} with status ${status} ${statusText}${suffix}`
}

async function readJsonResponse<T>(res: Response, label: string): Promise<T> {
  const contentType = res.headers.get('content-type') || ''
  const text = await res.text()
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(`${label} returned ${contentType || 'unknown content type'}: ${normalizeAuthErrorBody(text).slice(0, 240)}`)
  }
  try {
    return JSON.parse(text) as T
  } catch (error: any) {
    throw new Error(`${label} was not valid JSON: ${error?.message || 'parse failed'}`)
  }
}

function normalizeAuthErrorBody(body: string) {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeAuthOutput(output: string) {
  return normalizeAuthErrorBody(output)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'jwt-***')
    .replace(/sk-[A-Za-z0-9_*.:-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9_*.:-]{6,}/gi, 'Bearer ***')
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = AUTH_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Operation timed out')), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
    })
  } catch (error: any) {
    if (isTimeoutError(error)) throw new Error(`Operation timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function isTimeoutError(error: any) {
  return error?.name === 'AbortError' || /operation timed out|timed out|abort/i.test(error?.message || '')
}

async function loadCodexTokens(): Promise<CodexTokenData | null> {
  const value = await getSetting(TOKENS_SETTING_KEY)
  if (!value) return null
  const json = await decodeStoredSecret(value)
  try {
    const parsed = JSON.parse(json) as CodexTokenData
    if (!parsed.access_token || !parsed.refresh_token) return null
    return parsed
  } catch {
    return null
  }
}

async function saveCodexTokens(tokens: CodexTokenData) {
  await upsertSetting(TOKENS_SETTING_KEY, await encodeStoredSecret(JSON.stringify(tokens)))
}

async function getSetting(key: string) {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return rows[0]?.value
}

async function upsertSetting(key: string, value: string) {
  const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key))
  } else {
    await db.insert(settings).values({ key, value })
  }
}

async function deleteSetting(key: string) {
  await db.delete(settings).where(eq(settings.key, key))
}

async function encodeStoredSecret(value: string) {
  if (process.platform === 'win32') {
    try {
      const encrypted = await runPowerShell([
        '$plain=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]));',
        '$secure=ConvertTo-SecureString -String $plain -AsPlainText -Force;',
        'ConvertFrom-SecureString $secure',
      ].join(' '), [Buffer.from(value, 'utf8').toString('base64')])
      return `dpapi:v1:${encrypted.trim()}`
    } catch {
      // Fall through to portable storage when DPAPI is unavailable.
    }
  }
  return `json:v1:${Buffer.from(value, 'utf8').toString('base64')}`
}

async function decodeStoredSecret(value: string) {
  if (value.startsWith('dpapi:v1:')) {
    const encrypted = value.slice('dpapi:v1:'.length)
    return runPowerShell([
      '$secure=ConvertTo-SecureString $args[0];',
      '$bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);',
      'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }',
      'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
    ].join(' '), [encrypted])
  }
  if (value.startsWith('json:v1:')) {
    return Buffer.from(value.slice('json:v1:'.length), 'base64').toString('utf8')
  }
  return value
}

async function runPowerShell(command: string, args: string[]) {
  const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text().catch(() => ''),
    new Response(proc.stderr).text().catch(() => ''),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `PowerShell exited with code ${code}`)
  return stdout.trim()
}

async function openExternalUrl(url: string) {
  if (url !== DEVICE_URL) throw new Error('unsupported authorization URL')

  const command =
    process.platform === 'win32'
      ? ['cmd.exe', '/d', '/s', '/c', 'start', '""', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url]

  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text().catch(() => ''),
  ])
  if (code !== 0) throw new Error(stderr.trim() || `Failed to open authorization page with exit code ${code}`)
}

function inferAccountId(idToken?: string) {
  const claims = decodeJwtPayload(idToken)
  if (!claims) return null
  return findStringClaim(claims, [
    'account_id',
    'https://api.openai.com/auth/account_id',
    'https://auth.openai.com/account_id',
    'chatgpt_account_id',
  ])
}

function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token) return null
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function findStringClaim(claims: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = claims[key]
    if (typeof value === 'string' && value) return value
  }

  for (const value of Object.values(claims)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found: string | null = findStringClaim(value as Record<string, unknown>, keys)
      if (found) return found
    }
  }
  return null
}
