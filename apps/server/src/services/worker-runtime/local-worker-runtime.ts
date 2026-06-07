import type { workspaceAgents } from '@agenthub/db'
import { buildAgentProfile } from '../agents/profile-builder'
import { isCodeAgentProfile, runtimeRegistry } from '../runtime'
import type { AgentExecutionEnvelope } from '../execution/agent-execution-envelope'
import type { WorkerRuntime, WorkerRuntimeContext, WorkerRuntimeEvent, WorkerRuntimeResult } from './types'
import { projectWorkerContractIntoBridgeCwd } from './worker-bridge-contract'

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
    const artifacts: WorkerRuntimeResult['artifacts'] = []
    let latestMetadata: Record<string, unknown> = {}
    let latestCodeAgentRunMetadata: Record<string, unknown> | null = null
    let terminalStatusFromMetadata: WorkerRuntimeResult['status'] | null = null

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
    const projection = await projectWorkerContractIntoBridgeCwd({
      workerInstanceId: context.workerInstanceId,
      agent: this.agent,
      executionCwd: envelope.worktreePath,
      runtimeBase: profile.codeAgentType,
      room: {
        roomId: context.roomId,
        roomKind: 'task',
        participantId: context.workerParticipantId ?? null,
        title: context.taskId ?? context.roomId,
      },
      task: context.taskId
        ? {
            taskId: context.taskId,
            taskThreadId: context.taskThreadId ?? null,
            runId: context.runId ?? null,
            roomId: context.roomId,
            status: 'running',
            title: context.taskId,
            sharedTaskRelativeRoot: context.sharedTaskRelativeRoot ?? null,
            sharedTaskSpecPath: context.sharedTaskSpecPath ?? null,
            runtimeLeaseId: context.runtimeLeaseId ?? null,
          }
        : null,
      controllerUrl: process.env.AGENTHUB_CONTAINER_CONTROLLER_URL || process.env.AGENTHUB_CONTROLLER_URL || null,
      sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
    })
    if (projection) {
      envelope.agentContractRoot = projection.contract.root
      envelope.projectedAgentContractRoot = projection.bridgeRoot
      envelope.projectedAgentsPath = projection.agentsPath
      envelope.projectedSoulPath = projection.soulPath
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
          const metadata = chunk.metadata
          if (metadata?.sessionId && typeof metadata.sessionId === 'string') {
            sessionId = metadata.sessionId
          }
          if (isCodeAgentRunMetadata(metadata)) {
            latestCodeAgentRunMetadata = mergeCodeAgentRunMetadata(
              latestCodeAgentRunMetadata,
              metadata,
              sessionId,
            )
            terminalStatusFromMetadata = workerStatusFromCodeAgentMetadata(metadata) ?? terminalStatusFromMetadata
            yield {
              type: 'progress',
              message: 'Worker runtime metadata updated.',
              metadata: latestCodeAgentRunMetadata,
            }
            continue
          }
          latestMetadata = {
            ...latestMetadata,
            ...metadata,
          }
          if (chunk.metadata?.sessionId && typeof chunk.metadata.sessionId === 'string') {
            sessionId = chunk.metadata.sessionId
          }
          continue
        }
        yield { type: 'message', message: chunk.text }
      }
      const status = terminalStatusFromMetadata ?? 'completed'
      return {
        runtimeType: profile.runtimeType,
        status,
        message: status === 'completed' ? undefined : 'Worker execution failed.',
        artifacts,
        metadata: buildFinalWorkerMetadata(latestMetadata, latestCodeAgentRunMetadata, sessionId),
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

function buildFinalWorkerMetadata(
  latestMetadata: Record<string, unknown>,
  latestCodeAgentRunMetadata: Record<string, unknown> | null,
  sessionId?: string,
) {
  const sessionMetadata = sessionId ? { sessionId } : {}
  if (latestCodeAgentRunMetadata) {
    return {
      ...latestMetadata,
      ...mergeCodeAgentRunMetadata(latestCodeAgentRunMetadata, sessionMetadata, sessionId),
    }
  }
  const metadata = { ...latestMetadata, ...sessionMetadata }
  return Object.keys(metadata).length ? metadata : undefined
}

function isCodeAgentRunMetadata(metadata: Record<string, unknown>) {
  return metadata.type === 'code-agent-run'
}

function mergeCodeAgentRunMetadata(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
  sessionId?: string,
) {
  const merged: Record<string, unknown> = {
    ...(previous ?? {}),
    ...next,
    ...(sessionId ? { sessionId } : {}),
  }
  for (const key of ['commands', 'files', 'toolCalls', 'artifacts', 'logs', 'steps']) {
    const nextValue = next[key]
    const previousValue = previous?.[key]
    if (Array.isArray(nextValue) && nextValue.length > 0) {
      merged[key] = nextValue
    } else if (Array.isArray(previousValue) && previousValue.length > 0) {
      merged[key] = previousValue
    }
  }
  return merged
}

function workerStatusFromCodeAgentMetadata(metadata: Record<string, unknown>) {
  if (metadata.type !== 'code-agent-run') return null
  if (metadata.status === 'completed') return 'completed'
  if (metadata.status === 'cancelled') return 'cancelled'
  if (metadata.status === 'failed' || metadata.status === 'timed-out') return 'failed'
  return null
}
