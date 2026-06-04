import { db, eq, roomParticipants, rooms, taskThreads } from '@agenthub/db'
import { roomService } from './room-service'
import type { EnsureRoomForTaskThreadInput } from './types'

export interface RoomReconcileResult {
  roomId: string
  changed: boolean
  phase: 'session-room' | 'task-room' | 'participants'
}

/**
 * RoomController owns Room resource reconciliation for the HiClaw-lite kernel.
 *
 * RoomService remains the provider-facing adapter. New orchestration code should
 * call this controller when it needs a group room or task room to exist.
 */
export class RoomController {
  async reconcileSessionRoom(sessionId: string, ownerId: string): Promise<RoomReconcileResult> {
    const [before] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.sessionId, sessionId)).limit(1)
    const room = await roomService.ensureRoomForSession(sessionId, ownerId)
    return {
      roomId: room.id,
      changed: !before,
      phase: 'session-room',
    }
  }

  async ensureSessionRoom(sessionId: string, ownerId: string) {
    const result = await this.reconcileSessionRoom(sessionId, ownerId)
    const [room] = await db.select().from(rooms).where(eq(rooms.id, result.roomId)).limit(1)
    if (!room) throw new Error('Room disappeared after reconcile')
    return room
  }

  async reconcileTaskThreadRoom(
    taskThreadId: string,
    ownerId: string,
  ): Promise<RoomReconcileResult> {
    const [before] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.taskThreadId, taskThreadId))
      .limit(1)
    const input = await roomService.buildTaskThreadRoomInput(taskThreadId, ownerId)
    const room = await roomService.ensureRoomForTaskThread(input)
    await this.reconcileTaskRoomParticipants(room.id, input)
    await startMatrixRoomListeners(room.id, 'task-thread-room-reconciled')
    return {
      roomId: room.id,
      changed: !before,
      phase: 'task-room',
    }
  }

  async ensureTaskThreadRoom(taskThreadId: string, ownerId: string) {
    const result = await this.reconcileTaskThreadRoom(taskThreadId, ownerId)
    const [room] = await db.select().from(rooms).where(eq(rooms.id, result.roomId)).limit(1)
    if (!room) throw new Error('Task room disappeared after reconcile')
    return room
  }

  async ensureTaskThreadRoomFromInput(input: EnsureRoomForTaskThreadInput) {
    const room = await roomService.ensureRoomForTaskThread(input)
    await this.reconcileTaskRoomParticipants(room.id, input)
    await startMatrixRoomListeners(room.id, 'task-thread-room-reconciled')
    return room
  }

  async reconcileRunTaskRooms(
    runId: string,
    ownerId: string,
  ): Promise<RoomReconcileResult[]> {
    const threads = await db.select().from(taskThreads).where(eq(taskThreads.runId, runId))
    const results: RoomReconcileResult[] = []
    for (const thread of threads) {
      results.push(await this.reconcileTaskThreadRoom(thread.id, ownerId))
    }
    return results
  }

  private async reconcileTaskRoomParticipants(
    roomId: string,
    input: EnsureRoomForTaskThreadInput,
  ) {
    if (!input.workspaceAgentId) return
    const participants = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.roomId, roomId))
    const existingWorker = participants.find(
      (participant) =>
        participant.participantType === 'worker' &&
        participant.workspaceAgentId === input.workspaceAgentId,
    )
    if (existingWorker) {
      if (input.workerInstanceId && existingWorker.workerInstanceId !== input.workerInstanceId) {
        await db
          .update(roomParticipants)
          .set({
            workerInstanceId: input.workerInstanceId,
            updatedAt: new Date(),
          })
          .where(eq(roomParticipants.id, existingWorker.id))
      }
      return
    }
    await roomService.addWorkerParticipant(roomId, input.workspaceAgentId)
  }
}

export const roomController = new RoomController()

async function startMatrixRoomListeners(roomId: string, reason: string) {
  const { matrixRuntimeSupervisor } = await import('./matrix-runtime-supervisor')
  await matrixRuntimeSupervisor.startRoomListeners(roomId, { reason }).catch(() => {
    // Matrix listener startup is best-effort; the Room resource remains reconciled.
  })
}
