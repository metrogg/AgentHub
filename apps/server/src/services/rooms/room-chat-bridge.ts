import { and, asc, db, eq, roomParticipants, sessions, workspaceAgents } from '@agenthub/db'
import type { MessageRow } from '../agent-runner'
import type { ManagerRuntime } from '../manager-runtime'
import type { WorkerRuntime } from '../worker-runtime'
import { roomService } from './room-service'

export interface AppendHumanMessageRoomFirstInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  content: string
  type: string
  metadata?: Record<string, unknown> | null
  replyToMessageId?: string | null
  /** Skip auto-dispatch. Used by tests that need to control dispatch timing. */
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

export async function appendHumanMessageRoomFirst(input: AppendHumanMessageRoomFirstInput) {
  const room = await roomService.ensureRoomForSession(input.session.id, input.session.ownerId)
  await ensureSessionRoomParticipants({
    roomId: room.id,
    session: input.session,
    userId: input.userId,
    userName: input.userName,
  })
  const human = await ensureHumanParticipant(room.id, input.userId, input.userName)

  let matrixMentions: string[] | undefined
  const mentionAgentIds = input.metadata?.mentions
  if (Array.isArray(mentionAgentIds) && mentionAgentIds.length > 0) {
    const participants = await db
      .select()
      .from(roomParticipants)
      .where(and(eq(roomParticipants.roomId, room.id), eq(roomParticipants.participantType, 'worker')))
    const participantIdByAgentId = new Map(
      participants.filter((p) => p.workspaceAgentId).map((p) => [p.workspaceAgentId!, p.id]),
    )
    matrixMentions = mentionAgentIds
      .map((id) => participantIdByAgentId.get(id as string))
      .filter((id): id is string => Boolean(id))
  }

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
      ...(input.skipDispatch ? { skipAutoDispatch: true } : {}),
      ...(matrixMentions?.length ? { matrix: { mentionedParticipantIds: matrixMentions } } : {}),
    },
  })
  const message: MessageRow = {
    id: `room:${event.id}`,
    sessionId: input.session.id,
    senderId: input.userId,
    senderType: 'user',
    type: input.type,
    content: input.content,
    metadata: {
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
    },
    isPinned: false,
    replyToMessageId: input.replyToMessageId ?? null,
    createdAt: event.createdAt,
  }

  // HiClaw model: dispatch is now handled automatically by roomService.appendTimelineEvent().
  // No explicit dispatch call needed here.

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

export interface RecordHumanMessageInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  message: MessageRow
  runtime?: ManagerRuntime
  workerRuntime?: WorkerRuntime
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

function projectedEventIdFromMessage(message: MessageRow) {
  if (!message.id.startsWith('room:')) return null
  const eventId = message.id.slice('room:'.length).trim()
  return eventId || null
}

async function ensureSessionRoomParticipants(input: {
  roomId: string
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
}) {
  await ensureHumanParticipant(input.roomId, input.userId, input.userName)

  if (input.session.type === 'direct') {
    if (input.session.workspaceAgentId) {
      await roomService.addWorkerParticipant(input.roomId, input.session.workspaceAgentId)
    }
    return
  }

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
  const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))
  const existing = participants.find((participant) => participant.participantType === 'manager')
  if (existing) return existing
  return roomService.addParticipant({
    roomId,
    participantType: 'manager',
    displayName: 'Manager',
    role: 'manager',
  })
}
