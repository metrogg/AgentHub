import type { AgentArtifact } from '@agenthub/db'

export type WorkerRuntimeType =
  | 'code-agent'
  | 'llm'
  | 'openclaw'
  | 'qwenpaw'

/** Worker 运行模式：轻量一次性 CLI 执行 vs 常驻 Room Worker */
export type WorkerRuntimeKind =
  | 'ephemeral-code-agent'
  | 'resident-openclaw'
  | 'resident-qwenpaw'

export type WorkerRuntimeEvent =
  | {
      type: 'progress'
      message: string
      progressPercent?: number
      metadata?: Record<string, unknown>
    }
  | {
      type: 'message'
      message: string
      metadata?: Record<string, unknown>
    }
  | {
      type: 'artifact'
      artifact: AgentArtifact
      message?: string
      status?: 'discovered' | 'registered' | 'verified' | 'partial' | 'failed'
      metadata?: Record<string, unknown>
    }
  | {
      type: 'clarification'
      message: string
      question?: string
      options?: string[]
      metadata?: Record<string, unknown>
    }
  | {
      type: 'failed'
      message: string
      metadata?: Record<string, unknown>
    }

export interface WorkerRuntimeContext {
  roomId: string
  sessionId: string
  workspaceId: string
  workspaceAgentId: string
  workerParticipantId?: string | null
  workerInstanceId?: string | null
  taskId?: string | null
  taskThreadId?: string | null
  runId?: string | null
  prompt: string
  history: Array<{
    senderType: 'human' | 'manager' | 'worker' | 'system'
    type: string
    body: string
  }>
  workspacePath?: string | null
  sandboxEnv?: Record<string, string>
  resumeSessionId?: string
  continueSession?: boolean
}

export interface WorkerRuntimeResult {
  runtimeType: WorkerRuntimeType
  kind?: WorkerRuntimeKind
  status: 'completed' | 'failed' | 'cancelled' | 'waiting_for_human'
  message?: string
  artifacts?: AgentArtifact[]
  metadata?: Record<string, unknown>
  sessionId?: string
}

export interface WorkerRuntime {
  readonly runtimeType: WorkerRuntimeType
  readonly kind: WorkerRuntimeKind
  executeTask(
    context: WorkerRuntimeContext,
    signal?: AbortSignal,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown>
}
