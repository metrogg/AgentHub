
import {
  asc,
  db,
  desc,
  eq,
  
  sessions,
  timelineEvents,
  workspaceAgents,
  workspaces,
} from '@agenthub/db'
import {
  AgentRoleType,
  CodeAgentType,
  RuntimeType,
  SandboxPolicy,
  TaskType,
  WsEvent,
} from '@agenthub/shared'
import { AppError, AppErrorCodes } from '../../lib/error'
import { logger } from '../../lib/logger'
import { broadcastSessionEvent, type MessageRow } from '../agent-runner'
import { checkInputGuardrails } from '../orchestrator/input-guardrails'
import type { ManagerDecisionEventContext } from '../orchestrator/manager-loop'
import { buildDynamicOrchestratorPlan } from '../orchestrator/plan-generator'
import { validateRealWorkerAssignments } from '../orchestrator/plan-utils'
import { emitRunEvent } from '../orchestrator/run-events'
import { runController, type RunControllerRunContext } from '../orchestrator/run-controller'
import type { TaskOutputContract, TaskValidation } from '../orchestrator/types'
import type { WorkerRuntime } from '../worker-runtime'
import { dispatchAssignBatch } from '../controller-plane/task-dispatcher'
import { roomService } from '../rooms'
import type { ManagerAction } from './types'

export type PlanAgent = {
  key: string
  name: string
  role: string
  roleType?: AgentRoleType
  color?: string
  systemPrompt?: string
  description?: string
  roleProfile?: Record<string, unknown> | null
  modelId?: string | null
  runtimeType?: RuntimeType
  codeAgentType?: CodeAgentType | null
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: SandboxPolicy
}

export type PlanTask = {
  id: string
  phaseId?: string
  title: string
  description: string
  agentKey: string
  taskType?: TaskType
  dependencies?: string[]
  parallelGroup?: string
  maxRetries?: number
  fallbackAgentId?: string
  outputContract?: TaskOutputContract
  validation?: TaskValidation
  agentSelection?: {
    selectedAgentKey: string
    score: number
    rationale: string[]
    reviewerAgentKey?: string
    fallbackAgentKey?: string
  }
}

export type PlanPhase = {
  id: string
  title: string
  purpose: string
  taskIds: string[]
}

export type OrchestratorPlan = {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: PlanAgent[]
  phases?: PlanPhase[]
  tasks: PlanTask[]
}

export type DispatchMonitor = {
  dispatchId: string
  groupSessionId?: string
  taskIds: string[]
}

export function managerAssignActionsFromPlan(input: {
  plan: OrchestratorPlan
  agentsByKey: Map<string, typeof workspaceAgents.$inferSelect>
}): ManagerAction[] {
  const actions: ManagerAction[] = []
  const taskKeys = new Set(input.plan.tasks.map((task) => task.id))
  for (const task of input.plan.tasks) {
    const worker = input.agentsByKey.get(task.agentKey)
    if (!worker) continue
    actions.push({
      type: 'assign',
      targetWorkerId: worker.id,
      taskKey: task.id,
      dependsOn: (task.dependencies ?? []).filter((dependency) => taskKeys.has(dependency)),
      taskTitle: task.title,
      taskDescription: task.description,
      message: `@${worker.name} 请接手：${task.title}\n\n${task.description}`,
      reason: task.agentSelection?.rationale?.join('\n') || `Dynamic Manager plan assigned ${task.title} to ${worker.name}.`,
      metadata: {
        source: 'dynamic-orchestrator-plan',
        planTitle: input.plan.title,
        planGoal: input.plan.goal,
        phaseId: task.phaseId ?? null,
        taskType: task.taskType ?? null,
        parallelGroup: task.parallelGroup ?? null,
        outputContract: task.outputContract ?? null,
        validation: task.validation ?? null,
        agentSelection: task.agentSelection ?? null,
      },
    })
  }
  if (actions.length !== input.plan.tasks.length) {
    const missingTasks = input.plan.tasks
      .filter((task) => !input.agentsByKey.has(task.agentKey))
      .map((task) => `${task.title} -> ${task.agentKey}`)
    throw AppError.fromCode(
      AppErrorCodes.ORCHESTRATOR_PLAN_INVALID,
      `动态计划引用了当前群聊中不存在的 Worker：${missingTasks.join('；')}`,
    )
  }
  return actions
}

