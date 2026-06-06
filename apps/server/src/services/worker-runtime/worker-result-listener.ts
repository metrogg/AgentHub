import {
  and,
  db,
  desc,
  eq,
  orchestratorRuns,
  roomParticipants,
  rooms,
  runtimeLeases,
  taskThreads,
  workspaceTasks,
  workerInstances,
} from '@agenthub/db'
import { logger } from '../../lib/logger'
import { ensureWorkerAgentContractFromController } from '../agent-contract'
import { roomService } from '../rooms'
import { runController } from '../orchestrator/run-controller'
import { runtimeLeaseController } from '../orchestrator/runtime-lease-controller'
import { markWorkerInstanceState } from '../orchestrator/worker-runtime-resources'
import { updateTaskThreadStatus } from '../orchestrator/task-thread-service'
import { createTaskClarification } from './task-clarification-store'

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
    await handleTaskCompleted(input, summary)
    return true
  }

  // BLOCKED: <reason>
  const blockedMatch = body.match(/^BLOCKED:\s*(.+)$/s)
  if (blockedMatch) {
    const reason = blockedMatch[1]!.trim()
    await handleTaskBlocked(input, reason)
    return true
  }

  // QUESTION: <question>
  const questionMatch = body.match(/^QUESTION:\s*(.+)$/s)
  if (questionMatch) {
    const question = questionMatch[1]!.trim()
    await handleWorkerQuestion(input, question)
    return true
  }

  // PHASE{N}_DONE: <summary>
  const phaseMatch = body.match(/^PHASE(\d+)_DONE:\s*(.+)$/s)
  if (phaseMatch) {
    const phaseNum = phaseMatch[1]
    const summary = phaseMatch[2]!.trim()
    await handlePhaseCompleted(input, phaseNum!, summary)
    return true
  }

  return false
}

type WorkerProtocolInput = Parameters<typeof handleWorkerProtocolMessage>[0]

async function handleTaskCompleted(input: WorkerProtocolInput, summary: string) {
  const context = await resolveTaskRoomContext(input)
  if (!context) {
    logger.warn({ roomId: input.roomId }, 'Worker reported TASK_COMPLETED but no task found for this room')
    return
  }

  await runController.markTaskCompleted(
    context.run,
    {
      taskId: context.task.id,
      title: context.task.title,
      agentId: context.task.agentId ?? context.thread?.workspaceAgentId ?? null,
      childSessionId: context.thread?.sessionId ?? context.room.sessionId ?? null,
      taskThreadId: context.thread?.id ?? context.room.taskThreadId ?? null,
      workerInstanceId: context.workerInstanceId,
      runtimeLeaseId: context.lease?.id ?? null,
      sharedTaskRelativeRoot: readString(context.room.metadata?.sharedTaskRelativeRoot),
      sharedTaskSpecPath: readString(context.room.metadata?.sharedTaskSpecPath),
      extraPayload: {
        source: 'worker-protocol.task-completed',
        summary,
        sourceEventId: input.eventId,
        taskRoomId: context.room.id,
      },
    },
  ).catch((err) => {
    logger.warn({ err, taskId: context.task.id }, 'Failed to mark task completed via run controller')
  })

  await runtimeLeaseController.release(context.lease?.id, {
    workerInstanceId: context.workerInstanceId,
    metadata: {
      source: 'worker-protocol.task-completed',
      sourceEventId: input.eventId,
      summary,
    },
  })
  await markWorkerAfterProtocolResult(context.worker, 'released after worker protocol completion')
  await refreshWorkerContractAfterProtocolResult(context, 'worker-protocol.task-completed')

  logger.info({ taskId: context.task.id, summary: summary.slice(0, 100) }, 'Worker reported TASK_COMPLETED')
}

async function handleTaskBlocked(input: WorkerProtocolInput, reason: string) {
  const context = await resolveTaskRoomContext(input)
  if (!context) {
    logger.warn({ roomId: input.roomId }, 'Worker reported BLOCKED but no task found for this room')
    return
  }

  await runController.markTaskBlocked(context.run, {
    taskId: context.task.id,
    title: context.task.title,
    agentId: context.task.agentId ?? context.thread?.workspaceAgentId ?? null,
    error: reason,
    reason: 'worker_protocol_blocked',
  })

  await runtimeLeaseController.release(context.lease?.id, {
    workerInstanceId: context.workerInstanceId,
    metadata: {
      source: 'worker-protocol.blocked',
      sourceEventId: input.eventId,
      reason,
    },
  })
  await markWorkerAfterProtocolResult(context.worker, 'blocked task reported through Matrix protocol')
  await refreshWorkerContractAfterProtocolResult(context, 'worker-protocol.blocked')

  logger.info({ taskId: context.task.id, reason: reason.slice(0, 100) }, 'Worker reported BLOCKED')
}

