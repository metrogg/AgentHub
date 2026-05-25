import { db, settings } from '@agenthub/db'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  enabled?: boolean
  provider?: string
  modelId?: string
  apiEndpoint?: string
  anthropicEndpoint?: string
  apiKeyEnv?: string
  apiKey?: string
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
  return normalized === 'anthropic' || normalized === 'claude' || Boolean(baseUrl?.includes('anthropic.com'))
}

function defaultBaseUrl(provider: string): string {
  return isAnthropicProvider(provider) ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL
}

function defaultModel(provider: string): string {
  return isAnthropicProvider(provider) ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL
}

function providerEnvApiKey(provider: string): { value?: string; source?: string } {
  const normalized = normalizeProvider(provider)
  const directName = `${normalized.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
  const direct = readEnv(directName)
  if (direct) return { value: direct, source: directName }

  if (isAnthropicProvider(provider)) {
    const value = clean(env.ANTHROPIC_API_KEY)
    return value ? { value, source: 'ANTHROPIC_API_KEY' } : {}
  }

  const openAiValue = clean(env.OPENAI_API_KEY)
  if (openAiValue) return { value: openAiValue, source: 'OPENAI_API_KEY' }

  const generic = clean(env.LLM_API_KEY)
  return generic ? { value: generic, source: 'LLM_API_KEY' } : {}
}

function normalizeConfig(candidate: ProviderCandidate, source: 'settings' | 'env'): LlmRuntimeConfig {
  const provider = normalizeProvider(candidate.provider)
  const baseUrl = (clean(candidate.baseUrl) ?? defaultBaseUrl(provider)).replace(/\/$/, '')
  const fallbackKey = providerEnvApiKey(provider)
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

function pickSettingsCandidate(map: Record<string, string>, selectedModelId?: string): ProviderCandidate | null {
  const catalog = parseCatalog(map.MODEL_CATALOG)
  const activeId = clean(selectedModelId) ?? clean(map.ACTIVE_MODEL_ID)
  const selected = activeId
    ? catalog.find((item) => item.id === activeId && item.enabled !== false)
    : undefined
  const firstConfigured = catalog.find((item) => {
    if (item.enabled === false || !clean(item.modelId)) return false
    return Boolean(configuredApiKey(item).value)
  })
  const item = selected ?? firstConfigured

  if (item?.modelId) {
    const key = configuredApiKey(item)
    return {
      apiKey: key.value,
      apiKeySource: key.source,
      baseUrl: item.provider === 'anthropic'
        ? clean(item.anthropicEndpoint) ?? clean(item.apiEndpoint)
        : clean(item.apiEndpoint) ?? clean(item.anthropicEndpoint),
      model: item.modelId,
      provider: item.provider,
    }
  }

  if (clean(map.ACTIVE_MODEL) || clean(map.ACTIVE_BASE_URL) || clean(map.ACTIVE_API_KEY)) {
    return {
      apiKey: clean(map.ACTIVE_API_KEY),
      apiKeySource: clean(map.ACTIVE_API_KEY) ? 'settings' : undefined,
      baseUrl: clean(map.ACTIVE_BASE_URL),
      model: clean(map.ACTIVE_MODEL),
      provider: clean(map.ACTIVE_PROVIDER),
    }
  }

  if (clean(map.ANTHROPIC_API_KEY)) {
    return {
      apiKey: clean(map.ANTHROPIC_API_KEY),
      apiKeySource: 'settings',
      baseUrl: env.ANTHROPIC_BASE_URL,
      model: clean(map.ANTHROPIC_MODEL),
      provider: 'anthropic',
    }
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

export function createLlmClient(config: LlmRuntimeConfig) {
  return {
    stream(options: StreamOptions) {
      if (isAnthropicProvider(config.provider, config.baseUrl)) {
        return streamAnthropic(options, config)
      }
      return streamOpenAICompatible(options, config)
    },
  }
}

export async function testLlmConnection(input: TestConnectionInput) {
  const provider = normalizeProvider(input.provider)
  const endpoint = isAnthropicProvider(provider)
    ? clean(input.anthropicEndpoint) ?? clean(input.apiEndpoint)
    : clean(input.apiEndpoint)
  const directKey = clean(input.apiKey)
  const envKey = readEnv(input.apiKeyEnv)
  const apiKey = directKey ?? envKey
  const model = clean(input.modelId)

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

  // 如果 model 是默认值，提示用户确认模型 ID 是否正确
  const isDefaultModel = !clean(input.modelId)

  try {
    const res = isAnthropicProvider(config.provider, config.baseUrl)
      ? await testAnthropicMessage(config)
      : await testOpenAICompatibleMessage(config)
    if (!res.ok) {
      let message = await formatHttpError('连接测试', res, config)
      if (res.status === 400 && isDefaultModel) {
        message += `（提示：未提供 modelId，使用了默认模型 "${config.model}"。如果使用的是第三方兼容 API，请在模型配置中填写正确的模型 ID。）`
      }
      return {
        ok: false,
        status: res.status,
        message,
      }
    }

    return { ok: true, status: res.status, message: '连接成功。' }
  } catch (error: any) {
    return { ok: false, message: redactSensitive(error?.message || '连接失败。', [apiKey]) }
  }
}

async function testAnthropicMessage(config: LlmRuntimeConfig) {
  return fetchWithRetry(
    `${config.baseUrl}/v1/messages`,
    {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        max_tokens: 8,
        messages: [{ role: 'user', content: '只回复 OK。' }],
        stream: false,
      }),
    },
    { ...config, maxRetries: 0 },
    'Anthropic 消息测试'
  )
}

async function testOpenAICompatibleMessage(config: LlmRuntimeConfig) {
  return fetchWithRetry(
    `${config.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: '只回复 OK。' }],
        max_tokens: 8,
        stream: false,
      }),
    },
    { ...config, maxRetries: 0 },
    '聊天补全测试'
  )
}

