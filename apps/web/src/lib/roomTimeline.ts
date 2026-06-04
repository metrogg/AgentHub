import { MessageType, SenderType } from '@agenthub/shared'
import type { Message, Room, RoomParticipant, TimelineEvent } from './api'

export interface RoomTimelineProjection {
  room: Room
  participantsById: Map<string, RoomParticipant>
  messages: Message[]
  events: RoomTimelineAgUiEvent[]
}

export interface RoomTimelineAgUiEvent {
  type: 'CUSTOM'
  name: string
  value: Record<string, unknown>
  runId?: string
  threadId?: string
  message?: string
}

export function projectRoomTimeline(input: {
  room: Room
  participants: RoomParticipant[]
  timeline: TimelineEvent[]
  sessionId: string
}): RoomTimelineProjection {
  const participantsById = new Map(input.participants.map((participant) => [participant.id, participant]))
  const messages = input.timeline
    .map((event) => timelineEventToMessage(event, input.room, input.sessionId, participantsById))
    .filter((message): message is Message => Boolean(message))
  const events = input.timeline.flatMap((event) => timelineEventToAgUiEvents(event, input.room, input.sessionId))
  return {
    room: input.room,
    participantsById,
    messages,
    events,
  }
}

function timelineEventToMessage(
  event: TimelineEvent,
  room: Room,
  sessionId: string,
  participantsById: Map<string, RoomParticipant>,
): Message | null {
  if (
    event.type !== 'human.message' &&
    event.type !== 'manager.message' &&
    event.type !== 'worker.message' &&
    event.type !== 'task.assigned' &&
    event.type !== 'task.progress' &&
    event.type !== 'artifact.created' &&
    event.type !== 'approval.requested' &&
    event.type !== 'system'
  ) {
    return null
  }

  const participant = event.senderParticipantId
    ? participantsById.get(event.senderParticipantId)
    : undefined
  const senderType = senderTypeFromTimeline(event)
  const senderName = displayNameForEvent(event, participant)
  const content = visibleBodyForEvent(event)
  if (!content.trim()) return null

  return {
    id: `room:${event.id}`,
    sessionId,
    senderId:
      participant?.workspaceAgentId ??
      participant?.userId ??
      participant?.workerInstanceId ??
      event.senderParticipantId ??
      event.senderType,
    senderType,
    type: MessageType.Text,
    content,
    metadata: {
      ...(event.metadata ?? {}),
      roomTimeline: {
        roomId: room.id,
        roomKind: room.kind,
        providerRoomId: room.providerRoomId,
        eventId: event.id,
        providerEventId: event.providerEventId,
        sequence: event.sequence,
        eventType: event.type,
      },
      senderName,
      agentName: senderType === SenderType.Agent ? senderName : undefined,
      displayContent: content,
    },
    createdAt: event.createdAt,
  }
}

function senderTypeFromTimeline(event: TimelineEvent): SenderType {
  if (event.senderType === 'human') return SenderType.User
  if (event.senderType === 'system' || event.type === 'system') return SenderType.System
  return SenderType.Agent
}

function displayNameForEvent(event: TimelineEvent, participant?: RoomParticipant) {
  if (participant?.displayName?.trim()) return participant.displayName.trim()
  if (event.senderType === 'manager') return 'Manager'
  if (event.senderType === 'worker') return 'Worker'
  if (event.senderType === 'human') return '我'
  return '系统'
}

function visibleBodyForEvent(event: TimelineEvent) {
  if (event.body.trim()) return event.body
  if (event.type === 'artifact.created') {
    const artifact = asRecord(event.metadata?.artifact)
    return asString(artifact?.title) ?? asString(event.metadata?.title) ?? '产物已创建'
  }
  if (event.type === 'task.progress') return asString(event.metadata?.progressStatus) ?? '任务进度更新'
  if (event.type === 'task.assigned') return asString(event.metadata?.taskTitle) ?? '任务已分配'
  if (event.type === 'approval.requested') return '需要用户确认'
  return ''
}

