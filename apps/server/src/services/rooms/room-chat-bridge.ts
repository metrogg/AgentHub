import { asc, db, eq, messages, roomParticipants, sessions, workspaceAgents } from '@agenthub/db'
import { dispatchAssignBatch } from '../controller-plane/task-dispatcher'
import type { ManagerAction, ManagerActionType, ManagerRuntime } from '../manager-runtime'
import { managerRuntimeService } from '../manager-runtime'
import type { WorkerRuntime } from '../worker-runtime'
import { workerRuntimeService } from '../worker-runtime'
import { roomService } from './room-service'
import { getActiveManagerProvider } from '../manager-runtime'

const MESSAGE_ACTION_TYPES = new Set<ManagerActionType>([
  'reply',
  'clarify',
  'propose_members',
])

export interface RecordHumanMessageInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  message: typeof messages.$inferSelect
  runtime?: ManagerRuntime
  workerRuntime?: WorkerRuntime
}

export interface AppendHumanMessageRoomFirstInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  content: string
  type: string
  metadata?: Record<string, unknown> | null
  replyToMessageId?: string | null
  skipDispatch?: boolean
}

export interface AppendMessageControlEventInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  kind: 'message.clear' | 'message.edit' | 'message.redact' | 'message.pin'
  body?: string
  metadata?: Record<string, unknown>
}

export interface ManagerFirstResult {
  roomId: string
  consumed: boolean
  reason: string
  actions: ManagerAction[]
  mirroredMessageIds: string[]
}

export interface TaskRoomHumanReplyResult {
  roomId: string
  consumed: boolean
  reason: string
  resumed: boolean
  appendedEventIds: string[]
}

export async function appendHumanMessageRoomFirst(input: AppendHumanMessageRoomFirstInput) {
  const room = await roomService.ensureRoomForSession(input.session.id, input.session.ownerId)
  await ensureSessionRoomParticipants({
    roomId: room.id,
    session: input.session,
    userId: input.userId,
    userName: input.userName,
  })
  const human = await ensureHumanParticipant(room.id, input.userId, input.userName)
  const event = await roomService.appendTimelineEvent({
    roomId: room.id,
    senderParticipantId: human.id,
    senderType: 'human',
    type: 'human.message',
    body: input.content,
    metadata: {
      ...(input.metadata ?? {}),
      kind: 'chat.message',
      sessionId: input.session.id,
      messageType: input.type,
      replyToMessageId: input.replyToMessageId ?? null,
      source: 'room-first',
    },
  })
  const messageMetadata = {
    ...(input.metadata ?? {}),
    roomTimelineProjection: {
      source: 'room-first',
      roomId: room.id,
      roomKind: room.kind,
      providerRoomId: room.providerRoomId,
      eventId: event.id,
      providerEventId: event.providerEventId,
      sequence: event.sequence,
      eventType: event.type,
    },
  }
  const message: typeof messages.$inferSelect = {
    id: `room:${event.id}`,
    sessionId: input.session.id,
    senderId: input.userId,
    senderType: 'user',
    type: input.type,
    content: input.content,
    metadata: messageMetadata,
    isPinned: false,
    replyToMessageId: input.replyToMessageId ?? null,
    createdAt: event.createdAt,
  }

  // HiClaw model: after writing the human message, dispatch it so
  // the Manager/Worker can pick it up (equivalent to Matrix /sync detecting it).
  if (!input.skipDispatch) {
    const { matrixRoomEventDispatcher } = await import('./matrix-event-dispatcher')
    await matrixRoomEventDispatcher.dispatchTimelineEvent(event.id).catch(() => {})
  }

  return { room, event, message }
}

export async function appendMessageControlEvent(input: AppendMessageControlEventInput) {
  const room = await roomService.ensureRoomForSession(input.session.id, input.session.ownerId)
  await ensureSessionRoomParticipants({
    roomId: room.id,
    session: input.session,
    userId: input.userId,
    userName: input.userName,
  })
  const human = await ensureHumanParticipant(room.id, input.userId, input.userName)
  const event = await roomService.appendTimelineEvent({
    roomId: room.id,
    senderParticipantId: human.id,
    senderType: 'human',
    type: 'system',
    body: input.body ?? '',
    metadata: {
      ...(input.metadata ?? {}),
      kind: input.kind,
      sessionId: input.session.id,
      actorUserId: input.userId,
      source: 'room-timeline-control',
    },
  })
  return { room, event }
}

