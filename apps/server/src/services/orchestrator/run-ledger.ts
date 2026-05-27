import { db, orchestratorRuns, eq } from '@agenthub/db'
import type { EmitRunEventInput } from './run-events'
import type {
  ExecutionPlan,
  ExecutionTask,
  OrchestratorPhase,
  ProgressLedger,
  TaskLedger,
  TaskOutputContract,
  TaskValidation,
} from './types'

type MutablePlan = ExecutionPlan & Record<string, unknown>

export function initializeRunLedger(plan: ExecutionPlan): ExecutionPlan {
  const now = new Date().toISOString()
  const phases = normalizePhases(plan)
  const tasks = normalizeTasks(plan.tasks, phases)
  const taskLedger = buildTaskLedger({ ...plan, phases, tasks }, now)
  const progressLedger = buildProgressLedger(plan.runId, tasks, now)

  return {
    ...plan,
    phases,
    tasks,
    taskLedger,
    progressLedger,
  }
}

export async function updateProgressLedgerFromEvent(input: EmitRunEventInput): Promise<void> {
  const [row] = await db
    .select({ plan: orchestratorRuns.plan })
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.id, input.runId))
    .limit(1)
  if (!row?.plan || typeof row.plan !== 'object') return

  const storedPlan = row.plan as MutablePlan
  if (!Array.isArray(storedPlan.tasks)) return
  const plan =
    storedPlan.taskLedger && storedPlan.progressLedger
      ? (storedPlan as ExecutionPlan)
      : initializeRunLedger(storedPlan as ExecutionPlan)
  const taskLedger = plan.taskLedger!
  const progressLedger = { ...plan.progressLedger! }
  const now = new Date().toISOString()
  const taskId = input.taskId ?? undefined
  const payload = input.payload ?? {}

  progressLedger.updatedAt = now

  switch (input.type) {
    case 'run.started':
      progressLedger.status = 'running'
      progressLedger.startedAt = progressLedger.startedAt ?? now
      break
    case 'phase.started':
      progressLedger.currentPhaseId = payloadText(payload.phaseId) ?? progressLedger.currentPhaseId
      break
    case 'task.queued':
      if (taskId && !taskLedger.tasks.some((task) => task.id === taskId)) {
        const phaseId = payloadText(payload.phaseId) ?? progressLedger.currentPhaseId ?? 'execution'
        const task = buildLedgerTask(
          {
            id: taskId,
            phaseId,
            title: payloadText(payload.title) ?? taskId,
            description: payloadText(payload.description) ?? '',
            agentId: input.agentId ?? '',
            dependencies: [],
            maxRetries: 2,
          },
          phaseId,
        )
        taskLedger.tasks.push(task)
        const phase = taskLedger.phases.find((item) => item.id === phaseId)
        if (phase && !phase.taskIds.includes(taskId)) phase.taskIds.push(taskId)
      }
      moveTask(progressLedger, taskId, 'pending')
      setLedgerTaskStatus(taskLedger, taskId, 'pending')
      break
    case 'task.started':
      moveTask(progressLedger, taskId, 'running')
      setLedgerTaskStatus(taskLedger, taskId, 'running')
      setCurrentPhaseFromTask(progressLedger, taskLedger, taskId)
      break
    case 'task.completed':
      moveTask(progressLedger, taskId, 'done')
      setLedgerTaskStatus(taskLedger, taskId, 'done')
      setCurrentPhaseFromTask(progressLedger, taskLedger, taskId)
      break
    case 'task.failed':
      moveTask(progressLedger, taskId, 'failed')
      setLedgerTaskStatus(taskLedger, taskId, 'failed')
      setCurrentPhaseFromTask(progressLedger, taskLedger, taskId)
      break
    case 'task.cancelled':
      moveTask(progressLedger, taskId, 'cancelled')
      setLedgerTaskStatus(taskLedger, taskId, 'cancelled')
      setCurrentPhaseFromTask(progressLedger, taskLedger, taskId)
      break
    case 'task.retrying':
      progressLedger.retryHistory = appendUnique(progressLedger.retryHistory, {
        taskId,
        attempt: typeof payload.attempt === 'number' ? payload.attempt : undefined,
        reason: payloadText(payload.reason),
        at: now,
      })
      break
    case 'task.reassigned':
      progressLedger.agentSubstitutions = appendUnique(progressLedger.agentSubstitutions, {
        taskId,
        fromAgentId: payloadText(payload.fromAgentId),
        toAgentId: payloadText(payload.toAgentId) ?? input.agentId ?? undefined,
        reason: payloadText(payload.reason),
        at: now,
      })
      updateLedgerTaskAgent(taskLedger, taskId, payloadText(payload.toAgentId) ?? input.agentId ?? undefined)
      break
    case 'blackboard.written': {
      const key = payloadText(payload.key)
      if (key) progressLedger.blackboardKeys = pushUnique(progressLedger.blackboardKeys, key)
      break
    }
    case 'artifact.created': {
      const artifactId = payloadText(payload.artifactId)
      if (artifactId) progressLedger.artifactIds = pushUnique(progressLedger.artifactIds, artifactId)
      break
    }
    case 'conflict.detected':
    case 'conflict.resolved':
      progressLedger.conflicts = appendUnique(progressLedger.conflicts, {
        filePath: payloadText(payload.filePath),
        resolution: payloadText(payload.resolution),
        severity: input.severity,
      })
      break
    case 'run.replanned':
      progressLedger.replanHistory = appendUnique(progressLedger.replanHistory, {
        strategy: payloadText(payload.strategy),
        reason: payloadText(payload.reason),
        changedTaskIds: arrayOfStrings(payload.changedTaskIds),
        at: now,
      })
      break
    case 'run.synthesizing':
      progressLedger.status = 'synthesizing'
      break
    case 'run.completed':
      progressLedger.status = 'completed'
      progressLedger.completedAt = now
      break
    case 'run.cancelled':
      cancelUnfinishedTasks(taskLedger, progressLedger)
      progressLedger.status = 'cancelled'
      progressLedger.completedAt = now
      break
    case 'run.failed':
      progressLedger.status = 'failed'
      progressLedger.completedAt = now
      break
  }

  taskLedger.updatedAt = now

  await db
    .update(orchestratorRuns)
    .set({
      plan: {
        ...(plan as MutablePlan),
        taskLedger,
        progressLedger,
      } as unknown as Record<string, unknown>,
    })
    .where(eq(orchestratorRuns.id, input.runId))
}

