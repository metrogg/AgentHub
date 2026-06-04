import { randomUUID } from 'node:crypto'
import {
  and,
  asc,
  db,
  eq,
  artifacts,
  orchestratorRuns,
  roomParticipants,
  runtimeLeases,
  sessions,
  taskThreads,
  workerInstances,
  workspaceAgents,
  workspaces,
  workspaceTasks,
} from '@agenthub/db'
import { TaskStatus } from '@agenthub/shared'
import { cancelAgentReply } from '../agent-runner'
import { blackboard, Blackboard } from '../blackboard'
import { appendHumanInterruptConstraint } from './human-interrupts'
import { emitRunEvent } from './run-events'
import { roomService } from '../rooms'
import { updateTaskThreadStatus } from './task-thread-service'
import type { ExecutionPlan } from './types'
import { runtimeLeaseController } from './runtime-lease-controller'
import { markWorkerInstanceState } from './worker-runtime-resources'
import { readSharedTaskResult } from './shared-task-directory'
import type { WorkerRuntime } from '../worker-runtime/types'
import { buildManagerResourceReviewSummary } from '../manager-runtime/final-review-skill'
import { managerRuntimeService, getActiveManagerProvider } from '../manager-runtime'

export interface ManagerDecisionEventContext {
  action: string
  reason?: string | null
  message?: string | null
  memberProposalCount?: number
}

export interface ManagerLoopRunContext {
  runId: string
}

interface HumanInterruptRecord {
  kind?: string
  messageId?: string
  content?: string
  actorId?: string
  actorType?: string
  createdAt?: string
}

export interface ProcessPendingHumanInterruptsResult {
  processedMessageIds: string[]
  updatedTaskIds: string[]
  reworkRequestedTaskIds: string[]
  interruptedActiveTaskIds: string[]
}

export async function startManagerLoopRun(input: {
  workspaceId: string
  groupSessionId: string
  goal: string
  orchestratorAgent?: {
    id?: string | null
    name?: string | null
  } | null
  decision?: ManagerDecisionEventContext | null
}): Promise<ManagerLoopRunContext> {
  const runId = randomUUID()
  const actorAgentId = input.orchestratorAgent?.id ?? null
  const actorName = input.orchestratorAgent?.name ?? 'Orchestrator'

  await db.insert(orchestratorRuns).values({
    id: runId,
    workspaceId: input.workspaceId,
    groupSessionId: input.groupSessionId,
    status: 'planning',
    plan: null,
  })

  await emitRunEvent({
    runId,
    workspaceId: input.workspaceId,
    groupSessionId: input.groupSessionId,
    agentId: actorAgentId,
    type: 'run.started',
    payload: { goal: input.goal, status: 'planning' },
  })
  await emitRunEvent({
    runId,
    workspaceId: input.workspaceId,
    groupSessionId: input.groupSessionId,
    agentId: actorAgentId,
    type: 'manager.thinking',
    payload: {
      actorAgentId,
      actorName,
      stage: 'planning',
      message: 'Manager 正在理解目标并准备动态分工。',
    },
  })

  if (input.decision) {
    await emitManagerDecisionEvents({
      runId,
      workspaceId: input.workspaceId,
      groupSessionId: input.groupSessionId,
      actorAgentId,
      actorName,
      decision: input.decision,
    })
  }

  return { runId }
}

export async function emitManagerDecisionEvents(input: {
  runId: string
  workspaceId: string
  groupSessionId: string
  actorAgentId?: string | null
  actorName?: string | null
  decision: ManagerDecisionEventContext
}) {
  const actorName = input.actorName ?? 'Orchestrator'
  await emitRunEvent({
    runId: input.runId,
    workspaceId: input.workspaceId,
    groupSessionId: input.groupSessionId,
    agentId: input.actorAgentId ?? null,
    type: 'manager.intent_observed',
    payload: {
      actorAgentId: input.actorAgentId ?? null,
      actorName,
      action: input.decision.action,
      reason: input.decision.reason ?? null,
      message: input.decision.message ?? null,
      memberProposalCount: input.decision.memberProposalCount ?? 0,
    },
  })
  await emitRunEvent({
    runId: input.runId,
    workspaceId: input.workspaceId,
    groupSessionId: input.groupSessionId,
    agentId: input.actorAgentId ?? null,
    type: 'manager.next_action',
    payload: {
      actorAgentId: input.actorAgentId ?? null,
      actorName,
      action: input.decision.action,
      reason: input.decision.reason ?? null,
      message: input.decision.message ?? null,
      memberProposalCount: input.decision.memberProposalCount ?? 0,
    },
  })
}

