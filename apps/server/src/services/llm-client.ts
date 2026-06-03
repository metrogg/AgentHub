import { db, settings } from '@agenthub/db'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { streamText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { FetchFunction } from '@ai-sdk/provider-utils'
import { INTERNAL_LLM_DEFAULT_MODEL_ID_SETTING } from '@agenthub/shared'
import { env } from '../env'
import { logger } from '../lib/logger'

export const DEFAULT_AGENT_INSTRUCTIONS =
  '你是 AgentHub Assistant，运行在多 Agent 协作平台中的 AI 协作者。请始终使用中文回复，结合当前对话上下文，给出清晰、实用的下一步。'

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ModelCatalogItem {
  id: string
  name?: string
  enabled?: boolean
  provider?: string
  modelId?: string
  apiEndpoint?: string
  anthropicEndpoint?: string
  apiKeyEnv?: string
  apiKey?: string
}

export interface ResolvedModelConfig {
  id: string
  name: string
  provider: string
  modelId: string
  apiEndpoint?: string
  anthropicEndpoint?: string
  apiKey?: string
  apiKeySource?: string
}

export interface LlmRuntimeConfig {
  apiKey: string | null
  apiKeySource: string | null
  baseUrl: string
  maxRetries: number
  model: string
  provider: string
  source: 'settings' | 'env'
  timeoutMs: number
  debug: {
    enabled: boolean
    dir: string
  }
}

interface ProviderCandidate {
  apiKey?: string
  apiKeySource?: string
  baseUrl?: string
  model?: string
  provider?: string
}

interface StreamOptions {
  messages: LLMMessage[]
  signal?: AbortSignal
  system?: string
}

interface TestConnectionInput {
  provider?: string
  apiEndpoint?: string
  anthropicEndpoint?: string
  apiKey?: string
  apiKeyEnv?: string
  modelId?: string
}

async function getSettingsMap(): Promise<Record<string, string>> {
  const rows = await db.select().from(settings)
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

function parseCatalog(value?: string): ModelCatalogItem[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseAppSettings(value?: string): { debugMode?: boolean } {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return { debugMode: Boolean(parsed?.debugMode) }
  } catch {
    return {}
  }
}

function defaultDebugDir() {
  return join(env.AGENTHUB_APP_DATA_DIR?.trim() || process.cwd(), 'debug', 'llm')
}

function clean(value?: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function readEnv(name?: string): string | undefined {
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined
  return clean(Bun.env[name])
}

function configuredApiKey(item: ModelCatalogItem): { value?: string; source?: string } {
  const inline = clean(item.apiKey)
  if (inline) return { value: inline, source: 'settings' }

  const fromEnv = readEnv(item.apiKeyEnv)
  if (fromEnv) return { value: fromEnv, source: item.apiKeyEnv }

  return {}
}

function normalizeProvider(provider?: string): string {
  return clean(provider)?.toLowerCase() ?? 'openai'
}

function isAnthropicProvider(provider: string, baseUrl?: string): boolean {
  const normalized = normalizeProvider(provider)
  if (normalized === 'anthropic' || normalized === 'claude') return true
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl)
    if (url.hostname.includes('anthropic.com')) return true
    if (/\/anthropic\/?$/.test(url.pathname)) return true
  } catch {
    // ignore malformed URL
  }
  return false
}

function endpointLooksAnthropic(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    const url = new URL(baseUrl)
    if (url.hostname.includes('anthropic.com')) return true
    return /\/anthropic\/?$/.test(url.pathname)
  } catch {
    return false
  }
}

