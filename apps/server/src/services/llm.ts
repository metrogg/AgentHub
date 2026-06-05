/**
 * ⚠️ 内部 LLM 调用层（非核心路径）
 *
 * 允许调用方白名单：
 * - agent-draft.ts        : Agent 草案生成（辅助链路）
 * - coding-tools.ts       : Coding Tools 诊断接口
 * - mobile.ts             : 移动端诊断接口
 *
 * 禁止调用方（核心路径必须使用真实 Agent runtime）：
 * - Manager 决策 / Worker 执行 / Run 控制
 * - 任何 orchestrator / task / room 事件处理
 */
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
