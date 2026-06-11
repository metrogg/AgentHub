import type { AgentArtifact } from '@agenthub/db'
import type { WorkerRuntimeEvent } from './types'

export interface WorkerRuntimeEventProjectionContext {
  roomId: string
  participantId: string
  workspaceAgentId: string
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  runtimeType: string
  event: WorkerRuntimeEvent
}

export interface WorkerRuntimeArtifactProjectionInput extends WorkerRuntimeEventProjectionContext {
  event: Extract<WorkerRuntimeEvent, { type: 'artifact' }>
  registeredArtifact?: { id: string; status: string } | null
  canonicalArtifact: AgentArtifact | Record<string, unknown>
}

export interface WorkerRuntimeClarificationProjectionInput extends WorkerRuntimeEventProjectionContext {
  event: Extract<WorkerRuntimeEvent, { type: 'clarification' }>
  clarificationId?: string | null
}

export interface WorkerRuntimeTimelineEventProjection {
  roomId: string
  senderParticipantId: string
  senderType: 'worker'
  type: 'artifact.created' | 'approval.requested' | 'worker.message' | 'task.progress'
  body: string
  metadata: Record<string, unknown>
}

export function projectWorkerRuntimeArtifactTimelineEvent(
  input: WorkerRuntimeArtifactProjectionInput,
): WorkerRuntimeTimelineEventProjection {
  return {
    roomId: input.roomId,
    senderParticipantId: input.participantId,
    senderType: 'worker',
    type: 'artifact.created',
    body: input.event.message ?? input.event.artifact.title,
    metadata: {
      kind: 'worker-runtime.artifact',
      artifactId: input.registeredArtifact?.id ?? input.event.artifact.id,
      status: input.event.status ?? input.registeredArtifact?.status ?? 'registered',
      workspaceAgentId: input.workspaceAgentId,
      workerInstanceId: input.workerInstanceId ?? null,
      runtimeType: input.runtimeType,
      artifact: input.canonicalArtifact,
      ...(input.event.metadata ?? {}),
    },
  }
}

export function projectWorkerRuntimeClarificationTimelineEvent(
  input: WorkerRuntimeClarificationProjectionInput,
): WorkerRuntimeTimelineEventProjection {
  const question = workerRuntimeClarificationQuestion(input.event)
  return {
    roomId: input.roomId,
    senderParticipantId: input.participantId,
    senderType: 'worker',
    type: 'approval.requested',
    body: input.event.message,
    metadata: {
      kind: 'worker-runtime.clarification-requested',
      clarificationId: input.clarificationId ?? null,
      workspaceAgentId: input.workspaceAgentId,
      workerInstanceId: input.workerInstanceId ?? null,
      runtimeLeaseId: input.runtimeLeaseId ?? null,
      runtimeType: input.runtimeType,
      question,
      options: input.event.options ?? [],
      ...(input.event.metadata ?? {}),
    },
  }
}

export function projectWorkerRuntimeClarificationLeaseWait(input: {
  roomId: string
  runId?: string | null
  taskId?: string | null
  event: Extract<WorkerRuntimeEvent, { type: 'clarification' }>
  clarificationId?: string | null
}) {
  const question = workerRuntimeClarificationQuestion(input.event)
  return {
    message: question,
    metadata: {
      waitingForHuman: true,
      clarificationId: input.clarificationId ?? null,
      question,
      roomId: input.roomId,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
    },
  }
}

export function projectWorkerRuntimeMessageTimelineEvent(
  input: WorkerRuntimeEventProjectionContext & { event: Extract<WorkerRuntimeEvent, { type: 'message' }> },
): WorkerRuntimeTimelineEventProjection {
  return {
    roomId: input.roomId,
    senderParticipantId: input.participantId,
    senderType: 'worker',
    type: 'worker.message',
    body: input.event.message,
    metadata: {
      kind: 'worker-runtime.message',
      workspaceAgentId: input.workspaceAgentId,
      workerInstanceId: input.workerInstanceId ?? null,
      runtimeType: input.runtimeType,
      hiddenFromChat: true,
      ...(input.event.metadata ?? {}),
    },
  }
}

export function projectWorkerRuntimeProgressTimelineEvent(
  input: WorkerRuntimeEventProjectionContext & { event: Extract<WorkerRuntimeEvent, { type: 'progress' | 'failed' }> },
): WorkerRuntimeTimelineEventProjection {
  return {
    roomId: input.roomId,
    senderParticipantId: input.participantId,
    senderType: 'worker',
    type: 'task.progress',
    body: input.event.message,
    metadata: {
      kind: input.event.type === 'failed' ? 'worker-runtime.failed' : 'worker-runtime.progress',
      workspaceAgentId: input.workspaceAgentId,
      workerInstanceId: input.workerInstanceId ?? null,
      runtimeType: input.runtimeType,
      progressPercent: input.event.type === 'progress' ? input.event.progressPercent ?? null : null,
      hiddenFromChat: true,
      ...(input.event.metadata ?? {}),
    },
  }
}

export function workerRuntimeClarificationQuestion(
  event: Extract<WorkerRuntimeEvent, { type: 'clarification' }>,
) {
  return event.question ?? event.message
}
