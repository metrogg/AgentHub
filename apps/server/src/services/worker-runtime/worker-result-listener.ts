import { db, eq, and, workspaceTasks, taskThreads } from '@agenthub/db'
import { TaskStatus } from '@agenthub/shared'
import { logger } from '../../lib/logger'
import { roomService } from '../rooms'
import { runController } from '../orchestrator/run-controller'
import { runtimeLeaseController } from '../orchestrator/runtime-lease-controller'
import { markWorkerInstanceState } from '../orchestrator/worker-runtime-resources'

/**
 * Parse Worker @mention protocol messages.
 * Aligns with HiClaw's Worker communication pattern:
 *   TASK_COMPLETED: <summary>
 *   BLOCKED: <reason>
 *   QUESTION: <question>
 *   PHASE{N}_DONE: <summary>
 *   NO_REPLY — silently ignored
 *
 * Returns true if the message was a protocol message and was handled.
 */
export async function handleWorkerProtocolMessage(input: {
  roomId: string
  roomKind: string
  body: string
  senderParticipantId: string | null
  senderType: string
  eventId: string
}): Promise<boolean> {
  // Only handle worker messages in task rooms
  if (input.senderType !== 'worker' || input.roomKind !== 'task') return false

  const body = input.body.trim()

  // NO_REPLY — Worker has nothing to say, ignore silently
  if (body === 'NO_REPLY') return true

  // TASK_COMPLETED: <summary>
  const completedMatch = body.match(/^TASK_COMPLETED:\s*(.+)$/s)
  if (completedMatch) {
    const summary = completedMatch[1]!.trim()
    await handleTaskCompleted(input.roomId, summary, input.eventId)
    return true
  }

  // BLOCKED: <reason>
  const blockedMatch = body.match(/^BLOCKED:\s*(.+)$/s)
  if (blockedMatch) {
    const reason = blockedMatch[1]!.trim()
    await handleTaskBlocked(input.roomId, reason, input.eventId)
    return true
  }

  // QUESTION: <question>
  const questionMatch = body.match(/^QUESTION:\s*(.+)$/s)
  if (questionMatch) {
    const question = questionMatch[1]!.trim()
    await handleWorkerQuestion(input.roomId, question, input.eventId)
    return true
  }

  // PHASE{N}_DONE: <summary>
  const phaseMatch = body.match(/^PHASE(\d+)_DONE:\s*(.+)$/s)
  if (phaseMatch) {
    const phaseNum = phaseMatch[1]
    const summary = phaseMatch[2]!.trim()
    await handlePhaseCompleted(input.roomId, phaseNum!, summary, input.eventId)
    return true
  }

  return false
}

async function handleTaskCompleted(roomId: string, summary: string, sourceEventId: string) {
  // Find the task associated with this room
  const [thread] = await db
    .select()
    .from(taskThreads)
    .where(eq(taskThreads.sessionId, roomId))
    .limit(1)

  if (!thread?.taskId) {
    logger.warn({ roomId }, 'Worker reported TASK_COMPLETED but no task found for this room')
    return
  }

  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.id, thread.taskId))
    .limit(1)

  if (!task) return

  // Mark task as completed
  if (task.runId) {
    await runController.markTaskCompleted(
      { runId: task.runId, workspaceId: task.workspaceId, groupSessionId: roomId },
      {
        taskId: task.id,
        title: task.title,
        agentId: task.agentId ?? undefined,
        durationMs: undefined,
        childSessionId: undefined,
        taskThreadId: thread.id,
        workerInstanceId: undefined,
        runtimeLeaseId: undefined,
        sharedTaskRelativeRoot: undefined,
        sharedTaskSpecPath: undefined,
        extraPayload: { source: 'worker-protocol', summary, sourceEventId },
      },
    ).catch((err) => {
      logger.warn({ err, taskId: task.id }, 'Failed to mark task completed via run controller')
    })
  }

  logger.info({ taskId: task.id, summary: summary.slice(0, 100) }, 'Worker reported TASK_COMPLETED')
}

async function handleTaskBlocked(roomId: string, reason: string, sourceEventId: string) {
  const [thread] = await db
    .select()
    .from(taskThreads)
    .where(eq(taskThreads.sessionId, roomId))
    .limit(1)

  if (!thread?.taskId) return

  const [task] = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.id, thread.taskId))
    .limit(1)

  if (!task) return

  // Update task status to blocked
  await db
    .update(workspaceTasks)
    .set({ status: TaskStatus.Blocked, errorLog: reason })
    .where(eq(workspaceTasks.id, task.id))

  logger.info({ taskId: task.id, reason: reason.slice(0, 100) }, 'Worker reported BLOCKED')
}

async function handleWorkerQuestion(roomId: string, question: string, sourceEventId: string) {
  // This is a clarification request — the Worker needs human input
  // The existing clarification flow in worker-runtime-service handles this
  // via the clarification event yielded by the runtime.
  // For resident Workers that send QUESTION via Matrix, we log it.
  logger.info({ roomId, question: question.slice(0, 100) }, 'Worker asked QUESTION via protocol')
}

async function handlePhaseCompleted(roomId: string, phaseNum: string, summary: string, sourceEventId: string) {
  logger.info({ roomId, phaseNum, summary: summary.slice(0, 100) }, 'Worker reported PHASE_DONE')
}
