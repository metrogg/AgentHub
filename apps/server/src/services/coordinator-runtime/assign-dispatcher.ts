import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  and,
  db,
  eq,
  messages,
  roomParticipants,
  sessions,
  workspaceAgents,
  workspaces,
  workspaceTasks,
} from '@agenthub/db'
import { TaskStatus } from '@agenthub/shared'
import { prepareAgentWorkdir } from '../execution/agent-workdir'
import { AppError, AppErrorCodes } from '../../lib/error'
import { logger } from '../../lib/logger'
import { agentHubUserCacheRoot, safePathSegment } from '../system-paths'
import { prepareTaskRuntimeThread } from '../orchestrator/task-thread-service'
import {
  markWorkerInstanceState,
} from '../orchestrator/worker-runtime-resources'
import { runController, type RunControllerRunContext } from '../orchestrator/run-controller'
import { runtimeLeaseController } from '../orchestrator/runtime-lease-controller'
import { roomController, roomService } from '../rooms'
import { workerRuntimeService } from '../worker-runtime'
import type { WorkerRuntime } from '../worker-runtime'
import type { CoordinatorAction } from './types'

export interface DispatchCoordinatorAssignInput {
  groupSession: typeof sessions.$inferSelect
  ownerId: string
  sourceMessage: typeof messages.$inferSelect
  action: CoordinatorAction
  runtimeType: string
  workerRuntime?: WorkerRuntime
  executeInline?: boolean
}

export interface DispatchCoordinatorAssignResult {
  runId: string
  taskId: string
  taskThreadId: string
  taskRoomId: string
  childSessionId: string
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  workerExecutionStarted: boolean
}

export interface DispatchCoordinatorAssignBatchInput {
  groupSession: typeof sessions.$inferSelect
  ownerId: string
  sourceMessage: typeof messages.$inferSelect
  actions: CoordinatorAction[]
  runtimeType: string
  run?: RunControllerRunContext
  workerRuntime?: WorkerRuntime
  executeInline?: boolean
}

export interface DispatchCoordinatorAssignBatchResult {
  runId: string
  tasks: DispatchCoordinatorAssignResult[]
  workerExecutionStarted: boolean
}

export async function dispatchCoordinatorAssign(
  input: DispatchCoordinatorAssignInput,
): Promise<DispatchCoordinatorAssignResult> {
  const batch = await dispatchCoordinatorAssignBatch({
    groupSession: input.groupSession,
    ownerId: input.ownerId,
    sourceMessage: input.sourceMessage,
    actions: [input.action],
    runtimeType: input.runtimeType,
    workerRuntime: input.workerRuntime,
    executeInline: input.executeInline,
  })
  const first = batch.tasks[0]
  if (!first) {
    throw AppError.fromCode(AppErrorCodes.TASK_EXECUTION_FAILED, 'Coordinator assign dispatch did not create a task')
  }
  return first
}

