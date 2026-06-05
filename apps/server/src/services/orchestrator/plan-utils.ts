/**
 * Plan utilities — pure (no LLM, no IO, no DB) helpers for plan normalization,
 * task contract validation, and JSON extraction/parsing. Extracted from the
 * legacy `planner.ts` so that the LLM-driven Planner can be removed while
 * callers like `manager-runtime/planning-dispatcher.ts` and tests
 * (`planner-normalization.test.ts`, `smoke.test.ts`) keep working.
 */

import type { CollaborationContract } from './collaboration-contract'
import type {
  ClarificationQuestion,
  CollaborationMode,
  ExecutionAgent,
  ExecutionPlan,
  ExecutionTask,
  TaskOutputContract,
  TaskValidation,
} from './types'

// ── Text & JSON helpers ─────────────────────────────────────────────

export function cleanPlanText(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 1200) : ''
}

export function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => cleanPlanText(item))
    .filter(Boolean)
    .slice(0, 12)
}

export function extractJsonObject(value: string) {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  const start = cleaned.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && inString) {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return cleaned.slice(start, index + 1)
    }
  }
  return null
}

export function parseJsonObject(value: string) {
  try {
    return JSON.parse(value)
  } catch (error) {
    const repaired = stripJsonComments(value).replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(repaired)
  }
}

function stripJsonComments(value: string) {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const next = value[index + 1]
    if (escaped) {
      output += char
      escaped = false
      continue
    }
    if (char === '\\' && inString) {
      output += char
      escaped = true
      continue
    }
    if (char === '"') {
      output += char
      inString = !inString
      continue
    }
    if (!inString && char === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1
      output += '\n'
      continue
    }
    if (!inString && char === '/' && next === '*') {
      index += 2
      while (index < value.length && !(value[index] === '*' && value[index + 1] === '/')) index += 1
      index += 1
      continue
    }
    output += char
  }
  return output
}

// ── Task type & id helpers ──────────────────────────────────────────

export function parseTaskType(value: unknown): ExecutionTask['taskType'] | undefined {
  if (
    value === 'read' ||
    value === 'research' ||
    value === 'design' ||
    value === 'code' ||
    value === 'test' ||
    value === 'verify' ||
    value === 'review' ||
    value === 'synthesize'
  ) {
    return value
  }
  return undefined
}

export function slugifyTaskId(value: string, index: number) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || `task-${index + 1}`
}