export async function processPendingHumanInterrupts(input: {
  run: {
    runId: string
    workspaceId: string
    groupSessionId: string
    actor?: {
      id?: string | null
      name?: string | null
    } | null
  }
}): Promise<ProcessPendingHumanInterruptsResult> {
  const namespace = Blackboard.namespace(input.run.workspaceId, input.run.runId)
  const terminalTaskStatuses = new Set(['done', 'failed', 'cancelled', 'skipped'])
  const interrupts = await blackboard.query({
    namespace,
    keyPattern: 'human_interrupts/%',
    orderBy: 'asc',
    limit: 50,
  })
  const [runRow] = await db
    .select({ plan: orchestratorRuns.plan })
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.id, input.run.runId))
    .limit(1)
  const persistedPlan = (runRow?.plan as ExecutionPlan | null) ?? null
  const [workspaceOwner] = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, input.run.workspaceId))
    .limit(1)
  const ownerId = workspaceOwner?.ownerId ?? null

  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.runId, input.run.runId))
    .orderBy(asc(workspaceTasks.orderIdx), asc(workspaceTasks.createdAt))

  const threads = await db
    .select()
    .from(taskThreads)
    .where(eq(taskThreads.runId, input.run.runId))
    .orderBy(asc(taskThreads.createdAt))

  const threadByTaskId = new Map(threads.map((thread) => [thread.taskId, thread]))
  const processedMessageIds: string[] = []
  const updatedTaskIds = new Set<string>()
  const reworkRequestedTaskIds = new Set<string>()
  const interruptedActiveTaskIds = new Set<string>()

  for (const entry of interrupts) {
    const payload = (entry.value ?? {}) as HumanInterruptRecord
    const messageId = typeof payload.messageId === 'string' ? payload.messageId : null
    const content = typeof payload.content === 'string' ? payload.content.trim() : ''
    if (!messageId || !content) continue

    const actionKey = `manager_actions/human_interrupts/${messageId}`
    const existingAction = await blackboard.read(namespace, actionKey)
    if (existingAction) continue

    const liveTasks = tasks.filter((task) =>
      !terminalTaskStatuses.has(task.status),
    )

    const changedTaskIds: string[] = []
    const entryReworkRequestedTaskIds: string[] = []
    for (const task of liveTasks) {
      const nextDescription = appendHumanInterruptConstraint(task.description, { messageId, content })
      if (nextDescription === task.description) continue

      await db
        .update(workspaceTasks)
        .set({
          description: nextDescription,
          progressStatus:
            task.status === TaskStatus.Pending || task.status === TaskStatus.Blocked
              ? 'Manager merged a new human requirement and is continuing with revised constraints.'
              : task.progressStatus ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(workspaceTasks.id, task.id))

      task.description = nextDescription
      if (task.status === TaskStatus.Pending || task.status === TaskStatus.Blocked) {
        task.progressStatus =
          'Manager merged a new human requirement and is continuing with revised constraints.'
      }
      changedTaskIds.push(task.id)
      updatedTaskIds.add(task.id)
    }

    if (ownerId) {
      await appendGroupHumanInterruptTimeline({
        ownerId,
        groupSessionId: input.run.groupSessionId,
        runId: input.run.runId,
        actorName: input.run.actor?.name ?? 'Manager',
        messageId,
        content,
        changedTaskIds,
      })
    }

    if (persistedPlan?.tasks?.length && changedTaskIds.length > 0) {
      const changedTaskIdSet = new Set(changedTaskIds)
      let planChanged = false
      for (const task of persistedPlan.tasks) {
        if (!changedTaskIdSet.has(task.id)) continue
        const updatedTask = tasks.find((item) => item.id === task.id)
        if (!updatedTask || updatedTask.description === task.description) continue
        task.description = updatedTask.description
        planChanged = true
      }
      if (planChanged) {
        await db
          .update(orchestratorRuns)
          .set({
            plan: persistedPlan as unknown as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(orchestratorRuns.id, input.run.runId))
      }
    }

    const activeThreadsToInterrupt = liveTasks
      .map((task) => ({ task, thread: threadByTaskId.get(task.id) ?? null }))
      .filter(
        (item): item is { task: (typeof tasks)[number]; thread: (typeof threads)[number] } =>
          item.thread !== null && item.thread.status === 'active',
      )
    const entryInterruptedActiveTaskIds: string[] = []
    if (activeThreadsToInterrupt.length > 0) {
      await emitRunEvent({
        runId: input.run.runId,
        workspaceId: input.run.workspaceId,
        groupSessionId: input.run.groupSessionId,
        agentId: input.run.actor?.id ?? null,
        type: 'manager.next_action',
        severity: 'warning',
        payload: {
          action: 'interrupting_active_workers',
          reason: 'Manager is stopping active workers so the new human requirement can take effect.',
          interruptMessageId: messageId,
          interruptedTaskIds: activeThreadsToInterrupt.map((item) => item.task.id),
        },
      })
    }

    for (const { task, thread } of activeThreadsToInterrupt) {
      cancelAgentReply(thread.sessionId)
      interruptedActiveTaskIds.add(task.id)
      entryInterruptedActiveTaskIds.push(task.id)

      const leases = await db
        .select()
        .from(runtimeLeases)
        .where(and(eq(runtimeLeases.runId, input.run.runId), eq(runtimeLeases.taskId, task.id)))

      for (const lease of leases) {
        if (!['creating', 'ready', 'running', 'cleaning'].includes(lease.status)) continue
        await runtimeLeaseController.markStale(lease.id, {
          error: 'Manager interrupted active task after a new human requirement.',
          metadata: {
            previousStatus: lease.status,
            interruptMessageId: messageId,
            interruptedBy: input.run.actor?.id ?? null,
            reason: 'human_interrupt',
          },
        })
      }

      await markWorkerInstanceState(thread.workerInstanceId ?? null, 'idle', {
        message: 'Manager interrupted the active task after a new human requirement.',
        health: {
          interruptedByHumanRequirement: true,
          interruptMessageId: messageId,
        },
      })

      await db
        .update(workspaceTasks)
        .set({
          status: TaskStatus.Pending,
          startedAt: null,
          completedAt: null,
          errorLog: 'Manager interrupted active work after a new human requirement.',
          progressPercent: 0,
          progressStatus: 'thread-prepared',
          updatedAt: new Date(),
        })
        .where(eq(workspaceTasks.id, task.id))
      await updateTaskThreadStatus(thread.id, 'prepared')
      if (ownerId) {
        await appendTaskHumanInterruptTimeline({
          ownerId,
          taskThreadId: thread.id,
          taskId: task.id,
          messageId,
          content,
          status: 'interrupted',
          body: 'Manager 收到新的人工补充要求，已暂停当前执行并准备按新约束重新推进。',
        })
      }
    }

    for (const task of liveTasks) {
      const thread = threadByTaskId.get(task.id)
      if (!thread) continue
      if (!['prepared', 'assigned', 'active'].includes(thread.status)) continue

      await emitRunEvent({
        runId: input.run.runId,
        workspaceId: input.run.workspaceId,
        groupSessionId: input.run.groupSessionId,
        taskId: task.id,
        threadId: thread.id,
        workerInstanceId: thread.workerInstanceId ?? null,
        agentId: task.agentId ?? null,
        type: 'task.rework_requested',
        severity: 'warning',
        payload: {
          taskId: task.id,
          taskTitle: task.title,
          childSessionId: thread.sessionId,
          taskThreadId: thread.id,
          taskThreadStatus: thread.status,
          interruptMessageId: messageId,
          interruptContentPreview: content.slice(0, 200),
          reason: 'human_interrupt',
          agentName: null,
        },
      })
      reworkRequestedTaskIds.add(task.id)
      entryReworkRequestedTaskIds.push(task.id)
      if (ownerId) {
        await appendTaskHumanInterruptTimeline({
          ownerId,
          taskThreadId: thread.id,
          taskId: task.id,
          messageId,
          content,
          status: 'rework_requested',
          body: 'Manager 已把新的人工补充要求同步到这个任务房间，后续执行需要遵守该约束。',
        })
      }
    }

    await emitRunEvent({
      runId: input.run.runId,
      workspaceId: input.run.workspaceId,
      groupSessionId: input.run.groupSessionId,
      agentId: input.run.actor?.id ?? null,
      type: 'run.replanned',
      severity: 'warning',
      payload: {
        strategy: 'human_interrupt',
        reason: 'Human updated requirements while the run is active.',
        changedTaskIds,
        interruptMessageId: messageId,
        memoryPlanUpdated: false,
        coordinationSource: 'room-timeline',
        reworkRequestedTaskIds: entryReworkRequestedTaskIds,
        interruptedActiveTaskIds: entryInterruptedActiveTaskIds,
      },
    })

    const groupSummary =
      changedTaskIds.length > 0
        ? `我已经把这条补充要求并入 ${changedTaskIds.length} 个未完成任务，并继续按新的约束推进当前协作。`
        : '我已经记录这条补充要求，当前没有可继续调整的未完成任务，我会把它带入后续总结和补充规划。'

    await persistManagerLoopMessage({
      sessionId: input.run.groupSessionId,
      senderId: input.run.actor?.id ?? 'system',
      senderType: input.run.actor?.id ? 'agent' : 'system',
      content: groupSummary,
      metadata: {
        kind: 'manager-human-interrupt-applied',
        systemEvent: 'manager_human_interrupt_applied',
        orchestratorRunId: input.run.runId,
        sourceMessageId: messageId,
        changedTaskIds,
        reworkRequestedTaskIds: entryReworkRequestedTaskIds,
        interruptedActiveTaskIds: entryInterruptedActiveTaskIds,
        memoryPlanUpdated: false,
        coordinationSource: 'room-timeline',
      },
    })

    await blackboard.write({
      namespace,
      key: actionKey,
      value: {
        kind: 'human_interrupt_applied',
        sourceKey: entry.key,
        messageId,
        changedTaskIds,
        reworkRequestedTaskIds: entryReworkRequestedTaskIds,
        interruptedActiveTaskIds: entryInterruptedActiveTaskIds,
        memoryPlanUpdated: false,
        coordinationSource: 'room-timeline',
        processedAt: new Date().toISOString(),
      },
      agentId: input.run.actor?.id ?? undefined,
      tags: ['human-interrupt', 'manager-action'],
    })

    processedMessageIds.push(messageId)
  }

  return {
    processedMessageIds,
    updatedTaskIds: [...updatedTaskIds],
    reworkRequestedTaskIds: [...reworkRequestedTaskIds],
    interruptedActiveTaskIds: [...interruptedActiveTaskIds],
  }
}

async function persistManagerLoopMessage(input: {
  sessionId: string
  senderId: string
  senderType: 'agent' | 'system'
  content: string
  metadata: Record<string, unknown>
}) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, input.sessionId)).limit(1)
  if (!session) return null
  const room = await roomService.ensureRoomForSession(session.id, session.ownerId)
  const event = await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: input.senderType === 'system' ? 'system' : 'manager',
    type: input.senderType === 'system' ? 'system' : 'manager.message',
    body: input.content,
    metadata: {
      ...input.metadata,
      source: 'manager-loop',
      legacyMessageProjectionDisabled: true,
    },
  })

  return {
    id: `room:${event.id}`,
    sessionId: input.sessionId,
    senderId: input.senderId,
    senderType: input.senderType,
    type: 'text',
    content: input.content,
    metadata: input.metadata,
    isPinned: false,
    replyToMessageId: null,
    createdAt: event.createdAt,
  }
}