export async function dispatchCoordinatorAssignBatch(
  input: DispatchCoordinatorAssignBatchInput,
): Promise<DispatchCoordinatorAssignBatchResult> {
  if (!input.groupSession.workspaceId) {
    throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '群聊未绑定工作区，无法派发任务')
  }
  const assignActions = input.actions.filter((action) => action.type === 'assign')
  if (assignActions.length === 0) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Coordinator 没有返回可派发的 assign action')
  }
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, input.groupSession.workspaceId))
    .limit(1)
  if (!workspace || workspace.ownerId !== input.ownerId) {
    throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
  }

  const specs = await Promise.all(
    assignActions.map(async (action, index) => {
      const worker = await resolveTargetWorker({
        workspaceId: workspace.id,
        targetWorkerId: action.targetWorkerId,
      })
      const taskTitle = action.taskTitle?.trim() || action.message?.trim() || `Manager 派发的任务 ${index + 1}`
      const taskDescription =
        action.taskDescription?.trim() ||
        action.message?.trim() ||
        input.sourceMessage.content
      return {
        action,
        taskId: randomUUID(),
        taskKey: normalizeTaskKey(action.taskKey, index),
        dependsOnKeys: normalizeDependencyKeys(action.dependsOn),
        worker,
        taskTitle,
        taskDescription,
        orderIdx: index,
      }
    }),
  )
  const taskIdByKey = validateAssignGraph(specs)
  const manager = await resolveManagerAgent(workspace.id)
  const run =
    input.run ??
    (await runController.start({
      workspaceId: workspace.id,
      groupSessionId: input.groupSession.id,
      goal: input.sourceMessage.content,
      actor: manager
        ? {
            id: manager.id,
            name: manager.name,
          }
        : {
            id: 'manager',
            name: 'Manager',
          },
      decision: {
        action: 'assign',
        reason: assignActions.map((action) => action.reason).filter(Boolean).join('\n') || undefined,
        message:
          assignActions.length === 1
            ? assignActions[0]?.message
            : `Manager 派发了 ${assignActions.length} 个 Worker 任务。`,
        memberProposalCount: 0,
      },
    }))
  const plan = buildAssignBatchPlan({
    sourceMessage: input.sourceMessage,
    specs,
  })
  await runController.prepareForDispatch(run, {
    plan,
    taskCount: specs.length,
    agentCount: new Set(specs.map((spec) => spec.worker.id)).size,
    phaseCount: 1,
  })

  const groupRoom = await roomController.ensureSessionRoom(input.groupSession.id, input.ownerId)
  const preparedTasks: PreparedCoordinatorAssignedTask[] = []
  for (const spec of specs) {
    preparedTasks.push(
      await prepareCoordinatorAssignedTask({
        workspace,
        run,
        ownerId: input.ownerId,
        groupSession: input.groupSession,
        sourceMessage: input.sourceMessage,
        groupRoomId: groupRoom.id,
        runtimeType: input.runtimeType,
        spec,
        taskIdByKey,
        workerRuntime: input.workerRuntime,
      }),
    )
  }
  await runController.markRunning(run, {
    plan,
    taskCount: preparedTasks.length,
  })

  const execution = executeCoordinatorAssignBatch({ run, tasks: preparedTasks })

  if (input.executeInline) {
    await execution
  } else {
    execution.catch((error: any) => {
      logger.error(
        {
          err: error?.message,
          runId: run.runId,
          taskCount: preparedTasks.length,
        },
        'Coordinator assign batch WorkerRuntime execution failed',
      )
    })
  }

  return {
    runId: run.runId,
    tasks: preparedTasks.map((task) => ({
      runId: run.runId,
      taskId: task.taskId,
      taskThreadId: task.taskThreadId,
      taskRoomId: task.taskRoomId,
      childSessionId: task.childSessionId,
      workerInstanceId: task.workerInstanceId ?? null,
      runtimeLeaseId: task.runtimeLeaseId ?? null,
      workerExecutionStarted: true,
    })),
    workerExecutionStarted: true,
  }
}

interface CoordinatorAssignSpec {
  action: CoordinatorAction
  taskId: string
  taskKey: string
  dependsOnKeys: string[]
  worker: typeof workspaceAgents.$inferSelect
  taskTitle: string
  taskDescription: string
  orderIdx: number
}

interface PreparedCoordinatorAssignedTask {
  run: RunControllerRunContext
  taskId: string
  taskKey: string
  dependencyTaskIds: string[]
  taskTitle: string
  taskDescription: string
  worker: typeof workspaceAgents.$inferSelect
  taskRoomId: string
  taskThreadId: string
  childSessionId: string
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  ownerId: string
  workerRuntime?: WorkerRuntime
}

interface WorkerTaskExecutionOutcome {
  taskId: string
  status: 'completed' | 'cancelled' | 'failed' | 'waiting_for_human'
  message?: string | null
}