export async function startPlanRunWithCoordinatorAssignBatch(params: {
  sessionId: string
  plan: OrchestratorPlan
  workspaceId: string
  ownerId: string
  runId?: string
  run: RunControllerRunContext
  
  workerRuntime?: WorkerRuntime
}): Promise<DispatchMonitor> {
  const { sessionId, plan, workspaceId, ownerId } = params
  const [sourceSession] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  if (!sourceSession || sourceSession.ownerId !== ownerId || sourceSession.workspaceId !== workspaceId) {
    throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '群聊会话不存在')
  }

  const { agentsByKey } = await dispatchPlanToExistingGroup(sourceSession, ownerId, plan)
  const validationAgents = plan.agents.map((agent) => {
    const dbAgent = agentsByKey.get(agent.key)
    return {
      id: dbAgent?.id ?? agent.key,
      key: agent.key,
      name: dbAgent?.name ?? agent.name,
      roleType: dbAgent?.roleType ?? agent.roleType,
    }
  })
  const validationError = validateRealWorkerAssignments({
    agents: validationAgents,
    tasks: plan.tasks.map((task) => ({
      agentId: agentsByKey.get(task.agentKey)?.id ?? task.agentKey,
      title: task.title,
    })),
  })
  if (validationError) {
    throw AppError.fromCode(AppErrorCodes.ORCHESTRATOR_PLAN_INVALID, validationError)
  }

  const goal = await resolvePlanGoal({
    sessionId,
    ownerId,
    content: plan.goal,
  })
  const actions = managerAssignActionsFromPlan({ plan, agentsByKey })
  const batch = await dispatchAssignBatch({
    groupSession: sourceSession,
    ownerId,
    goal,
    actions,
    runtimeType: 'code-agent',
    run: params.run,
    workerRuntime: params.workerRuntime,
  })

  await emitRunEvent({
    runId: batch.runId,
    workspaceId,
    groupSessionId: sessionId,
    type: 'plan.created',
    payload: {
      source: 'dynamic-plan-to-coordinator-assign',
      title: plan.title,
      goal: plan.goal,
      summary: plan.summary,
      phases: plan.phases ?? [],
      taskCount: plan.tasks.length,
      agentCount: plan.agents.length,
      legacyRunId: params.runId ?? null,
      coordinatorAssignTaskIds: batch.tasks.map((task) => task.taskId),
    },
  })

  return {
    dispatchId: batch.runId,
    groupSessionId: sessionId,
    taskIds: batch.tasks.map((task) => task.taskId),
  }
}

export async function generatePlanAndPushTaskBoard(
  sessionId: string,
  content: string,
  agents: any[],
  workspaceId: string,
  ownerId: string,
  options: {
    propagateErrors?: boolean
    decision?: ManagerDecisionEventContext
    run?: RunControllerRunContext
    runId?: string
    
    workerRuntime?: WorkerRuntime
  } = {},
): Promise<DispatchMonitor | null> {
  const orchestratorAgent = agents.find((a: any) => a.roleType === 'orchestrator')

  const guardrails = checkInputGuardrails(content)
  if (!guardrails.ok && guardrails.riskLevel === 'high') {
    await appendPlanningStatusTimeline({
      sessionId,
      ownerId,
      content: `请求被安全策略拦截：${guardrails.violations.join('；')}`,
      metadata: {
        kind: 'orchestrator-blocked',
        systemEvent: 'orchestrator_blocked',
        riskLevel: guardrails.riskLevel,
        violations: guardrails.violations,
      },
    })
    if (options.run) {
      await runController.fail(options.run, {
        error: `请求被安全策略拦截：${guardrails.violations.join('；')}`,
        stage: 'guardrails',
      })
    }
    return null
  }

  broadcastSessionEvent(sessionId, {
    type: WsEvent.AgentTyping,
    payload: {
      sessionId,
      agentId: orchestratorAgent?.id ?? 'orchestrator',
      agentName: orchestratorAgent?.name ?? 'Orchestrator',
      phase: 'planning',
    },
  })

  const managerRun =
    options.run ??
    (await runController.start({
      workspaceId,
      groupSessionId: sessionId,
      goal: content,
      actor: orchestratorAgent,
      decision: options.decision ?? null,
    }))
  const runId = options.runId ?? managerRun.runId

  try {
    const plan = await buildDynamicOrchestratorPlan(content, agents, workspaceId)
    return await startPlanRunWithCoordinatorAssignBatch({
      sessionId,
      plan,
      workspaceId,
      ownerId,
      runId,
      run: managerRun,
      
      workerRuntime: options.workerRuntime,
    })
  } catch (err: any) {
    const message = err?.message || '模型没有返回可执行的任务计划'
    logger.warn({ err: message, sessionId }, 'Dynamic orchestrator plan failed')
    await runController.fail(managerRun, {
      error: message,
      stage: 'planning',
    })
    await appendPlanningStatusTimeline({
      sessionId,
      ownerId,
      content: `Orchestrator 规划失败：${message}`,
      metadata: {
        kind: 'orchestrator-plan-failed',
        systemEvent: 'orchestrator_plan_failed',
        error: message,
      },
    })
    if (options.propagateErrors) throw err
    return null
  }
}

