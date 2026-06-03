import { randomUUID } from 'node:crypto'
import {
  and,
  asc,
  db,
  eq,
  messages,
  orchestratorRuns,
  runtimeLeases,
  taskThreads,
  workspaceTasks,
} from '@agenthub/db'
import { WsEvent, TaskStatus } from '@agenthub/shared'
import { broadcastSessionEvent, cancelAgentReply } from '../agent-runner'
import { blackboard, Blackboard } from '../blackboard'
import { OrchestratorEngine } from './orchestrator-engine'
import { appendHumanInterruptConstraint } from './human-interrupts'
import { emitRunEvent } from './run-events'
import type { ExecutionPlan } from './types'
import { markRuntimeLeaseStale, markWorkerInstanceState } from './worker-runtime-resources'

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

    const engineUpdate = OrchestratorEngine.applyHumanInterruptToActiveRun(input.run.runId, {
      messageId,
      content,
      targetTaskIds: changedTaskIds,
    })

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
        await markRuntimeLeaseStale(lease.id, {
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
        memoryPlanUpdated: engineUpdate.memoryPlanUpdated,
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
        memoryPlanUpdated: engineUpdate.memoryPlanUpdated,
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
        memoryPlanUpdated: engineUpdate.memoryPlanUpdated,
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
  const [message] = await db
    .insert(messages)
    .values({
      sessionId: input.sessionId,
      senderId: input.senderId,
      senderType: input.senderType,
      type: 'text',
      content: input.content,
      metadata: input.metadata,
    })
    .returning()

  if (message) {
    broadcastSessionEvent(input.sessionId, {
      type: WsEvent.MessageCompleted,
      payload: { sessionId: input.sessionId, message },
    })
  }

  return message ?? null
}