async function prepareCoordinatorAssignedTask(input: {
  workspace: typeof workspaces.$inferSelect
  run: RunControllerRunContext
  ownerId: string
  groupSession: typeof sessions.$inferSelect
  sourceMessage: typeof messages.$inferSelect
  groupRoomId: string
  runtimeType: string
  spec: CoordinatorAssignSpec
  taskIdByKey: Map<string, string>
  workerRuntime?: WorkerRuntime
}): Promise<PreparedCoordinatorAssignedTask> {
  const dependencyTaskIds = input.spec.dependsOnKeys.map((key) => input.taskIdByKey.get(key)!)
  const [task] = await db
    .insert(workspaceTasks)
    .values({
      id: input.spec.taskId,
      workspaceId: input.workspace.id,
      runId: input.run.runId,
      agentId: input.spec.worker.id,
      title: input.spec.taskTitle,
      description: input.spec.taskDescription,
      status: TaskStatus.Pending,
      sessionId: null,
      orderIdx: input.spec.orderIdx,
      progressStatus: 'thread-prepared',
      dependencies: dependencyTaskIds,
      maxRetries: 1,
    })
    .returning()
  if (!task) throw AppError.fromCode(AppErrorCodes.TASK_EXECUTION_FAILED, '任务创建失败')

  const runtimeThread = await prepareTaskRuntimeThread({
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
    ownerId: input.ownerId,
    runId: input.run.runId,
    taskId: task.id,
    groupSessionId: input.groupSession.id,
    projectPath: input.workspace.projectPath,
    taskTitle: input.spec.taskTitle,
    taskDescription: input.spec.taskDescription,
    goal: input.sourceMessage.content,
    agent: input.spec.worker,
  })

  const lease = await createTaskRuntimeLease({
    workspace: input.workspace,
    run: input.run,
    taskId: task.id,
    worker: input.spec.worker,
    workerInstanceId: runtimeThread.workerInstanceId ?? null,
    projectPath: runtimeThread.projectPath,
  })

  const taskRoom = await roomController.ensureTaskThreadRoomFromInput({
    ownerId: input.ownerId,
    workspaceId: input.workspace.id,
    groupSessionId: input.groupSession.id,
    sessionId: runtimeThread.sessionId,
    runId: input.run.runId,
    taskId: task.id,
    taskThreadId: runtimeThread.taskThreadId,
    title: `任务：${input.spec.taskTitle}`,
    workspaceAgentId: input.spec.worker.id,
    workerInstanceId: runtimeThread.workerInstanceId ?? null,
    metadata: {
      runtimeLeaseId: lease?.id ?? null,
      sharedTaskRelativeRoot: runtimeThread.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: runtimeThread.sharedTaskSpecPath ?? null,
    },
  })

  const assignmentMetadata = {
    kind: 'coordinator.assign.dispatched',
    actionType: 'assign',
    runtimeType: input.runtimeType,
    runId: input.run.runId,
    taskId: task.id,
    taskThreadId: runtimeThread.taskThreadId,
    taskRoomId: taskRoom.id,
    childSessionId: runtimeThread.sessionId,
    targetWorkerId: input.spec.worker.id,
    targetWorkerName: input.spec.worker.name,
    runtimeLeaseId: lease?.id ?? null,
    taskTitle: input.spec.taskTitle,
    taskDescription: input.spec.taskDescription,
    reason: input.spec.action.reason ?? null,
    taskKey: input.spec.taskKey,
    dependsOn: input.spec.dependsOnKeys,
    dependencyTaskIds,
  }
  await roomService.appendTimelineEvent({
    roomId: input.groupRoomId,
    senderType: 'manager',
    type: 'task.assigned',
    body: input.spec.action.message || `Manager 已将任务「${input.spec.taskTitle}」派给 ${input.spec.worker.name}。`,
    metadata: assignmentMetadata,
  })
  const taskRoomWorkerParticipant = await resolveTaskRoomWorkerParticipant(taskRoom.id, input.spec.worker.id)
  const taskRoomAssignmentBody =
    input.spec.action.message ||
    `@${input.spec.worker.name} 请接手：${input.spec.taskTitle}\n\n${input.spec.taskDescription}`
  if (taskRoomWorkerParticipant) {
    await roomService.appendMentionTimelineEvent({
      roomId: taskRoom.id,
      mentionParticipantId: taskRoomWorkerParticipant.id,
      senderType: 'manager',
      type: 'task.assigned',
      body: taskRoomAssignmentBody,
      metadata: {
        ...assignmentMetadata,
        matrixExecutionBus: true,
        coordinationSource: 'matrix-mention',
        mentionParticipantId: taskRoomWorkerParticipant.id,
        workerInstanceId: taskRoomWorkerParticipant.workerInstanceId ?? runtimeThread.workerInstanceId ?? null,
      },
    })
  } else {
    await roomService.appendTimelineEvent({
      roomId: taskRoom.id,
      senderType: 'system',
      type: 'system',
      body: `任务房间缺少 ${input.spec.worker.name} 的 Worker participant，无法写入 Matrix @mention；已降级为普通派发事件。`,
      metadata: {
        kind: 'coordinator.assign.mention-missing',
        runId: input.run.runId,
        taskId: task.id,
        taskRoomId: taskRoom.id,
        targetWorkerId: input.spec.worker.id,
      },
    })
    await roomService.appendTimelineEvent({
      roomId: taskRoom.id,
      senderType: 'manager',
      type: 'task.assigned',
      body: taskRoomAssignmentBody,
      metadata: {
        ...assignmentMetadata,
        matrixExecutionBus: false,
        coordinationSource: 'service-dispatch-fallback',
      },
    })
  }

  await runController.markTaskAssigned(input.run, {
    taskId: task.id,
    title: input.spec.taskTitle,
    agentId: input.spec.worker.id,
    workerInstanceId: runtimeThread.workerInstanceId ?? null,
    childSessionId: runtimeThread.sessionId,
    taskThreadId: runtimeThread.taskThreadId,
    sharedTaskRelativeRoot: runtimeThread.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath: runtimeThread.sharedTaskSpecPath ?? null,
    extraPayload: {
      source: 'coordinator-runtime.assign',
      taskRoomId: taskRoom.id,
      runtimeLeaseId: lease?.id ?? null,
    },
  })
  await runtimeLeaseController.markReady(lease?.id, {
    cwd: lease?.cwd ?? null,
    homeDir: lease?.homeDir ?? null,
    configDir: lease?.configDir ?? null,
    cacheDir: lease?.cacheDir ?? null,
    tmpDir: lease?.tmpDir ?? null,
    dataDir: lease?.dataDir ?? null,
  })

  return {
    run: input.run,
    taskId: task.id,
    taskKey: input.spec.taskKey,
    dependencyTaskIds,
    taskTitle: input.spec.taskTitle,
    taskDescription: input.spec.taskDescription,
    worker: input.spec.worker,
    taskRoomId: taskRoom.id,
    taskThreadId: runtimeThread.taskThreadId,
    childSessionId: runtimeThread.sessionId,
    workerInstanceId: runtimeThread.workerInstanceId ?? null,
    runtimeLeaseId: lease?.id ?? null,
    sharedTaskRelativeRoot: runtimeThread.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath: runtimeThread.sharedTaskSpecPath ?? null,
    ownerId: input.ownerId,
    workerRuntime: input.workerRuntime,
  }
}