function timelineEventToAgUiEvents(
  event: TimelineEvent,
  room: Room,
  sessionId: string,
): RoomTimelineAgUiEvent[] {
  if (event.type === 'task.assigned') {
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
        threadId: room.sessionId ?? sessionId,
        message: event.body,
        value: {
          ...baseTaskValue(event, room, sessionId),
          status: workspaceAgentIdForEvent(event) ? 'assigned' : 'pending',
          taskThreadStatus: workspaceAgentIdForEvent(event) ? 'assigned' : 'prepared',
          progressStatus: event.body,
        },
      },
    ]
  }

  if (event.type === 'task.progress') {
    const status = normalizeWorkerProgressStatus(event)
    const taskThreadStatus = normalizeWorkerTaskThreadStatus(event, status)
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
        threadId: room.sessionId ?? sessionId,
        message: event.body,
        value: {
          ...baseTaskValue(event, room, sessionId),
          status,
          taskThreadStatus,
          waitingForHuman: taskThreadStatus === 'waiting_for_human',
          clarificationId: asString(event.metadata?.clarificationId),
          clarificationQuestion: asString(event.metadata?.clarificationQuestion) ?? asString(event.metadata?.question),
          progressPercent: asNumber(event.metadata?.progressPercent),
          progressStatus: event.body || asString(event.metadata?.progressStatus),
        },
      },
    ]
  }

  if (
    event.type === 'approval.requested' &&
    event.metadata?.kind === 'worker-runtime.clarification-requested'
  ) {
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
        threadId: room.sessionId ?? sessionId,
        message: event.body,
        value: {
          ...baseTaskValue(event, room, sessionId),
          status: 'blocked',
          taskThreadStatus: 'waiting_for_human',
          waitingForHuman: true,
          clarificationId: asString(event.metadata?.clarificationId),
          clarificationQuestion: asString(event.metadata?.question) ?? event.body,
          progressStatus: event.body || asString(event.metadata?.question) || '等待用户澄清',
        },
      },
    ]
  }

  if (event.type === 'artifact.created') {
    const value = {
      ...baseTaskValue(event, room, sessionId),
      ...artifactValueFromEvent(event),
    }
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.artifact.created',
        runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
        threadId: room.sessionId ?? sessionId,
        message: event.body,
        value,
      },
    ]
  }

  if (event.type === 'manager.message') {
    const runStatusEvent = managerTimelineEventToRunStatus(event, room, sessionId)
    return runStatusEvent ? [runStatusEvent] : []
  }

  return []
}

function managerTimelineEventToRunStatus(
  event: TimelineEvent,
  room: Room,
  sessionId: string,
): RoomTimelineAgUiEvent | null {
  if (event.metadata?.kind === 'manager-review-started') {
    return {
      type: 'CUSTOM',
      name: 'agenthub.run.status',
      runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
      threadId: room.sessionId ?? sessionId,
      message: event.body,
      value: {
        status: 'synthesizing',
        runId: asString(event.metadata?.runId) ?? room.runId,
        taskCount: asNumber(event.metadata?.taskCount),
        artifactCount: asNumber(event.metadata?.artifactCount),
        summary: event.body,
        source: 'room-timeline',
      },
    }
  }

  if (event.metadata?.kind === 'manager-final-review') {
    const finalStatus = asString(event.metadata?.finalStatus)
    return {
      type: 'CUSTOM',
      name: 'agenthub.run.status',
      runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
      threadId: room.sessionId ?? sessionId,
      message: event.body,
      value: {
        status: finalStatus === 'failed' ? 'failed' : 'completed',
        runId: asString(event.metadata?.runId) ?? room.runId,
        finalStatus,
        doneCount: asNumber(event.metadata?.doneCount),
        failedCount: asNumber(event.metadata?.failedCount),
        cancelledCount: asNumber(event.metadata?.cancelledCount),
        blockedCount: asNumber(event.metadata?.blockedCount),
        artifactCount: asNumber(event.metadata?.artifactCount),
        summary: event.body,
        source: 'room-timeline',
      },
    }
  }

  return null
}

