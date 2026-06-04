import { randomUUID } from 'node:crypto'
import { gt } from 'drizzle-orm'
import { and, asc, db, desc, eq, roomParticipants, rooms, sql, timelineEvents } from '@agenthub/db'
import type {
  AddParticipantInput,
  AppendTimelineEventInput,
  CreateRoomInput,
  EnsureRoomForSessionInput,
  EnsureRoomForTaskThreadInput,
  ListTimelineEventsInput,
  ParticipantType,
  RoomAdapter,
  RoomKind,
} from './types'

interface MatrixClientOptions {
  homeserverUrl: string
  accessToken: string
  serverName: string
  autoInviteParticipants: boolean
  autoJoinParticipants: boolean
  registrationToken?: string
}

class MatrixClient {
  constructor(private readonly options: MatrixClientOptions) {}

  shouldAutoInviteParticipants() {
    return this.options.autoInviteParticipants
  }

  shouldAutoJoinParticipants() {
    return this.options.autoJoinParticipants
  }

  async createRoom(input: { name: string; topic?: string | null; invite?: string[] }) {
    return this.request<{ room_id: string }>('/_matrix/client/v3/createRoom', {
      method: 'POST',
      body: {
        name: input.name,
        topic: input.topic ?? undefined,
        preset: 'private_chat',
        invite: input.invite?.length ? input.invite : undefined,
        visibility: 'private',
      },
    })
  }

  async inviteUser(roomId: string, userId: string) {
    return this.request<Record<string, never>>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      {
        method: 'POST',
        body: { user_id: userId },
      },
    )
  }

  async joinRoom(roomId: string) {
    return this.request<{ room_id: string }>(
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      {
        method: 'POST',
        body: {},
      },
    )
  }

  async sendTextMessage(roomId: string, body: string, metadata: Record<string, unknown>) {
    const txId = `agenthub-${randomUUID()}`
    return this.request<{ event_id: string }>(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txId)}`,
      {
        method: 'PUT',
        body: {
          msgtype: 'm.text',
          body,
          'org.agenthub.metadata': metadata,
        },
      },
    )
  }

  matrixUserId(input: { type: ParticipantType; id?: string | null; displayName: string }) {
    const localpart = matrixLocalpart(input.id ?? input.displayName)
    if (input.type === 'human') return `@human-${localpart}:${this.options.serverName}`
    if (input.type === 'manager') return `@manager-${localpart}:${this.options.serverName}`
    if (input.type === 'system') return `@system-${localpart}:${this.options.serverName}`
    return `@worker-${localpart}:${this.options.serverName}`
  }

  private async request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${this.options.homeserverUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Matrix API ${init.method} ${path} failed: ${response.status} ${text.slice(0, 500)}`)
    }
    return response.json() as Promise<T>
  }
}

export class MatrixRoomAdapter implements RoomAdapter {
  private readonly options: Partial<MatrixClientOptions>
  private clientInstance: MatrixClient | null = null

  constructor(options: Partial<MatrixClientOptions> = {}) {
    this.options = options
  }

  private client() {
    if (this.clientInstance) return this.clientInstance
    const homeserverUrl = this.options.homeserverUrl ?? process.env.AGENTHUB_MATRIX_HOMESERVER_URL
    const accessToken = this.options.accessToken ?? process.env.AGENTHUB_MATRIX_ACCESS_TOKEN
    const serverName = this.options.serverName ?? process.env.AGENTHUB_MATRIX_SERVER_NAME ?? 'agenthub.local'
    if (!homeserverUrl || !accessToken) {
      throw new Error(
        'Matrix room provider requires AGENTHUB_MATRIX_HOMESERVER_URL and AGENTHUB_MATRIX_ACCESS_TOKEN. ' +
          'Start Tuwunel/Synapse and configure a real Matrix access token, or set AGENTHUB_ROOM_PROVIDER=local-matrix-compatible only for local tests.',
      )
    }
    this.clientInstance = new MatrixClient({
      homeserverUrl,
      accessToken,
      serverName,
      autoInviteParticipants:
        this.options.autoInviteParticipants ?? matrixBool('AGENTHUB_MATRIX_AUTO_INVITE_PARTICIPANTS', true),
      autoJoinParticipants:
        this.options.autoJoinParticipants ?? matrixBool('AGENTHUB_MATRIX_AUTO_JOIN_PARTICIPANTS', false),
      registrationToken:
        this.options.registrationToken ?? (process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN?.trim() || undefined),
    })
    return this.clientInstance
  }