async function resolveTaskRoomWorkerParticipant(roomId: string, workspaceAgentId: string) {
  const [participant] = await db
    .select()
    .from(roomParticipants)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.workspaceAgentId, workspaceAgentId)))
    .limit(1)
  return participant ?? null
}

async function executeCoordinatorAssignBatch(input: {
  run: RunControllerRunContext
  tasks: PreparedCoordinatorAssignedTask[]
}) {
  const outcomes: WorkerTaskExecutionOutcome[] = []
  const outcomeByTaskId = new Map<string, WorkerTaskExecutionOutcome>()
  const layers = buildExecutionLayers(input.tasks)

  for (const layer of layers) {
    const runnable: PreparedCoordinatorAssignedTask[] = []
    for (const task of layer) {
      const blockedBy = task.dependencyTaskIds
        .map((taskId) => outcomeByTaskId.get(taskId))
        .filter((outcome) => outcome && outcome.status !== 'completed') as WorkerTaskExecutionOutcome[]
      if (blockedBy.length > 0) {
        const outcome = blockedBy.some((outcome) => outcome.status === 'waiting_for_human')
          ? await markTaskWaitingForHumanDependency({
              task,
              blockedBy,
            })
          : await markTaskSkippedByDependency({
              task,
              blockedBy,
            })
        outcomes.push(outcome)
        outcomeByTaskId.set(outcome.taskId, outcome)
      } else {
        runnable.push(task)
      }
    }
    const layerOutcomes = await Promise.all(runnable.map((task) => executeWorkerTaskRoom(task)))
    for (const outcome of layerOutcomes) {
      outcomes.push(outcome)
      outcomeByTaskId.set(outcome.taskId, outcome)
    }
  }

  const failed = outcomes.filter((outcome) => outcome.status === 'failed')
  const cancelled = outcomes.filter((outcome) => outcome.status === 'cancelled')
  const waitingForHuman = outcomes.filter((outcome) => outcome.status === 'waiting_for_human')
  if (waitingForHuman.length > 0 && failed.length === 0 && cancelled.length === 0) {
    await runController.markRunning(input.run, {
      taskCount: input.tasks.length,
    })
    await runController.reconcile(input.run)
    return outcomes
  }
  if (failed.length > 0) {
    await runController.finish(input.run, {
      status: 'failed',
      summary:
        failed.length === 1
          ? failed[0]?.message ?? 'A Worker task failed.'
          : `${failed.length}/${outcomes.length} 个 Worker 任务失败。`,
      payload: {
        source: 'coordinator-runtime.assign.batch',
        taskCount: outcomes.length,
        failedTaskIds: failed.map((outcome) => outcome.taskId),
      },
    })
    return outcomes
  }
  if (cancelled.length > 0) {
    await runController.finish(input.run, {
      status: 'cancelled',
      summary:
        cancelled.length === 1
          ? cancelled[0]?.message ?? 'A Worker task was cancelled.'
          : `${cancelled.length}/${outcomes.length} 个 Worker 任务被取消。`,
      payload: {
        source: 'coordinator-runtime.assign.batch',
        taskCount: outcomes.length,
        cancelledTaskIds: cancelled.map((outcome) => outcome.taskId),
      },
    })
    return outcomes
  }
  await runController.finish(input.run, {
    status: 'completed',
    summary:
      outcomes.length === 1
        ? outcomes[0]?.message ?? 'Worker task completed.'
        : `${outcomes.length} 个 Worker 任务已完成。`,
    payload: {
      source: 'coordinator-runtime.assign.batch',
      taskCount: outcomes.length,
      taskIds: outcomes.map((outcome) => outcome.taskId),
    },
  })
  return outcomes
}

