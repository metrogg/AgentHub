import {
  and,
  db,
  eq,
  matrixIdentities,
  roomParticipants,
  rooms,
  runtimeLeases,
  taskThreads,
  timelineEvents,
  workerInstances,
  workspaceTasks,
} from '@agenthub/db'
import { managerRuntimeService, getActiveManagerProvider } from '../manager-runtime'
import { registerTaskArtifact, toCanonicalArtifactRecord } from '../orchestrator/artifact-store'
import { runController } from '../orchestrator/run-controller'
import { runtimeLeaseController } from '../orchestrator/runtime-lease-controller'
import { markWorkerInstanceState } from '../orchestrator/worker-runtime-resources'
import { workerRuntimeService } from '../worker-runtime/worker-runtime-service'
import { createMatrixClientFromEnv } from './matrix-client'
import { roomService } from './room-service'

export interface MatrixRoomEventDispatcherInput {
  eventIds: string[]
}

export interface MatrixRoomEventDispatcherResult {
  dispatchedEventIds: string[]
  ignoredEventIds: string[]
}

export interface MatrixRoomEventDispatcherHandlers {
  runWorkerTaskRoom(input: {
    roomId: string
    ownerId: string
    workspaceAgentId: string
    source: string
  }): Promise<unknown>
  stepManagerRoom(input: {
    roomId: string
    ownerId: string
    afterSequence: number
    source: string
  }): Promise<unknown>
  cancelTaskRoom?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    reason: string
  }): Promise<unknown>
  recordApprovalControl?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    command: 'approve' | 'deny'
    body: string
  }): Promise<unknown>
  resumeTaskRoomAfterApproval?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    answer: string
    runAfterResume?: boolean
  }): Promise<{ consumed: boolean; appendedEventIds: string[] } | unknown>
  resumeTaskRoomAfterHumanAnswer?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    answer: string
    runAfterResume?: boolean
  }): Promise<{ consumed: boolean; appendedEventIds: string[] } | unknown>
  denyTaskRoomClarification?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    reason: string
  }): Promise<{ consumed: boolean; appendedEventIds: string[] } | unknown>
  registerFileArtifact?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
  }): Promise<unknown>
}

export class MatrixRoomEventDispatcher {
  private readonly handlers: MatrixRoomEventDispatcherHandlers

  constructor(handlers: Partial<MatrixRoomEventDispatcherHandlers> = {}) {
    this.handlers = {
      runWorkerTaskRoom: (input) => workerRuntimeService.runTaskRoom(input),
      stepManagerRoom: async (input) => {
        // If a resident Manager (OpenClaw/QwenPaw) is running, skip the local step call.
        // The resident process observes the room via Matrix /sync autonomously.
        const provider = getActiveManagerProvider()
        if (provider && (provider.runtimeType === 'openclaw' || provider.runtimeType === 'qwenpaw')) {
          const status = await provider.status()
          if (status.running || status.endpoint) {
            return { consumed: true, skipped: true, reason: 'resident-manager-active' }
          }
        }
        return managerRuntimeService.stepRoom({
          roomId: input.roomId,
          ownerId: input.ownerId,
          afterSequence: input.afterSequence,
          source: input.source,
        })
      },
      cancelTaskRoom: (input) => cancelTaskRoomFromMatrix(input),
      recordApprovalControl: (input) => recordApprovalControlFromMatrix(input),
      resumeTaskRoomAfterHumanAnswer: (input) =>
        workerRuntimeService.resumeTaskRoomAfterHumanAnswer({
          roomId: input.roomId,
          ownerId: input.ownerId,
          sourceEventId: input.sourceEventId,
          answer: input.answer,
          runAfterResume: input.runAfterResume,
        }),
      denyTaskRoomClarification: (input) =>
        workerRuntimeService.denyTaskRoomClarification({
          roomId: input.roomId,
          ownerId: input.ownerId,
          sourceEventId: input.sourceEventId,
          reason: input.reason,
        }),
      registerFileArtifact: (input) => registerMatrixFileArtifact(input),
      ...handlers,
    }
    this.handlers.resumeTaskRoomAfterApproval ??= this.handlers.resumeTaskRoomAfterHumanAnswer
  }

