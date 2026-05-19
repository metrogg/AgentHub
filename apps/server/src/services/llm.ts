import Anthropic from '@anthropic-ai/sdk'
import { env } from '../env'
import { logger } from '../lib/logger'

const client = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function* streamReply(
  messages: LLMMessage[],
  system?: string
): AsyncGenerator<string, void, unknown> {
  if (!client) {
    yield '⚠️ 未配置 ANTHROPIC_API_KEY，请在 .env 中设置后重启服务。'
    return
  }

  try {
    const stream = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: system ?? '你是一个乐于助人的 AI 助手，来自 AgentHub 多 Agent 协作平台。',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    })

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        yield chunk.delta.text
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'LLM stream error')
    yield `\n\n[错误: ${err.message || 'LLM 调用失败'}]`
  }
}
