import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { logger } from '../lib/logger'
import {
  formatLlmTransportError,
  redactSensitive,
  resolveLlmRuntimeConfig,
  type LlmRuntimeConfig,
} from '../services/llm-client'

interface QuickPromptItem {
  id: string
  label: string
  prompt: string
}

export const welcomeRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .post('/quick-prompts', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const seed = typeof body.seed === 'string' && body.seed.trim()
      ? body.seed.trim().slice(0, 80)
      : Date.now().toString(36)
    const requestedCount = typeof body.count === 'number' && Number.isFinite(body.count)
      ? body.count
      : 10
    const count = Math.min(12, Math.max(6, Math.floor(requestedCount)))

    const result = await generateQuickPrompts(seed, count)

    return c.json({
      generatedAt: new Date().toISOString(),
      items: result.items,
      seed,
      source: result.source,
      error: result.error,
    })
  })

async function generateQuickPrompts(seed: string, count: number): Promise<{
  items: QuickPromptItem[]
  source: 'llm' | 'unavailable'
  error?: string
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('quick prompts timeout')), 4_000)
  let runtimeConfig: LlmRuntimeConfig | null = null
  try {
    const system = [
      '你是 AgentHub 欢迎页的动态提示词生成器。',
      '根据当前时间、开发者可能的工作场景和多 Coding Agent 协作产品定位，生成一组可点击的中文快速对话建议。',
      '只返回严格 JSON，不要 Markdown，不要解释。',
      '每条必须适合直接发给 AgentHub，避免固定模板感，不要复用一套预置列表。',
      '返回结构：{"items":[{"label":"不超过12个中文字","prompt":"用户可直接发送的一句话任务"}]}',
    ].join('\n')
    const prompt = JSON.stringify({
      seed,
      count,
      language: 'zh-CN',
      product: 'AgentHub IM 式多 Coding Agent 协作平台',
      constraints: [
        '内容必须由本次模型动态生成',
        '不要生成营销口号',
        '优先覆盖代码实现、调研报告、文档/PDF/HTML 产物、多 Agent 协作、项目诊断等场景',
      ],
    })

    runtimeConfig = await resolveLlmRuntimeConfig()
    if (!runtimeConfig.apiKey) {
      return { items: [], source: 'unavailable', error: 'LLM API Key is not configured.' }
    }
    const output = await fetchQuickPromptCompletion(runtimeConfig, system, prompt, controller.signal)

    const jsonText = extractJsonObject(output)
    if (!jsonText) throw new Error('模型未返回可解析 JSON')
    const parsed = parseQuickPromptPayload(jsonText)
    const items = normalizePromptItems(parsed.items, count)
    if (!items.length) throw new Error('模型返回的快速提示为空')
    return { items, source: 'llm' }
  } catch (error: any) {
    const message = isQuickPromptTimeout(error)
      ? '快速提示模型生成超时'
      : runtimeConfig
        ? redactSensitive(formatLlmTransportError(error, runtimeConfig), [runtimeConfig.apiKey])
        : error?.message || '快速提示模型生成失败'
    logger.warn({ err: message }, 'Dynamic quick prompts unavailable')
    return { items: [], source: 'unavailable', error: message }
  } finally {
    clearTimeout(timeout)
  }
}

function isQuickPromptTimeout(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const record = error as { message?: unknown; name?: unknown; cause?: unknown }
  if (record.name === 'AbortError') return true
  if (typeof record.message === 'string' && /quick prompts timeout|aborted|abort/i.test(record.message)) {
    return true
  }
  return isQuickPromptTimeout(record.cause)
}

async function fetchQuickPromptCompletion(
  config: LlmRuntimeConfig,
  system: string,
  prompt: string,
  signal: AbortSignal,
) {
  if (isAnthropicQuickPromptRuntime(config)) {
    return fetchAnthropicQuickPromptCompletion(config, system, prompt, signal)
  }
  return fetchOpenAiQuickPromptCompletion(config, system, prompt, signal)
}

async function fetchOpenAiQuickPromptCompletion(
  config: LlmRuntimeConfig,
  system: string,
  prompt: string,
  signal: AbortSignal,
) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
  const response = await globalThis.fetch(url, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${config.apiKey ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      stream: false,
      temperature: 0.8,
      max_tokens: 1200,
    }),
  })

  if (!response.ok) throw new Error(await formatQuickPromptHttpError(response, url))
  const body = await response.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>
    output_text?: unknown
  } | null
  const content = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? body?.output_text
  if (typeof content !== 'string') throw new Error('模型未返回文本内容')
  return content
}

async function fetchAnthropicQuickPromptCompletion(
  config: LlmRuntimeConfig,
  system: string,
  prompt: string,
  signal: AbortSignal,
) {
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
        authorization: `Bearer ${config.apiKey ?? ''}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': config.apiKey ?? '',
      },
      body: JSON.stringify({
        model: config.model,
        system,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
      }),
    })

    if (response.ok) {
      const body = await response.json().catch(() => null) as {
        content?: Array<{ text?: unknown }>
      } | null
      const content = body?.content
        ?.map((part) => typeof part.text === 'string' ? part.text : '')
        .join('')
      if (typeof content !== 'string') throw new Error('模型未返回文本内容')
      return content
    }

    lastError = await formatQuickPromptHttpError(response, url)
    if (response.status !== 404) break
  }

  throw new Error(lastError || 'Anthropic-compatible quick prompts request failed.')
}

function isAnthropicQuickPromptRuntime(config: LlmRuntimeConfig) {
  const provider = config.provider.toLowerCase()
  if (provider === 'anthropic' || provider === 'claude') return true
  try {
    const url = new URL(config.baseUrl)
    return url.hostname.includes('anthropic.com') || /\/anthropic\/?$/i.test(url.pathname)
  } catch {
    return false
  }
}

async function formatQuickPromptHttpError(response: Response, url: string) {
  const body = await response.text().catch(() => '')
  const detail = body.trim().slice(0, 400)
  return [
    `HTTP ${response.status} ${response.statusText || ''}`.trim(),
    `URL: ${url}`,
    detail,
  ].filter(Boolean).join(' | ')
}

function normalizePromptItems(
  value: Array<{ label?: unknown; prompt?: unknown }> | undefined,
  count: number,
): QuickPromptItem[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const items: QuickPromptItem[] = []
  for (const item of value) {
    const label = typeof item.label === 'string' ? item.label.trim().slice(0, 24) : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim().slice(0, 500) : ''
    if (!label || !prompt || seen.has(prompt)) continue
    seen.add(prompt)
    items.push({ id: `llm-${items.length + 1}`, label, prompt })
    if (items.length >= count) break
  }
  return items
}

function extractJsonObject(value: string) {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}

function parseQuickPromptPayload(jsonText: string): { items?: Array<{ label?: unknown; prompt?: unknown }> } {
  const attempts = [
    jsonText,
    repairJsonDelimiters(stripTrailingCommas(jsonText)),
    repairJsonDelimiters(jsonText),
  ]

  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as { items?: Array<{ label?: unknown; prompt?: unknown }> }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('快速提示 JSON 解析失败')
}

function stripTrailingCommas(value: string) {
  return value.replace(/,\s*([}\]])/g, '$1')
}

function repairJsonDelimiters(value: string) {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const char of value) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if ((char === '}' || char === ']') && stack[stack.length - 1] === char) stack.pop()
  }

  if (inString) value += '"'
  if (!stack.length) return value
  return value + stack.reverse().join('')
}