function baseTaskValue(event: TimelineEvent, room: Room, sessionId: string): Record<string, unknown> {
  return {
    taskId: asString(event.metadata?.taskId) ?? room.taskId,
    taskThreadId: asString(event.metadata?.taskThreadId) ?? room.taskThreadId,
    childSessionId: room.sessionId ?? sessionId,
    sessionId: room.sessionId ?? sessionId,
    roomId: room.id,
    taskTitle: asString(event.metadata?.taskTitle) ?? room.title,
    taskDescription: asString(event.metadata?.taskDescription),
    agentId: workspaceAgentIdForEvent(event),
    agentName: asString(event.metadata?.agentName) ?? asString(event.metadata?.workerName),
    workerInstanceId: asString(event.metadata?.workerInstanceId),
    runtimeLeaseId: asString(event.metadata?.runtimeLeaseId),
    runtimeType: asString(event.metadata?.runtimeType),
    sharedTaskRelativeRoot: asString(event.metadata?.sharedTaskRelativeRoot),
    sharedTaskSpecPath: asString(event.metadata?.sharedTaskSpecPath),
  }
}

function normalizeWorkerProgressStatus(event: TimelineEvent) {
  const raw = asString(event.metadata?.status)
  if (raw === 'completed') return 'done'
  if (raw === 'waiting_for_human' || raw === 'awaiting_human_clarification') return 'blocked'
  if (raw === 'failed' || raw === 'cancelled') return raw
  if (event.metadata?.kind === 'worker-runtime.failed') return 'failed'
  if (event.metadata?.kind === 'worker-runtime.skipped-by-dependency') return 'failed'
  if (event.metadata?.kind === 'worker-runtime.waiting-for-human') return 'blocked'
  if (event.metadata?.kind === 'worker-runtime.waiting-on-human-dependency') return 'blocked'
  const progressStatus = asString(event.metadata?.progressStatus)
  if (progressStatus === 'skipped-by-dependency') return 'failed'
  if (progressStatus === 'waiting_on_dependency_human_clarification') return 'blocked'
  return 'running'
}

function normalizeWorkerTaskThreadStatus(
  event: TimelineEvent,
  status: ReturnType<typeof normalizeWorkerProgressStatus>,
) {
  const raw = asString(event.metadata?.taskThreadStatus) ?? asString(event.metadata?.threadStatus)
  if (
    raw === 'prepared' ||
    raw === 'assigned' ||
    raw === 'active' ||
    raw === 'waiting_for_human' ||
    raw === 'completed' ||
    raw === 'failed' ||
    raw === 'cancelled'
  ) {
    return raw
  }
  if (
    event.metadata?.kind === 'worker-runtime.waiting-for-human' ||
    event.metadata?.kind === 'worker-runtime.waiting-on-human-dependency' ||
    event.metadata?.waitingForHuman === true ||
    status === 'blocked'
  ) {
    return 'waiting_for_human'
  }
  if (event.metadata?.kind === 'worker-runtime.skipped-by-dependency') return 'failed'
  if (status === 'failed' || status === 'cancelled') return status
  if (status === 'done') return 'completed'
  return 'active'
}

function workspaceAgentIdForEvent(event: TimelineEvent) {
  return (
    asString(event.metadata?.workspaceAgentId) ??
    asString(event.metadata?.targetWorkerId) ??
    asString(event.metadata?.agentId)
  )
}

function artifactValueFromEvent(event: TimelineEvent): Record<string, unknown> {
  const artifact = asRecord(event.metadata?.artifact) ?? {}
  return {
    artifact,
    artifactId: asString(event.metadata?.artifactId) ?? asString(artifact.id),
    title: asString(artifact.title) ?? asString(event.metadata?.title) ?? event.body,
    filePath:
      asString(artifact.filePath) ??
      asString(artifact.path) ??
      asString(artifact.storagePath) ??
      asString(artifact.objectKey),
    sourcePath: asString(artifact.sourcePath),
    handoffPath: asString(artifact.handoffPath),
    handoffRelativePath: asString(artifact.handoffRelativePath),
    objectKey: asString(artifact.objectKey),
    bucket: asString(artifact.bucket),
    storageProvider: asString(artifact.storageProvider),
    storagePath: asString(artifact.storagePath),
    artifactKind: asString(artifact.artifactKind) ?? asString(artifact.kind),
    source: asString(artifact.source) ?? 'artifact-store',
    url: asString(artifact.url),
    size: asNumber(artifact.size),
    status: asString(artifact.status),
    visibility: asString(artifact.visibility),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