async function handleWorkerQuestion(input: WorkerProtocolInput, question: string) {
  const context = await resolveTaskRoomContext(input)
  if (!context) {
    logger.warn({ roomId: input.roomId }, 'Worker asked QUESTION but no task found for this room')
    return
  }

  const clarification = await createTaskClarification({
    runId: context.run.runId,
    taskId: context.task.id,
    agentId: context.task.agentId ?? context.thread?.workspaceAgentId ?? null,
    question,
    options: [],
  })

  await runController.markTaskWaitingForHuman(context.run, {
    taskId: context.task.id,
    title: context.task.title,
    agentId: context.task.agentId ?? context.thread?.workspaceAgentId ?? null,
    question,
    clarificationId: clarification?.id ?? null,
    childSessionId: context.thread?.sessionId ?? context.room.sessionId ?? null,
    taskThreadId: context.thread?.id ?? context.room.taskThreadId ?? null,
    workerInstanceId: context.workerInstanceId,
    runtimeLeaseId: context.lease?.id ?? null,
    sharedTaskRelativeRoot: readString(context.room.metadata?.sharedTaskRelativeRoot),
    sharedTaskSpecPath: readString(context.room.metadata?.sharedTaskSpecPath),
    extraPayload: {
      source: 'worker-protocol.question',
      sourceEventId: input.eventId,
      taskRoomId: context.room.id,
    },
  })

  await runtimeLeaseController.markWaitingForHuman(context.lease?.id, {
    workerInstanceId: context.workerInstanceId,
    message: question,
    metadata: {
      source: 'worker-protocol.question',
      sourceEventId: input.eventId,
      clarificationId: clarification?.id ?? null,
      question,
      roomId: context.room.id,
      runId: context.run.runId,
      taskId: context.task.id,
    },
  })

  await roomService.appendTimelineEvent({
    roomId: context.room.id,
    senderParticipantId: input.senderParticipantId,
    senderType: 'worker',
    type: 'approval.requested',
    body: question,
    metadata: {
      kind: 'worker-runtime.clarification-requested',
      source: 'worker-protocol.question',
      sourceEventId: input.eventId,
      clarificationId: clarification?.id ?? null,
      workspaceAgentId: context.task.agentId ?? context.thread?.workspaceAgentId ?? null,
      workerInstanceId: context.workerInstanceId,
      runtimeLeaseId: context.lease?.id ?? null,
      question,
      options: [],
    },
  })

  await refreshWorkerContractAfterProtocolResult(context, 'worker-protocol.question')

  logger.info({ taskId: context.task.id, question: question.slice(0, 100) }, 'Worker asked QUESTION via protocol')
}

async function handlePhaseCompleted(input: WorkerProtocolInput, phaseNum: string, summary: string) {
  const context = await resolveTaskRoomContext(input)
  if (!context) {
    logger.warn({ roomId: input.roomId, phaseNum }, 'Worker reported PHASE_DONE but no task found for this room')
    return
  }

  await runController.markTaskProgress(context.run, {
    taskId: context.task.id,
    title: context.task.title,
    agentId: context.task.agentId ?? context.thread?.workspaceAgentId ?? null,
    percent: null,
    progressStatus: `phase_${phaseNum}_done`,
    childSessionId: context.thread?.sessionId ?? context.room.sessionId ?? null,
    taskThreadId: context.thread?.id ?? context.room.taskThreadId ?? null,
    workerInstanceId: context.workerInstanceId,
    runtimeLeaseId: context.lease?.id ?? null,
    sharedTaskRelativeRoot: readString(context.room.metadata?.sharedTaskRelativeRoot),
    sharedTaskSpecPath: readString(context.room.metadata?.sharedTaskSpecPath),
    persistRunUpdatedAt: true,
    extraPayload: {
      source: 'worker-protocol.phase-done',
      phase: phaseNum,
      summary,
      sourceEventId: input.eventId,
      taskRoomId: context.room.id,
    },
  })
  if (context.thread?.id) {
    await updateTaskThreadStatus(context.thread.id, 'active', input.eventId)
  }
  await refreshWorkerContractAfterProtocolResult(context, 'worker-protocol.phase-done')

  logger.info({ taskId: context.task.id, phaseNum, summary: summary.slice(0, 100) }, 'Worker reported PHASE_DONE')
}

