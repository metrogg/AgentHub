import { logger } from '../../lib/logger'
import { isCodeAgentProfile } from '../code-agent-adapter'
import type { AgentOutputChunk, AgentRuntime, ExecutionContext } from './agent-runtime'
import { ClaudeCodeRunner } from './claude-code-runner'
import { TextPacer } from './text-pacer'

export class CodeAgentRuntime implements AgentRuntime {
  readonly runtimeType = 'code-agent'
  readonly displayName = 'Code Agent'

  async *execute(ctx: ExecutionContext): AsyncGenerator<AgentOutputChunk> {
    const { profile } = ctx

    if (!isCodeAgentProfile(profile)) {
      yield { kind: 'text', text: '这个 Agent 配置不是 Code Agent，无法执行代码任务。' }
      return
    }

    const runner = new ClaudeCodeRunner()
    let claudeSessionId: string | undefined
    const pacers = new Map<string, TextPacer>()
    const reasoningBuffers = new Map<string, string>()

    const drainPacer = function* (): Generator<AgentOutputChunk> {
      for (const [id, pacer] of pacers) {
        const chunk = pacer.drain()
        if (chunk) yield { kind: 'text', text: chunk }
      }
    }

    try {
      for await (const output of runner.runTimeline(profile, ctx)) {
        if (ctx.signal?.aborted) break

        // 先 drain 所有 pacer 的累积文本
        yield* drainPacer()

        switch (output.type) {
          case 'text_delta': {
            let pacer = pacers.get(output.blockId)
            if (!pacer) {
              pacer = new TextPacer(33)
              pacers.set(output.blockId, pacer)
            }
            pacer.push(output.text)
            break
          }

          case 'reasoning_delta': {
            const prev = reasoningBuffers.get(output.blockId) ?? ''
            reasoningBuffers.set(output.blockId, prev + output.text)
            yield { kind: 'reasoning', text: output.text }
            break
          }

          case 'timeline_event': {
            const ev = output.event

            // 文本 block 结束 → 停止 pacer，产出剩余文本
            if (
              ev.kind === 'message' &&
              (ev.status === 'success' || ev.status === 'cancelled')
            ) {
              const pacer = pacers.get(ev.id)
              if (pacer) {
                const remainder = pacer.finishImmediate()
                pacers.delete(ev.id)
                if (remainder) yield { kind: 'text', text: remainder }
              }
            }

            // 捕获 Claude session ID 用于会话恢复
            if (ev.payload?.sessionId && typeof ev.payload.sessionId === 'string') {
              claudeSessionId = ev.payload.sessionId as string
            }

            yield { kind: 'timeline_event', event: ev }
            break
          }
        }
      }

      // sweep: drain 所有 pacer 剩余文本
      for (const [id, pacer] of pacers) {
        const remainder = pacer.finishImmediate()
        if (remainder) yield { kind: 'text', text: remainder }
      }
    } catch (error: any) {
      if (ctx.signal?.aborted) return
      logger.error(
        { err: error?.message, sessionId: ctx.sessionId },
        'CodeAgentRuntime execute error',
      )
      yield { kind: 'text', text: `\n\n[错误：${error?.message || 'Code Agent 执行失败'}]` }
    }

    // 向后兼容：最后返回 metadata chunk，包含 session ID 用于会话恢复
    if (claudeSessionId) {
      yield {
        kind: 'metadata',
        metadata: { sessionId: claudeSessionId },
      }
    }
  }
}
