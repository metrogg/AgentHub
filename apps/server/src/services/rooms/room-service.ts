import { db, eq, sessions, taskThreads, workspaceAgents, workspaces, workspaceTasks } from '@agenthub/db'
import { WsEvent } from '@agenthub/shared'
import { AppError, AppErrorCodes } from '../../lib/error'
import { broadcastSessionEvent } from '../agent-runner'
import { LocalMatrixCompatibleRoomAdapter } from './local-matrix-compatible-adapter'
import { MatrixRoomAdapter } from './matrix-room-adapter'
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
    return event
  }

  async appendMentionTimelineEvent(input: AppendMentionTimelineEventInput) {
    const event = this.adapter.appendMentionTimelineEvent
      ? await this.adapter.appendMentionTimelineEvent(input)
      : await this.adapter.appendTimelineEvent(input)
    await this.broadcastTimelineEvent(input.roomId, event).catch(() => {
      // Timeline persistence is the source of truth; realtime broadcast is best-effort.
    })
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
    return this.adapter.ensureRoomForSession({
      ownerId,
      sessionId: session.id,
      title: session.title,
      sessionType: session.type,
      workspaceId: session.workspaceId,
      workspaceAgentId: session.workspaceAgentId,
      metadata: session.metadata,
    })
  }

  async ensureRoomForTaskThread(input: EnsureRoomForTaskThreadInput) {
    const [thread] = await db.select().from(taskThreads).where(eq(taskThreads.id, input.taskThreadId)).limit(1)
    if (!thread) throw AppError.fromCode(AppErrorCodes.TASK_NOT_FOUND, '任务房间不存在')
    return this.adapter.ensureRoomForTaskThread(input)
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

  async addWorkerParticipant(roomId: string, workspaceAgentId: string) {
    const [agent] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, workspaceAgentId)).limit(1)
    if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')
    return this.addParticipant({
      roomId,
      participantType: 'worker',
      workspaceAgentId,
      displayName: agent.name,
      role: 'member',
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
}

export const roomService = new RoomService()

function createDefaultRoomAdapter(): RoomAdapter {
  const configured = process.env.AGENTHUB_ROOM_PROVIDER?.trim()
  if (configured === 'local-matrix-compatible') return new LocalMatrixCompatibleRoomAdapter()
  if (configured === 'matrix') return new MatrixRoomAdapter()
  if (process.env.NODE_ENV === 'test') return new LocalMatrixCompatibleRoomAdapter()
  return new MatrixRoomAdapter()
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
