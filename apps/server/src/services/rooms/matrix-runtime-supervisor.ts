import { and, db, eq, matrixIdentities, roomParticipants, rooms, workerInstances } from '@agenthub/db'
import { matrixRuntimeListener, type MatrixRuntimeListener } from './matrix-runtime-listener'
import type { ParticipantType } from './types'

export interface MatrixRuntimeSupervisorStartResult {
  started: boolean
  reason: string
  identityId?: string
  participantId?: string
}

/**
 * Owns Matrix sync-loop lifecycle for real AgentHub participants.
 *
 * HiClaw's important trick is not just creating Matrix rooms. Manager and
 * Workers are real Matrix users that keep listening to their rooms. This
 * supervisor makes that lifecycle explicit in AgentHub.
 */
export class MatrixRuntimeSupervisor {
  constructor(private readonly listener: MatrixRuntimeListener = matrixRuntimeListener) {}

  async startParticipantListener(
    participantId: string,
    input: { reason?: string; dispatch?: boolean } = {},
  ): Promise<MatrixRuntimeSupervisorStartResult> {
    const [participant] = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.id, participantId))
      .limit(1)
    if (!participant) {
      return { started: false, reason: 'participant_not_found', participantId }
    }
    if (!shouldListen(participant.participantType)) {
      return {
        started: false,
        reason: `participant_type_${participant.participantType}_does_not_run_backend_listener`,
        participantId,
      }
    }

    // Resident workers (OpenClaw/QwenPaw) run their own /sync; skip AgentHub-managed listener
    if (participant.participantType === 'worker' && participant.workerInstanceId) {
      const [worker] = await db
        .select()
        .from(workerInstances)
        .where(eq(workerInstances.id, participant.workerInstanceId))
        .limit(1)
      if (worker && (worker.runtimeBase === 'openclaw' || worker.runtimeBase === 'copaw' || worker.runtimeBase === 'qwenpaw')) {
        return {
          started: false,
          reason: `resident_worker_${worker.runtimeBase}_runs_own_sync`,
          participantId,
        }
      }
    }

    const [room] = await db.select().from(rooms).where(eq(rooms.id, participant.roomId)).limit(1)
    if (!room || room.provider !== 'matrix') {
      return { started: false, reason: 'room_is_not_matrix', participantId }
    }
    if (!participant.providerUserId) {
      return { started: false, reason: 'participant_has_no_matrix_user', participantId }
    }
    const [identity] = await db
      .select()
      .from(matrixIdentities)
      .where(eq(matrixIdentities.userId, participant.providerUserId))
      .limit(1)
    if (!identity?.accessToken) {
      return { started: false, reason: 'matrix_identity_missing_token', participantId }
    }

    this.listener.start({
      identityId: identity.id,
      dispatch: input.dispatch ?? true,
      pollIntervalMs: matrixListenerPollIntervalMs(),
      timeoutMs: matrixListenerLongPollTimeoutMs(),
    })
    await db
      .update(roomParticipants)
      .set({
        metadata: {
          ...(participant.metadata ?? {}),
          matrixListener: {
            running: true,
            identityId: identity.id,
            startedAt: new Date().toISOString(),
            reason: input.reason ?? 'participant-active',
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(roomParticipants.id, participant.id))
    return {
      started: true,
      reason: 'listener_running',
      identityId: identity.id,
      participantId,
    }
  }

  async startRoomListeners(
    roomId: string,
    input: { reason?: string; dispatch?: boolean } = {},
  ): Promise<MatrixRuntimeSupervisorStartResult[]> {
    const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))
    const results: MatrixRuntimeSupervisorStartResult[] = []
    for (const participant of participants) {
      results.push(await this.startParticipantListener(participant.id, input))
    }
    return results
  }

  async startWorkerInstanceListeners(
    workerInstanceId: string,
    input: { reason?: string; dispatch?: boolean } = {},
  ): Promise<MatrixRuntimeSupervisorStartResult[]> {
    const participants = await db
      .select()
      .from(roomParticipants)
      .where(
        and(
          eq(roomParticipants.participantType, 'worker'),
          eq(roomParticipants.workerInstanceId, workerInstanceId),
        ),
      )
    const results: MatrixRuntimeSupervisorStartResult[] = []
    for (const participant of participants) {
      results.push(await this.startParticipantListener(participant.id, input))
    }
    return results
  }

  async startActiveParticipantListeners(
    input: { reason?: string; dispatch?: boolean; limit?: number } = {},
  ): Promise<{
    startedCount: number
    skippedCount: number
    results: MatrixRuntimeSupervisorStartResult[]
  }> {
    const participants = await db
      .select({
        id: roomParticipants.id,
      })
      .from(roomParticipants)
      .innerJoin(rooms, eq(roomParticipants.roomId, rooms.id))
      .where(
        and(
          eq(rooms.provider, 'matrix'),
          eq(rooms.status, 'active'),
          eq(roomParticipants.status, 'joined'),
        ),
      )
      .limit(input.limit ?? 1000)
    const results: MatrixRuntimeSupervisorStartResult[] = []
    for (const participant of participants) {
      results.push(await this.startParticipantListener(participant.id, {
        reason: input.reason ?? 'server-startup-recovery',
        dispatch: input.dispatch,
      }))
    }
    return {
      startedCount: results.filter((result) => result.started).length,
      skippedCount: results.filter((result) => !result.started).length,
      results,
    }
  }

  async stopParticipantListener(participantId: string) {
    const [participant] = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.id, participantId))
      .limit(1)
    if (!participant?.providerUserId) return false
    const [identity] = await db
      .select()
      .from(matrixIdentities)
      .where(eq(matrixIdentities.userId, participant.providerUserId))
      .limit(1)
    if (!identity) return false
    this.listener.stop(identity.id)
    await db
      .update(roomParticipants)
      .set({
        metadata: {
          ...(participant.metadata ?? {}),
          matrixListener: {
            running: false,
            identityId: identity.id,
            stoppedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(roomParticipants.id, participant.id))
    return true
  }

  async stopWorkerInstanceListeners(workerInstanceId: string) {
    const participants = await db
      .select()
      .from(roomParticipants)
      .where(
        and(
          eq(roomParticipants.participantType, 'worker'),
          eq(roomParticipants.workerInstanceId, workerInstanceId),
        ),
      )
    let stoppedCount = 0
    for (const participant of participants) {
      if (await this.stopParticipantListener(participant.id)) stoppedCount += 1
    }
    return { stoppedCount }
  }
}

function shouldListen(participantType: ParticipantType) {
  return participantType === 'manager' || participantType === 'worker'
}

function matrixListenerPollIntervalMs() {
  const raw = Number(process.env.AGENTHUB_MATRIX_LISTENER_POLL_INTERVAL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 1000
}

function matrixListenerLongPollTimeoutMs() {
  const raw = Number(process.env.AGENTHUB_MATRIX_LISTENER_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 30000
}

export const matrixRuntimeSupervisor = new MatrixRuntimeSupervisor()
