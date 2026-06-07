import { and, db, eq, roomParticipants, rooms, sessions, taskThreads, workerInstances, workspaceAgents, workspaces, workspaceTasks } from '@agenthub/db'
import { WsEvent } from '@agenthub/shared'
import { AppError, AppErrorCodes } from '../../lib/error'
import { broadcastSessionEvent } from '../agent-runner'
import { MatrixRoomAdapter } from './matrix-room-adapter'
import { TestRoomAdapter } from './test-room-adapter'
import type {
  AddParticipantInput,
  AppendMentionTimelineEventInput,
  AppendTimelineEventInput,
  CreateRoomInput,
  EnsureRoomForTaskThreadInput,
  ListTimelineEventsInput,
  RoomAdapter,
} from './types'

export class RoomService {
  constructor(private readonly adapter: RoomAdapter = createDefaultRoomAdapter()) {}

  createRoom(input: CreateRoomInput) {
    return this.adapter.createRoom(input)
  }

  async addParticipant(input: AddParticipantInput) {
    const participant = await this.adapter.addParticipant(input)
    const { matrixRuntimeSupervisor } = await import('./matrix-runtime-supervisor')
    await matrixRuntimeSupervisor.startParticipantListener(participant.id, {
      reason: 'room-participant-reconciled',
    }).catch(() => {
      // Matrix listener startup is supervised separately; room membership remains the source of truth.
    })
    return participant
  }

  async appendTimelineEvent(input: AppendTimelineEventInput) {
    const event = await this.adapter.appendTimelineEvent(input)
    await this.broadcastTimelineEvent(input.roomId, event).catch(() => {
      // Timeline persistence is the source of truth; realtime broadcast is best-effort.
    })
    if (!shouldSkipAutoDispatch(event.metadata)) {
      this.schedulePlatformTimelineDispatch(event.id)
    }
    return event
  }

  async appendMentionTimelineEvent(input: AppendMentionTimelineEventInput) {
    const event = this.adapter.appendMentionTimelineEvent
      ? await this.adapter.appendMentionTimelineEvent(input)
      : await this.adapter.appendTimelineEvent(input)
    await this.broadcastTimelineEvent(input.roomId, event).catch(() => {
      // Timeline persistence is the source of truth; realtime broadcast is best-effort.
    })
    if (!shouldSkipAutoDispatch(event.metadata)) {
      this.schedulePlatformTimelineDispatch(event.id)
    }
    return event
  }

  async importTimelineEvent(input: AppendTimelineEventInput & { providerEventId: string }) {
    const event = this.adapter.importTimelineEvent
      ? await this.adapter.importTimelineEvent(input)
      : await this.adapter.appendTimelineEvent(input)
    await this.broadcastTimelineEvent(input.roomId, event).catch(() => {
      // Timeline persistence is the source of truth; realtime broadcast is best-effort.
    })
    return event
  }

  listTimelineEvents(input: ListTimelineEventsInput) {
    return this.adapter.listTimelineEvents(input)
  }

  listRooms(ownerId: string, workspaceId?: string | null) {
    return this.adapter.listRoomsForOwner(ownerId, workspaceId)
  }

