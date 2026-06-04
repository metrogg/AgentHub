import {
  and,
  asc,
  db,
  eq,
  messages,
  orchestratorRuns,
  runtimeLeases,
  taskThreads,
  workspaces,
  workerInstances,
  workspaceTasks,
} from '@agenthub/db'
import { WsEvent } from '@agenthub/shared'
import { broadcastSessionEvent } from '../agent-runner'
import { workerController } from './worker-controller'
import { emitRunEvent } from './run-events'
import { updateTaskThreadStatus } from './task-thread-service'
import { runtimeLeaseController } from './runtime-lease-controller'
import { markWorkerInstanceState } from './worker-runtime-resources'
import { managerLoopStep } from './manager-loop'
import { roomService } from '../rooms'

export interface PatrolResult {
  checkedRuns: number
  checkedWorkers: number
  staleWorkerCount: number
  timedOutTaskCount: number
  actions: PatrolAction[]
}

export interface PatrolAction {
  kind: 'worker_stale' | 'task_timeout' | 'worker_failed' | 'progress_check'
  runId?: string | null
  taskId?: string | null
  threadId?: string | null
  workerInstanceId?: string | null
  groupSessionId?: string | null
  message: string
}

const TASK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes without progress
const WORKER_STALE_MS = 8 * 60 * 1000 // 8 minutes without heartbeat while busy

/**
 * ManagerPatrol implements HiClaw's heartbeat-driven active supervision.
 *
 * In HiClaw, the Manager doesn't just react to user messages — it periodically:
 * 1. Reads state.json to find active tasks
 * 2. Checks worker readiness and health
 * 3. Asks about progress in the right room
 * 4. Reports anomalies to the admin channel
 *
 * ManagerPatrol brings this pattern to AgentHub: it scans all active runs,
 * checks worker health, detects timed-out tasks, and emits transparent
 * progress-check events that make the Manager's supervision visible.
 */