async function markTaskSkippedByDependency(input: {
  task: PreparedCoordinatorAssignedTask
  blockedBy: WorkerTaskExecutionOutcome[]
}): Promise<WorkerTaskExecutionOutcome> {
  const message = `依赖任务未成功完成，跳过执行：${input.blockedBy.map((outcome) => outcome.taskId).join(', ')}`
  await roomService.appendTimelineEvent({
    roomId: input.task.taskRoomId,
    senderType: 'system',
    type: 'task.progress',
    body: message,
    metadata: {
      kind: 'worker-runtime.skipped-by-dependency',
      source: 'coordinator-runtime.assign',
      taskId: input.task.taskId,
      taskKey: input.task.taskKey,
      taskThreadId: input.task.taskThreadId,
      dependencyTaskIds: input.task.dependencyTaskIds,
      blockedBy: input.blockedBy.map((outcome) => ({
        taskId: outcome.taskId,
        status: outcome.status,
        message: outcome.message ?? null,
      })),
    },
  })
  await runController.markTaskFailed(input.task.run, {
    taskId: input.task.taskId,
    title: input.task.taskTitle,
    agentId: input.task.worker.id,
    error: message,
    progressStatus: 'skipped-by-dependency',
    childSessionId: input.task.childSessionId,
    taskThreadId: input.task.taskThreadId,
    workerInstanceId: input.task.workerInstanceId ?? null,
    runtimeLeaseId: input.task.runtimeLeaseId ?? null,
    sharedTaskRelativeRoot: input.task.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath: input.task.sharedTaskSpecPath ?? null,
    extraPayload: {
      source: 'coordinator-runtime.assign',
      taskRoomId: input.task.taskRoomId,
      taskKey: input.task.taskKey,
      dependencyTaskIds: input.task.dependencyTaskIds,
      skippedByDependency: true,
    },
    severity: 'warning',
  })
  await runtimeLeaseController.fail(input.task.runtimeLeaseId, {
    workerInstanceId: input.task.workerInstanceId ?? null,
    error: message,
    metadata: {
      resultStatus: 'skipped-by-dependency',
      dependencyTaskIds: input.task.dependencyTaskIds,
    },
  })
  return {
    taskId: input.task.taskId,
    status: 'failed',
    message,
  }
}

async function markTaskWaitingForHumanDependency(input: {
  task: PreparedCoordinatorAssignedTask
  blockedBy: WorkerTaskExecutionOutcome[]
}): Promise<WorkerTaskExecutionOutcome> {
  const waitingTaskIds = input.blockedBy
    .filter((outcome) => outcome.status === 'waiting_for_human')
    .map((outcome) => outcome.taskId)
  const message = `依赖任务正在等待用户澄清，当前任务暂停分发：${waitingTaskIds.join(', ')}`
  await roomService.appendTimelineEvent({
    roomId: input.task.taskRoomId,
    senderType: 'system',
    type: 'task.progress',
    body: message,
    metadata: {
      kind: 'worker-runtime.waiting-on-human-dependency',
      source: 'coordinator-runtime.assign',
      taskId: input.task.taskId,
      taskKey: input.task.taskKey,
      taskThreadId: input.task.taskThreadId,
      dependencyTaskIds: input.task.dependencyTaskIds,
      waitingTaskIds,
      blockedBy: input.blockedBy.map((outcome) => ({
        taskId: outcome.taskId,
        status: outcome.status,
        message: outcome.message ?? null,
      })),
    },
  })
  await runController.markTaskProgress(input.task.run, {
    taskId: input.task.taskId,
    title: input.task.taskTitle,
    agentId: input.task.worker.id,
    childSessionId: input.task.childSessionId,
    taskThreadId: input.task.taskThreadId,
    workerInstanceId: input.task.workerInstanceId ?? null,
    runtimeLeaseId: input.task.runtimeLeaseId ?? null,
    sharedTaskRelativeRoot: input.task.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath: input.task.sharedTaskSpecPath ?? null,
    percent: 0,
    progressStatus: 'waiting_on_dependency_human_clarification',
    severity: 'warning',
    extraPayload: {
      source: 'coordinator-runtime.assign',
      taskRoomId: input.task.taskRoomId,
      taskKey: input.task.taskKey,
      dependencyTaskIds: input.task.dependencyTaskIds,
      waitingTaskIds,
      waitingOnHumanDependency: true,
    },
  })
  return {
    taskId: input.task.taskId,
    status: 'waiting_for_human',
    message,
  }
}