export function titleFromGoal(goal: string) {
  const cleaned = goal.replace(/[。.!?？\n\r]/g, ' ').trim()
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}...` : cleaned || '多 Agent 协作任务'
}

// ── Contract & validation helpers ──────────────────────────────────

export function normalizeTaskOutputContract(
  value: unknown,
  taskId: string,
): TaskOutputContract | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as {
    requiredBlackboardWrites?: unknown
    requiredArtifacts?: unknown
    allowedPaths?: unknown
    acceptanceCriteria?: unknown
  }
  const hasRequiredBlackboardWrites =
    Array.isArray(item.requiredBlackboardWrites) && item.requiredBlackboardWrites.length > 0
  const requiredBlackboardWrites: TaskOutputContract['requiredBlackboardWrites'] =
    hasRequiredBlackboardWrites
      ? [
          {
            key: `task_${taskId}_output`,
            schemaType: 'task_output',
          },
        ]
      : []
  const requiredArtifacts = arrayOfStrings(item.requiredArtifacts)
  const allowedPaths = arrayOfStrings(item.allowedPaths)
  const acceptanceCriteria = arrayOfStrings(item.acceptanceCriteria)
  if (
    !requiredBlackboardWrites.length &&
    !requiredArtifacts.length &&
    !allowedPaths.length &&
    !acceptanceCriteria.length
  )
    return undefined
  return {
    requiredBlackboardWrites,
    requiredArtifacts,
    allowedPaths,
    acceptanceCriteria,
  }
}

export function normalizeTaskValidation(value: unknown): TaskValidation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as { commands?: unknown; requiresReview?: unknown }
  const commands = arrayOfStrings(item.commands)
  if (!commands.length && item.requiresReview !== true) return undefined
  return {
    commands,
    requiresReview: item.requiresReview === true,
  }
}

export function parseBlackboardSchemaType(
  value: unknown,
): TaskOutputContract['requiredBlackboardWrites'][number]['schemaType'] | undefined {
  if (
    value === 'fact' ||
    value === 'decision' ||
    value === 'risk' ||
    value === 'artifact_ref' ||
    value === 'diff_summary' ||
    value === 'test_result' ||
    value === 'task_output'
  ) {
    return value
  }
  return undefined
}

export function validateRealWorkerAssignments(input: {
  agents: Array<Pick<ExecutionAgent, 'id' | 'key' | 'name' | 'roleType'>>
  tasks: Array<Pick<ExecutionTask, 'agentId' | 'title'>>
}): string | null {
  const workers = input.agents.filter((agent) => agent.roleType !== 'orchestrator')
  if (!workers.length) return 'No worker agents are available; Orchestrator cannot execute tasks by itself'

  const agentById = new Map(input.agents.map((agent) => [agent.id, agent]))
  const assignedWorkerIds = new Set<string>()
  for (const task of input.tasks) {
    const agent = agentById.get(task.agentId)
    if (!agent) return `Task "${task.title}" references an agent that is not in the current team`
    if (agent.roleType === 'orchestrator') {
      return `Task "${task.title}" is assigned to Orchestrator; worker tasks must use specialist agents`
    }
    assignedWorkerIds.add(agent.id)
  }

  if (workers.length >= 2 && assignedWorkerIds.size < 2) {
    return 'At least two different worker agents must participate when two or more workers are available'
  }

  return null
}

// ── Planner output normalization ───────────────────────────────────

export interface PlannerNormalizationResult {
  plan: ExecutionPlan | null
  error?: string
  recoverable: boolean
}

export function normalizePlannerOutput(
  runId: string,
  goal: string,
  generated: unknown,
  agents: ExecutionAgent[],
  contracts: CollaborationContract[] = [],
): PlannerNormalizationResult {
  if (!generated || typeof generated !== 'object') {
    return { plan: null, error: 'Planner did not return a JSON object', recoverable: true }
  }
  const candidate = generated as {
    collaborationMode?: unknown
    title?: unknown
    summary?: unknown
    phases?: Array<{
      id?: unknown
      title?: unknown
      purpose?: unknown
      taskIds?: unknown
    }>
    clarificationQuestions?: Array<{
      id?: unknown
      question?: unknown
      options?: unknown
    }>
    tasks?: Array<{
      id?: unknown
      phaseId?: unknown
      title?: unknown
      description?: unknown
      agentKey?: unknown
      taskType?: unknown
      dependencies?: unknown
      parallelGroup?: unknown
      maxRetries?: unknown
      outputContract?: unknown
      validation?: unknown
    }>
  }

  if (!Array.isArray(candidate.tasks) || candidate.tasks.length === 0) {
    return { plan: null, error: 'Planner returned no executable tasks', recoverable: true }
  }

  const agentMap = new Map(agents.map((a) => [a.key, a]))
  const taskIds = new Set<string>()
  const rawIdToUuid = new Map<string, string>()
  const tasks: ExecutionTask[] = []
  const violations: string[] = []

  for (const [index, t] of candidate.tasks.entries()) {
    const title = cleanPlanText(t.title)
    const description = cleanPlanText(t.description)
    const agentKey = typeof t.agentKey === 'string' ? t.agentKey : ''
    const requestedAgent = agentMap.get(agentKey)
    if (!title || !description) {
      violations.push(`Task ${index + 1} is missing title or description`)
      continue
    }
    if (!requestedAgent) {
      violations.push(`Task "${title}" references unknown agent key "${agentKey || '(empty)'}"`)
      continue
    }
    if (requestedAgent.roleType === 'orchestrator') {
      violations.push(`Task "${title}" is assigned to Orchestrator; execution tasks must target worker agents`)
      continue
    }
    const taskType = parseTaskType(t.taskType)

    const rawId = cleanPlanText(t.id) || slugifyTaskId(title, index)
    const id = crypto.randomUUID()
    rawIdToUuid.set(rawId, id)
    if (taskIds.has(id)) continue
    taskIds.add(id)

    const deps: string[] = []
    if (Array.isArray(t.dependencies)) {
      for (const dep of t.dependencies) {
        if (typeof dep === 'string') deps.push(dep)
      }
    }

    tasks.push({
      id,
      phaseId: cleanPlanText(t.phaseId) || undefined,
      title,
      description,
      agentId: requestedAgent.id,
      taskType,
      dependencies: deps,
      parallelGroup: typeof t.parallelGroup === 'string' ? t.parallelGroup : undefined,
      maxRetries: typeof t.maxRetries === 'number' ? Math.max(0, Math.min(t.maxRetries, 5)) : 2,
      outputContract: normalizeTaskOutputContract(t.outputContract, id),
      validation: normalizeTaskValidation(t.validation),
    })
  }

  if (violations.length) {
    return { plan: null, error: violations.slice(0, 4).join('; '), recoverable: true }
  }
  if (!tasks.length) {
    return { plan: null, error: 'Planner returned no valid worker tasks', recoverable: true }
  }

  for (const task of tasks) {
    task.dependencies = task.dependencies.map((dep) => rawIdToUuid.get(dep) ?? dep)
  }

  const knownTaskIds = new Set(tasks.map((task) => task.id))
  const unresolvedDependencies = tasks.flatMap((task) =>
    task.dependencies
      .filter((dep) => !knownTaskIds.has(dep))
      .map((dep) => `${task.title} -> ${dep}`),
  )
  if (unresolvedDependencies.length) {
    return {
      plan: null,
      error: `Planner returned dependencies that do not match any task: ${unresolvedDependencies.slice(0, 4).join('; ')}`,
      recoverable: true,
    }
  }

  const assignmentError = validateRealWorkerAssignments({ agents, tasks })
  if (assignmentError) {
    return { plan: null, error: assignmentError, recoverable: true }
  }

  applyContractDefaults(tasks, contracts)
  const phases = normalizePhases(candidate.phases, tasks, rawIdToUuid)
  const contractError = validatePlannerContracts(tasks, contracts)
  if (contractError) {
    return { plan: null, error: contractError, recoverable: true }
  }

  const clarificationQuestions: ClarificationQuestion[] = []
  if (Array.isArray(candidate.clarificationQuestions)) {
    for (const q of candidate.clarificationQuestions) {
      if (!q || typeof q !== 'object') continue
      const question = cleanPlanText(q.question)
      if (!question) continue
      const options = Array.isArray(q.options)
        ? q.options.filter((o): o is string => typeof o === 'string')
        : []
      clarificationQuestions.push({
        id: typeof q.id === 'string' ? q.id : `cq-${clarificationQuestions.length}`,
        question,
        options: options.length > 0 ? options : undefined,
      })
    }
  }

  const mode =
    typeof candidate.collaborationMode === 'string' &&
    ['pipeline', 'mapreduce', 'supervisor'].includes(candidate.collaborationMode)
      ? (candidate.collaborationMode as CollaborationMode)
      : undefined

  return {
    plan: {
      runId,
      title: cleanPlanText(candidate.title) || titleFromGoal(goal),
      goal,
      agents,
      tasks,
      phases: phases.length > 0 ? phases : undefined,
      collaborationMode: mode,
      clarificationQuestions:
        clarificationQuestions.length > 0 ? clarificationQuestions : undefined,
    },
    recoverable: false,
  }
}

function normalizePhases(
  phases: unknown,
  tasks: ExecutionTask[],
  rawIdToUuid: Map<string, string>,
): import('./types').OrchestratorPhase[] {
  const normalized: import('./types').OrchestratorPhase[] = []
  if (Array.isArray(phases)) {
    for (const phase of phases) {
      if (!phase || typeof phase !== 'object') continue
      const item = phase as {
        id?: unknown
        title?: unknown
        purpose?: unknown
        taskIds?: unknown
      }
      const id = cleanPlanText(item.id)
      if (!id || normalized.some((existing) => existing.id === id)) continue
      const rawTaskIds = Array.isArray(item.taskIds)
        ? item.taskIds.filter((taskId): taskId is string => typeof taskId === 'string')
        : []
      const taskIds = rawTaskIds
        .map((tid) => rawIdToUuid.get(tid) ?? tid)
        .filter(Boolean) as string[]
      normalized.push({
        id,
        title: cleanPlanText(item.title) || phaseTitleFromId(id),
        purpose: cleanPlanText(item.purpose) || phasePurposeFromId(id),
        taskIds,
      })
    }
  }

  for (const task of tasks) {
    const phaseId = task.phaseId ?? normalized.find((item) => item.taskIds.includes(task.id))?.id ?? 'execution'
    task.phaseId = phaseId
    let phase = normalized.find((item) => item.id === phaseId)
    if (!phase) {
      phase = {
        id: phaseId,
        title: phaseTitleFromId(phaseId),
        purpose: phasePurposeFromId(phaseId),
        taskIds: [],
      }
      normalized.push(phase)
    }
    if (!phase.taskIds.includes(task.id)) phase.taskIds.push(task.id)
  }

  return normalized
}

function phaseTitleFromId(id: string): string {
  if (id === 'analysis') return '分析'
  if (id === 'design') return '设计'
  if (id === 'implementation') return '实现'
  if (id === 'verification') return '验证'
  if (id === 'synthesis') return '汇总'
  return '执行'
}

function phasePurposeFromId(id: string): string {
  if (id === 'analysis') return '理解目标和上下文'
  if (id === 'design') return '确定方案和边界'
  if (id === 'implementation') return '完成核心实现'
  if (id === 'verification') return '验证质量和风险'
  if (id === 'synthesis') return '汇总协作产出'
  return '推进当前任务'
}

function validatePlannerContracts(tasks: ExecutionTask[], contracts: CollaborationContract[]) {
  if (!contracts.length) return null
  const requiredArtifacts = new Set<string>()
  for (const contract of contracts) {
    for (const artifact of contract.outputs.requiredArtifacts) requiredArtifacts.add(artifact)
    for (const forbiddenPath of contract.scope.forbiddenPaths) {
      for (const task of tasks) {
        const allowedPaths = task.outputContract?.allowedPaths ?? []
        if (allowedPaths.some((allowed) => pathPatternIntersects(allowed, forbiddenPath))) {
          return `Task "${task.title}" declares an allowed path that intersects forbidden contract path "${forbiddenPath}"`
        }
      }
    }
  }

  for (const required of requiredArtifacts) {
    const matched = tasks.some((task) => (task.outputContract?.requiredArtifacts ?? []).includes(required))
    if (!matched) return `Explicit collaboration contract requires artifact "${required}" but no task declares it`
  }
  const requiresBlackboardWrites = contracts.some(
    (contract) => contract.outputs.requiredBlackboardWrites.length > 0,
  )
  if (
    requiresBlackboardWrites &&
    !tasks.some((task) => (task.outputContract?.requiredBlackboardWrites ?? []).length > 0)
  ) {
    return 'Explicit collaboration contract requires blackboard writes but no task declares any blackboard output contract'
  }

  return null
}

function applyContractDefaults(tasks: ExecutionTask[], contracts: CollaborationContract[]) {
  if (!contracts.length) return
  const allowedPaths = contracts.flatMap((contract) => contract.scope.allowedPaths ?? [])
  const acceptanceCriteria = contracts.flatMap((contract) => [
    ...(contract.quality.acceptanceCriteria ?? []),
    ...(contract.quality.qualityGates ?? []),
  ])
  if (!allowedPaths.length && !acceptanceCriteria.length) return

  for (const task of tasks) {
    const current = task.outputContract ?? {
      requiredBlackboardWrites: [],
      requiredArtifacts: [],
      allowedPaths: [],
      acceptanceCriteria: [],
    }
    const nextAllowed = uniqueStrings([
      ...(current.allowedPaths ?? []),
      ...allowedPaths,
    ])
    const nextCriteria = uniqueStrings([
      ...(current.acceptanceCriteria ?? []),
      ...acceptanceCriteria,
    ])
    task.outputContract = {
      ...current,
      allowedPaths: nextAllowed,
      acceptanceCriteria: nextCriteria,
    }
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function pathPatternIntersects(a: string, b: string) {
  const left = normalizePathPattern(a)
  const right = normalizePathPattern(b)
  if (!left || !right) return false
  if (left === right) return true
  if (left.startsWith(right.replace(/\*\*$/, '')) || right.startsWith(left.replace(/\*\*$/, ''))) return true
  return false
}

function normalizePathPattern(pattern: string) {
  return pattern.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '')
}