export async function recordHumanMessageInRoomTimeline(input: RecordHumanMessageInput) {
  const room = await roomService.ensureRoomForSession(input.session.id, input.session.ownerId)
  await ensureSessionRoomParticipants({
    roomId: room.id,
    session: input.session,
    userId: input.userId,
    userName: input.userName,
  })
  const existingEvents = await roomService.listTimelineEvents({ roomId: room.id, limit: 500 })
  const projectedEventId = projectedEventIdFromMessage(input.message)
  const hasEvent = existingEvents.some((event) => {
    if (event.metadata?.messageId === input.message.id) return true
    if (event.metadata?.projectionMessageId === input.message.id) return true
    return Boolean(projectedEventId && event.id === projectedEventId)
  })
  if (hasEvent) return room
  const human = await ensureHumanParticipant(room.id, input.userId, input.userName)
  await roomService.appendTimelineEvent({
    roomId: room.id,
    senderParticipantId: human.id,
    senderType: 'human',
    type: 'human.message',
    body: input.message.content,
    metadata: {
      kind: 'chat.message',
      messageId: input.message.id,
      sessionId: input.session.id,
      messageType: input.message.type,
      replyToMessageId: input.message.replyToMessageId ?? null,
      ...(input.message.metadata ?? {}),
    },
  })
  return room
}

function projectedEventIdFromMessage(message: typeof messages.$inferSelect) {
  if (!message.id.startsWith('room:')) return null
  const eventId = message.id.slice('room:'.length).trim()
  return eventId || null
}

export async function stepCoordinatorForGroupMessage(input: RecordHumanMessageInput): Promise<ManagerFirstResult> {
  const room = await recordHumanMessageInRoomTimeline(input)
  await appendCoordinatorObservingEvent({
    roomId: room.id,
    sourceMessageId: input.message.id,
  })

  // If a resident Manager (OpenClaw/QwenPaw) is running, skip the local step call.
  // The resident process observes the room via Matrix /sync autonomously.
  const provider = getActiveManagerProvider()
  if (provider.runtimeType === 'openclaw' || provider.runtimeType === 'qwenpaw') {
    const status = await provider.status()
    if (status.running) {
      return {
        roomId: room.id,
        consumed: true,
        reason: `Resident Manager (${provider.runtimeType}) is active; message delivered to room timeline for autonomous processing.`,
        actions: [],
        mirroredMessageIds: [],
      }
    }
  }

  const result = await managerRuntimeService.stepRoom({
    roomId: room.id,
    ownerId: input.session.ownerId,
    appendActions: false,
    runtime: input.runtime,
    source: 'room-chat-bridge',
  })
  if (result.actions.length === 0) {
    await appendCoordinatorRuntimeBlockedEvent({
      roomId: room.id,
      sourceMessageId: input.message.id,
      reason: 'ManagerRuntime returned no actions.',
      runtimeType: result.runtimeType,
    })
    return {
      roomId: room.id,
      consumed: true,
      reason: 'ManagerRuntime returned no actions; no legacy orchestrator fallback will run.',
      actions: [],
      mirroredMessageIds: [],
    }
  }
  const unsupportedAction = result.actions.find(
    (action) => !MESSAGE_ACTION_TYPES.has(action.type) && action.type !== 'assign',
  )
  if (unsupportedAction) {
    await appendCoordinatorRuntimeBlockedEvent({
      roomId: room.id,
      sourceMessageId: input.message.id,
      reason: `ManagerRuntime returned unsupported action ${unsupportedAction.type}.`,
      runtimeType: result.runtimeType,
    })
    return {
      roomId: room.id,
      consumed: true,
      reason: `ManagerRuntime returned unsupported action ${unsupportedAction.type}; no legacy orchestrator fallback will run.`,
      actions: result.actions,
      mirroredMessageIds: [],
    }
  }

  const mirroredMessageIds: string[] = []
  const assignActions = result.actions.filter((action) => action.type === 'assign')
  if (assignActions.length > 0) {
    try {
      await dispatchAssignBatch({
        groupSession: input.session,
        ownerId: input.session.ownerId,
        goal: input.message.content,
        actions: assignActions,
        runtimeType: result.runtimeType,
        workerRuntime: input.workerRuntime,
      })
    } catch (error: any) {
      await appendCoordinatorRuntimeBlockedEvent({
        roomId: room.id,
        sourceMessageId: input.message.id,
        reason: `ManagerRuntime assign dispatch failed: ${error?.message || 'unknown error'}`,
        runtimeType: result.runtimeType,
      })
      return {
        roomId: room.id,
        consumed: true,
        reason: `Coordinator assign dispatch failed: ${error?.message || 'unknown error'}`,
        actions: result.actions,
        mirroredMessageIds: [],
      }
    }
  }

  for (const action of result.actions) {
    if (action.type === 'assign') continue
    await appendManagerActionToRoomTimeline({
      roomId: room.id,
      action,
      runtimeType: result.runtimeType,
      sourceMessageId: input.message.id,
    })
  }

  return {
    roomId: room.id,
    consumed: true,
    reason: assignActions.length
      ? 'Coordinator dispatched real task room assignment through WorkerRuntime.'
      : 'Coordinator handled this as a room-level conversational action.',
    actions: result.actions,
    mirroredMessageIds,
  }
}