  async dispatchImportedEvents(input: MatrixRoomEventDispatcherInput): Promise<MatrixRoomEventDispatcherResult> {
    const dispatchedEventIds: string[] = []
    const ignoredEventIds: string[] = []
    for (const eventId of input.eventIds) {
      const dispatched = await this.dispatchImportedEvent(eventId)
      if (dispatched) dispatchedEventIds.push(eventId)
      else ignoredEventIds.push(eventId)
    }
    return { dispatchedEventIds, ignoredEventIds }
  }

  private async dispatchImportedEvent(eventId: string) {
    const [event] = await db.select().from(timelineEvents).where(eq(timelineEvents.id, eventId)).limit(1)
    if (!event) return false
    if (event.metadata?.kind !== 'matrix.sync.imported') return false
    const [room] = await db.select().from(rooms).where(eq(rooms.id, event.roomId)).limit(1)
    if (!room) return false

    if (event.type === 'file.shared') {
      await this.handlers.registerFileArtifact?.({
        roomId: room.id,
        ownerId: room.ownerId,
        sourceEventId: event.id,
      })
      return true
    }

    const command = parseMatrixControlCommand(event.body)
    if (command?.type === 'stop' && room.kind === 'task') {
      await this.handlers.cancelTaskRoom?.({
        roomId: room.id,
        ownerId: room.ownerId,
        sourceEventId: event.id,
        reason: command.reason || 'matrix_room_stop',
      })
      return true
    }
    if (command?.type === 'approve' || command?.type === 'deny') {
      if (command.type === 'approve' && room.kind === 'task') {
        const resumeResult = await this.handlers.resumeTaskRoomAfterApproval?.({
          roomId: room.id,
          ownerId: room.ownerId,
          sourceEventId: event.id,
          answer: command.reason || '批准继续。',
        })
        if (isConsumedResult(resumeResult)) return true
      }
      if (command.type === 'deny' && room.kind === 'task') {
        const denyResult = await this.handlers.denyTaskRoomClarification?.({
          roomId: room.id,
          ownerId: room.ownerId,
          sourceEventId: event.id,
          reason: command.reason || '用户拒绝当前澄清请求。',
        })
        if (isConsumedResult(denyResult)) return true
      }
      await this.handlers.recordApprovalControl?.({
        roomId: room.id,
        ownerId: room.ownerId,
        sourceEventId: event.id,
        command: command.type,
        body: event.body,
      })
      if (room.kind === 'group' || room.kind === 'manager_dm') {
        await this.handlers.stepManagerRoom({
          roomId: room.id,
          ownerId: room.ownerId,
          afterSequence: Math.max(0, event.sequence - 1),
          source: `matrix-human-${command.type}`,
        })
      }
      return true
    }

    if (event.senderType === 'human' && room.kind === 'task') {
      const resumeResult = await this.handlers.resumeTaskRoomAfterHumanAnswer?.({
        roomId: room.id,
        ownerId: room.ownerId,
        sourceEventId: event.id,
        answer: event.body,
      })
      if (isConsumedResult(resumeResult)) return true
    }

    const mentionedParticipantIds = matrixMentionedParticipantIds(event.metadata)
    for (const participantId of mentionedParticipantIds) {
      const [participant] = await db
        .select()
        .from(roomParticipants)
        .where(eq(roomParticipants.id, participantId))
        .limit(1)
      if (!participant) continue
      if (participant.participantType === 'worker' && room.kind === 'task' && participant.workspaceAgentId) {
        const canClaim = await canWorkerClaimTask(participant.workerInstanceId)
        if (!canClaim) {
          await roomService.appendTimelineEvent({
            roomId: room.id,
            senderParticipantId: participant.id,
            senderType: 'worker',
            type: 'task.progress',
            body: '当前正忙，无法接单。',
            metadata: {
              kind: 'worker-runtime.busy',
              workspaceAgentId: participant.workspaceAgentId,
              workerInstanceId: participant.workerInstanceId,
            },
          })
          return true
        }

        // Worker claims the task: write "已接单" and update state
        await roomService.appendTimelineEvent({
          roomId: room.id,
          senderParticipantId: participant.id,
          senderType: 'worker',
          type: 'task.progress',
          body: '已接单，准备执行任务。',
          metadata: {
            kind: 'worker-runtime.claimed',
            workspaceAgentId: participant.workspaceAgentId,
            workerInstanceId: participant.workerInstanceId,
            sourceEventId: event.id,
          },
        })
        if (participant.workerInstanceId) {
          await markWorkerInstanceState(participant.workerInstanceId, 'assigned', {
            message: 'Worker claimed task from Matrix mention.',
            health: {
              claimedRoomId: room.id,
              claimedAt: new Date().toISOString(),
              sourceEventId: event.id,
            },
          })
        }

        // Async dispatch to WorkerRuntimeService
        void this.handlers.runWorkerTaskRoom({
          roomId: room.id,
          ownerId: room.ownerId,
          workspaceAgentId: participant.workspaceAgentId,
          source: 'matrix-mention',
        })
        return true
      }
      if (participant.participantType === 'manager' && (room.kind === 'group' || room.kind === 'manager_dm')) {
        await this.handlers.stepManagerRoom({
          roomId: room.id,
          ownerId: room.ownerId,
          afterSequence: Math.max(0, event.sequence - 1),
          source: 'matrix-manager-mention',
        })
        return true
      }
    }

    if (event.senderType === 'human' && room.kind === 'group') {
      await this.handlers.stepManagerRoom({
        roomId: room.id,
        ownerId: room.ownerId,
        afterSequence: Math.max(0, event.sequence - 1),
        source: 'matrix-human-room-message',
      })
      return true
    }

    return false
  }
}

