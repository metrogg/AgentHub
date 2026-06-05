import { roomService } from '../rooms'
import { matrixRuntimeSupervisor } from '../rooms/matrix-runtime-supervisor'
import type {
  WorkerRuntime,
  WorkerRuntimeContext,
  WorkerRuntimeEvent,
  WorkerRuntimeResult,
} from './types'

/**
 * ResidentRoomWorkerRuntime — 常驻 Room Worker 运行时。
 *
 * 与 EphemeralCodeAgentWorkerRuntime 不同，它不直接启动 CLI 子进程，
 * 而是通过在 Matrix task room 中 @mention Worker participant 来派发任务。
 * Worker 进程本身由外部（如 OpenClaw / QwenPaw）常驻，通过 Matrix listener 接单。
 *
 * 第一版只负责：
 * 1. 向 task room 写入带 @mention 的 assignment message。
 * 2. 标记任务为 assigned，等待 Worker 通过 Matrix timeline 回复。
 */
export class ResidentRoomWorkerRuntime implements WorkerRuntime {
  readonly runtimeType: 'openclaw' | 'qwenpaw'
  readonly kind: 'resident-openclaw' | 'resident-qwenpaw'

  /** Worker participant 在 Room 中的 id，用于 @mention */
  readonly workerParticipantId: string

  constructor(opts: {
    runtimeType: 'openclaw' | 'qwenpaw'
    workerParticipantId: string
  }) {
    this.runtimeType = opts.runtimeType
    this.kind = opts.runtimeType === 'openclaw' ? 'resident-openclaw' : 'resident-qwenpaw'
    this.workerParticipantId = opts.workerParticipantId
  }

  async *executeTask(
    context: WorkerRuntimeContext,
    signal?: AbortSignal,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield {
      type: 'progress',
      message: `Resident Worker (${this.runtimeType}) 准备通过 Matrix @mention 接单。`,
      progressPercent: 5,
      metadata: { kind: this.kind, workerParticipantId: this.workerParticipantId },
    }

    if (signal?.aborted) {
      return {
        runtimeType: this.runtimeType,
        kind: this.kind,
        status: 'cancelled',
        message: 'Resident Worker assignment was cancelled before dispatch.',
      }
    }

    // 写入 task room：@mention Worker，附带 prompt
    const event = await roomService.appendMentionTimelineEvent({
      roomId: context.roomId,
      senderType: 'system',
      type: 'task.assigned',
      body: context.prompt,
      metadata: {
        kind: 'worker-runtime.resident-assignment',
        runId: context.runId,
        taskId: context.taskId,
        taskThreadId: context.taskThreadId,
        workspaceAgentId: context.workspaceAgentId,
        workerInstanceId: context.workerInstanceId,
        workerKind: this.kind,
      },
      mentionParticipantId: this.workerParticipantId,
    })
    const listener = await matrixRuntimeSupervisor.startParticipantListener(this.workerParticipantId, {
      reason: 'resident-worker-assignment',
      dispatch: true,
    })

    yield {
      type: 'progress',
      message: listener.started
        ? '已把任务通过 Matrix @mention 发送给 Resident Worker，并启动了该 Worker 的 Matrix listener。'
        : `已把任务通过 Matrix @mention 发送给 Resident Worker；listener 暂未启动：${listener.reason}。`,
      progressPercent: 10,
      metadata: {
        timelineEventId: event.id,
        workerParticipantId: this.workerParticipantId,
        listener,
      },
    }

    // Resident Worker 的后续执行由外部进程通过 Matrix /sync 完成；
    // 这里返回 waiting_for_human（在此场景下表示"等待外部 Worker 处理"）。
    return {
      runtimeType: this.runtimeType,
      kind: this.kind,
      status: 'waiting_for_human',
      message:
        '任务已 dispatched 到 Resident Worker，等待 Matrix timeline 导入后续进度与结果。',
      metadata: {
        dispatched: true,
        timelineEventId: event.id,
        workerParticipantId: this.workerParticipantId,
        listener,
      },
    }
  }
}