async function executeWorkerTaskRoom(input: {
  run: RunControllerRunContext
  taskId: string
  taskTitle: string
  taskDescription: string
  worker: typeof workspaceAgents.$inferSelect
  taskRoomId: string
  taskThreadId: string
  childSessionId: string
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  ownerId: string
  workerRuntime?: WorkerRuntime
}): Promise<WorkerTaskExecutionOutcome> {
  const startedAt = Date.now()
  await runtimeLeaseController.markRunning(input.runtimeLeaseId, { startedAt: new Date() })
  await markWorkerInstanceState(input.workerInstanceId, 'busy', {
    message: `Running task ${input.taskTitle}.`,
  })
  await runController.markTaskActive(input.run, {
    taskId: input.taskId,
    title: input.taskTitle,
    agentId: input.worker.id,
    childSessionId: input.childSessionId,
    taskThreadId: input.taskThreadId,
    workerInstanceId: input.workerInstanceId ?? null,
    runtimeLeaseId: input.runtimeLeaseId ?? null,
    sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
    progressPercent: 5,
    progressStatus: 'worker-runtime-starting',
    extraPayload: {
      source: 'coordinator-runtime.assign',
      taskRoomId: input.taskRoomId,
    },
  })

  try {
    const result = await workerRuntimeService.runTaskRoom({
      roomId: input.taskRoomId,
      ownerId: input.ownerId,
      workspaceAgentId: input.worker.id,
      prompt: input.taskDescription,
      runtime: input.workerRuntime,
    })
    const durationMs = Date.now() - startedAt
    if (result.status === 'waiting_for_human') {
      const clarificationId =
        typeof result.metadata?.clarificationId === 'string'
          ? result.metadata.clarificationId
          : null
      const clarificationQuestion =
        typeof result.metadata?.clarificationQuestion === 'string'
          ? result.metadata.clarificationQuestion
          : result.message ?? null
      await runController.markTaskWaitingForHuman(input.run, {
        taskId: input.taskId,
        title: input.taskTitle,
        agentId: input.worker.id,
        question: clarificationQuestion,
        clarificationId,
        childSessionId: input.childSessionId,
        taskThreadId: input.taskThreadId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        artifacts: artifactsForRunController(result.artifacts),
        extraPayload: {
          source: 'coordinator-runtime.assign',
          taskRoomId: input.taskRoomId,
          timelineEventCount: result.appendedEventIds.length,
          message: result.message ?? null,
        },
      })
      await runtimeLeaseController.markWaitingForHuman(input.runtimeLeaseId, {
        workerInstanceId: input.workerInstanceId ?? null,
        message: clarificationQuestion,
        metadata: {
          resultStatus: result.status,
          clarificationId,
          clarificationQuestion,
          taskRoomId: input.taskRoomId,
        },
      })
      return {
        taskId: input.taskId,
        status: 'waiting_for_human',
        message: result.message ?? `${input.taskTitle} waiting for human clarification.`,
      }
    }
    if (result.status === 'completed') {
      await runController.markTaskCompleted(input.run, {
        taskId: input.taskId,
        title: input.taskTitle,
        agentId: input.worker.id,
        childSessionId: input.childSessionId,
        taskThreadId: input.taskThreadId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        durationMs,
        artifacts: artifactsForRunController(result.artifacts),
        extraPayload: {
          source: 'coordinator-runtime.assign',
          taskRoomId: input.taskRoomId,
          timelineEventCount: result.appendedEventIds.length,
          message: result.message ?? null,
        },
      })
      await runtimeLeaseController.release(input.runtimeLeaseId, {
        workerInstanceId: input.workerInstanceId ?? null,
        metadata: { resultStatus: result.status },
      })
      return {
        taskId: input.taskId,
        status: 'completed',
        message: result.message ?? `${input.taskTitle} completed.`,
      }
    }
    if (result.status === 'cancelled') {
      await runController.markTaskCancelled(input.run, {
        taskId: input.taskId,
        title: input.taskTitle,
        agentId: input.worker.id,
        reason: result.message ?? 'worker-runtime-cancelled',
        childSessionId: input.childSessionId,
        taskThreadId: input.taskThreadId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        extraPayload: {
          source: 'coordinator-runtime.assign',
          taskRoomId: input.taskRoomId,
        },
      })
      await runtimeLeaseController.release(input.runtimeLeaseId, {
        workerInstanceId: input.workerInstanceId ?? null,
        metadata: { resultStatus: result.status },
      })
      return {
        taskId: input.taskId,
        status: 'cancelled',
        message: result.message ?? `${input.taskTitle} cancelled.`,
      }
    }
    await runController.markTaskFailed(input.run, {
      taskId: input.taskId,
      title: input.taskTitle,
      agentId: input.worker.id,
      error: result.message ?? 'WorkerRuntime failed.',
      childSessionId: input.childSessionId,
      taskThreadId: input.taskThreadId,
      workerInstanceId: input.workerInstanceId ?? null,
      runtimeLeaseId: input.runtimeLeaseId ?? null,
      sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
      durationMs,
      artifacts: artifactsForRunController(result.artifacts),
      extraPayload: {
        source: 'coordinator-runtime.assign',
        taskRoomId: input.taskRoomId,
      },
    })
    await runtimeLeaseController.fail(input.runtimeLeaseId, {
      workerInstanceId: input.workerInstanceId ?? null,
      error: result.message ?? 'WorkerRuntime failed.',
      metadata: { resultStatus: result.status },
    })
    return {
      taskId: input.taskId,
      status: 'failed',
      message: result.message ?? `${input.taskTitle} failed.`,
    }
  } catch (error: any) {
    const message = error?.message || 'WorkerRuntime execution failed.'
    await roomService.appendTimelineEvent({
      roomId: input.taskRoomId,
      senderType: 'system',
      type: 'task.progress',
      body: `WorkerRuntime 执行失败：${message}`,
      metadata: {
        kind: 'worker-runtime.failed',
        source: 'coordinator-runtime.assign',
        taskId: input.taskId,
        taskThreadId: input.taskThreadId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        error: message,
      },
    })
    await runController.markTaskFailed(input.run, {
      taskId: input.taskId,
      title: input.taskTitle,
      agentId: input.worker.id,
      error: message,
      childSessionId: input.childSessionId,
      taskThreadId: input.taskThreadId,
      workerInstanceId: input.workerInstanceId ?? null,
      runtimeLeaseId: input.runtimeLeaseId ?? null,
      sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
      durationMs: Date.now() - startedAt,
      extraPayload: {
        source: 'coordinator-runtime.assign',
        taskRoomId: input.taskRoomId,
      },
    })
    await runtimeLeaseController.fail(input.runtimeLeaseId, {
      workerInstanceId: input.workerInstanceId ?? null,
      error: message,
    })
    return {
      taskId: input.taskId,
      status: 'failed',
      message,
    }
  }
}