async function appendPlanningStatusTimeline(input: {
  sessionId: string
  ownerId: string
  content: string
  metadata: Record<string, unknown>
}) {
  const room = await roomService.ensureRoomForSession(input.sessionId, input.ownerId)
  await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'system',
    type: 'system',
    body: input.content,
    metadata: {
      ...input.metadata,
      source: 'planning-dispatcher',
      messageProjectionDisabled: true,
    },
  })
}

async function dispatchPlanToExistingGroup(
  session: typeof sessions.$inferSelect,
  ownerId: string,
  plan: OrchestratorPlan,
): Promise<{
  workspaceId: string
  groupSessionId: string
  agentsByKey: Map<string, typeof workspaceAgents.$inferSelect>
}> {
  if (!session.workspaceId)
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '会话未关联工作区')

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1)
  if (!workspace || workspace.ownerId !== ownerId) {
    throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
  }

  const existingAgents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspace.id))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  const agentsByKey = new Map<string, typeof workspaceAgents.$inferSelect>()
  for (const agent of existingAgents) {
    const direct = plan.agents.find((item) => item.key === agent.id)
    if (direct) {
      agentsByKey.set(direct.key, agent)
      continue
    }
    const name = agent.name.toLowerCase()
    const role = agent.role.toLowerCase()
    const roleType = agent.roleType.toLowerCase()
    const matched = plan.agents.find((item) => {
      const key = item.key.toLowerCase()
      return (
        name === item.name.toLowerCase() ||
        name.includes(key) ||
        role.includes(key) ||
        roleType === key ||
        (item.roleType ? roleType === item.roleType : false)
      )
    })
    if (matched) agentsByKey.set(matched.key, agent)
  }

  const missingAgents = plan.agents.filter((a) => !agentsByKey.has(a.key))
  if (missingAgents.length > 0) {
    logger.warn(
      { missing: missingAgents.map((a) => a.name), workspaceId: workspace.id },
      'dispatchPlanToExistingGroup: plan references agents not in workspace, skipping missing tasks',
    )
  }

  return { workspaceId: workspace.id, groupSessionId: session.id, agentsByKey }
}


/**
 * Resolve plan goal from room timeline (Room-first source of truth).
 * HiClaw-style: Manager reads timeline directly; backend no longer constructs MessageRow.
 */
async function resolvePlanGoal(input: {
  sessionId: string
  ownerId: string
  content: string
}): Promise<string> {
  const { roomService } = await import('../rooms')
  const room = await roomService.ensureRoomForSession(input.sessionId, input.ownerId)
  const timeline = await db
    .select()
    .from(timelineEvents)
    .where(eq(timelineEvents.roomId, room.id))
    .orderBy(desc(timelineEvents.sequence))
    .limit(1)
  const latestEvent = timeline[0]
  if (latestEvent?.senderType === 'human' && latestEvent.body?.trim()) {
    return latestEvent.body.trim()
  }
  return input.content
}