async function appendGroupHumanInterruptTimeline(input: {
  ownerId: string
  groupSessionId: string
  runId: string
  actorName: string
  messageId: string
  content: string
  changedTaskIds: string[]
}) {
  const groupRoom = await roomService.ensureRoomForSession(input.groupSessionId, input.ownerId)
  await roomService.appendTimelineEvent({
    roomId: groupRoom.id,
    senderType: 'manager',
    type: 'manager.message',
    body:
      input.changedTaskIds.length > 0
        ? `${input.actorName} 已收到新的人工补充要求，并把它并入 ${input.changedTaskIds.length} 个未完成任务。`
        : `${input.actorName} 已收到新的人工补充要求，并会把它带入后续协作。`,
    metadata: {
      kind: 'human_interrupt_applied',
      runId: input.runId,
      sourceMessageId: input.messageId,
      changedTaskIds: input.changedTaskIds,
      contentPreview: input.content.slice(0, 500),
      coordinationSource: 'room-timeline',
    },
  })
}

async function appendTaskHumanInterruptTimeline(input: {
  ownerId: string
  taskThreadId: string
  taskId: string
  messageId: string
  content: string
  status: 'interrupted' | 'rework_requested'
  body: string
}) {
  const taskRoomInput = await roomService.buildTaskThreadRoomInput(input.taskThreadId, input.ownerId)
  const taskRoom = await roomService.ensureRoomForTaskThread(taskRoomInput)
  await roomService.appendTimelineEvent({
    roomId: taskRoom.id,
    senderType: 'manager',
    type: 'task.progress',
    body: input.body,
    metadata: {
      kind: 'human_interrupt_task_update',
      taskId: input.taskId,
      taskThreadId: input.taskThreadId,
      sourceMessageId: input.messageId,
      status: input.status,
      contentPreview: input.content.slice(0, 500),
      coordinationSource: 'room-timeline',
    },
  })
}