function parseMatrixControlCommand(body: string | null | undefined) {
  const trimmed = body?.trim() ?? ''
  const match = trimmed.match(/^\/([a-zA-Z-]+)(?:\s+([\s\S]*))?$/)
  if (!match?.[1]) return null
  const command = match[1].toLowerCase()
  const rest = match[2]?.trim() ?? ''
  if (command === 'stop' || command === 'cancel') return { type: 'stop' as const, reason: rest }
  if (command === 'approve' || command === 'ok' || command === 'yes') return { type: 'approve' as const, reason: rest }
  if (command === 'deny' || command === 'reject' || command === 'no') return { type: 'deny' as const, reason: rest }
  return null
}

function isConsumedResult(result: unknown): result is { consumed: boolean } {
  return Boolean(result && typeof result === 'object' && 'consumed' in result && (result as any).consumed === true)
}

async function cancelTaskRoomFromMatrix(input: {
  roomId: string
  ownerId: string
  sourceEventId: string
  reason: string
}) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
  if (!room || room.ownerId !== input.ownerId || room.kind !== 'task') return null
  if (!room.runId || !room.workspaceId || !room.taskId) {
    return roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'system',
      type: 'system',
      body: '收到 /stop，但这个任务房间缺少 run/task 绑定，无法取消执行。',
      metadata: {
        kind: 'matrix.control.stop.failed',
        sourceEventId: input.sourceEventId,
        reason: 'room_missing_run_task_binding',
      },
    })
  }
  const [thread] = room.taskThreadId
    ? await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId)).limit(1)
    : await db
        .select()
        .from(taskThreads)
        .where(and(eq(taskThreads.runId, room.runId), eq(taskThreads.taskId, room.taskId)))
        .limit(1)
  const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, room.taskId)).limit(1)
  const [lease] = thread?.workerInstanceId
    ? await db
        .select()
        .from(runtimeLeases)
        .where(and(eq(runtimeLeases.workerInstanceId, thread.workerInstanceId), eq(runtimeLeases.taskId, room.taskId)))
        .limit(1)
    : await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId)).limit(1)
  const run = {
    runId: room.runId,
    workspaceId: room.workspaceId,
    groupSessionId: thread?.groupSessionId ?? room.sessionId ?? room.id,
  }

  const stopped = await workerRuntimeService.stopTaskRoom(room.id)
  if (stopped) {
    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'system',
      type: 'task.progress',
      body: '已终止正在运行的 Worker 进程。',
      metadata: {
        kind: 'matrix.control.stop.process-terminated',
        sourceEventId: input.sourceEventId,
      },
    })
  }

  await runController.markTaskCancelled(run, {
    taskId: room.taskId,
    title: task?.title ?? room.title,
    agentId: task?.agentId ?? thread?.workspaceAgentId ?? null,
    reason: input.reason || 'matrix_room_stop',
    progressStatus: 'cancelled-by-matrix-stop',
    childSessionId: thread?.sessionId ?? room.sessionId ?? null,
    taskThreadId: thread?.id ?? room.taskThreadId ?? null,
    workerInstanceId: thread?.workerInstanceId ?? null,
    runtimeLeaseId: lease?.id ?? null,
    extraPayload: {
      source: 'matrix-room-control',
      sourceEventId: input.sourceEventId,
    },
  })
  await runtimeLeaseController.release(lease?.id, {
    workerInstanceId: thread?.workerInstanceId ?? null,
    metadata: {
      resultStatus: 'cancelled',
      source: 'matrix-room-control',
      sourceEventId: input.sourceEventId,
    },
  })
  return roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'system',
    type: 'task.progress',
    body: '已收到 /stop，当前任务已取消。',
    metadata: {
      kind: 'matrix.control.stop.applied',
      status: 'cancelled',
      sourceEventId: input.sourceEventId,
      runId: room.runId,
      taskId: room.taskId,
      taskThreadId: thread?.id ?? room.taskThreadId ?? null,
      runtimeLeaseId: lease?.id ?? null,
    },
  })
}