  async createRoom(input: CreateRoomInput) {
    const matrixRoom = await this.client().createRoom({
      name: input.title,
      topic: input.topic ?? null,
    })
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: matrixRoom.room_id,
        kind: input.kind,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId ?? null,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
        taskThreadId: input.taskThreadId ?? null,
        title: input.title,
        topic: input.topic ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          matrix: {
            homeserverUrl: process.env.AGENTHUB_MATRIX_HOMESERVER_URL ?? null,
          },
        },
      })
      .returning()
    if (!room) throw new Error('Matrix room create failed')
    return room
  }

  async ensureRoomForSession(input: EnsureRoomForSessionInput) {
    const [existing] = await db.select().from(rooms).where(eq(rooms.sessionId, input.sessionId)).limit(1)
    if (existing) return existing
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
          .set({ workerInstanceId: input.workerInstanceId, updatedAt: new Date() })
          .where(eq(roomParticipants.id, existing.id))
          .returning()
        return updated ?? existing
      }
      return existing
    }
    const providerUserId =
      input.providerUserId ??
      this.client().matrixUserId({
        type: input.participantType,
        id: input.userId ?? input.workspaceAgentId ?? input.workerInstanceId ?? null,
        displayName: input.displayName,
      })
    const [participant] = await db
      .insert(roomParticipants)
      .values({
        roomId: input.roomId,
        providerUserId,
        participantType: input.participantType,
        userId: input.userId ?? null,
        workspaceAgentId: input.workspaceAgentId ?? null,
        workerInstanceId: input.workerInstanceId ?? null,
        displayName: input.displayName,
        role: input.role ?? defaultRole(input.participantType),
        metadata: input.metadata ?? {},
    })
      .returning()
    if (!participant) throw new Error('Matrix room participant create failed')
    await this.reconcileMatrixMembership(input.roomId, providerUserId, input.metadata ?? {})
    const [updated] = await db.select().from(roomParticipants).where(eq(roomParticipants.id, participant.id)).limit(1)
    return updated ?? participant
  }

  private async reconcileMatrixMembership(
    roomId: string,
    providerUserId: string,
    participantMetadata: Record<string, unknown>,
  ) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1)
    if (!room?.providerRoomId) return
    const client = this.client()
    const membership: Record<string, unknown> = {
      provider: 'matrix',
      providerRoomId: room.providerRoomId,
      providerUserId,
      invited: false,
      joinedByAppToken: false,
      note:
        'AgentHub stores Matrix identity mapping here. Per-participant access tokens are a follow-up MatrixIdentity/TokenVault concern.',
    }
    if (client.shouldAutoInviteParticipants()) {
      try {
        await client.inviteUser(room.providerRoomId, providerUserId)
        membership.invited = true
      } catch (error) {
        membership.inviteError = (error as Error).message
      }
    }
    if (client.shouldAutoJoinParticipants()) {
      try {
        await client.joinRoom(room.providerRoomId)
        membership.joinedByAppToken = true
      } catch (error) {
        membership.joinError = (error as Error).message
      }
    }
    await db
      .update(roomParticipants)
      .set({
        metadata: {
          ...participantMetadata,
          matrixMembership: membership,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.providerUserId, providerUserId)))
  }

  async appendTimelineEvent(input: AppendTimelineEventInput) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
    if (!room) throw new Error(`Room not found: ${input.roomId}`)
    const matrixEvent = await this.client().sendTextMessage(room.providerRoomId, input.body ?? '', {
      senderType: input.senderType,
      eventType: input.type,
      ...(input.metadata ?? {}),
    })
    const sequenceRows = await db
      .select({ nextSequence: sql<number>`coalesce(max(${timelineEvents.sequence}), 0) + 1` })
      .from(timelineEvents)
      .where(eq(timelineEvents.roomId, input.roomId))
    const nextSequence = sequenceRows[0]?.nextSequence ?? 1
    const [event] = await db
      .insert(timelineEvents)
      .values({
        roomId: input.roomId,
        providerEventId: input.providerEventId ?? matrixEvent.event_id,
        senderParticipantId: input.senderParticipantId ?? null,
        senderType: input.senderType,
        type: input.type,
        body: input.body ?? '',
        metadata: {
          ...(input.metadata ?? {}),
          matrix: {
            eventId: matrixEvent.event_id,
            roomId: room.providerRoomId,
          },
        },
        sequence: nextSequence ?? 1,
      })
      .returning()
    if (!event) throw new Error('Matrix timeline event create failed')
    await db.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, input.roomId))
    return event
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

function roomKindForSession(input: EnsureRoomForSessionInput): RoomKind {
  if (input.metadata?.kind === 'agent-direct') return 'direct'
  return input.sessionType === 'group' ? 'group' : 'direct'
}

function defaultRole(type: ParticipantType) {
  if (type === 'human') return 'owner'
  if (type === 'manager') return 'manager'
  if (type === 'system') return 'system'
  return 'member'
}

function matrixLocalpart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/:.+$/, '')
    .replace(/[^a-z0-9._=-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'participant'
}

function matrixBool(name: string, defaultValue: boolean) {
  const value = process.env[name]?.trim().toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  return defaultValue
}