interface CompletedRunReviewInput {
  ctx: StepContext
  tasks: Array<typeof workspaceTasks.$inferSelect>
  threads: Array<typeof taskThreads.$inferSelect>
}

interface CompletedRunReviewResult {
  reason: string
  summary: string
  summaryMessageId: string | null
  finalStatus: 'completed' | 'failed'
}

async function synthesizeCompletedRunFromResources(
  input: CompletedRunReviewInput,
): Promise<CompletedRunReviewResult> {
  const { ctx, tasks, threads } = input
  const [run] = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.id, ctx.runId))
    .limit(1)
  if (!run || run.status !== 'running') {
    return {
      reason: `Run status is ${run?.status ?? 'missing'}; final review skipped.`,
      summary: '',
      summaryMessageId: run?.summaryMessageId ?? null,
      finalStatus: run?.status === 'failed' ? 'failed' : 'completed',
    }
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1)
  const taskIds = new Set(tasks.map((task) => task.id))
  const agentIds = new Set(tasks.map((task) => task.agentId).filter((id): id is string => Boolean(id)))
  const [artifactRows, agentRows] = await Promise.all([
    db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, ctx.runId))
      .orderBy(asc(artifacts.createdAt)),
    agentIds.size > 0 ? db.select().from(workspaceAgents) : Promise.resolve([]),
  ])
  const agentNameById = new Map(
    agentRows
      .filter((agent) => agentIds.has(agent.id))
      .map((agent) => [agent.id, agent.name] as const),
  )
  const threadByTaskId = new Map(threads.map((thread) => [thread.taskId, thread] as const))
  const timelineByTaskId = new Map<string, Awaited<ReturnType<typeof roomService.listTimelineEvents>>>()
  for (const thread of threads) {
    if (!taskIds.has(thread.taskId)) continue
    try {
      const taskRoomInput = await roomService.buildTaskThreadRoomInput(thread.id, workspace?.ownerId ?? '')
      const room = await roomService.ensureRoomForTaskThread(taskRoomInput)
      timelineByTaskId.set(
        thread.taskId,
        await roomService.listTimelineEvents({ roomId: room.id, limit: 200 }),
      )
    } catch {
      // Final review should be transparent even if a legacy task lacks a task room.
    }
  }

  const sharedResults = new Map<string, Awaited<ReturnType<typeof readSharedTaskResult>>>()
  const childSessions =
    threads.length > 0
      ? await db.select().from(sessions)
      : []
  const sessionMetadataById = new Map(childSessions.map((session) => [session.id, session.metadata] as const))
  for (const task of tasks) {
    const thread = threadByTaskId.get(task.id)
    const metadata = thread ? sessionMetadataById.get(thread.sessionId) : null
    const sharedTaskRelativeRoot = stringValue(metadata?.sharedTaskRelativeRoot)
    if (!sharedTaskRelativeRoot) {
      sharedResults.set(task.id, null)
      continue
    }
    sharedResults.set(
      task.id,
      await readSharedTaskResult({
        projectPath: workspace?.projectPath ?? null,
        sharedTaskRelativeRoot,
      }).catch(() => null),
    )
  }

  const summary = buildManagerResourceReviewSummary({
    goal: goalFromPlan(run.plan) ?? workspace?.goal ?? null,
    tasks,
    threads,
    artifactRows,
    agentNameById,
    timelineByTaskId,
    sharedResults,
  })
  const doneCount = tasks.filter((task) => task.status === TaskStatus.Done).length
  const failedCount = tasks.filter((task) => task.status === TaskStatus.Failed).length
  const cancelledCount = tasks.filter((task) => task.status === TaskStatus.Cancelled).length
  const blockedCount = tasks.filter((task) => task.status === TaskStatus.Blocked).length
  const finalStatus: 'completed' | 'failed' =
    failedCount > 0 || cancelledCount > 0 || blockedCount > 0 ? 'failed' : 'completed'

  await markRunSynthesizing(ctx, {
    artifactCount: artifactRows.length,
    taskCount: tasks.length,
    summary: `Manager reviewed ${tasks.length} terminal task(s).`,
  })
  const groupRoom = workspace?.ownerId
    ? await roomService.ensureRoomForSession(ctx.groupSessionId, workspace.ownerId)
    : null
  if (groupRoom) {
    await roomService.appendTimelineEvent({
      roomId: groupRoom.id,
      senderType: 'manager',
      type: 'manager.message',
      body: summary,
      metadata: {
        kind: 'manager-final-review',
        runId: ctx.runId,
        finalStatus,
        doneCount,
        failedCount,
        cancelledCount,
        blockedCount,
        artifactCount: artifactRows.length,
        coordinationSource: 'coordinator-runtime.resource-review',
      },
    })
  }
  const message = await persistManagerLoopMessage({
    sessionId: ctx.groupSessionId,
    senderId: ctx.actorId ?? 'system',
    senderType: ctx.actorId ? 'agent' : 'system',
    content: summary,
    metadata: {
      kind: 'manager-final-review',
      systemEvent: 'manager_final_review',
      orchestratorRunId: ctx.runId,
      finalStatus,
      doneCount,
      failedCount,
      cancelledCount,
      blockedCount,
      artifactCount: artifactRows.length,
      coordinationSource: 'coordinator-runtime.resource-review',
    },
  })
  await finishRunFromManager(ctx, {
    status: finalStatus,
    summary,
    summaryMessageId: message?.id ?? null,
    payload: {
      doneCount,
      failedCount,
      cancelledCount,
      blockedCount,
      artifactCount: artifactRows.length,
      reviewedTaskIds: tasks.map((task) => task.id),
      coordinationSource: 'coordinator-runtime.resource-review',
    },
  })

  return {
    reason: `All ${tasks.length} tasks reached terminal state (${doneCount} done, ${failedCount} failed, ${cancelledCount} cancelled, ${blockedCount} blocked). Manager final review completed.`,
    summary,
    summaryMessageId: message?.id ?? null,
    finalStatus,
  }
}