async function recordApprovalControlFromMatrix(input: {
  roomId: string
  ownerId: string
  sourceEventId: string
  command: 'approve' | 'deny'
  body: string
}) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
  if (!room || room.ownerId !== input.ownerId) return null
  return roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'system',
    type: 'system',
    body: input.command === 'approve' ? '已记录人工确认。' : '已记录人工拒绝。',
    metadata: {
      kind: 'matrix.control.approval',
      command: input.command,
      sourceEventId: input.sourceEventId,
      body: input.body,
      roomKind: room.kind,
    },
  })
}

async function registerMatrixFileArtifact(input: {
  roomId: string
  ownerId: string
  sourceEventId: string
}) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
  if (!room || room.ownerId !== input.ownerId) return null
  if (!room.workspaceId || !room.runId || !room.taskId) return null
  const [event] = await db.select().from(timelineEvents).where(eq(timelineEvents.id, input.sourceEventId)).limit(1)
  const file = matrixFileRef(event?.metadata)
  if (!file) return null
  const [thread] = room.taskThreadId
    ? await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId)).limit(1)
    : []
  const materialized = await materializeMatrixFileArtifact({
    roomId: room.id,
    sourceEventId: input.sourceEventId,
    file,
    senderParticipantId: event?.senderParticipantId ?? null,
  })
  const artifact = await registerTaskArtifact({
    workspaceId: room.workspaceId,
    runId: room.runId,
    taskId: room.taskId,
    roomId: room.id,
    taskThreadId: thread?.id ?? room.taskThreadId ?? null,
    workspaceAgentId: thread?.workspaceAgentId ?? null,
    workerInstanceId: thread?.workerInstanceId ?? null,
    artifact: {
      kind: 'file',
      title: file.name ?? 'Matrix shared file',
      path: file.name ?? `matrix-file-${input.sourceEventId}.json`,
      mimeType: materialized.mimeType ?? file.info?.mimetype,
      size: materialized.size ?? file.info?.size,
      bytes: materialized.bytes,
      content: materialized.content,
      matrixFile: file,
      sourceEventId: input.sourceEventId,
      matrixDownload: materialized.metadata,
    },
    status: materialized.status,
  })
  if (!artifact) return null
  return roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'system',
    type: 'artifact.created',
    body: materialized.status === 'registered'
      ? `已从 Matrix 下载并登记共享文件：${artifact.title}`
      : `已登记 Matrix 文件引用，但下载原始文件失败：${artifact.title}`,
    metadata: {
      kind: 'matrix.file.artifact-registered',
      sourceEventId: input.sourceEventId,
      artifactId: artifact.id,
      artifact: toCanonicalArtifactRecord(artifact),
      matrixDownload: materialized.metadata,
    },
  })
}