async function appendCoordinatorRuntimeBlockedEvent(input: {
  roomId: string
  sourceMessageId: string
  reason: string
  runtimeType: string
}) {
  return roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderType: 'manager',
    type: 'system',
    body: `Manager Runtime 未能继续执行：${input.reason}`,
    metadata: {
      kind: 'coordinator.runtime-blocked',
      sourceMessageId: input.sourceMessageId,
      runtimeType: input.runtimeType,
      reason: input.reason,
      noLegacyFallback: true,
    },
  })
}

async function appendCoordinatorObservingEvent(input: {
  roomId: string
  sourceMessageId: string
}) {
  const timeline = await roomService.listTimelineEvents({ roomId: input.roomId, limit: 200 })
  const existing = timeline.find(
    (event) =>
      event.metadata?.kind === 'coordinator.observing' &&
      event.metadata?.sourceMessageId === input.sourceMessageId,
  )
  if (existing) return existing
  const manager = await ensureManagerParticipant(input.roomId)
  return roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderParticipantId: manager.id,
    senderType: 'manager',
    type: 'manager.message',
    body: 'Manager 已收到，正在判断是直接回复、追问还是分派任务。',
    metadata: {
      kind: 'coordinator.observing',
      actionType: 'observe',
      phase: 'observing',
      sourceMessageId: input.sourceMessageId,
      coordinationSource: 'room-timeline',
    },
  })
}

export async function stepTaskRoomAfterHumanMessage(input: RecordHumanMessageInput): Promise<TaskRoomHumanReplyResult> {
  const room = await recordHumanMessageInRoomTimeline(input)
  return workerRuntimeService.resumeTaskRoomAfterHumanAnswer({
    roomId: room.id,
    ownerId: input.session.ownerId,
    sourceMessageId: input.message.id,
    answer: input.message.content,
    runtime: input.workerRuntime,
  })
}

async function appendManagerActionToRoomTimeline(input: {
  roomId: string
  action: ManagerAction
  runtimeType: string
  sourceMessageId: string
}) {
  const content = visibleManagerActionContent(input.action)
  if (input.action.type === 'propose_members') {
    return roomService.appendTimelineEvent({
      roomId: input.roomId,
      senderType: 'manager',
      type: 'approval.requested',
      body: content || '我建议补充一些更合适的成员，请确认。',
      metadata: {
        kind: 'coordinator.action',
        actionType: input.action.type,
        sourceMessageId: input.sourceMessageId,
        reason: input.action.reason ?? null,
        runtimeType: input.runtimeType,
        memberProposals: input.action.memberProposals ?? [],
        memberProposalStatus: 'pending',
        ...(input.action.metadata ?? {}),
      },
    })
  }
  if (!content) return null
  return roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderType: 'manager',
    type: 'manager.message',
    body: content,
    metadata: {
      kind: 'coordinator.action',
      actionType: input.action.type,
      sourceMessageId: input.sourceMessageId,
      reason: input.action.reason ?? null,
      runtimeType: input.runtimeType,
      ...(input.action.metadata ?? {}),
    },
  })
}

async function ensureSessionRoomParticipants(input: {
  roomId: string
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
}) {
  await ensureHumanParticipant(input.roomId, input.userId, input.userName)

  // Direct sessions only need the specific agent participant (no manager)
  if (input.session.type === 'direct') {
    if (input.session.workspaceAgentId) {
      await roomService.addWorkerParticipant(input.roomId, input.session.workspaceAgentId)
    }
    return
  }

  // Group sessions need manager + all workspace agents
  await ensureManagerParticipant(input.roomId)
  if (!input.session.workspaceId) return
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, input.session.workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  for (const agent of agents) {
    if (agent.roleType === 'orchestrator') continue
    await roomService.addWorkerParticipant(input.roomId, agent.id)
  }
}

async function ensureHumanParticipant(roomId: string, userId: string, userName?: string | null) {
  return roomService.addParticipant({
    roomId,
    participantType: 'human',
    userId,
    displayName: userName || 'You',
    role: 'owner',
  })
}

async function ensureManagerParticipant(roomId: string) {
  const participants = await db
    .select()
    .from(roomParticipants)
    .where(eq(roomParticipants.roomId, roomId))
  const existing = participants.find((participant) => participant.participantType === 'manager')
  if (existing) return existing
  return roomService.addParticipant({
    roomId,
    participantType: 'manager',
    displayName: 'Manager',
    role: 'manager',
  })
}

function visibleManagerActionContent(action: ManagerAction) {
  if (action.message?.trim()) return action.message.trim()
  if (action.type === 'wait') return null
  if (action.type === 'clarify') return '我需要再确认一些信息。'
  if (action.type === 'propose_members') return '我建议补充一些更合适的成员，请确认。'
  if (action.type === 'reply') return null
  return null
}