async function markRunSynthesizing(
  ctx: StepContext,
  input: { artifactCount: number; taskCount: number; summary: string },
) {
  await db
    .update(orchestratorRuns)
    .set({
      status: 'synthesizing',
      updatedAt: new Date(),
    })
    .where(eq(orchestratorRuns.id, ctx.runId))
  await emitRunEvent({
    runId: ctx.runId,
    workspaceId: ctx.workspaceId,
    groupSessionId: ctx.groupSessionId,
    agentId: ctx.actorId,
    type: 'run.synthesizing',
    payload: input,
  })
  const [workspace] = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .limit(1)
  if (workspace?.ownerId) {
    const groupRoom = await roomService.ensureRoomForSession(ctx.groupSessionId, workspace.ownerId)
    await roomService.appendTimelineEvent({
      roomId: groupRoom.id,
      senderType: 'manager',
      type: 'manager.message',
      body: input.summary,
      metadata: {
        kind: 'manager-review-started',
        runId: ctx.runId,
        status: 'synthesizing',
        taskCount: input.taskCount,
        artifactCount: input.artifactCount,
        coordinationSource: 'coordinator-runtime.resource-review',
      },
    })
  }
}

async function finishRunFromManager(
  ctx: StepContext,
  input: {
    status: 'completed' | 'failed'
    summary: string
    summaryMessageId: string | null
    payload: Record<string, unknown>
  },
) {
  await db
    .update(orchestratorRuns)
    .set({
      status: input.status,
      summaryMessageId: input.summaryMessageId,
      updatedAt: new Date(),
    })
    .where(eq(orchestratorRuns.id, ctx.runId))
  await emitRunEvent({
    runId: ctx.runId,
    workspaceId: ctx.workspaceId,
    groupSessionId: ctx.groupSessionId,
    agentId: ctx.actorId,
    type: input.status === 'completed' ? 'run.completed' : 'run.failed',
    severity: input.status === 'completed' ? 'info' : 'warning',
    payload: {
      summary: input.summary,
      summaryMessageId: input.summaryMessageId,
      status: input.status,
      ...input.payload,
    },
  })
}

