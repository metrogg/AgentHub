import { gt } from 'drizzle-orm'
import { and, asc, db, desc, eq, matrixIdentities, roomParticipants, rooms, sql, timelineEvents, workspaceAgents } from '@agenthub/db'
import { MatrixApiError, MatrixClient, matrixBool, matrixLocalpart } from './matrix-client'
import { MatrixIdentityService, identityOwnerFromParticipant } from './matrix-identity-service'
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

interface MatrixRoomAdapterOptions {
  homeserverUrl?: string
  accessToken?: string
  serverName?: string
  autoInviteParticipants?: boolean
  autoJoinParticipants?: boolean
  registrationToken?: string
}

export class MatrixRoomAdapter implements RoomAdapter {
  private readonly options: MatrixRoomAdapterOptions
  private clientInstance: MatrixClient | null = null
  private identityServiceInstance: MatrixIdentityService | null = null
  private clientSignature: string | null = null

  constructor(options: MatrixRoomAdapterOptions = {}) {
    this.options = options
  }

  async createRoom(input: CreateRoomInput) {
    const client = this.client()
    const aliasName = roomAliasName(input)
    const alias = aliasName ? `#${aliasName}:${client.serverName}` : null
    let providerRoomId: string | null = null
    let resolvedByAlias = false

    if (alias) {
      try {
        const resolved = await client.resolveRoomAlias(alias)
        providerRoomId = resolved.room_id
        resolvedByAlias = true
      } catch {
        providerRoomId = null
      }
    }

    if (!providerRoomId) {
      const matrixRoom = await client.createRoom({
        name: input.title,
        topic: input.topic ?? null,
        aliasName,
      })
      providerRoomId = matrixRoom.room_id
    }

    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId,
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
            homeserverUrl: client.homeserverUrl,
            alias,
            resolvedByAlias,
          },
        },
      })
      .returning()
    if (!room) throw new Error('Matrix room create failed')
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
    if (input.sessionType === 'group') {
      const managerAgent = input.workspaceId ? await resolveWorkspaceManagerAgent(input.workspaceId) : null
      await this.addParticipant({
        roomId: room.id,
        participantType: 'manager',
        workspaceAgentId: managerAgent?.id ?? null,
        displayName: managerAgent?.name ?? 'Manager',
        role: 'manager',
        metadata: managerAgent ? managerParticipantMetadata(managerAgent) : { identityKind: 'generic-manager' },
      })
    }
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
    const managerAgent = await resolveWorkspaceManagerAgent(input.workspaceId)
    await this.addParticipant({
      roomId: room.id,
      participantType: 'manager',
      workspaceAgentId: managerAgent?.id ?? null,
      displayName: managerAgent?.name ?? 'Manager',
      role: 'manager',
      metadata: managerAgent ? managerParticipantMetadata(managerAgent) : { identityKind: 'generic-manager' },
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
    const identity = await this.identityService().ensureIdentity(identityOwnerFromParticipant(input))
    const providerUserId = input.providerUserId ?? identity.userId
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
                : eq(roomParticipants.providerUserId, providerUserId),
        ),
      )
      .limit(1)

    if (existing) {
      const [updated] = await db
        .update(roomParticipants)
        .set({
          providerUserId,
          workerInstanceId: input.workerInstanceId ?? existing.workerInstanceId,
          displayName: input.displayName || existing.displayName,
          updatedAt: new Date(),
        })
        .where(eq(roomParticipants.id, existing.id))
        .returning()
      await this.reconcileMatrixMembership(updated ?? existing, input.metadata ?? {})
      const [reloaded] = await db.select().from(roomParticipants).where(eq(roomParticipants.id, existing.id)).limit(1)
      return reloaded ?? updated ?? existing
    }

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
    await this.reconcileMatrixMembership(participant, input.metadata ?? {})
    const [updated] = await db.select().from(roomParticipants).where(eq(roomParticipants.id, participant.id)).limit(1)
    return updated ?? participant
  }

  async appendTimelineEvent(input: AppendTimelineEventInput) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
    if (!room) throw new Error(`Room not found: ${input.roomId}`)
    const senderIdentity = input.senderParticipantId
      ? await this.getIdentityForSenderParticipant(input.senderParticipantId)
      : null
    if (senderIdentity?.accessToken) {
      await this.ensureSenderJoined(room.providerRoomId, input.senderParticipantId!, senderIdentity.accessToken)
    }
    const messageMetadata = {
      senderType: input.senderType,
      eventType: input.type,
      senderParticipantId: input.senderParticipantId ?? null,
      sentAsMatrixUserId: senderIdentity?.userId ?? null,
      ...(input.metadata ?? {}),
    }
    const sendMessage = () =>
      this.client().sendTextMessage(
        room.providerRoomId,
        input.body ?? '',
        messageMetadata,
        { accessToken: senderIdentity?.accessToken ?? null },
      )
    const matrixEvent = await this.sendWithMembershipRetry({
      providerRoomId: room.providerRoomId,
      participantId: input.senderParticipantId ?? null,
      accessToken: senderIdentity?.accessToken ?? null,
      send: sendMessage,
    })
    return this.insertLocalTimelineEvent({
      ...input,
      providerEventId: input.providerEventId ?? matrixEvent.event_id,
      metadata: {
        ...(input.metadata ?? {}),
        matrix: {
          ...readMatrixMetadata(input.metadata),
          eventId: matrixEvent.event_id,
          roomId: room.providerRoomId,
          senderUserId: senderIdentity?.userId ?? null,
          usedParticipantToken: Boolean(senderIdentity?.accessToken),
        },
      },
    })
  }

  async appendMentionTimelineEvent(input: AppendTimelineEventInput & { mentionParticipantId: string }) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
    if (!room) throw new Error(`Room not found: ${input.roomId}`)
    const senderIdentity = input.senderParticipantId
      ? await this.getIdentityForSenderParticipant(input.senderParticipantId)
      : null
    const mentionParticipant = await this.getParticipant(input.mentionParticipantId)
    if (!mentionParticipant?.providerUserId) {
      throw new Error(`Matrix mention target participant is not bound to a Matrix user: ${input.mentionParticipantId}`)
    }
    const mentionUserId = mentionParticipant.providerUserId
    if (senderIdentity?.accessToken) {
      await this.ensureSenderJoined(room.providerRoomId, input.senderParticipantId!, senderIdentity.accessToken)
    }
    const sendMention = () =>
      this.client().sendMentionMessage(
        room.providerRoomId,
        {
          body: input.body ?? '',
          mentionUserId,
          mentionDisplayName: mentionParticipant.displayName,
          metadata: {
            senderType: input.senderType,
            eventType: input.type,
            senderParticipantId: input.senderParticipantId ?? null,
            mentionParticipantId: input.mentionParticipantId,
            mentionUserId,
            ...(input.metadata ?? {}),
          },
        },
        { accessToken: senderIdentity?.accessToken ?? null },
      )
    const matrixEvent = await this.sendWithMembershipRetry({
      providerRoomId: room.providerRoomId,
      participantId: input.senderParticipantId ?? null,
      accessToken: senderIdentity?.accessToken ?? null,
      send: sendMention,
    })
    return this.insertLocalTimelineEvent({
      ...input,
      providerEventId: input.providerEventId ?? matrixEvent.event_id,
      metadata: {
        ...(input.metadata ?? {}),
        matrix: {
          eventId: matrixEvent.event_id,
          roomId: room.providerRoomId,
          senderUserId: senderIdentity?.userId ?? null,
          usedParticipantToken: Boolean(senderIdentity?.accessToken),
          mentions: [mentionParticipant.providerUserId],
          mentionedParticipantIds: [input.mentionParticipantId],
        },
      },
    })
  }

  async importTimelineEvent(input: AppendTimelineEventInput & { providerEventId: string }) {
    return this.insertLocalTimelineEvent(input)
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

  private async insertLocalTimelineEvent(input: AppendTimelineEventInput & { providerEventId: string }) {
    const [existing] = await db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.roomId, input.roomId), eq(timelineEvents.providerEventId, input.providerEventId)))
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
        providerEventId: input.providerEventId,
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
        .where(and(eq(timelineEvents.roomId, input.roomId), eq(timelineEvents.providerEventId, input.providerEventId)))
        .limit(1)
      if (existingAfterConflict) return existingAfterConflict
      throw new Error('Matrix timeline event create failed')
    }
    await db.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, input.roomId))
    return event
  }

  private async reconcileMatrixMembership(
    participant: typeof roomParticipants.$inferSelect,
    participantMetadata: Record<string, unknown>,
  ) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, participant.roomId)).limit(1)
    if (!room?.providerRoomId || !participant.providerUserId) return
    const identity = await this.getIdentityByUserId(participant.providerUserId)
    const client = this.client()
    const membership: Record<string, unknown> = {
      provider: 'matrix',
      providerRoomId: room.providerRoomId,
      providerUserId: participant.providerUserId,
      identityId: identity?.id ?? null,
      invited: false,
      joined: false,
      joinedWithParticipantToken: false,
    }
    if (client.shouldAutoInviteParticipants()) {
      try {
        await client.inviteUser(room.providerRoomId, participant.providerUserId)
        membership.invited = true
      } catch (error) {
        membership.inviteError = (error as Error).message
        const fallbackInvite = await this.inviteUserFromJoinedParticipant({
          roomId: room.id,
          providerRoomId: room.providerRoomId,
          targetUserId: participant.providerUserId,
        })
        if (fallbackInvite.invited) {
          membership.invited = true
          membership.invitedWithParticipantToken = true
        } else if (fallbackInvite.error) {
          membership.fallbackInviteError = fallbackInvite.error
        }
      }
    }
    if (client.shouldAutoJoinParticipants() && identity?.accessToken) {
      try {
        await client.joinRoom(room.providerRoomId, identity.accessToken)
        membership.joined = true
        membership.joinedWithParticipantToken = true
      } catch (error) {
        membership.joinError = (error as Error).message
      }
    }
    await db
      .update(roomParticipants)
      .set({
        status: membership.joined ? 'joined' : membership.invited ? 'invited' : 'left',
        metadata: {
          ...(participant.metadata ?? {}),
          ...participantMetadata,
          matrixMembership: membership,
        },
        updatedAt: new Date(),
      })
      .where(eq(roomParticipants.id, participant.id))
  }

  private async sendWithMembershipRetry<T>(input: {
    providerRoomId: string
    participantId: string | null
    accessToken: string | null
    send: () => Promise<T>
  }) {
    try {
      return await input.send()
    } catch (error) {
      if (!isSenderMembershipLeaveError(error) || !input.participantId || !input.accessToken) {
        throw error
      }
      await this.ensureSenderJoined(input.providerRoomId, input.participantId, input.accessToken, {
        forceInvite: true,
      })
      return input.send()
    }
  }

  private async ensureSenderJoined(
    providerRoomId: string,
    participantId: string,
    accessToken: string,
    options: { forceInvite?: boolean } = {},
  ) {
    const [participant] = await db.select().from(roomParticipants).where(eq(roomParticipants.id, participantId)).limit(1)
    if (!participant) return
    const client = this.client()
    const membership: Record<string, unknown> = {
      ...(participant.metadata?.matrixMembership && typeof participant.metadata.matrixMembership === 'object'
        ? (participant.metadata.matrixMembership as Record<string, unknown>)
        : {}),
      provider: 'matrix',
      providerRoomId,
      providerUserId: participant.providerUserId ?? null,
      senderJoinCheckedAt: new Date().toISOString(),
    }
    try {
      await client.joinRoom(providerRoomId, accessToken)
      await db
        .update(roomParticipants)
        .set({
          status: 'joined',
          metadata: {
            ...(participant.metadata ?? {}),
            matrixMembership: {
              ...membership,
              joined: true,
              joinedWithParticipantToken: true,
              senderJoinError: null,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(roomParticipants.id, participantId))
      return
    } catch (firstError) {
      if (options.forceInvite && participant.providerUserId) {
        try {
          await client.inviteUser(providerRoomId, participant.providerUserId)
        } catch (inviteError) {
          const fallbackInvite = await this.inviteUserFromJoinedParticipant({
            roomId: participant.roomId,
            providerRoomId,
            targetUserId: participant.providerUserId,
          })
          if (!fallbackInvite.invited) {
            membership.inviteError = (inviteError as Error).message
            if (fallbackInvite.error) membership.fallbackInviteError = fallbackInvite.error
          }
        }
        try {
          await client.joinRoom(providerRoomId, accessToken)
          await db
            .update(roomParticipants)
            .set({
              status: 'joined',
              metadata: {
                ...(participant.metadata ?? {}),
                matrixMembership: {
                  ...membership,
                  invitedForSenderJoin: true,
                  joined: true,
                  joinedWithParticipantToken: true,
                  senderJoinError: null,
                },
              },
              updatedAt: new Date(),
            })
            .where(eq(roomParticipants.id, participantId))
          return
        } catch (secondError) {
          await db
            .update(roomParticipants)
            .set({
              status: 'left',
              metadata: {
                ...(participant.metadata ?? {}),
                matrixMembership: {
                  ...membership,
                  joined: false,
                  senderJoinError: (secondError as Error).message,
                },
              },
              updatedAt: new Date(),
            })
            .where(eq(roomParticipants.id, participantId))
          return
        }
      }
      await db
        .update(roomParticipants)
        .set({
          status: 'left',
          metadata: {
            ...(participant.metadata ?? {}),
            matrixMembership: {
              ...membership,
              joined: false,
              senderJoinError: (firstError as Error).message,
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(roomParticipants.id, participantId))
      // best-effort: if join fails, the send attempt will surface the real error
    }
  }

  private async inviteUserFromJoinedParticipant(input: {
    roomId: string
    providerRoomId: string
    targetUserId: string
  }) {
    const participants = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.roomId, input.roomId))
    let lastError: string | null = null
    for (const participant of participants) {
      if (!participant.providerUserId || participant.providerUserId === input.targetUserId) continue
      if (!matrixMembershipJoined(participant.metadata)) continue
      const identity = await this.getIdentityByUserId(participant.providerUserId)
      if (!identity?.accessToken) continue
      try {
        await this.client().inviteUser(input.providerRoomId, input.targetUserId, {
          accessToken: identity.accessToken,
        })
        return { invited: true, error: null }
      } catch (error) {
        lastError = (error as Error).message
      }
    }
    return { invited: false, error: lastError }
  }

  private async getIdentityForSenderParticipant(participantId: string) {
    const [row] = await db.select().from(roomParticipants).where(eq(roomParticipants.id, participantId)).limit(1)
    if (!row?.providerUserId) return null
    return this.getIdentityByUserId(row.providerUserId)
  }

  private async getParticipant(participantId: string) {
    const [participant] = await db.select().from(roomParticipants).where(eq(roomParticipants.id, participantId)).limit(1)
    return participant ?? null
  }

  private async getIdentityByUserId(userId: string) {
    const [identity] = await db.select().from(matrixIdentities).where(eq(matrixIdentities.userId, userId)).limit(1)
    return identity ?? null
  }

  private client() {
    const homeserverUrl = this.options.homeserverUrl ?? process.env.AGENTHUB_MATRIX_HOMESERVER_URL
    const accessToken = this.options.accessToken ?? process.env.AGENTHUB_MATRIX_ACCESS_TOKEN
    const serverName = this.options.serverName ?? process.env.AGENTHUB_MATRIX_SERVER_NAME ?? 'agenthub.local'
    if (!homeserverUrl) {
      throw new Error(
        'Matrix room provider requires AGENTHUB_MATRIX_HOMESERVER_URL. ' +
          'Start Tuwunel/Synapse/Conduit and keep AGENTHUB_ROOM_PROVIDER=matrix.',
      )
    }
    const signature = [
      homeserverUrl,
      accessToken ?? '',
      serverName,
      process.env.AGENTHUB_MATRIX_ADMIN_ROOM_ALIAS ?? '',
      String(this.options.autoInviteParticipants ?? matrixBool('AGENTHUB_MATRIX_AUTO_INVITE_PARTICIPANTS', true)),
      String(this.options.autoJoinParticipants ?? matrixBool('AGENTHUB_MATRIX_AUTO_JOIN_PARTICIPANTS', true)),
      this.options.registrationToken ?? process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN?.trim() ?? '',
    ].join('|')
    if (this.clientInstance && this.clientSignature === signature) return this.clientInstance
    this.clientSignature = signature
    this.identityServiceInstance = null
    this.clientInstance = new MatrixClient({
      homeserverUrl,
      adminAccessToken: accessToken,
      adminRoomAlias: process.env.AGENTHUB_MATRIX_ADMIN_ROOM_ALIAS,
      serverName,
      autoInviteParticipants:
        this.options.autoInviteParticipants ?? matrixBool('AGENTHUB_MATRIX_AUTO_INVITE_PARTICIPANTS', true),
      autoJoinParticipants:
        this.options.autoJoinParticipants ?? matrixBool('AGENTHUB_MATRIX_AUTO_JOIN_PARTICIPANTS', true),
      registrationToken:
        this.options.registrationToken ?? (process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN?.trim() || undefined),
    })
    return this.clientInstance
  }

  private identityService() {
    if (this.identityServiceInstance) return this.identityServiceInstance
    this.identityServiceInstance = new MatrixIdentityService(this.client())
    return this.identityServiceInstance
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

function roomAliasName(input: CreateRoomInput) {
  if (input.taskThreadId) return `agenthub-task-${matrixLocalpart(input.taskThreadId)}`
  if (input.sessionId) return `agenthub-session-${matrixLocalpart(input.sessionId)}`
  if (input.runId) return `agenthub-run-${matrixLocalpart(input.runId)}`
  return null
}

function readMatrixMetadata(metadata: Record<string, unknown> | null | undefined) {
  const matrix = metadata?.matrix
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return {}
  return matrix as Record<string, unknown>
}

function matrixMembershipJoined(metadata: Record<string, unknown> | null | undefined) {
  const membership = metadata?.matrixMembership
  if (!membership || typeof membership !== 'object' || Array.isArray(membership)) return false
  return (membership as Record<string, unknown>).joined === true
}

function isSenderMembershipLeaveError(error: unknown) {
  if (!(error instanceof MatrixApiError)) return false
  return (
    error.status === 403 &&
    /sender'?s membership|membership `?leave`?|is not `?join`?|M_FORBIDDEN/i.test(error.responseBody)
  )
}

async function resolveWorkspaceManagerAgent(workspaceId: string) {
  const [agent] = await db
    .select()
    .from(workspaceAgents)
    .where(and(eq(workspaceAgents.workspaceId, workspaceId), eq(workspaceAgents.roleType, 'orchestrator')))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
    .limit(1)
  return agent ?? null
}

function managerParticipantMetadata(agent: typeof workspaceAgents.$inferSelect) {
  return {
    identityKind: 'workspace-orchestrator-manager',
    managerAgentId: agent.id,
    roleType: agent.roleType,
    managerDisplayRole: agent.role,
    color: agent.color,
    avatar: agent.avatar,
  }
}