export async function runManagerPatrol(): Promise<PatrolResult> {
  const actions: PatrolAction[] = []
  let checkedWorkers = 0
  let staleWorkerCount = 0
  let timedOutTaskCount = 0

  // Find all active runs
  const activeRuns = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.status, 'running'))
    .limit(50)

  for (const run of activeRuns) {
    const [workspace] = await db
      .select({ ownerId: workspaces.ownerId })
      .from(workspaces)
      .where(eq(workspaces.id, run.workspaceId))
      .limit(1)
    const ownerId = workspace?.ownerId ?? null

    // Get all non-terminal tasks for this run
    const terminalStatuses = new Set(['done', 'failed', 'cancelled', 'skipped'])
    const activeTasks = await db
      .select()
      .from(workspaceTasks)
      .where(
        and(
          eq(workspaceTasks.runId, run.id),
          eq(workspaceTasks.status, 'running'),
        ),
      )
      .orderBy(asc(workspaceTasks.orderIdx))

    if (activeTasks.length === 0) continue

    // Get all threads for these tasks
    const threads = await db
      .select()
      .from(taskThreads)
      .where(
        and(
          eq(taskThreads.runId, run.id),
          eq(taskThreads.status, 'active'),
        ),
      )
    const threadByTaskId = new Map(threads.map((t) => [t.taskId, t]))

    // Get all busy worker instances
    const busyWorkerIds = [
      ...new Set(
        threads
          .map((t) => t.workerInstanceId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ]

    if (busyWorkerIds.length > 0) {
      const busyWorkerIdSet = new Set(busyWorkerIds)
      const workers = await db
        .select()
        .from(workerInstances)
        .where(eq(workerInstances.observedState, 'busy'))

      for (const worker of workers.filter((candidate) => busyWorkerIdSet.has(candidate.id))) {
        checkedWorkers++

        // Reconcile worker health
        const reconcileResult = await workerController.reconcile(worker.id, {
          workspaceId: run.workspaceId,
          groupSessionId: run.groupSessionId,
          runId: run.id,
        })

        if (reconcileResult.error) {
          staleWorkerCount++
          const workerThread = threads.find((t) => t.workerInstanceId === worker.id)
          actions.push({
            kind: 'worker_failed',
            runId: run.id,
            taskId: workerThread?.taskId ?? null,
            threadId: workerThread?.id ?? null,
            workerInstanceId: worker.id,
            groupSessionId: run.groupSessionId,
            message: `Patrol detected unhealthy worker ${worker.id}: ${reconcileResult.error}`,
          })

          await emitRunEvent({
            runId: run.id,
            workspaceId: run.workspaceId,
            groupSessionId: run.groupSessionId,
            workerInstanceId: worker.id,
            type: 'manager.next_action',
            severity: 'warning',
            payload: {
              action: 'patrol_worker_unhealthy',
              reason: reconcileResult.error,
              workerInstanceId: worker.id,
              runtimeBase: worker.runtimeBase,
              observedState: worker.observedState,
            },
          })
          await appendPatrolRoomTimeline({
            ownerId,
            groupSessionId: run.groupSessionId,
            runId: run.id,
            taskId: workerThread?.taskId ?? null,
            threadId: workerThread?.id ?? null,
            workerInstanceId: worker.id,
            kind: 'worker_failed',
            severity: 'error',
            body: `Manager 巡检发现 Worker ${worker.id} 异常：${reconcileResult.error}`,
            metadata: {
              reason: 'patrol_worker_unhealthy',
              runtimeBase: worker.runtimeBase,
              reconcilePhase: reconcileResult.phase,
            },
          })
        }

        // Check for stale workers (busy but no heartbeat)
        const heartbeatAgeMs = worker.lastHeartbeatAt
          ? Date.now() - worker.lastHeartbeatAt.getTime()
          : Date.now() - worker.updatedAt.getTime()

        if (heartbeatAgeMs > WORKER_STALE_MS && worker.observedState === 'busy') {
          staleWorkerCount++
          const message = `Worker ${worker.id} (${worker.runtimeBase}) has been busy without a heartbeat for ${Math.round(heartbeatAgeMs / 1000)}s.`

          // Mark the active lease as stale so the resource layer knows
          const [activeLease] = await db
            .select()
            .from(runtimeLeases)
            .where(
              and(
                eq(runtimeLeases.workerInstanceId, worker.id),
                eq(runtimeLeases.status, 'running'),
              ),
            )
            .limit(1)

          if (activeLease) {
            await runtimeLeaseController.markStale(activeLease.id, {
              error: message,
              metadata: { staleReason: 'patrol_heartbeat_lost', lastHeartbeatAgeMs: heartbeatAgeMs },
            })
          }

          // Report to timeline — let Manager LLM decide next action
          const workerThread = threads.find((t) => t.workerInstanceId === worker.id)
          actions.push({
            kind: 'worker_stale',
            runId: run.id,
            threadId: workerThread?.id ?? null,
            workerInstanceId: worker.id,
            groupSessionId: run.groupSessionId,
            message,
          })
          await appendPatrolRoomTimeline({
            ownerId,
            groupSessionId: run.groupSessionId,
            runId: run.id,
            taskId: workerThread?.taskId ?? null,
            threadId: workerThread?.id ?? null,
            workerInstanceId: worker.id,
            kind: 'worker_stale',
            severity: 'error',
            body: message,
            metadata: {
              reason: 'patrol_worker_stale',
              runtimeBase: worker.runtimeBase,
              heartbeatAgeMs,
            },
          })
        }
      }
    }

    // Check for task timeouts (running too long without completion)
    for (const task of activeTasks) {
      const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : null
      if (!startedAt) continue

      const elapsedMs = Date.now() - startedAt
      if (elapsedMs < TASK_TIMEOUT_MS) continue

      timedOutTaskCount++
      const thread = threadByTaskId.get(task.id)
      const message = `Task "${task.title}" has been running for ${Math.round(elapsedMs / 1000)}s without completion. Manager is checking progress.`

      actions.push({
        kind: 'task_timeout',
        runId: run.id,
        taskId: task.id,
        threadId: thread?.id ?? null,
        groupSessionId: run.groupSessionId,
        message,
      })
      await appendPatrolRoomTimeline({
        ownerId,
        groupSessionId: run.groupSessionId,
        runId: run.id,
        taskId: task.id,
        threadId: thread?.id ?? null,
        workerInstanceId: thread?.workerInstanceId ?? null,
        kind: 'task_timeout',
        severity: 'warning',
        body: `Manager 正在检查任务 "${task.title}" 的进度：已经运行 ${Math.round(elapsedMs / 1000 / 60)} 分钟，尚未完成报告。`,
        metadata: {
          reason: 'patrol_task_timeout',
          taskTitle: task.title,
          elapsedMs,
        },
      })

      // Emit a progress-check event in the group chat
      if (run.groupSessionId) {
        await emitRunEvent({
          runId: run.id,
          workspaceId: run.workspaceId,
          groupSessionId: run.groupSessionId,
          taskId: task.id,
          threadId: thread?.id ?? null,
          type: 'manager.next_action',
          severity: 'warning',
          payload: {
            action: 'patrol_task_timeout',
            reason: message,
            taskId: task.id,
            taskTitle: task.title,
            elapsedMs,
            threadId: thread?.id ?? null,
            sessionId: thread?.sessionId ?? null,
          },
        })

        // Post a visible progress-check message in the group chat
        try {
          const [patrolMsg] = await db
            .insert(messages)
            .values({
              sessionId: run.groupSessionId,
              senderId: 'system',
              senderType: 'system',
              type: 'text',
              content: `🔄 正在检查任务 "${task.title}" 的进度...已经运行了 ${Math.round(elapsedMs / 1000 / 60)} 分钟，还没有完成报告。`,
              metadata: {
                kind: 'manager-patrol-check',
                systemEvent: 'manager_patrol_check',
                orchestratorRunId: run.id,
                taskId: task.id,
                threadId: thread?.id ?? null,
                elapsedMs,
              },
            })
            .returning()

          if (patrolMsg) {
            broadcastSessionEvent(run.groupSessionId, {
              type: WsEvent.MessageCompleted,
              payload: { sessionId: run.groupSessionId, message: patrolMsg },
            })
          }
        } catch {
          // Non-critical: message insert failure shouldn't break the patrol
        }
      }
    }

    // Trigger ManagerLoop.step() for this active run so the Manager can
    // decide the next action (dispatch, review, synthesize) based on the
    // latest observed state — not just report issues.
    managerLoopStep(run.id).catch(() => {})
  }

  return {
    checkedRuns: activeRuns.length,
    checkedWorkers,
    staleWorkerCount,
    timedOutTaskCount,
    actions,
  }
}

/**
 * Run a single patrol cycle and log the results.
 * Designed to be called by a timer or cron.
 */
export async function patrolAndLog(): Promise<PatrolResult> {
  const result = await runManagerPatrol()
  if (result.staleWorkerCount > 0 || result.timedOutTaskCount > 0) {
    const { logger } = await import('../../lib/logger')
    logger.warn(
      {
        checkedRuns: result.checkedRuns,
        checkedWorkers: result.checkedWorkers,
        staleWorkerCount: result.staleWorkerCount,
        timedOutTaskCount: result.timedOutTaskCount,
        actionCount: result.actions.length,
      },
      '[ManagerPatrol] Patrol cycle completed with issues',
    )
  }
  return result
}

async function appendPatrolRoomTimeline(input: {
  ownerId?: string | null
  groupSessionId?: string | null
  runId: string
  taskId?: string | null
  threadId?: string | null
  workerInstanceId?: string | null
  kind: 'worker_stale' | 'worker_failed' | 'task_timeout'
  severity: 'warning' | 'error'
  body: string
  metadata?: Record<string, unknown>
}) {
  if (!input.ownerId) return
  const metadata = {
    kind: 'manager-patrol-check',
    patrolKind: input.kind,
    severity: input.severity,
    runId: input.runId,
    taskId: input.taskId ?? null,
    threadId: input.threadId ?? null,
    workerInstanceId: input.workerInstanceId ?? null,
    coordinationSource: 'room-timeline',
    ...(input.metadata ?? {}),
  }

  if (input.groupSessionId) {
    try {
      const groupRoom = await roomService.ensureRoomForSession(input.groupSessionId, input.ownerId)
      await roomService.appendTimelineEvent({
        roomId: groupRoom.id,
        senderType: 'manager',
        type: 'manager.message',
        body: input.body,
        metadata,
      })
    } catch {
      // Patrol timeline writes are best-effort; RunEvent and legacy message remain as fallback.
    }
  }

  if (input.threadId) {
    try {
      const taskRoomInput = await roomService.buildTaskThreadRoomInput(input.threadId, input.ownerId)
      const taskRoom = await roomService.ensureRoomForTaskThread(taskRoomInput)
      await roomService.appendTimelineEvent({
        roomId: taskRoom.id,
        senderType: 'manager',
        type: 'task.progress',
        body: input.body,
        metadata,
      })
    } catch {
      // Legacy or partially migrated tasks may not have task rooms yet.
    }
  }
}