function goalFromPlan(plan: unknown): string | null {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null
  return stringValue((plan as Record<string, unknown>).goal)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * ManagerLoopStepResult — the outcome of one HiClaw-style Observe → Think → Act cycle.
 *
 * In HiClaw, the Manager doesn't just react to user messages. It continuously:
 *   1. Observe: check WorkLedger, TaskThreads, WorkerInstances
 *   2. Think:   decide the next action
 *   3. Act:     execute the action
 *   4. Review:  verify outcomes
 *   5. Adjust:  update ledger, retry, reassign
 *
 * ManagerLoop.step() brings this cycle to AgentHub as a discrete, callable unit.
 */
export interface ManagerLoopStepResult {
  action: 'dispatch_pending' | 'review_running' | 'synthesize' | 'waiting' | 'blocked' | 'completed' | 'llm_driven'
  reason: string
  dispatchedTaskIds: string[]
  reviewedTaskIds: string[]
  completedRun: boolean
}

export interface ManagerLoopStepOptions {
  workerRuntime?: WorkerRuntime
  executeInline?: boolean
}

interface WorkerRuntimeDispatcher {
  rerunTaskRoom(input: {
    roomId: string
    ownerId: string
    workspaceAgentId?: string | null
    prompt?: string | null
    runtime?: WorkerRuntime
    source?: string
    signal?: AbortSignal
  }): Promise<{ status: string }>
}

interface StepContext {
  runId: string
  workspaceId: string
  groupSessionId: string
  actorId: string | null
  actorName: string
}

async function dispatchPreparedTaskRooms(input: {
  ctx: StepContext
  tasks: Array<typeof workspaceTasks.$inferSelect>
  threadByTaskId: Map<string, typeof taskThreads.$inferSelect>
  runtime?: WorkerRuntime
  executeInline: boolean
}): Promise<string[]> {
  const [workspace] = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, input.ctx.workspaceId))
    .limit(1)
  const ownerId = workspace?.ownerId ?? null
  if (!ownerId) {
    await emitRunEvent({
      runId: input.ctx.runId,
      workspaceId: input.ctx.workspaceId,
      groupSessionId: input.ctx.groupSessionId,
      agentId: input.ctx.actorId,
      type: 'manager.next_action',
      severity: 'warning',
      payload: {
        action: 'dispatch_blocked',
        reason: 'Manager could not dispatch task rooms because the workspace owner was not found.',
        coordinationSource: 'room-timeline',
      },
    })
    return []
  }

  const dispatcher = await loadWorkerRuntimeDispatcher()
  const dispatchedTaskIds: string[] = []
  const backgroundJobs: Array<Promise<unknown>> = []

  for (const task of input.tasks) {
    const thread = input.threadByTaskId.get(task.id)
    if (!thread) {
      await markPendingTaskDispatchBlocked(input.ctx, task, {
        reason: 'missing_task_thread',
        message: 'Manager 尚未找到这个任务的一等 TaskThread 资源，不能通过 WorkerRuntime 派发。',
      })
      continue
    }
    const workspaceAgentId = thread.workspaceAgentId ?? task.agentId ?? null
    if (!workspaceAgentId) {
      await markPendingTaskDispatchBlocked(input.ctx, task, {
        thread,
        reason: 'missing_worker',
        message: '任务房间还没有绑定 Worker，Manager 暂不能派发。',
      })
      continue
    }

    const roomInput = await roomService.buildTaskThreadRoomInput(thread.id, ownerId)
    const room = await roomService.ensureRoomForTaskThread(roomInput)
    await ensureWorkerParticipantForDispatch(room.id, workspaceAgentId)
    await updateTaskThreadStatus(thread.id, 'assigned')

    const assignedEvent = await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'manager',
      type: 'task.assigned',
      body: `Manager 正式派发任务：${task.title}`,
      metadata: {
        kind: 'manager-loop.dispatch',
        runId: input.ctx.runId,
        taskId: task.id,
        taskThreadId: thread.id,
        workspaceAgentId,
        taskDescription: task.description,
        coordinationSource: 'room-timeline',
      },
    })

    await emitRunEvent({
      runId: input.ctx.runId,
      workspaceId: input.ctx.workspaceId,
      groupSessionId: input.ctx.groupSessionId,
      taskId: task.id,
      threadId: thread.id,
      workerInstanceId: thread.workerInstanceId ?? null,
      agentId: workspaceAgentId,
      type: 'task.assigned',
      payload: {
        title: task.title,
        taskTitle: task.title,
        childSessionId: thread.sessionId,
        taskThreadId: thread.id,
        taskThreadStatus: 'assigned',
        taskRoomId: room.id,
        timelineEventId: assignedEvent.id,
        coordinationSource: 'room-timeline',
      },
    })

    const runWorker = dispatcher
      .rerunTaskRoom({
        roomId: room.id,
        ownerId,
        workspaceAgentId,
        prompt: task.description,
        runtime: input.runtime,
        source: 'manager-loop.dispatch-pending',
      })
      .catch((error: any) =>
        recordTaskRoomDispatchFailure({
          ctx: input.ctx,
          roomId: room.id,
          task,
          thread,
          workspaceAgentId,
          error,
        }),
      )
    dispatchedTaskIds.push(task.id)
    if (input.executeInline) {
      await runWorker
    } else {
      backgroundJobs.push(runWorker)
    }
  }

  if (!input.executeInline && backgroundJobs.length > 0) {
    Promise.allSettled(backgroundJobs).catch(() => {})
  }
  return dispatchedTaskIds
}

async function loadWorkerRuntimeDispatcher(): Promise<WorkerRuntimeDispatcher> {
  const { workerRuntimeService } = await import('../worker-runtime/worker-runtime-service')
  return workerRuntimeService
}

async function ensureWorkerParticipantForDispatch(roomId: string, workspaceAgentId: string) {
  const participants = await db
    .select()
    .from(roomParticipants)
    .where(eq(roomParticipants.roomId, roomId))
  const existing = participants.find(
    (participant) =>
      participant.participantType === 'worker' &&
      participant.workspaceAgentId === workspaceAgentId,
  )
  if (existing) return existing
  return roomService.addWorkerParticipant(roomId, workspaceAgentId)
}

async function markPendingTaskDispatchBlocked(
  ctx: StepContext,
  task: typeof workspaceTasks.$inferSelect,
  input: {
    thread?: typeof taskThreads.$inferSelect | null
    reason: string
    message: string
  },
) {
  const thread = input.thread ?? null
  await emitRunEvent({
    runId: ctx.runId,
    workspaceId: ctx.workspaceId,
    groupSessionId: ctx.groupSessionId,
    taskId: task.id,
    threadId: thread?.id ?? null,
    workerInstanceId: thread?.workerInstanceId ?? null,
    agentId: task.agentId ?? thread?.workspaceAgentId ?? null,
    type: 'manager.next_action',
    severity: 'warning',
    payload: {
      action: 'dispatch_blocked',
      reason: input.reason,
      message: input.message,
      taskTitle: task.title,
      taskThreadId: thread?.id ?? null,
      coordinationSource: 'room-timeline',
    },
  })
  if (!thread) return
  try {
    const [workspace] = await db
      .select({ ownerId: workspaces.ownerId })
      .from(workspaces)
      .where(eq(workspaces.id, ctx.workspaceId))
      .limit(1)
    if (!workspace?.ownerId) return
    const roomInput = await roomService.buildTaskThreadRoomInput(thread.id, workspace.ownerId)
    const room = await roomService.ensureRoomForTaskThread(roomInput)
    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'manager',
      type: 'task.progress',
      body: input.message,
      metadata: {
        kind: 'manager-loop.dispatch-blocked',
        reason: input.reason,
        runId: ctx.runId,
        taskId: task.id,
        taskThreadId: thread.id,
        coordinationSource: 'room-timeline',
      },
    })
  } catch {
    // Run events still make the blocked dispatch visible if the task room is malformed.
  }
}