async function createTaskRuntimeLease(input: {
  workspace: typeof workspaces.$inferSelect
  run: RunControllerRunContext
  taskId: string
  worker: typeof workspaceAgents.$inferSelect
  workerInstanceId?: string | null
  projectPath?: string | null
}) {
  const workdir = prepareAgentWorkdir({
    projectPath: input.projectPath,
    runId: input.run.runId,
    taskId: input.taskId,
    agentId: input.worker.id,
    agentName: input.worker.name,
    sandboxPolicy: input.worker.sandboxPolicy ?? 'workspace-write',
  })
  const root = resolve(
    agentHubUserCacheRoot(),
    'runtime-leases',
    safePathSegment(input.run.runId),
    safePathSegment(input.worker.name || input.worker.id),
    safePathSegment(input.taskId),
  )
  const homeDir = resolve(root, 'home')
  const configDir = resolve(root, 'config')
  const cacheDir = resolve(root, 'cache')
  const tmpDir = resolve(root, 'tmp')
  const dataDir = resolve(root, 'data')
  for (const path of [homeDir, configDir, cacheDir, tmpDir, dataDir]) {
    mkdirSync(path, { recursive: true })
  }
  return runtimeLeaseController.create({
    workspaceId: input.workspace.id,
    runId: input.run.runId,
    taskId: input.taskId,
    workerInstanceId: input.workerInstanceId ?? null,
    provider: 'local-workdir',
    cwd: workdir?.executionPath ?? input.workspace.projectPath ?? null,
    homeDir,
    configDir,
    cacheDir,
    tmpDir,
    dataDir,
    metadata: {
      source: 'coordinator-runtime.assign',
      workdirRelativePath: workdir?.relativePath ?? null,
      workspacePath: input.workspace.projectPath ?? null,
      sandboxPolicy: input.worker.sandboxPolicy ?? 'workspace-write',
    },
  })
}

async function resolveTargetWorker(input: { workspaceId: string; targetWorkerId?: string | null }) {
  const rows = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, input.workspaceId))
  const explicitTarget = input.targetWorkerId?.trim()
  if (explicitTarget) {
    const worker = rows.find((agent) => agent.id === explicitTarget || agent.name === explicitTarget)
    if (!worker) {
      throw AppError.fromCode(
        AppErrorCodes.AGENT_NOT_FOUND,
        `Manager 指定的 Worker 不存在：${explicitTarget}`,
      )
    }
    return worker
  }
  const worker =
    rows.find((agent) => agent.roleType !== 'orchestrator') ??
    null
  if (!worker) {
    throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Manager 没有可派发的 Worker')
  }
  return worker
}

