import type { workspaceAgents } from '@agenthub/db'
import type { CodeAgentRunMetadata } from '@agenthub/shared'
import { buildAgentProfile } from '../agents/profile-builder'
import { isCodeAgentProfile, runtimeRegistry } from '../runtime'
import type { AgentExecutionEnvelope } from '../execution/agent-execution-envelope'
import type { WorkerRuntime, WorkerRuntimeContext, WorkerRuntimeEvent, WorkerRuntimeResult } from './types'

type WorkspaceAgentRow = typeof workspaceAgents.$inferSelect

export class EphemeralCodeAgentWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
  readonly kind = 'ephemeral-code-agent' as const

  constructor(private readonly agent: WorkspaceAgentRow) {}

  async *executeTask(
    context: WorkerRuntimeContext,
    signal?: AbortSignal,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    const profile = buildAgentProfile(this.agent, context.workspacePath ?? null)
    // AgentHub Worker 必须是真实 Code Agent runtime。
    // 不再支持 LLM profile 的 Worker fallback；让错误尽早暴露。
    if (!isCodeAgentProfile(profile)) {
      throw new Error(
        `Worker ${profile.name} (${profile.id}) 的 profile.runtimeType=${profile.runtimeType ?? 'undefined'}` +
          ` 不是 code-agent。AgentHub Worker 必须是真实 Code Agent runtime（codex|claude-code|opencode|gemini），不接受 LLM profile。`,
      )
    }
    const runtime = runtimeRegistry.resolveForProfile(profile)
    const chunks: string[] = []
    const artifacts: WorkerRuntimeResult['artifacts'] = []

    yield {
      type: 'progress',
      message: `${profile.name} 已接单，正在启动 ${runtime.displayName}。`,
      progressPercent: 5,
      metadata: { runtimeType: runtime.runtimeType },
    }

    const envelope: AgentExecutionEnvelope = {
      runId: context.runId ?? context.sessionId,
      taskId: context.taskId ?? context.sessionId,
      agentId: context.workspaceAgentId,
      agentName: this.agent.name,
      projectPath: context.workspacePath ?? null,
      worktreePath: context.workspacePath ?? null,
      sandboxPolicy: profile.sandboxPolicy,
      envAllowlist: [],
      sandboxEnv: context.sandboxEnv,
    }

    let sessionId: string | undefined
    let codeAgentRun: CodeAgentRunMetadata | undefined

    try {
      for await (const chunk of runtime.execute({
        sessionId: context.sessionId,
        prompt: context.prompt,
        history: context.history.map((event) => ({
          senderType: event.senderType,
          content: event.body,
        })),
        profile,
        signal: signal ?? new AbortController().signal,
        workspaceId: context.workspaceId,
        workspacePath: context.workspacePath ?? undefined,
        envelope,
        continueSession: context.continueSession,
        resumeSessionId: context.resumeSessionId,
        rawFinalOutput: true,
      })) {
        if (signal?.aborted) {
          return {
            runtimeType: profile.runtimeType,
            status: 'cancelled',
            message: 'Worker execution was cancelled.',
            artifacts,
            sessionId,
          }
        }
        if (chunk.kind === 'artifact') {
          artifacts.push(chunk.artifact)
          yield {
            type: 'artifact',
            artifact: chunk.artifact,
            message: chunk.artifact.title,
          }
          continue
        }
        if (chunk.kind === 'metadata') {
          if (chunk.metadata?.sessionId && typeof chunk.metadata.sessionId === 'string') {
            sessionId = chunk.metadata.sessionId
          }
          if (isCodeAgentRunMetadata(chunk.metadata)) {
            codeAgentRun = chunk.metadata
            yield {
              type: 'metadata',
              metadata: {
                codeAgentRun,
                ...(sessionId ? { sessionId } : {}),
              },
            }
          }
          continue
        }
        chunks.push(chunk.text)
        yield {
          type: 'message',
          message: chunk.text,
        }
      }
      const message = chunks.join('').trim()
      return {
        runtimeType: profile.runtimeType,
        status: 'completed',
        message,
        artifacts,
        metadata: codeAgentRun
          ? {
              codeAgentRun: {
                ...codeAgentRun,
                artifacts: artifacts.length ? artifacts : codeAgentRun.artifacts,
                finalMessage: codeAgentRun.finalMessage ?? message,
              },
            }
          : undefined,
        sessionId,
      }
    } catch (error: any) {
      const message = error?.message || 'Worker execution failed.'
      yield {
        type: 'failed',
        message,
      }
      return {
        runtimeType: profile.runtimeType,
        status: 'failed',
        message,
        artifacts,
        metadata: codeAgentRun
          ? {
              codeAgentRun: {
                ...codeAgentRun,
                status: codeAgentRun.status === 'running' ? 'failed' : codeAgentRun.status,
                artifacts: artifacts.length ? artifacts : codeAgentRun.artifacts,
                finalMessage: codeAgentRun.finalMessage ?? message,
              },
            }
          : undefined,
        sessionId,
      }
    }
  }
}

function isCodeAgentRunMetadata(value: Record<string, unknown>): value is CodeAgentRunMetadata {
  return (
    value.type === 'code-agent-run' &&
    typeof value.status === 'string' &&
    typeof value.runtime === 'string' &&
    typeof value.command === 'string'
  )
}