function normalizePhases(plan: ExecutionPlan): OrchestratorPhase[] {
  const existing = Array.isArray(plan.phases) ? plan.phases : []
  const phases = existing
    .map((phase) => ({
      id: safeId(phase.id) || 'execution',
      title: phase.title || titleFromPhaseId(phase.id),
      purpose: phase.purpose || phase.title || titleFromPhaseId(phase.id),
      taskIds: Array.isArray(phase.taskIds) ? [...phase.taskIds] : [],
    }))
    .filter((phase, index, list) => phase.id && list.findIndex((item) => item.id === phase.id) === index)

  for (const [index, task] of plan.tasks.entries()) {
    const phaseId = safeId(task.phaseId) || inferPhaseId(task, index)
    let phase = phases.find((item) => item.id === phaseId)
    if (!phase) {
      phase = {
        id: phaseId,
        title: titleFromPhaseId(phaseId),
        purpose: purposeFromPhaseId(phaseId),
        taskIds: [],
      }
      phases.push(phase)
    }
    if (!phase.taskIds.includes(task.id)) phase.taskIds.push(task.id)
  }

  return phases.length
    ? phases
    : [{ id: 'execution', title: '执行', purpose: '完成当前协作任务', taskIds: plan.tasks.map((task) => task.id) }]
}

function normalizeTasks(tasks: ExecutionTask[], phases: OrchestratorPhase[]): ExecutionTask[] {
  return tasks.map((task, index) => {
    const phaseId = safeId(task.phaseId) || phases.find((phase) => phase.taskIds.includes(task.id))?.id || inferPhaseId(task, index)
    return {
      ...task,
      phaseId,
      taskType: task.taskType ?? inferTaskType(task),
      inputRefs: task.inputRefs ?? [],
      outputContract: task.outputContract ?? defaultOutputContract(task),
      validation: task.validation ?? defaultValidation(task),
    }
  })
}