  async getRoomForOwner(roomId: string, ownerId: string) {
    const room = await this.adapter.getRoom(roomId)
    if (!room || room.ownerId !== ownerId) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, 'Room 不存在')
    }
    return room
  }

  async listRoomParticipants(roomId: string, ownerId: string) {
    await this.getRoomForOwner(roomId, ownerId)
    return this.adapter.listParticipants(roomId)
  }

  async ensureRoomForSession(sessionId: string, ownerId: string) {
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== ownerId) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    }
    const room = await this.adapter.ensureRoomForSession({
      ownerId,
      sessionId: session.id,
      title: session.title,
      sessionType: session.type,
      workspaceId: session.workspaceId,
      workspaceAgentId: session.workspaceAgentId,
      metadata: session.metadata,
    })
    await this.startRoomRuntimeListeners(room.id, 'room-session-reconciled').catch(() => {
      // Listener startup is supervised separately; room creation must remain available.
    })
    return room
  }

  async ensureRoomForTaskThread(input: EnsureRoomForTaskThreadInput) {
    const [thread] = await db.select().from(taskThreads).where(eq(taskThreads.id, input.taskThreadId)).limit(1)
    if (!thread) throw AppError.fromCode(AppErrorCodes.TASK_NOT_FOUND, '任务房间不存在')
    const room = await this.adapter.ensureRoomForTaskThread(input)
    await this.startRoomRuntimeListeners(room.id, 'task-room-reconciled').catch(() => {
      // Listener startup is supervised separately; task room creation must remain available.
    })
    return room
  }

  async buildTaskThreadRoomInput(taskThreadId: string, ownerId: string): Promise<EnsureRoomForTaskThreadInput> {
    const [thread] = await db.select().from(taskThreads).where(eq(taskThreads.id, taskThreadId)).limit(1)
    if (!thread) throw AppError.fromCode(AppErrorCodes.TASK_NOT_FOUND, '任务子对话不存在')
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, thread.workspaceId)).limit(1)
    if (!workspace || workspace.ownerId !== ownerId) {
      throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
    }
    const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, thread.taskId)).limit(1)
    const title = task?.title ? `任务：${task.title}` : '任务子对话'
    return {
      ownerId,
      workspaceId: thread.workspaceId,
      groupSessionId: thread.groupSessionId,
      sessionId: thread.sessionId,
      runId: thread.runId,
      taskId: thread.taskId,
      taskThreadId: thread.id,
      title,
      workspaceAgentId: thread.workspaceAgentId,
      workerInstanceId: thread.workerInstanceId,
      metadata: {
        status: thread.status,
      },
    }
  }

  async addWorkerParticipant(roomId: string, workspaceAgentId: string, workerInstanceId?: string | null) {
    const [agent] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, workspaceAgentId)).limit(1)
    if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')
    const resolvedWorkerInstanceId =
      workerInstanceId ??
      await db
        .select({ id: workerInstances.id })
        .from(workerInstances)
        .where(eq(workerInstances.workspaceAgentId, workspaceAgentId))
        .limit(1)
        .then((rows) => rows[0]?.id ?? null)
    const participant = await this.addParticipant({
      roomId,
      participantType: 'worker',
      workspaceAgentId,
      workerInstanceId: resolvedWorkerInstanceId,
      displayName: agent.name,
      role: 'member',
    })
    return participant
  }

  private async startRoomRuntimeListeners(roomId: string, reason: string) {
    const { matrixRuntimeSupervisor } = await import('./matrix-runtime-supervisor')
    await matrixRuntimeSupervisor.startRoomListeners(roomId, { reason })
  }

  private async dispatchPlatformTimelineEvent(eventId: string) {
    const { matrixRoomEventDispatcher } = await import('./matrix-event-dispatcher')
    await matrixRoomEventDispatcher.dispatchTimelineEvent(eventId)
  }

  private schedulePlatformTimelineDispatch(eventId: string) {
    void this.dispatchPlatformTimelineEvent(eventId).catch(() => {
      // Matrix /sync remains the source of truth for resident runtimes; platform dispatch is a local safety net.
    })
  }

  async announceWorkerPresenceInJoinedRooms(
    workerInstanceId: string,
    input: { mode: 'intro' | 'ready' | 'listening'; sourceEventId?: string | null } = { mode: 'intro' },
  ) {
    const participantRows = await db
      .select({
        participant: roomParticipants,
        room: rooms,
        agent: workspaceAgents,
      })
      .from(roomParticipants)
      .innerJoin(rooms, eq(roomParticipants.roomId, rooms.id))
      .innerJoin(workspaceAgents, eq(roomParticipants.workspaceAgentId, workspaceAgents.id))
      .where(
        and(
          eq(roomParticipants.participantType, 'worker'),
          eq(roomParticipants.workerInstanceId, workerInstanceId),
          eq(roomParticipants.status, 'joined'),
        ),
      )

    const announcements: Array<{ roomId: string; eventId: string | null }> = []
    for (const row of participantRows) {
      if (row.room.kind !== 'group' && row.room.kind !== 'manager_dm') continue
      const eventId = await this.appendWorkerPresenceAnnouncement(row, {
        mode: input.mode,
        sourceEventId: input.sourceEventId ?? null,
      })
      if (eventId) {
        announcements.push({ roomId: row.room.id, eventId })
      }
    }
    return announcements
  }

  async appendWorkerSelfIntroduction(
    roomId: string,
    workerParticipantId: string,
    input: { sourceEventId?: string | null } = {},
  ) {
    const [row] = await db
      .select({
        participant: roomParticipants,
        room: rooms,
        agent: workspaceAgents,
      })
      .from(roomParticipants)
      .innerJoin(rooms, eq(roomParticipants.roomId, rooms.id))
      .innerJoin(workspaceAgents, eq(roomParticipants.workspaceAgentId, workspaceAgents.id))
      .where(and(eq(roomParticipants.id, workerParticipantId), eq(roomParticipants.roomId, roomId)))
      .limit(1)
    if (!row || (row.room.kind !== 'group' && row.room.kind !== 'manager_dm')) return null
    return this.appendWorkerPresenceAnnouncement(row, {
      mode: 'intro',
      sourceEventId: input.sourceEventId ?? null,
    })
  }

  private async broadcastTimelineEvent(roomId: string, event: Awaited<ReturnType<RoomAdapter['appendTimelineEvent']>>) {
    const room = await this.adapter.getRoom(roomId)
    if (!room) return
    const participants = await this.adapter.listParticipants(roomId)
    const targetSessionIds = timelineBroadcastSessionIds(room)
    if (!targetSessionIds.length) return
    for (const sessionId of targetSessionIds) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.RoomTimelineEvent,
        payload: {
          sessionId,
          room,
          event,
          participants,
        },
      })
    }
  }

  private async appendWorkerPresenceAnnouncement(
    row: {
      participant: typeof roomParticipants.$inferSelect
      room: typeof rooms.$inferSelect
      agent: typeof workspaceAgents.$inferSelect
    },
    input: { mode: 'intro' | 'ready' | 'listening'; sourceEventId?: string | null },
  ) {
    const metadata = (row.participant.metadata ?? {}) as Record<string, unknown>
    const announcementKey =
      input.mode === 'ready'
        ? 'workerReadyAnnouncedAt'
        : input.mode === 'listening'
          ? 'workerListeningAnnouncedAt'
          : 'workerIntroAnnouncedAt'
    const announcedAt = typeof metadata[announcementKey] === 'string' ? metadata[announcementKey] : null
    if (announcedAt) return null

    const body =
      input.mode === 'ready'
        ? `${row.agent.name} 已在线。`
        : input.mode === 'listening'
          ? `${row.agent.name} 已进入监听状态。`
          : `${row.agent.name} 已加入房间。`

    const event = await this.appendTimelineEvent({
      roomId: row.room.id,
      senderParticipantId: null,
      senderType: 'system',
      type: 'system',
      body,
      metadata: {
        kind: `worker-runtime.${input.mode}-announcement`,
        workspaceAgentId: row.agent.id,
        workerInstanceId: row.participant.workerInstanceId ?? null,
        sourceEventId: input.sourceEventId ?? null,
        hiddenFromChat: true,
        uiPresentation: 'presence',
      },
    })

    await db
      .update(roomParticipants)
      .set({
        metadata: {
          ...metadata,
          [announcementKey]: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(roomParticipants.id, row.participant.id))

    return event.id
  }
}

export const roomService = new RoomService()

function createDefaultRoomAdapter(): RoomAdapter {
  const configured = process.env.AGENTHUB_ROOM_PROVIDER?.trim()
  if (process.env.AGENTHUB_TEST_ROOM_ADAPTER === '1') {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('AGENTHUB_TEST_ROOM_ADAPTER is test-only and cannot be used outside NODE_ENV=test.')
    }
    return new TestRoomAdapter()
  }
  if (configured === 'local-matrix-compatible') {
    throw new Error(
      'AGENTHUB_ROOM_PROVIDER=local-matrix-compatible has been removed. Start a real Matrix homeserver such as Tuwunel and use AGENTHUB_ROOM_PROVIDER=matrix.',
    )
  }
  if (configured === 'matrix') return new MatrixRoomAdapter()
  if (process.env.NODE_ENV === 'test') return new TestRoomAdapter()
  return new MatrixRoomAdapter()
}

function shouldSkipAutoDispatch(metadata: Record<string, unknown> | null | undefined) {
  return metadata?.skipAutoDispatch === true
}

function timelineBroadcastSessionIds(room: Awaited<ReturnType<RoomAdapter['getRoom']>>) {
  if (!room) return []
  const ids = new Set<string>()
  if (room.sessionId) ids.add(room.sessionId)
  const compatibility = room.metadata?.compatibility
  if (compatibility && typeof compatibility === 'object' && !Array.isArray(compatibility)) {
    const groupSessionId = (compatibility as Record<string, unknown>).groupSessionId
    if (typeof groupSessionId === 'string' && groupSessionId.trim()) {
      ids.add(groupSessionId)
    }
  }
  return Array.from(ids)
}