async function recordTaskRoomDispatchFailure(input: {
  ctx: StepContext
  roomId: string
  task: typeof workspaceTasks.$inferSelect
  thread: typeof taskThreads.$inferSelect
  workspaceAgentId: string
  error: any
}) {
  const message = input.error?.message || String(input.error)
  await roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderType: 'manager',
    type: 'task.progress',
    body: `WorkerRuntime 派发失败：${message}`,
    metadata: {
      kind: 'manager-loop.dispatch-failed',
      runId: input.ctx.runId,
      taskId: input.task.id,
      taskThreadId: input.thread.id,
      workspaceAgentId: input.workspaceAgentId,
      error: message,
      coordinationSource: 'room-timeline',
    },
  })
  await emitRunEvent({
    runId: input.ctx.runId,
    workspaceId: input.ctx.workspaceId,
    groupSessionId: input.ctx.groupSessionId,
    taskId: input.task.id,
    threadId: input.thread.id,
    workerInstanceId: input.thread.workerInstanceId ?? null,
    agentId: input.workspaceAgentId,
    type: 'task.failed',
    severity: 'error',
    payload: {
      title: input.task.title,
      taskTitle: input.task.title,
      childSessionId: input.thread.sessionId,
      taskThreadId: input.thread.id,
      taskThreadStatus: input.thread.status,
      error: message,
      source: 'manager-loop.dispatch-pending',
      coordinationSource: 'room-timeline',
    },
  })
}

function isDispatchablePendingTask(task: typeof workspaceTasks.$inferSelect) {
  if (task.status === 'pending') return true
  if (task.status !== 'blocked') return false
  return task.progressStatus !== 'awaiting_human_clarification'
}