async function materializeMatrixFileArtifact(input: {
  roomId: string
  sourceEventId: string
  file: MatrixFileRef
  senderParticipantId?: string | null
}): Promise<{
  status: 'registered' | 'partial'
  bytes?: Uint8Array
  content?: string
  mimeType?: string | null
  size?: number | null
  metadata: Record<string, unknown>
}> {
  if (!input.file.url?.startsWith('mxc://')) {
    return descriptorMatrixFileArtifact(input.file, input.sourceEventId, {
      reason: 'not_mxc_uri',
    })
  }

  try {
    const client = createMatrixClientFromEnv()
    const accessToken = await resolveMatrixMediaAccessToken(input.roomId, input.senderParticipantId)
    const downloaded = await client.downloadMedia(
      {
        mxcUrl: input.file.url,
        fileName: input.file.name,
      },
      { accessToken },
    )
    return {
      status: 'registered',
      bytes: downloaded.bytes,
      mimeType: downloaded.contentType ?? input.file.info?.mimetype ?? null,
      size: downloaded.bytes.byteLength,
      metadata: {
        source: 'matrix-media-download',
        downloaded: true,
        endpoint: downloaded.endpoint,
        contentType: downloaded.contentType,
        contentDisposition: downloaded.contentDisposition,
        fileName: downloaded.fileName ?? input.file.name ?? null,
        usedParticipantToken: Boolean(accessToken),
      },
    }
  } catch (error) {
    return descriptorMatrixFileArtifact(input.file, input.sourceEventId, {
      reason: 'download_failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function descriptorMatrixFileArtifact(
  file: MatrixFileRef,
  sourceEventId: string,
  extra: Record<string, unknown>,
) {
  return {
    status: 'partial' as const,
    content: JSON.stringify({
      source: 'matrix-file-ref',
      matrix: file,
      sourceEventId,
      ...extra,
    }, null, 2),
    mimeType: 'application/json',
    size: undefined,
    metadata: {
      source: 'matrix-file-ref',
      downloaded: false,
      ...extra,
    },
  }
}

async function resolveMatrixMediaAccessToken(roomId: string, preferredParticipantId?: string | null) {
  const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))
  const preferred = preferredParticipantId
    ? participants.find((participant) => participant.id === preferredParticipantId)
    : null
  for (const participant of [preferred, ...participants]) {
    const userId = participant?.providerUserId
    if (!userId) continue
    const [identity] = await db
      .select()
      .from(matrixIdentities)
      .where(eq(matrixIdentities.userId, userId))
      .limit(1)
    if (identity?.accessToken) return identity.accessToken
  }
  return null
}

type MatrixFileRef = NonNullable<ReturnType<typeof matrixFileRef>>

function matrixFileRef(metadata: Record<string, unknown> | null | undefined) {
  const matrix = metadata?.matrix
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return null
  const file = (matrix as Record<string, unknown>).file
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null
  const record = file as Record<string, unknown>
  const info = record.info && typeof record.info === 'object' && !Array.isArray(record.info)
    ? record.info as Record<string, unknown>
    : null
  return {
    msgtype: typeof record.msgtype === 'string' ? record.msgtype : null,
    name: typeof record.name === 'string' ? record.name : null,
    url: typeof record.url === 'string' ? record.url : null,
    info: info
      ? {
          mimetype: typeof info.mimetype === 'string' ? info.mimetype : undefined,
          size: typeof info.size === 'number' ? info.size : undefined,
        }
      : null,
  }
}

async function canWorkerClaimTask(workerInstanceId: string | null | undefined): Promise<boolean> {
  if (!workerInstanceId) return false
  const [worker] = await db
    .select()
    .from(workerInstances)
    .where(eq(workerInstances.id, workerInstanceId))
    .limit(1)
  if (!worker) return false
  const claimableStates = ['listening', 'idle', 'ready']
  return claimableStates.includes(worker.observedState)
}

function matrixMentionedParticipantIds(metadata: Record<string, unknown> | null | undefined) {
  const matrix = metadata?.matrix
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return []
  const ids = (matrix as Record<string, unknown>).mentionedParticipantIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
}

export const matrixRoomEventDispatcher = new MatrixRoomEventDispatcher()
