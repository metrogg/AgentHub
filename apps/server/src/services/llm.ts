import { logger } from '../lib/logger'
import {
  createLlmClient,
  DEFAULT_AGENT_INSTRUCTIONS,
  redactSensitive,
  resolveLlmRuntimeConfig,
  type LLMMessage,
} from './llm-client'

export type { LLMMessage }

export async function* streamReply(
  messages: LLMMessage[],
  system?: string,
  selectedModelId?: string
): AsyncGenerator<string, void, unknown> {
  const config = await resolveLlmRuntimeConfig(selectedModelId)

  if (!config.apiKey) {
    yield 'API key is not configured. Set LLM_API_KEY or a provider-specific key such as OPENAI_API_KEY in the environment, then restart the server.'
    return
  }

  try {
    const client = createLlmClient(config)
    yield* client.stream({
      messages,
      system: system ?? DEFAULT_AGENT_INSTRUCTIONS,
    })
  } catch (err: any) {
    const message = redactSensitive(err?.message || 'LLM call failed', [config.apiKey])
    logger.error(
      {
        err: message,
        model: config.model,
        provider: config.provider,
        source: config.source,
      },
      'LLM stream error'
    )
    yield `\n\n[Error: ${message}]`
  }
}