function inferProviderFromEndpoint(baseUrl?: string): string {
  if (!baseUrl) return 'openai-compatible'
  try {
    const url = new URL(baseUrl)
    const host = url.hostname.toLowerCase()
    if (host.includes('anthropic.com')) return 'anthropic'
    if (/\/anthropic\/?$/i.test(url.pathname)) return 'anthropic'
    if (host.includes('openai.com')) return 'openai'
    if (host.includes('deepseek.com')) return 'deepseek'
    if (host.includes('xiaomimimo.com')) return 'mimo'
    if (host.includes('bigmodel.cn')) return 'zhipu'
    if (host.includes('moonshot')) return 'moonshot'
    if (host.includes('alibabacloud') || host.includes('aliyuncs') || host.includes('qwen')) return 'dashscope'
  } catch {
    // Ignore malformed endpoint and use a generic OpenAI-compatible provider.
  }
  return 'openai-compatible'
}

function resolveCatalogRuntime(item: ModelCatalogItem): ProviderCandidate {
  const rawProvider = normalizeProvider(item.provider)
  const apiEndpoint = clean(item.apiEndpoint)
  const anthropicEndpoint = clean(item.anthropicEndpoint)
  const declaredAnthropic = rawProvider === 'anthropic' || rawProvider === 'claude'
  const useAnthropicRuntime =
    declaredAnthropic &&
    (Boolean(anthropicEndpoint) || !apiEndpoint || endpointLooksAnthropic(apiEndpoint))
  const baseUrl = useAnthropicRuntime
    ? anthropicEndpoint ?? apiEndpoint
    : apiEndpoint ?? anthropicEndpoint
  const provider = useAnthropicRuntime
    ? rawProvider
    : declaredAnthropic
      ? inferProviderFromEndpoint(apiEndpoint)
      : rawProvider
  const key = configuredApiKey(item)

  return {
    apiKey: key.value,
    apiKeySource: key.source,
    baseUrl,
    model: item.modelId,
    provider,
  }
}

function resolveDirectRuntime(input: TestConnectionInput): ProviderCandidate {
  const rawProvider = normalizeProvider(input.provider)
  const apiEndpoint = clean(input.apiEndpoint)
  const anthropicEndpoint = clean(input.anthropicEndpoint)
  const declaredAnthropic = rawProvider === 'anthropic' || rawProvider === 'claude'
  const useAnthropicRuntime =
    declaredAnthropic &&
    (Boolean(anthropicEndpoint) || !apiEndpoint || endpointLooksAnthropic(apiEndpoint))
  const baseUrl = useAnthropicRuntime
    ? anthropicEndpoint ?? apiEndpoint
    : apiEndpoint ?? anthropicEndpoint
  const provider = useAnthropicRuntime
    ? rawProvider
    : declaredAnthropic
      ? inferProviderFromEndpoint(apiEndpoint)
      : rawProvider

  return {
    baseUrl,
    model: clean(input.modelId),
    provider,
  }
}

function defaultBaseUrl(provider: string): string {
  return isAnthropicProvider(provider) ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL
}

function defaultModel(provider: string): string {
  return isAnthropicProvider(provider) ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL
}

function isOpenAiProvider(provider: string, baseUrl?: string): boolean {
  const normalized = normalizeProvider(provider)
  return normalized === 'openai' || Boolean(baseUrl?.includes('api.openai.com'))
}