async function resolveManagerAgent(workspaceId: string) {
  const [manager] = await db
    .select()
    .from(workspaceAgents)
    .where(and(eq(workspaceAgents.workspaceId, workspaceId), eq(workspaceAgents.roleType, 'orchestrator')))
    .limit(1)
  return manager ?? null
}

function buildAssignBatchPlan(input: {
  sourceMessage: typeof messages.$inferSelect
  specs: CoordinatorAssignSpec[]
}) {
  const uniqueWorkers = Array.from(
    new Map(input.specs.map((spec) => [spec.worker.id, spec.worker])).values(),
  )
  return {
    schema: 'agenthub.hiclaw-lite.assign-batch.v1',
    source: 'coordinator-runtime.assign',
    title:
      input.specs.length === 1
        ? input.specs[0]?.taskTitle ?? 'Manager assigned task'
        : `Manager assigned ${input.specs.length} worker tasks`,
    goal: input.sourceMessage.content,
    phases: [
      {
        id: 'phase-1',
        title: 'Manager assigned worker tasks',
        taskIds: input.specs.map((_, index) => `task-${index + 1}`),
      },
    ],
    agents: uniqueWorkers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      role: worker.role,
      runtimeType: worker.runtimeType,
      codeAgentType: worker.codeAgentType,
    })),
    tasks: input.specs.map((spec, index) => ({
      id: `task-${index + 1}`,
      taskKey: spec.taskKey,
      taskId: spec.taskId,
      title: spec.taskTitle,
      description: spec.taskDescription,
      agentId: spec.worker.id,
      dependsOn: spec.dependsOnKeys,
      dependencies: spec.dependsOnKeys.map((key) => input.specs.find((candidate) => candidate.taskKey === key)?.taskId).filter(Boolean),
      reason: spec.action.reason ?? null,
    })),
    decision: {
      action: 'assign',
      reasons: input.specs.map((spec) => spec.action.reason ?? null),
      messages: input.specs.map((spec) => spec.action.message ?? null),
    },
  }
}

function normalizeTaskKey(value: string | undefined, index: number) {
  const key = value?.trim()
  return key || `task-${index + 1}`
}

function normalizeDependencyKeys(value: string[] | undefined) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean)))
}

function validateAssignGraph(specs: CoordinatorAssignSpec[]) {
  const taskIdByKey = new Map<string, string>()
  for (const spec of specs) {
    if (taskIdByKey.has(spec.taskKey)) {
      throw AppError.fromCode(
        AppErrorCodes.VALIDATION_FAILED,
        `Coordinator assign taskKey 重复：${spec.taskKey}`,
      )
    }
    taskIdByKey.set(spec.taskKey, spec.taskId)
  }
  for (const spec of specs) {
    for (const key of spec.dependsOnKeys) {
      if (!taskIdByKey.has(key)) {
        throw AppError.fromCode(
          AppErrorCodes.VALIDATION_FAILED,
          `Coordinator assign 依赖不存在：${spec.taskKey} dependsOn ${key}`,
        )
      }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string) => {
    if (visited.has(key)) return
    if (visiting.has(key)) {
      throw AppError.fromCode(
        AppErrorCodes.VALIDATION_FAILED,
        `Coordinator assign 依赖存在环：${key}`,
      )
    }
    visiting.add(key)
    const spec = specs.find((candidate) => candidate.taskKey === key)
    for (const dependency of spec?.dependsOnKeys ?? []) visit(dependency)
    visiting.delete(key)
    visited.add(key)
  }
  for (const spec of specs) visit(spec.taskKey)
  return taskIdByKey
}

function buildExecutionLayers(tasks: PreparedCoordinatorAssignedTask[]) {
  const remaining = new Map(tasks.map((task) => [task.taskId, task]))
  const completed = new Set<string>()
  const layers: PreparedCoordinatorAssignedTask[][] = []
  while (remaining.size > 0) {
    const layer = Array.from(remaining.values()).filter((task) =>
      task.dependencyTaskIds.every((dependencyTaskId) => completed.has(dependencyTaskId)),
    )
    if (layer.length === 0) {
      throw AppError.fromCode(
        AppErrorCodes.VALIDATION_FAILED,
        'Coordinator assign dependency graph cannot be scheduled.',
      )
    }
    layers.push(layer)
    for (const task of layer) {
      remaining.delete(task.taskId)
      completed.add(task.taskId)
    }
  }
  return layers
}

function artifactsForRunController(value: unknown) {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
}