export async function managerLoopStep(
  runId: string,
  options: ManagerLoopStepOptions = {},
): Promise<ManagerLoopStepResult> {
  const terminalStatuses = new Set(['done', 'failed', 'cancelled', 'skipped'])

  // ─── Skip if a resident Manager (OpenClaw/QwenPaw) is active ─────────
  // Resident processes observe rooms via Matrix /sync autonomously.
  const provider = getActiveManagerProvider()
  if (provider.runtimeType === 'openclaw' || provider.runtimeType === 'qwenpaw') {
    const status = await provider.status()
    if (status.running || status.endpoint) {
      return {
        action: 'waiting',
        reason: `Resident Manager (${provider.runtimeType}) is active; skipping local managerLoopStep.`,
        dispatchedTaskIds: [],
        reviewedTaskIds: [],
        completedRun: false,
      }
    }
  }

  // ─── Observe: load current state ─────────────────────────────────────
  const [run] = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.id, runId))
    .limit(1)
  if (!run) {
    return { action: 'waiting', reason: 'Run not found', dispatchedTaskIds: [], reviewedTaskIds: [], completedRun: false }
  }
  if (run.status !== 'running') {
    return { action: 'waiting', reason: `Run status is ${run.status}`, dispatchedTaskIds: [], reviewedTaskIds: [], completedRun: false }
  }

  const ctx: StepContext = {
    runId,
    workspaceId: run.workspaceId,
    groupSessionId: run.groupSessionId,
    actorId: null,
    actorName: 'Manager',
  }

  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.runId, runId))
    .orderBy(asc(workspaceTasks.orderIdx), asc(workspaceTasks.createdAt))

  const threads = await db
    .select()
    .from(taskThreads)
    .where(eq(taskThreads.runId, runId))
    .orderBy(asc(taskThreads.createdAt))

  const threadByTaskId = new Map(threads.map((t) => [t.taskId, t]))

  // Load worker health for runState
  const workerRows = await db
    .select()
    .from(workerInstances)
    .where(eq(workerInstances.workspaceId, run.workspaceId))

  const [workspace] = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, run.workspaceId))
    .limit(1)
  const ownerId = workspace?.ownerId ?? null

  // ─── Fallback: if all tasks terminal, synthesize immediately ─────────
  const terminalTasks = tasks.filter((t) => terminalStatuses.has(t.status))
  if (tasks.length > 0 && terminalTasks.length === tasks.length) {
    const review = await synthesizeCompletedRunFromResources({ ctx, tasks: terminalTasks, threads })
    return {
      action: 'synthesize',
      reason: review.reason,
      dispatchedTaskIds: [],
      reviewedTaskIds: terminalTasks.map((t) => t.id),
      completedRun: true,
    }
  }

  // Load workspace agent names for worker health
  const workspaceAgentIds = workerRows.map((w) => w.workspaceAgentId).filter(Boolean) as string[]
  const agentNames = new Map<string, string>()
  if (workspaceAgentIds.length > 0) {
    const agents = await db
      .select({ id: workspaceAgents.id, name: workspaceAgents.name })
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, run.workspaceId))
    for (const a of agents) {
      agentNames.set(a.id, a.name)
    }
  }

  // ─── Build ManagerRunState for LLM ───────────────────────────────────
  const runState = {
    runId: run.id,
    status: run.status,
    goal: null as string | null,
    tasks: tasks.map((t) => ({
      taskId: t.id,
      title: t.title,
      status: t.status,
      progressStatus: t.progressStatus ?? null,
      assignedTo: t.agentId ?? null,
    })),
    workers: workerRows.map((w) => ({
      workspaceAgentId: w.workspaceAgentId ?? w.id,
      name: agentNames.get(w.workspaceAgentId) ?? w.workspaceAgentId ?? w.id,
      observedState: w.observedState ?? 'unknown',
      lastHeartbeatAt: w.lastHeartbeatAt ? new Date(w.lastHeartbeatAt).toISOString() : null,
    })),
  }

  // ─── Find group room ─────────────────────────────────────────────────
  if (!ownerId || !run.groupSessionId) {
    return { action: 'blocked', reason: 'Missing ownerId or groupSessionId', dispatchedTaskIds: [], reviewedTaskIds: [], completedRun: false }
  }
  const groupRoom = await roomService.ensureRoomForSession(run.groupSessionId, ownerId)

  // ─── Think: invoke ManagerRuntime ────────────────────────────────────
  let stepResult: Awaited<ReturnType<typeof managerRuntimeService.stepRoom>>
  try {
    stepResult = await managerRuntimeService.stepRoom({
      roomId: groupRoom.id,
      ownerId,
      source: 'manager-loop',
      runState,
      appendActions: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await emitRunEvent({
      runId, workspaceId: ctx.workspaceId, groupSessionId: ctx.groupSessionId,
      type: 'manager.next_action', severity: 'error',
      payload: { action: 'runtime_error', reason: message },
    })
    return { action: 'waiting', reason: `ManagerRuntime error: ${message}`, dispatchedTaskIds: [], reviewedTaskIds: [], completedRun: false }
  }

  // ─── Act: execute returned actions ───────────────────────────────────
  const dispatchedTaskIds: string[] = []
  const reviewedTaskIds: string[] = []
  let hasDispatched = false
  let hasCancelled = false
  let hasReworked = false

  for (const action of stepResult.actions) {
    switch (action.type) {
      case 'assign': {
        // Find pending task matching taskKey or taskTitle
        const targetTask = tasks.find((t) =>
          (action.taskKey && t.id === action.taskKey) ||
          (action.taskTitle && t.title === action.taskTitle),
        )
        if (targetTask && isDispatchablePendingTask(targetTask)) {
          const singleDispatched = await dispatchPreparedTaskRooms({
            ctx, tasks: [targetTask], threadByTaskId,
            runtime: options.workerRuntime,
            executeInline: options.executeInline ?? false,
          })
          if (singleDispatched.length > 0) {
            dispatchedTaskIds.push(...singleDispatched)
            hasDispatched = true
          }
        }
        break
      }
      case 'rework': {
        const targetTask = tasks.find((t) =>
          (action.taskKey && t.id === action.taskKey) ||
          (action.taskTitle && t.title === action.taskTitle),
        )
        if (targetTask) {
          await db.update(workspaceTasks)
            .set({ status: 'pending', progressStatus: 'rework_requested', updatedAt: new Date() })
            .where(eq(workspaceTasks.id, targetTask.id))
          const thread = threadByTaskId.get(targetTask.id)
          if (thread) {
            await updateTaskThreadStatus(thread.id, 'prepared')
          }
          await emitRunEvent({
            runId, workspaceId: ctx.workspaceId, groupSessionId: ctx.groupSessionId,
            taskId: targetTask.id, threadId: thread?.id ?? null,
            type: 'manager.next_action',
            payload: { action: 'rework', reason: action.reason ?? 'Manager requested rework', taskId: targetTask.id },
          })
          hasReworked = true
        }
        break
      }
      case 'cancel_task': {
        const targetTask = tasks.find((t) =>
          (action.taskKey && t.id === action.taskKey) ||
          (action.taskTitle && t.title === action.taskTitle),
        )
        if (targetTask) {
          await db.update(workspaceTasks)
            .set({ status: 'cancelled', updatedAt: new Date(), completedAt: new Date() })
            .where(eq(workspaceTasks.id, targetTask.id))
          const thread = threadByTaskId.get(targetTask.id)
          if (thread?.workerInstanceId) {
            await runtimeLeaseController.release(thread.workerInstanceId, { metadata: { reason: 'Manager cancelled task' } })
          }
          await emitRunEvent({
            runId, workspaceId: ctx.workspaceId, groupSessionId: ctx.groupSessionId,
            taskId: targetTask.id, threadId: thread?.id ?? null,
            type: 'task.cancelled',
            payload: { reason: action.reason ?? 'Manager cancelled', taskId: targetTask.id },
          })
          hasCancelled = true
        }
        break
      }
      case 'create_worker': {
        // Placeholder: emit event and let worker-controller handle actual creation
        await emitRunEvent({
          runId, workspaceId: ctx.workspaceId, groupSessionId: ctx.groupSessionId,
          type: 'manager.next_action',
          payload: { action: 'create_worker', reason: action.reason ?? 'Manager requested new worker', message: action.message },
        })
        break
      }
      case 'reply':
      case 'clarify':
      case 'propose_members':
      case 'wait':
        // Already handled by stepRoom (timeline events written)
        break
      default:
        break
    }
  }

  // Build result
  const pendingTasks = tasks.filter((t) => isDispatchablePendingTask(t))
  const runningTasks = tasks.filter((t) => t.status === 'running')

  if (hasDispatched) {
    return {
      action: 'dispatch_pending',
      reason: `Manager LLM dispatched ${dispatchedTaskIds.length} task(s)`,
      dispatchedTaskIds,
      reviewedTaskIds,
      completedRun: false,
    }
  }
  if (runningTasks.length > 0) {
    return {
      action: 'review_running',
      reason: stepResult.actions.map((a) => a.reason ?? a.type).join('; ') || `${runningTasks.length} task(s) running`,
      dispatchedTaskIds,
      reviewedTaskIds: runningTasks.map((t) => t.id),
      completedRun: false,
    }
  }

  // Persist manager state snapshot for cross-step memory
  try {
    const stateNamespace = Blackboard.namespace(run.workspaceId, run.id)
    await blackboard.write({
      namespace: stateNamespace,
      key: `manager_state/steps/${Date.now()}`,
      value: {
        observedAt: new Date().toISOString(),
        taskCount: tasks.length,
        terminalCount: terminalTasks.length,
        pendingCount: pendingTasks.length,
        runningCount: runningTasks.length,
        actionsTaken: stepResult.actions.map((a) => ({ type: a.type, reason: a.reason })),
        rawOutputPreview: stepResult.rawOutput?.slice(0, 500) ?? null,
      },
    })
  } catch {
    // State persistence is best-effort
  }

  return {
    action: 'llm_driven',
    reason: stepResult.actions.map((a) => `${a.type}: ${a.reason ?? ''}`).join('; ') || 'Manager observed and decided to wait',
    dispatchedTaskIds,
    reviewedTaskIds,
    completedRun: false,
  }
}