function providerEnvApiKey(provider: string, baseUrl?: string): { value?: string; source?: string } {
  const normalized = normalizeProvider(provider)
  const directName = `${normalized.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
  const direct = readEnv(directName)
  if (direct) return { value: direct, source: directName }

  if (isAnthropicProvider(provider, baseUrl)) {
    const value = clean(env.ANTHROPIC_API_KEY)
    return value ? { value, source: 'ANTHROPIC_API_KEY' } : {}
  }

  if (isOpenAiProvider(provider, baseUrl)) {
    const openAiValue = clean(env.OPENAI_API_KEY)
    if (openAiValue) return { value: openAiValue, source: 'OPENAI_API_KEY' }
  }

  const generic = clean(env.LLM_API_KEY)
  return generic ? { value: generic, source: 'LLM_API_KEY' } : {}
}

function normalizeConfig(candidate: ProviderCandidate, source: 'settings' | 'env'): LlmRuntimeConfig {
  const provider = normalizeProvider(candidate.provider)
  const baseUrl = (clean(candidate.baseUrl) ?? defaultBaseUrl(provider)).replace(/\/$/, '')
  const fallbackKey = providerEnvApiKey(provider, baseUrl)
  const apiKey = clean(candidate.apiKey) ?? fallbackKey.value ?? null

  return {
    apiKey,
    apiKeySource: candidate.apiKey ? candidate.apiKeySource ?? source : fallbackKey.source ?? null,
    baseUrl,
    maxRetries: env.LLM_MAX_RETRIES,
    model: clean(candidate.model) ?? defaultModel(provider),
    provider,
    source,
    timeoutMs: env.LLM_TIMEOUT_MS,
    debug: {
      enabled: false,
      dir: defaultDebugDir(),
    },
  }
}

function withDebugSettings(config: LlmRuntimeConfig, map: Record<string, string>): LlmRuntimeConfig {
  const appSettings = parseAppSettings(map.APP_SETTINGS)
  return {
    ...config,
    debug: {
      enabled: Boolean(appSettings.debugMode),
      dir: defaultDebugDir(),
    },
  }
}

function resolveInternalDefaultModelId(
  map: Record<string, string>,
  selectedModelId?: string | null,
) {
  return (
    clean(selectedModelId) ??
    clean(map[INTERNAL_LLM_DEFAULT_MODEL_ID_SETTING]) ??
    clean(map.ACTIVE_MODEL_ID)
  )
}

function pickSettingsCandidate(map: Record<string, string>, selectedModelId?: string): ProviderCandidate | null {
  const catalog = parseCatalog(map.MODEL_CATALOG)
  const activeId = resolveInternalDefaultModelId(map, selectedModelId)
  const selected = activeId
    ? catalog.find((item) => (item.id === activeId || item.modelId === activeId) && item.enabled !== false)
    : undefined
  const firstConfigured = catalog.find((item) => {
    if (item.enabled === false || !clean(item.modelId)) return false
    return Boolean(configuredApiKey(item).value)
  })
  const item = selected ?? firstConfigured

  if (item?.modelId) {
    return resolveCatalogRuntime(item)
  }

  return null
}

export async function resolveLlmRuntimeConfig(selectedModelId?: string): Promise<LlmRuntimeConfig> {
  try {
    const map = await getSettingsMap()
    const candidate = pickSettingsCandidate(map, selectedModelId)
    if (candidate) return withDebugSettings(normalizeConfig(candidate, 'settings'), map)
  } catch (error: any) {
    logger.warn({ err: redactSensitive(error?.message || String(error)) }, 'Failed to load model settings')
  }

  const provider = normalizeProvider(env.LLM_PROVIDER)
  return withDebugSettings(normalizeConfig(
    {
      apiKey: clean(env.LLM_API_KEY),
      apiKeySource: clean(env.LLM_API_KEY) ? 'LLM_API_KEY' : undefined,
      baseUrl: clean(env.LLM_BASE_URL),
      model: clean(env.LLM_MODEL),
      provider,
    },
    'env'
  ), {})
}

export async function resolveModelApiKey(modelId?: string | null): Promise<{ apiKey?: string; provider?: string; baseUrl?: string }> {
  try {
    const map = await getSettingsMap()
    const catalog = parseCatalog(map.MODEL_CATALOG)
    const targetId = resolveInternalDefaultModelId(map, modelId)
    const item = targetId
      ? catalog.find((entry) => (entry.id === targetId || entry.modelId === targetId) && entry.enabled !== false)
      : catalog.find((entry) => entry.enabled !== false && clean(entry.modelId))
    if (item?.modelId) {
      const candidate = resolveCatalogRuntime(item)
      return { apiKey: candidate.apiKey, provider: candidate.provider, baseUrl: candidate.baseUrl }
    }
  } catch {
    // fall through to LLM runtime config fallback
  }
  const fallback = await resolveLlmRuntimeConfig(modelId ?? undefined)
  return { apiKey: fallback.apiKey ?? undefined, provider: fallback.provider, baseUrl: fallback.baseUrl }
}

export async function resolveModelConfig(modelId?: string | null): Promise<ResolvedModelConfig | null> {
  try {
    const map = await getSettingsMap()
    const catalog = parseCatalog(map.MODEL_CATALOG)
    const targetId = resolveInternalDefaultModelId(map, modelId)
    const item = targetId
      ? catalog.find((entry) => (entry.id === targetId || entry.modelId === targetId) && entry.enabled !== false)
      : catalog.find((entry) => entry.enabled !== false && clean(entry.modelId))
    if (!item?.modelId) return null

    const key = configuredApiKey(item)
    return {
      id: item.id,
      name: clean(item.name) ?? item.id,
      provider: normalizeProvider(item.provider),
      modelId: item.modelId,
      apiEndpoint: clean(item.apiEndpoint),
      anthropicEndpoint: clean(item.anthropicEndpoint),
      apiKey: key.value,
      apiKeySource: key.source,
    }
  } catch {
    return null
  }
}

export async function getLlmRuntimeStatus(selectedModelId?: string) {
  const config = await resolveLlmRuntimeConfig(selectedModelId)
  return {
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeySource: config.apiKeySource,
    baseUrl: config.baseUrl,
    model: config.model,
    provider: config.provider,
    source: config.source,
  }
}

/* ─────────── Vercel AI SDK integration ─────────── */

function createAiSdkModel(config: LlmRuntimeConfig) {
  const { apiKey, baseUrl, model } = config
  if (!apiKey) {
    throw new Error('API Key 未配置。请设置 LLM_API_KEY 或供应商专用 API Key 环境变量。')
  }

  const fetch = createLlmFetch(config)
  if (isAnthropicProvider(config.provider, config.baseUrl)) {
    return createAnthropic({ apiKey, baseURL: baseUrl, fetch })(model)
  }

  // AgentHub 目前按 OpenAI-compatible chat/completions 适配各种供应商。
  // 不自动切 Responses API，避免官方/第三方供应商和测试 mock 走两套协议。
  const openai = createOpenAI({ apiKey, baseURL: baseUrl, fetch })
  return openai.chat(model)
}

export function createLlmClient(config: LlmRuntimeConfig) {
  return {
    async *stream(options: StreamOptions) {
      const model = createAiSdkModel(config)
      const timeout = withTimeoutSignal(options.signal, config.timeoutMs, 'LLM stream')
      const { textStream } = streamText({
        model,
        system: options.system ?? DEFAULT_AGENT_INSTRUCTIONS,
        messages: options.messages,
        abortSignal: timeout.signal,
        maxRetries: config.maxRetries,
      })

      try {
        for await (const delta of textStream) {
          yield delta
        }
      } finally {
        timeout.dispose()
      }
    },
  }
}

export async function testLlmConnection(input: TestConnectionInput) {
  const runtime = resolveDirectRuntime(input)
  const provider = normalizeProvider(runtime.provider)
  const endpoint = clean(runtime.baseUrl)
  const directKey = clean(input.apiKey)
  const envKey = readEnv(input.apiKeyEnv)
  const apiKey = directKey ?? envKey
  const model = clean(runtime.model)

  if (!endpoint) {
    return { ok: false, message: 'API endpoint is required.' }
  }

  if (!apiKey) {
    return { ok: false, message: 'API key is not configured. Fill it in or set the configured environment variable.' }
  }

  const config = normalizeConfig(
    {
      apiKey,
      apiKeySource: directKey ? 'request' : input.apiKeyEnv,
      baseUrl: endpoint,
      model,
      provider,
    },
    'settings'
  )

  const isDefaultModel = !clean(input.modelId)

  try {
    const timeout = withTimeoutSignal(undefined, config.timeoutMs, '连接测试')
    try {
      await testProviderConnection(config, apiKey, timeout.signal)
    } finally {
      timeout.dispose()
    }

    return { ok: true, status: 200, message: '连接成功。' }
  } catch (error: any) {
    let message = redactSensitive(formatLlmTransportError(error, config), [apiKey])
    if (error?.message?.includes('400') && isDefaultModel) {
      message += `（提示：未提供 modelId，使用了默认模型 "${config.model}"。如果使用的是第三方兼容 API，请在模型配置中填写正确的模型 ID。）`
    }
    return { ok: false, message }
  }
}

async function testProviderConnection(config: LlmRuntimeConfig, apiKey: string, signal: AbortSignal) {
  if (isAnthropicProvider(config.provider, config.baseUrl)) {
    return testAnthropicConnection(config, apiKey, signal)
  }
  return testOpenAiCompatibleConnection(config, apiKey, signal)
}

async function testOpenAiCompatibleConnection(config: LlmRuntimeConfig, apiKey: string, signal: AbortSignal) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
  const response = await globalThis.fetch(url, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: '只回复 OK。' }],
      max_tokens: 8,
      temperature: 0,
    }),
  })
  if (!response.ok) throw new Error(await formatHttpError(response, url))
  return response
}

async function testAnthropicConnection(config: LlmRuntimeConfig, apiKey: string, signal: AbortSignal) {
  const baseUrl = config.baseUrl.replace(/\/$/, '')
  const candidateUrls = baseUrl.endsWith('/v1')
    ? [`${baseUrl}/messages`]
    : [`${baseUrl}/v1/messages`, `${baseUrl}/messages`]
  let lastError = ''

  for (const url of candidateUrls) {
    const response = await globalThis.fetch(url, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: '只回复 OK。' }],
        max_tokens: 8,
      }),
    })
    if (response.ok) return response

    lastError = await formatHttpError(response, url)
    if (response.status !== 404) break
  }

  throw new Error(lastError || 'Anthropic-compatible connection failed.')
}

async function formatHttpError(response: Response, url: string) {
  const body = await response.text().catch(() => '')
  const detail = body.trim().slice(0, 400)
  return [
    `HTTP ${response.status} ${response.statusText || ''}`.trim(),
    `URL: ${url}`,
    detail,
  ].filter(Boolean).join(' | ')
}

function withTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number, label: string) {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parent?.reason ?? new Error(`${label}已中止`))
  const timer = setTimeout(() => controller.abort(new Error(`${label}超时`)), timeoutMs)

  if (parent?.aborted) {
    abortFromParent()
  } else {
    parent?.addEventListener('abort', abortFromParent, { once: true })
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

function createLlmFetch(config: LlmRuntimeConfig): FetchFunction {
  const llmFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const startedAt = Date.now()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    try {
      const response = await globalThis.fetch(input, init)
      await writeLlmDebugLog(config, 'AI SDK request', url, init, {
        ok: response.ok,
        status: response.status,
        durationMs: Date.now() - startedAt,
      })
      return response
    } catch (error: any) {
      await writeLlmDebugLog(config, 'AI SDK request', url, init, {
        error: error?.message || String(error),
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }
  return llmFetch as unknown as FetchFunction
}

async function writeLlmDebugLog(
  config: LlmRuntimeConfig,
  label: string,
  url: string,
  init: RequestInit | undefined,
  result: Record<string, unknown>,
) {
  if (!config.debug.enabled) return
  try {
    await mkdir(config.debug.dir, { recursive: true })
    const timestamp = new Date().toISOString()
    const fileName = `${timestamp.replace(/[:.]/g, '-')}-${safeFilePart(label)}.json`
    const payload = {
      timestamp,
      label,
      provider: config.provider,
      model: config.model,
      source: config.source,
      request: {
        method: init?.method ?? 'GET',
        url: redactSensitive(url, [config.apiKey]),
        headers: redactHeaders(init?.headers),
        body: redactRequestBody(init?.body, config.apiKey),
      },
      result: redactJson(result, config.apiKey),
    }
    await writeFile(join(config.debug.dir, fileName), JSON.stringify(payload, null, 2), 'utf8')
  } catch (error: any) {
    logger.debug({ err: error?.message || String(error) }, 'Failed to write LLM debug log')
  }
}

function redactHeaders(headers: RequestInit['headers'] | undefined) {
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(headersToRecord(headers))) {
    output[key] = /authorization|api[-_]?key|x-api-key/i.test(key) ? '***' : redactSensitive(String(value))
  }
  return output
}

function headersToRecord(headers: RequestInit['headers'] | undefined) {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers as Record<string, string>
}

function redactRequestBody(body: RequestInit['body'] | null | undefined, apiKey: string | null) {
  if (typeof body !== 'string') return body ? '[non-string body]' : undefined
  try {
    return redactJson(JSON.parse(body), apiKey)
  } catch {
    return redactSensitive(body, [apiKey])
  }
}

function redactJson(value: unknown, apiKey?: string | null): unknown {
  if (typeof value === 'string') return redactSensitive(value, [apiKey])
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactJson(item, apiKey))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /authorization|api[-_]?key|x-api-key/i.test(key) ? '***' : redactJson(item, apiKey),
    ])
  )
}

function safeFilePart(value: string) {
  return value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'request'
}

/* ─────────── Utilities ─────────── */

export function redactSensitive(value: string, extraSecrets: Array<string | null | undefined> = []): string {
  let output = value
  const secrets = [
    env.LLM_API_KEY,
    env.OPENAI_API_KEY,
    env.ANTHROPIC_API_KEY,
    ...extraSecrets,
  ].flatMap((secret) => {
    const cleaned = clean(secret)
    return cleaned && cleaned.length >= 8 ? [cleaned] : []
  })

  for (const secret of secrets) {
    output = output.replace(new RegExp(escapeRegex(secret), 'g'), '***')
  }

  return output
    .replace(/Bearer\s+[A-Za-z0-9_*.:-]{6,}/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_*.:-]{6,}/g, 'sk-***')
    .replace(/sess-[A-Za-z0-9_*.:-]{6,}/g, 'sess-***')
}

export function formatLlmTransportError(
  error: unknown,
  config?: Pick<LlmRuntimeConfig, 'baseUrl' | 'provider'>,
): string {
  const raw = collectErrorMessages(error).join(' | ') || '连接失败。'
  if (looksLikeCertificateError(raw)) {
    const host = safeEndpointHost(config?.baseUrl)
    const endpoint = host ? `（${host}）` : ''
    return [
      `TLS 证书校验失败${endpoint}。`,
      '请检查模型 Base URL 是否正确，代理或网关是否使用自签名证书，或者目标服务是否缺少完整证书链。',
      '如果你在使用公司代理、抓包代理或自签名中转服务，请把对应 CA 证书加入系统信任链；开发环境也可以设置 NODE_EXTRA_CA_CERTS 指向 CA 证书文件后重启 AgentHub。',
      '不建议使用 NODE_TLS_REJECT_UNAUTHORIZED=0 关闭证书校验。',
      `原始错误：${raw}`,
    ].join(' ')
  }
  return raw
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let i = 0; i < 6 && current && !seen.has(current); i += 1) {
    seen.add(current)
    if (current instanceof Error) {
      if (current.message) messages.push(current.message)
      const cause = (current as Error & { cause?: unknown }).cause
      current = cause
      continue
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>
      for (const key of ['message', 'code', 'name']) {
        const value = record[key]
        if (typeof value === 'string' && value) messages.push(value)
      }
      current = record.cause
      continue
    }
    messages.push(String(current))
    break
  }
  return Array.from(new Set(messages))
}

function looksLikeCertificateError(message: string): boolean {
  return /certificate|cert_|cert\s|tls|ssl|x509|self[-\s]?signed|unable to verify|unable_to_verify|unknown certificate verification|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID/i.test(message)
}

function safeEndpointHost(baseUrl?: string) {
  if (!baseUrl) return ''
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
