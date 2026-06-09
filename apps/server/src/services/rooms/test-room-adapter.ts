import { randomUUID } from 'node:crypto'
import { gt } from 'drizzle-orm'
import { asc, db, desc, eq, and, roomParticipants, rooms, sql, timelineEvents } from '@agenthub/db'
import type {
  AddParticipantInput,
  AppendMentionTimelineEventInput,
  AppendTimelineEventInput,
  CreateRoomInput,
  EnsureRoomForSessionInput,
  EnsureRoomForTaskThreadInput,
  ListTimelineEventsInput,
  ParticipantType,
  RoomAdapter,
  RoomKind,
} from './types'

function providerRoomId() {
  return `!agenthub-test-${randomUUID()}:test.agenthub`
}

function providerEventId() {
  return `$agenthub-test-${randomUUID()}`
}

function roomKindForSession(input: EnsureRoomForSessionInput): RoomKind {
  if (input.metadata?.kind === 'agent-direct') return 'direct'
  return input.sessionType === 'group' ? 'group' : 'direct'
}

export class TestRoomAdapter implements RoomAdapter {
  async createRoom(input: CreateRoomInput) {
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: providerRoomId(),
        kind: input.kind,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId ?? null,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
        taskThreadId: input.taskThreadId ?? null,
        title: input.title,
        topic: input.topic ?? null,
        metadata: input.metadata ?? {},
      })
      .returning()
    if (!room) throw new Error('Room create failed')
    return room
  }

  async ensureRoomForSession(input: EnsureRoomForSessionInput) {
    const [existing] = await db.select().from(rooms).where(eq(rooms.sessionId, input.sessionId)).limit(1)
    if (existing) {
      const expectedKind = roomKindForSession(input)
      const expectedCompatibility = {
        source: 'session',
        sessionType: input.sessionType,
        workspaceAgentId: input.workspaceAgentId ?? null,
      }
      const existingCompatibility =
        existing.metadata?.compatibility && typeof existing.metadata.compatibility === 'object'
          ? (existing.metadata.compatibility as Record<string, unknown>)
          : {}
      const metadata = {
        ...(existing.metadata ?? {}),
        ...(input.metadata ?? {}),
        compatibility: {
          ...existingCompatibility,
          ...expectedCompatibility,
        },
      }
      const [updated] = await db
        .update(rooms)
        .set({
          kind: expectedKind,
          workspaceId: input.workspaceId ?? null,
          title: input.title || existing.title,
          metadata,
          updatedAt: new Date(),
        })
        .where(eq(rooms.id, existing.id))
        .returning()
      return updated ?? existing
    }
    const room = await this.createRoom({
      kind: roomKindForSession(input),
      ownerId: input.ownerId,
      title: input.title,
      workspaceId: input.workspaceId ?? null,
      sessionId: input.sessionId,
      metadata: {
        ...(input.metadata ?? {}),
        compatibility: {
          source: 'session',
          sessionType: input.sessionType,
          workspaceAgentId: input.workspaceAgentId ?? null,
        },
      },
    })
    await this.addParticipant({
      roomId: room.id,
      participantType: 'human',
      userId: input.ownerId,
      displayName: 'You',
      role: 'owner',
    })
    return room
  }

  async ensureRoomForTaskThread(input: EnsureRoomForTaskThreadInput) {
    const [existing] = await db.select().from(rooms).where(eq(rooms.taskThreadId, input.taskThreadId)).limit(1)
    if (existing) return existing
    const room = await this.createRoom({
      kind: 'task',
      ownerId: input.ownerId,
      title: input.title,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      taskThreadId: input.taskThreadId,
      metadata: {
        ...input.metadata,
        compatibility: {
          source: 'task_thread',
          groupSessionId: input.groupSessionId,
          workspaceAgentId: input.workspaceAgentId ?? null,
          workerInstanceId: input.workerInstanceId ?? null,
        },
      },
    })
    await this.addParticipant({
      roomId: room.id,
      participantType: 'human',
      userId: input.ownerId,
      displayName: 'You',
      role: 'owner',
    })
    await this.addParticipant({
      roomId: room.id,
      participantType: 'manager',
      displayName: 'Manager',
      role: 'manager',
    })
    if (input.workerInstanceId) {
      await this.addParticipant({
        roomId: room.id,
        participantType: 'worker',
        workspaceAgentId: input.workspaceAgentId ?? null,
        displayName: `Worker-${input.workerInstanceId.slice(0, 6)}`,
        role: 'member',
        workerInstanceId: input.workerInstanceId,
      })
    }
    return room
  }

  async addParticipant(input: AddParticipantInput) {
    const [existing] = await db
      .select()
      .from(roomParticipants)
      .where(
        and(
          eq(roomParticipants.roomId, input.roomId),
          input.userId
            ? eq(roomParticipants.userId, input.userId)
            : input.workspaceAgentId
              ? eq(roomParticipants.workspaceAgentId, input.workspaceAgentId)
              : input.workerInstanceId
                ? eq(roomParticipants.workerInstanceId, input.workerInstanceId)
                : eq(roomParticipants.displayName, input.displayName),
        ),
      )
      .limit(1)
    if (existing) {
      if (input.workerInstanceId && existing.workerInstanceId !== input.workerInstanceId) {
        const [updated] = await db
          .update(roomParticipants)
          .set({
            workerInstanceId: input.workerInstanceId,
            updatedAt: new Date(),
          })
          .where(eq(roomParticipants.id, existing.id))
          .returning()
        return updated ?? existing
      }
      return existing
    }
    const [participant] = await db
      .insert(roomParticipants)
      .values({
        roomId: input.roomId,
        providerUserId: input.providerUserId ?? localProviderUserId(input.participantType, input.displayName),
        participantType: input.participantType,
        userId: input.userId ?? null,
        workspaceAgentId: input.workspaceAgentId ?? null,
        workerInstanceId: input.workerInstanceId ?? null,
        displayName: input.displayName,
        role: input.role ?? defaultRole(input.participantType),
        metadata: input.metadata ?? {},
      })
      .returning()
    if (!participant) throw new Error('Room participant create failed')
    return participant
  }

  async appendTimelineEvent(input: AppendTimelineEventInput) {
    const resolvedProviderEventId = input.providerEventId ?? providerEventId()
    const [existing] = await db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.roomId, input.roomId), eq(timelineEvents.providerEventId, resolvedProviderEventId)))
      .limit(1)
    if (existing) return existing
    const sequenceRows = await db
      .select({ nextSequence: sql<number>`coalesce(max(${timelineEvents.sequence}), 0) + 1` })
      .from(timelineEvents)
      .where(eq(timelineEvents.roomId, input.roomId))
    const nextSequence = sequenceRows[0]?.nextSequence ?? 1
    const [event] = await db
      .insert(timelineEvents)
      .values({
        roomId: input.roomId,
        providerEventId: resolvedProviderEventId,
        senderParticipantId: input.senderParticipantId ?? null,
        senderType: input.senderType,
        type: input.type,
        body: input.body ?? '',
        metadata: input.metadata ?? {},
        sequence: nextSequence ?? 1,
      })
      .onConflictDoNothing({
        target: [timelineEvents.roomId, timelineEvents.providerEventId],
      })
      .returning()
    if (!event) {
      const [existingAfterConflict] = await db
        .select()
        .from(timelineEvents)
        .where(and(eq(timelineEvents.roomId, input.roomId), eq(timelineEvents.providerEventId, resolvedProviderEventId)))
        .limit(1)
      if (existingAfterConflict) return existingAfterConflict
      throw new Error('Timeline event create failed')
    }
    await db.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, input.roomId))
    return event
  }

  async appendMentionTimelineEvent(input: AppendMentionTimelineEventInput) {
    const [participant] = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.id, input.mentionParticipantId))
      .limit(1)
    return this.appendTimelineEvent({
      ...input,
      metadata: {
        ...(input.metadata ?? {}),
        matrix: {
          roomId: null,
          senderUserId: null,
          usedParticipantToken: false,
          mentions: participant?.providerUserId ? [participant.providerUserId] : [],
          mentionedParticipantIds: [input.mentionParticipantId],
          testOnly: true,
        },
        mentionParticipantId: input.mentionParticipantId,
      },
    })
  }

  async listTimelineEvents(input: ListTimelineEventsInput) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
    const condition =
      input.afterSequence && input.afterSequence > 0
        ? and(eq(timelineEvents.roomId, input.roomId), gt(timelineEvents.sequence, input.afterSequence))
        : eq(timelineEvents.roomId, input.roomId)
    return db
      .select()
      .from(timelineEvents)
      .where(condition)
      .orderBy(asc(timelineEvents.sequence))
      .limit(limit)
  }

  async listRoomsForOwner(ownerId: string, workspaceId?: string | null) {
    const condition = workspaceId
      ? and(eq(rooms.ownerId, ownerId), eq(rooms.workspaceId, workspaceId))
      : eq(rooms.ownerId, ownerId)
    return db.select().from(rooms).where(condition).orderBy(desc(rooms.updatedAt))
  }

  async getRoom(roomId: string) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1)
    return room ?? null
  }

  async listParticipants(roomId: string) {
    return db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))
  }
}

function defaultRole(type: ParticipantType) {
  if (type === 'human') return 'owner'
  if (type === 'manager') return 'manager'
  if (type === 'system') return 'system'
  return 'member'
}

function localProviderUserId(type: ParticipantType, displayName: string) {
  const normalizedName = displayName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return `@${type}-${normalizedName || 'participant'}:test.agenthub`
}
