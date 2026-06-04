import type { workspaceAgents } from '@agenthub/db'
import { buildAgentProfile } from '../agents/profile-builder'
import { runtimeRegistry } from '../runtime'
import type { AgentExecutionEnvelope } from '../execution/agent-execution-envelope'
import type { WorkerRuntime, WorkerRuntimeContext, WorkerRuntimeEvent, WorkerRuntimeResult } from './types'

type WorkspaceAgentRow = typeof workspaceAgents.$inferSelect

export class LocalWorkerRuntimeAdapter implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const

  constructor(private readonly agent: WorkspaceAgentRow) {}

  async *executeTask(
    context: WorkerRuntimeContext,
    signal?: AbortSignal,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    const profile = buildAgentProfile(this.agent, context.workspacePath ?? null)
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
          yield {
            type: 'progress',
            message: 'Worker runtime metadata updated.',
            metadata: chunk.metadata,
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
        sessionId,
      }
    }
  }
}