function buildTaskLedger(plan: ExecutionPlan, now: string): TaskLedger {
  const assignments = new Map<string, string[]>()
  for (const task of plan.tasks) {
    const existing = assignments.get(task.agentId) ?? []
    existing.push(task.id)
    assignments.set(task.agentId, existing)
  }

  return {
    runId: plan.runId,
    title: plan.title,
    goal: plan.goal,
    assumptions: [],
    constraints: [],
    phases: plan.phases ?? [],
    tasks: plan.tasks.map((task) => buildLedgerTask(task, task.phaseId ?? 'execution')),
    agentAssignments: Array.from(assignments, ([agentId, taskIds]) => ({ agentId, taskIds })),
    createdAt: now,
    updatedAt: now,
  }
}

function buildProgressLedger(runId: string, tasks: ExecutionTask[], now: string): ProgressLedger {
  return {
    runId,
    status: 'running',
    currentPhaseId: tasks[0]?.phaseId,
    pendingTaskIds: tasks.map((task) => task.id),
    runningTaskIds: [],
    completedTaskIds: [],
    failedTaskIds: [],
    cancelledTaskIds: [],
    blockedTaskIds: [],
    blackboardKeys: [],
    artifactIds: [],
    conflicts: [],
    retryHistory: [],
    agentSubstitutions: [],
    replanHistory: [],
    startedAt: now,
    updatedAt: now,
  }
}

function buildLedgerTask(task: ExecutionTask, phaseId: string): TaskLedger['tasks'][number] {
  return {
    id: task.id,
    phaseId,
    title: task.title,
    description: task.description,
    agentId: task.agentId,
    dependencies: task.dependencies ?? [],
    taskType: task.taskType ?? inferTaskType(task),
    status: 'pending',
    outputContract: task.outputContract ?? defaultOutputContract(task),
    validation: task.validation ?? defaultValidation(task),
  }
}

function moveTask(ledger: ProgressLedger, taskId: string | undefined, status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled') {
  if (!taskId) return
  ledger.pendingTaskIds = ledger.pendingTaskIds.filter((id) => id !== taskId)
  ledger.runningTaskIds = ledger.runningTaskIds.filter((id) => id !== taskId)
  ledger.completedTaskIds = ledger.completedTaskIds.filter((id) => id !== taskId)
  ledger.failedTaskIds = ledger.failedTaskIds.filter((id) => id !== taskId)
  ledger.cancelledTaskIds = ledger.cancelledTaskIds.filter((id) => id !== taskId)

  if (status === 'pending') ledger.pendingTaskIds = pushUnique(ledger.pendingTaskIds, taskId)
  if (status === 'running') ledger.runningTaskIds = pushUnique(ledger.runningTaskIds, taskId)
  if (status === 'done') ledger.completedTaskIds = pushUnique(ledger.completedTaskIds, taskId)
  if (status === 'failed') ledger.failedTaskIds = pushUnique(ledger.failedTaskIds, taskId)
  if (status === 'cancelled') ledger.cancelledTaskIds = pushUnique(ledger.cancelledTaskIds, taskId)
}

function setLedgerTaskStatus(taskLedger: TaskLedger, taskId: string | undefined, status: TaskLedger['tasks'][number]['status']) {
  if (!taskId) return
  const task = taskLedger.tasks.find((item) => item.id === taskId)
  if (task) task.status = status
}

function updateLedgerTaskAgent(taskLedger: TaskLedger, taskId: string | undefined, agentId: string | undefined) {
  if (!taskId || !agentId) return
  const task = taskLedger.tasks.find((item) => item.id === taskId)
  if (task) task.agentId = agentId
}