async function resolveTaskRoomContext(input: WorkerProtocolInput) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
  if (!room || room.kind !== 'task') return null

  const [participant] = input.senderParticipantId
    ? await db.select().from(roomParticipants).where(eq(roomParticipants.id, input.senderParticipantId)).limit(1)
    : []

  const [thread] = room.taskThreadId
    ? await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId)).limit(1)
    : room.runId && room.taskId
      ? await db
          .select()
          .from(taskThreads)
          .where(and(eq(taskThreads.runId, room.runId), eq(taskThreads.taskId, room.taskId)))
          .limit(1)
      : room.sessionId
        ? await db.select().from(taskThreads).where(eq(taskThreads.sessionId, room.sessionId)).limit(1)
        : []

  const taskId = room.taskId ?? thread?.taskId ?? null
  if (!taskId) return null
  const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, taskId)).limit(1)
  if (!task) return null

  const runId = room.runId ?? thread?.runId ?? task.runId ?? null
  if (!runId) return null
  const [runRow] = await db.select().from(orchestratorRuns).where(eq(orchestratorRuns.id, runId)).limit(1)
  const groupSessionId = thread?.groupSessionId ?? runRow?.groupSessionId ?? null
  if (!groupSessionId) return null

  const workerInstanceId = participant?.workerInstanceId ?? thread?.workerInstanceId ?? room.metadata?.workerInstanceId
  const normalizedWorkerInstanceId = typeof workerInstanceId === 'string' ? workerInstanceId : null
  const [worker] = normalizedWorkerInstanceId
    ? await db.select().from(workerInstances).where(eq(workerInstances.id, normalizedWorkerInstanceId)).limit(1)
    : []
  const [lease] = normalizedWorkerInstanceId
    ? await db
        .select()
        .from(runtimeLeases)
        .where(and(eq(runtimeLeases.taskId, task.id), eq(runtimeLeases.workerInstanceId, normalizedWorkerInstanceId)))
        .orderBy(desc(runtimeLeases.updatedAt))
        .limit(1)
    : await db
        .select()
        .from(runtimeLeases)
        .where(eq(runtimeLeases.taskId, task.id))
        .orderBy(desc(runtimeLeases.updatedAt))
        .limit(1)

  return {
    room,
    thread: thread ?? null,
    task,
    lease: lease ?? null,
    worker: worker ?? null,
    workerInstanceId: normalizedWorkerInstanceId,
    run: {
      runId,
      workspaceId: room.workspaceId ?? task.workspaceId,
      groupSessionId,
    },
  }
}

async function markWorkerAfterProtocolResult(
  worker: typeof workerInstances.$inferSelect | null,
  message: string,
) {
  if (!worker) return
  const nextState =
    worker.runtimeBase === 'openclaw' || worker.runtimeBase === 'qwenpaw' || worker.runtimeBase === 'copaw'
      ? 'listening'
      : 'idle'
  await markWorkerInstanceState(worker.id, nextState, {
    message,
    health: {
      protocolResultAt: new Date().toISOString(),
      runtimeBase: worker.runtimeBase,
    },
  })
}

async function refreshWorkerContractAfterProtocolResult(
  context: NonNullable<Awaited<ReturnType<typeof resolveTaskRoomContext>>>,
  source: string,
) {
  if (!context.workerInstanceId) return
  await ensureWorkerAgentContractFromController({
    workerInstanceId: context.workerInstanceId,
    controllerUrl: process.env.AGENTHUB_CONTAINER_CONTROLLER_URL || process.env.AGENTHUB_CONTROLLER_URL || null,
    sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
  }).catch((err) => {
    logger.warn({
      err,
      source,
      workerInstanceId: context.workerInstanceId,
      taskId: context.task.id,
      roomId: context.room.id,
    }, 'Failed to refresh Worker contract after Matrix protocol result')
  })
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}
