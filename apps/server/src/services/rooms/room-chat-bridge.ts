import { asc, db, eq, messages, roomParticipants, sessions, timelineEvents, workspaceAgents } from '@agenthub/db'
import { WsEvent } from '@agenthub/shared'
import { broadcastSessionEvent } from '../agent-runner'
import { coordinatorService } from '../coordinator-runtime'
import { dispatchCoordinatorAssignBatch } from '../coordinator-runtime/assign-dispatcher'
import type { CoordinatorAction, CoordinatorActionType, CoordinatorRuntime } from '../coordinator-runtime'
import type { WorkerRuntime } from '../worker-runtime'
import { workerRuntimeService } from '../worker-runtime'
import { roomService } from './room-service'

const MESSAGE_ACTION_TYPES = new Set<CoordinatorActionType>([
  'reply',
  'clarify',
  'propose_members',
])

export interface RecordHumanMessageInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  message: typeof messages.$inferSelect
  runtime?: CoordinatorRuntime
  workerRuntime?: WorkerRuntime
  executeInline?: boolean
}

export interface AppendHumanMessageRoomFirstInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  content: string
  type: string
  metadata?: Record<string, unknown> | null
  replyToMessageId?: string | null
}

export interface CoordinatorFirstResult {
  roomId: string
  consumed: boolean
  reason: string
  actions: CoordinatorAction[]
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
  const projectionMessageId = `room:${event.id}`
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
  const [message] = await db
    .insert(messages)
    .values({
      id: projectionMessageId,
      sessionId: input.session.id,
      senderId: input.userId,
      senderType: 'user',
      type: input.type,
      content: input.content,
      metadata: messageMetadata,
      replyToMessageId: input.replyToMessageId ?? undefined,
    })
    .returning()
  if (!message) throw new Error('Room-first message projection create failed')

  await db
    .update(timelineEvents)
    .set({
      metadata: {
        ...(event.metadata ?? {}),
        messageId: message.id,
        projectionMessageId: message.id,
      },
    })
    .where(eq(timelineEvents.id, event.id))

  return { room, event, message }
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
  const hasEvent = existingEvents.some((event) => event.metadata?.messageId === input.message.id)
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

export async function stepCoordinatorForGroupMessage(input: RecordHumanMessageInput): Promise<CoordinatorFirstResult> {
  const room = await recordHumanMessageInRoomTimeline(input)
  await appendCoordinatorObservingEvent({
    roomId: room.id,
    sourceMessageId: input.message.id,
  })
  const result = await coordinatorService.stepRoom({
    roomId: room.id,
    ownerId: input.session.ownerId,
    appendActions: false,
    runtime: input.runtime,
  })
  if (result.actions.length === 0) {
    return {
      roomId: room.id,
      consumed: false,
      reason: 'Coordinator returned no actions; keeping legacy orchestrator fallback.',
      actions: [],
      mirroredMessageIds: [],
    }
  }
  const unsupportedAction = result.actions.find(
    (action) => !MESSAGE_ACTION_TYPES.has(action.type) && action.type !== 'assign',
  )
  if (unsupportedAction) {
    return {
      roomId: room.id,
      consumed: false,
      reason: `Coordinator returned unsupported action ${unsupportedAction.type}; keeping legacy orchestrator fallback.`,
      actions: result.actions,
      mirroredMessageIds: [],
    }
  }

  const mirroredMessageIds: string[] = []
  const assignActions = result.actions.filter((action) => action.type === 'assign')
  if (assignActions.length > 0) {
    try {
      await dispatchCoordinatorAssignBatch({
        groupSession: input.session,
        ownerId: input.session.ownerId,
        sourceMessage: input.message,
        actions: assignActions,
        runtimeType: result.runtimeType,
        workerRuntime: input.workerRuntime,
        executeInline: input.executeInline,
      })
    } catch (error: any) {
      return {
        roomId: room.id,
        consumed: false,
        reason: `Coordinator assign dispatch failed: ${error?.message || 'unknown error'}`,
        actions: result.actions,
        mirroredMessageIds: [],
      }
    }
  }

  for (const action of result.actions) {
    if (action.type === 'assign') continue
    await appendCoordinatorActionToRoomTimeline({
      roomId: room.id,
      action,
      runtimeType: result.runtimeType,
      sourceMessageId: input.message.id,
    })
    const message = await mirrorCoordinatorActionToMessage({
      sessionId: input.session.id,
      roomId: room.id,
      action,
      runtimeType: result.runtimeType,
      sourceMessageId: input.message.id,
    })
    if (message) mirroredMessageIds.push(message.id)
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
    executeInline: input.executeInline,
  })
}

async function appendCoordinatorActionToRoomTimeline(input: {
  roomId: string
  action: CoordinatorAction
  runtimeType: string
  sourceMessageId: string
}) {
  const content = visibleCoordinatorActionContent(input.action)
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

async function mirrorCoordinatorActionToMessage(input: {
  sessionId: string
  roomId: string
  action: CoordinatorAction
  runtimeType: string
  sourceMessageId: string
}) {
  const content = visibleCoordinatorActionContent(input.action)
  if (!content) return null
  const [message] = await db
    .insert(messages)
    .values({
      sessionId: input.sessionId,
      senderId: 'manager',
      senderType: 'agent',
      type: input.action.type === 'propose_members' ? 'task_card' : 'text',
      content,
      metadata: {
        kind: 'coordinator-runtime-message',
        systemEvent: 'coordinator_runtime_action',
        actionType: input.action.type,
        reason: input.action.reason ?? null,
        runtimeType: input.runtimeType,
        sourceMessageId: input.sourceMessageId,
        roomId: input.roomId,
        agentName: 'Manager',
        senderName: 'Manager',
        ...(input.action.type === 'propose_members'
          ? {
              memberProposals: input.action.memberProposals ?? [],
              memberProposalStatus: 'pending',
            }
          : {}),
        ...(input.action.metadata ?? {}),
      },
    })
    .returning()
  if (message) {
    broadcastSessionEvent(input.sessionId, {
      type: WsEvent.MessageCompleted,
      payload: { sessionId: input.sessionId, message },
    })
  }
  return message ?? null
}

function visibleCoordinatorActionContent(action: CoordinatorAction) {
  if (action.message?.trim()) return action.message.trim()
  if (action.type === 'wait') return null
  if (action.type === 'clarify') return '我需要再确认一些信息。'
  if (action.type === 'propose_members') return '我建议补充一些更合适的成员，请确认。'
  if (action.type === 'reply') return null
  return null
}