function cancelUnfinishedTasks(taskLedger: TaskLedger, progressLedger: ProgressLedger) {
  const unfinished = new Set([
    ...progressLedger.pendingTaskIds,
    ...progressLedger.runningTaskIds,
    ...progressLedger.blockedTaskIds,
  ])
  for (const task of taskLedger.tasks) {
    if (task.status === 'pending' || task.status === 'running') {
      unfinished.add(task.id)
      task.status = 'cancelled'
    }
  }
  progressLedger.pendingTaskIds = progressLedger.pendingTaskIds.filter((id) => !unfinished.has(id))
  progressLedger.runningTaskIds = progressLedger.runningTaskIds.filter((id) => !unfinished.has(id))
  progressLedger.blockedTaskIds = progressLedger.blockedTaskIds.filter((id) => !unfinished.has(id))
  for (const taskId of unfinished) {
    progressLedger.cancelledTaskIds = pushUnique(progressLedger.cancelledTaskIds, taskId)
  }
}

function setCurrentPhaseFromTask(progressLedger: ProgressLedger, taskLedger: TaskLedger, taskId: string | undefined) {
  if (!taskId) return
  const phaseId = taskLedger.tasks.find((task) => task.id === taskId)?.phaseId
  if (phaseId) progressLedger.currentPhaseId = phaseId
}

function defaultOutputContract(task: ExecutionTask): TaskOutputContract {
  return {
    requiredBlackboardWrites: [
      {
        key: `task_${task.id}_output`,
        schemaType: 'task_output',
      },
    ],
    requiredArtifacts: task.taskType === 'code' ? ['diff'] : [],
    acceptanceCriteria: [],
  }
}

function defaultValidation(task: ExecutionTask): TaskValidation {
  return {
    commands: [],
    requiresReview: task.taskType === 'code',
  }
}

function inferTaskType(task: ExecutionTask): NonNullable<ExecutionTask['taskType']> {
  const text = `${task.id} ${task.title} ${task.description}`.toLowerCase()
  if (/(review|审查|审核|风险)/i.test(text)) return 'review'
  if (/(test|verify|验证|测试|qa)/i.test(text)) return 'test'
  if (/(code|build|implement|实现|开发|修改)/i.test(text)) return 'code'
  if (/(design|方案|设计|架构)/i.test(text)) return 'design'
  if (/(research|调研|资料|搜索)/i.test(text)) return 'research'
  if (/(summary|synthesize|汇总|总结)/i.test(text)) return 'synthesize'
  return 'read'
}

function inferPhaseId(task: ExecutionTask, index: number): string {
  const text = `${task.id} ${task.title} ${task.description}`.toLowerCase()
  if (/(plan|analysis|scan|read|理解|梳理|分析|调研)/i.test(text)) return 'analysis'
  if (/(design|方案|架构|设计)/i.test(text)) return 'design'
  if (/(build|code|implement|实现|开发|修改)/i.test(text)) return 'implementation'
  if (/(review|test|verify|审查|测试|验证|风险)/i.test(text)) return 'verification'
  if (/(summary|synthesize|汇总|总结)/i.test(text)) return 'synthesis'
  return index === 0 ? 'analysis' : 'execution'
}

function titleFromPhaseId(phaseId?: string): string {
  switch (phaseId) {
    case 'analysis':
      return '分析'
    case 'design':
      return '设计'
    case 'implementation':
      return '实现'
    case 'verification':
      return '验证'
    case 'synthesis':
      return '汇总'
    default:
      return '执行'
  }
}

function purposeFromPhaseId(phaseId: string): string {
  switch (phaseId) {
    case 'analysis':
      return '理解目标、上下文和依赖'
    case 'design':
      return '确定方案、边界和产物契约'
    case 'implementation':
      return '完成主要交付实现'
    case 'verification':
      return '审查风险并验证交付质量'
    case 'synthesis':
      return '汇总各 Agent 产出并回写聊天流'
    default:
      return '推进当前协作任务'
  }
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned || undefined
}

function payloadText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function pushUnique<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list : [...list, item]
}

function appendUnique<T>(list: T[], item: T): T[] {
  const serialized = JSON.stringify(item)
  return list.some((existing) => JSON.stringify(existing) === serialized) ? list : [...list, item]
}
