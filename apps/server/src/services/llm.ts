import { db, settings } from '@agenthub/db'
import { env } from '../env'
import { logger } from '../lib/logger'
import { createAssistantAgent, DEFAULT_AGENT_INSTRUCTIONS } from '../mastra/agents'

interface ModelCatalogItem {
  id: string
  enabled?: boolean
  provider?: string
  modelId?: string
  apiEndpoint?: string
  anthropicEndpoint?: string
  apiKeyEnv?: string
  apiKey?: string
}

interface RuntimeConfig {
  apiKey: string | null
  model: string
  provider: string
  baseUrl: string
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

function readEnv(name?: string): string | undefined {
  if (!name) return undefined
  return Bun.env[name]
}

function configuredApiKey(item: ModelCatalogItem): string | undefined {
  return item.apiKey || readEnv(item.apiKeyEnv)
}

function pickAutomaticModel(catalog: ModelCatalogItem[]): ModelCatalogItem | undefined {
  const candidates = catalog.filter(
    (item) => item.enabled && item.provider === 'anthropic' && item.modelId && configuredApiKey(item)
  )
  if (candidates.length === 0) return undefined
  return candidates[Math.floor(Math.random() * candidates.length)]
}

async function resolveRuntimeConfig(selectedModelId?: string): Promise<RuntimeConfig> {
  try {
    const map = await getSettingsMap()
    const catalog = parseCatalog(map.MODEL_CATALOG)
    const selected =
      (selectedModelId && catalog.find((item) => item.id === selectedModelId && item.enabled)) ||
      pickAutomaticModel(catalog)

    if (selected?.modelId) {
      const apiKey = configuredApiKey(selected)
      if (apiKey) {
        return {
          apiKey,
          model: selected.modelId,
          provider: selected.provider || 'openai',
          baseUrl: selected.provider === 'anthropic'
            ? selected.apiEndpoint || 'https://api.anthropic.com'
            : selected.apiEndpoint || selected.anthropicEndpoint || 'https://api.openai.com/v1',
        }
      }
    }

    if (map.ACTIVE_API_KEY) {
      return {
        apiKey: map.ACTIVE_API_KEY,
        model: map.ACTIVE_MODEL || env.ANTHROPIC_MODEL,
        provider: map.ACTIVE_PROVIDER || 'openai',
        baseUrl: map.ACTIVE_BASE_URL || 'https://api.openai.com/v1',
      }
    }
    if (map.ANTHROPIC_API_KEY) {
      return {
        apiKey: map.ANTHROPIC_API_KEY,
        model: map.ANTHROPIC_MODEL || env.ANTHROPIC_MODEL,
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
      }
    }
  } catch {
    // Settings are optional; fall back to environment configuration.
  }

  return {
    apiKey: env.ANTHROPIC_API_KEY ?? null,
    model: env.ANTHROPIC_MODEL,
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
  }
}

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function* streamReply(
  messages: LLMMessage[],
  system?: string,
  selectedModelId?: string
): AsyncGenerator<string, void, unknown> {
  const { apiKey, model, provider, baseUrl } = await resolveRuntimeConfig(selectedModelId)
  if (!apiKey) {
    yield 'API Key is not configured. Add it in Settings or set it in .env and restart the server.'
    return
  }

  try {
    if (provider !== 'anthropic') {
      yield* streamOpenAICompatible(messages, { apiKey, model, baseUrl })
      return
    }

    const agent = createAssistantAgent(apiKey, system ?? DEFAULT_AGENT_INSTRUCTIONS, model)
    const stream = await agent.stream(
      messages.map((m) => ({ role: m.role, content: m.content }))
    )

    for await (const delta of stream.textStream) {
      yield delta
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Mastra LLM stream error')
    yield `\n\n[Error: ${err.message || 'LLM call failed'}]`
  }
}

async function* streamOpenAICompatible(
  messages: LLMMessage[],
  config: { apiKey: string; model: string; baseUrl: string }
): AsyncGenerator<string, void, unknown> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: DEFAULT_AGENT_INSTRUCTIONS },
        ...messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      stream: true,
    }),
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    yield `[Error: ${text.slice(0, 300) || `OpenAI-compatible request failed: HTTP ${res.status}`}]`
    return
  }

  const reader = res.body.getReader()
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
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content
        if (typeof delta === 'string' && delta) yield delta
      } catch {
        // Ignore malformed SSE chunks.
      }
    }
  }
}
