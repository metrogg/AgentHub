import { logger } from '../../lib/logger'
import { isCodeAgentProfile, streamCodeAgentReply, type CodeAgentReplyChunk } from '../code-agent-adapter'
import type { AgentOutputChunk, AgentProfile, AgentRuntime, ExecutionContext } from './agent-runtime'

export class CodeAgentRuntime implements AgentRuntime {
  readonly runtimeType = 'code-agent'
  readonly displayName = 'Code Agent'

  async *execute(ctx: ExecutionContext): AsyncGenerator<AgentOutputChunk> {
    const { profile, prompt, history, signal } = ctx

    if (!isCodeAgentProfile(profile)) {
      yield { kind: 'text', text: '这个 Agent 配置不是 Code Agent，无法执行代码任务。' }
      return
    }

    const userMsg = {
      id: crypto.randomUUID(),
      sessionId: ctx.sessionId,
      senderId: 'user',
      senderType: 'user' as const,
      type: 'text',
      content: prompt,
      metadata: null,
      createdAt: new Date(),
    }

    let claudeSessionId: string | undefined

    try {
      for await (const chunk of streamCodeAgentReply(
        profile,
        userMsg,
        history,
        signal,
        ctx.envelope,
        ctx.continueSession,
      )) {
        if (signal?.aborted) break
        // 捕获 session ID 从 metadata chunk
        if (typeof chunk !== 'string' && chunk.kind === 'code-agent-metadata' && chunk.metadata) {
          const metadata = chunk.metadata as Record<string, unknown>
          if (metadata.sessionId && typeof metadata.sessionId === 'string') {
            claudeSessionId = metadata.sessionId
          }
        }
        yield normalizeChunk(chunk)
      }
    } catch (error: any) {
      if (signal?.aborted) return
      logger.error({ err: error?.message, sessionId: ctx.sessionId }, 'CodeAgentRuntime execute error')
      yield { kind: 'text', text: `\n\n[错误：${error?.message || 'Code Agent 执行失败'}]` }
    }

    // 在最后返回一个 metadata chunk，包含 session ID 用于会话恢复
    if (claudeSessionId) {
      yield {
        kind: 'metadata',
        metadata: { sessionId: claudeSessionId },
      }
    }
  }
}

function normalizeChunk(chunk: CodeAgentReplyChunk): AgentOutputChunk {
  if (typeof chunk === 'string') {
    return { kind: 'text', text: chunk }
  }
  if (chunk.kind === 'code-agent-metadata') {
    return { kind: 'metadata', metadata: chunk.metadata as unknown as Record<string, unknown> }
  }
  return { kind: 'text', text: String(chunk) }
}