async function* streamOpenAICompatible(
  options: StreamOptions,
  config: LlmRuntimeConfig
): AsyncGenerator<string, void, unknown> {
  assertApiKey(config)
  const res = await fetchWithRetry(
    `${config.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: options.system ?? DEFAULT_AGENT_INSTRUCTIONS },
          ...options.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
        stream: true,
      }),
      signal: options.signal,
    },
    config,
    '聊天补全'
  )

  if (!res.ok || !res.body) {
    throw new Error(await formatHttpError('聊天补全', res, config))
  }

  for await (const data of iterateSseData(res.body)) {
    if (data === '[DONE]') continue
    try {
      const parsed = JSON.parse(data)
      const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content
      if (typeof delta === 'string' && delta) yield delta
    } catch {
      // Ignore malformed SSE chunks.
    }
  }
}

async function* streamAnthropic(
  options: StreamOptions,
  config: LlmRuntimeConfig
): AsyncGenerator<string, void, unknown> {
  assertApiKey(config)
  const res = await fetchWithRetry(
    `${config.baseUrl}/v1/messages`,
    {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        model: config.model,
        max_tokens: 4096,
        system: options.system ?? DEFAULT_AGENT_INSTRUCTIONS,
        messages: options.messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
      }),
      signal: options.signal,
    },
    config,
    'Anthropic 消息'
  )

  if (!res.ok || !res.body) {
    throw new Error(await formatHttpError('Anthropic 消息', res, config))
  }

  for await (const data of iterateSseData(res.body)) {
    try {
      const parsed = JSON.parse(data)
      const delta = parsed?.delta?.text
      if (typeof delta === 'string' && delta) yield delta
    } catch {
      // Ignore malformed SSE chunks.
    }
  }
}

function buildHeaders(config: LlmRuntimeConfig): Record<string, string> {
  if (isAnthropicProvider(config.provider, config.baseUrl)) {
    return {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': config.apiKey ?? '',
    }
  }

  return {
    authorization: `Bearer ${config.apiKey ?? ''}`,
    'content-type': 'application/json',
  }
}

function assertApiKey(config: LlmRuntimeConfig) {
  if (!config.apiKey) {
    throw new Error('API Key 未配置。请设置 LLM_API_KEY 或供应商专用 API Key 环境变量。')
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  config: LlmRuntimeConfig,
  label: string
): Promise<Response> {
  let lastError: unknown

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`${label}超时`)), config.timeoutMs)
    const abortFromInput = () => controller.abort(init.signal?.reason ?? new Error(`${label}已中止`))
    if (init.signal?.aborted) abortFromInput()
    else init.signal?.addEventListener('abort', abortFromInput, { once: true })

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
      })
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', abortFromInput)
      await writeLlmDebugLog(config, label, url, init, {
        attempt,
        status: res.status,
        ok: res.ok,
        retryable: isRetryableStatus(res.status) && attempt < config.maxRetries,
      })

      if (isRetryableStatus(res.status) && attempt < config.maxRetries) {
        await res.arrayBuffer().catch(() => undefined)
        await delay(backoffMs(attempt))
        continue
      }

      return res
    } catch (error) {
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', abortFromInput)
      lastError = error
      await writeLlmDebugLog(config, label, url, init, {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      })
      if (attempt >= config.maxRetries) break
      await delay(backoffMs(attempt))
    }
  }

  const message = lastError instanceof Error ? lastError.message : `${label}请求失败`
  throw new Error(redactSensitive(message, [config.apiKey]))
}

async function writeLlmDebugLog(
  config: LlmRuntimeConfig,
  label: string,
  url: string,
  init: RequestInit,
  result: Record<string, unknown>
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
        method: init.method ?? 'GET',
        url: redactSensitive(url, [config.apiKey]),
        headers: redactHeaders(init.headers),
        body: redactRequestBody(init.body, config.apiKey),
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

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599)
}

function backoffMs(attempt: number): number {
  return Math.min(4_000, 300 * 2 ** attempt)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function formatHttpError(label: string, res: Response, config: LlmRuntimeConfig): Promise<string> {
  const body = await res.text().catch(() => '')
  const providerMessage = extractProviderErrorMessage(body)
  const details = providerMessage || body || `HTTP ${res.status}`
  return `${label}失败，状态码 ${res.status}：${redactSensitive(details.slice(0, 500), [config.apiKey])}`
}

function extractProviderErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error
    return typeof message === 'string' ? message : null
  } catch {
    return null
  }
}

async function* iterateSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data) yield data
    }
  }
}

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
