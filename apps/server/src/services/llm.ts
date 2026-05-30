import { logger } from '../lib/logger'
import {
  createLlmClient,
  DEFAULT_AGENT_INSTRUCTIONS,
  redactSensitive,
  resolveLlmRuntimeConfig,
  type LLMMessage,
  type LlmStreamChunk,
} from './llm-client'

export type { LLMMessage }
export type { LlmStreamChunk }

export async function* streamReply(
  messages: LLMMessage[],
  system?: string,
  selectedModelId?: string,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const config = await resolveLlmRuntimeConfig(selectedModelId)

  if (!config.apiKey) {
    yield 'API Key 未配置。请在环境变量中设置 LLM_API_KEY 或 OPENAI_API_KEY 等供应商专用 Key，然后重启服务。'
    return
  }

  try {
    const client = createLlmClient(config)
    yield* client.stream({
      messages,
      signal,
      system: system ?? DEFAULT_AGENT_INSTRUCTIONS,
    })
  } catch (err: any) {
    const message = redactSensitive(err?.message || 'LLM 调用失败', [config.apiKey])
    logger.error(
      {
        err: message,
        model: config.model,
        provider: config.provider,
        source: config.source,
      },
      'LLM stream error'
    )
    yield `\n\n[错误：${message}]`
  }
}

export async function* streamReplyParts(
  messages: LLMMessage[],
  system?: string,
  selectedModelId?: string,
  signal?: AbortSignal
): AsyncGenerator<LlmStreamChunk, void, unknown> {
  const config = await resolveLlmRuntimeConfig(selectedModelId)

  if (!config.apiKey) {
    yield {
      type: 'text-delta',
      text: 'API Key 鏈厤缃€傝鍦ㄧ幆澧冨彉閲忎腑璁剧疆 LLM_API_KEY 鎴?OPENAI_API_KEY 绛変緵搴斿晢涓撶敤 Key锛岀劧鍚庨噸鍚湇鍔°€?',
    }
    return
  }

  try {
    const client = createLlmClient(config)
    yield* client.streamParts({
      messages,
      signal,
      system: system ?? DEFAULT_AGENT_INSTRUCTIONS,
    })
  } catch (err: any) {
    const message = redactSensitive(err?.message || 'LLM 璋冪敤澶辫触', [config.apiKey])
    logger.error(
      {
        err: message,
        model: config.model,
        provider: config.provider,
        source: config.source,
      },
      'LLM stream error'
    )
    yield { type: 'text-delta', text: `\n\n[閿欒锛?{message}]` }
  }
}
