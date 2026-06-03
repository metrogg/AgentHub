import { streamReply } from '../llm'
import { runtimeRegistry, type AgentProfile } from '../runtime'
import { extractJsonObject, normalizeTaskOutputContract, normalizeTaskValidation, parseJsonObject, titleFromGoal, validateRealWorkerAssignments } from './planner'
import type { CollaborationContract } from './collaboration-contract'
import { formatContractsForPlanner } from './collaboration-contract'
import { initializeRunLedger } from './run-ledger'
import type { ExecutionAgent, ExecutionPlan, ExecutionTask, CollaborationMode } from './types'

export interface ManagerPlanInput {
  goal: string
  agents: ExecutionAgent[]
  agentRelations?: ExecutionPlan['agentRelations']
  workspacePath?: string | null
  collaborationContracts?: CollaborationContract[]
  managerModelId?: string | null
  managerSystemPrompt?: string | null
  managerAgent?: ExecutionAgent | null
}

type ManagerPlanTask = {
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
}

type ManagerPlanOutput = {
  collaborationMode?: unknown
  title?: unknown
  summary?: unknown
  phases?: Array<{
    id?: unknown
    title?: unknown
    purpose?: unknown
    taskIds?: unknown
  }>
  tasks?: ManagerPlanTask[]
}

/**
 * Manager-first planning action.
 *
 * This replaces the old "Planner is the brain" path. The Manager/Orchestrator
 * is asked to decide concrete team actions directly, while this service only
 * validates the result and maps it into AgentHub resources.
 */
export async function createManagerActionPlan(input: ManagerPlanInput): Promise<ExecutionPlan> {
  const runId = crypto.randomUUID()
  const workers = input.agents.filter((agent) => agent.roleType !== 'orchestrator')
  if (!workers.length) {
    throw new Error('当前群聊只有 Orchestrator，没有可执行任务的 Worker')
  }

  const output = await generateManagerPlanOutput(input)
  const jsonText = extractJsonObject(output)
  if (!jsonText) {
    throw new Error(`Manager 没有返回可解析的行动方案。原始输出片段：${formatPreview(output)}`)
  }

  const parsed = parseJsonObject(jsonText) as ManagerPlanOutput
  const plan = normalizeManagerPlanOutput({
    runId,
    goal: input.goal,
    generated: parsed,
    agents: input.agents,
    contracts: input.collaborationContracts ?? [],
    agentRelations: input.agentRelations ?? [],
  })
  return initializeRunLedger(plan)
}

async function generateManagerPlanOutput(input: ManagerPlanInput) {
  if (input.managerAgent?.runtimeType === 'code-agent') {
    return generateWithManagerCodeAgent(input)
  }
  return generateWithInternalLlm(input)
}

async function generateWithInternalLlm(input: ManagerPlanInput) {
  let output = ''
  for await (const chunk of streamReply(
    [{ role: 'user', content: buildManagerPlanUserPrompt(input) }],
    buildManagerPlanSystemPrompt(input),
    input.managerModelId ?? undefined,
  )) {
    output += chunk
    if (output.length > 24_000) break
  }
  return output
}

async function generateWithManagerCodeAgent(input: ManagerPlanInput) {
  const manager = input.managerAgent
  if (!manager?.codeAgentType) {
    throw new Error('Manager 配置为 Code Agent，但没有绑定 Coding Tools 类型')
  }

  const profile: AgentProfile = {
    id: manager.id,
    name: manager.name,
    role: manager.role,
    roleType: manager.roleType,
    description: manager.description,
    systemPrompt: [
      manager.systemPrompt,
      buildManagerPlanSystemPrompt(input),
      '你本次只进行团队管理决策，不要修改文件、不要运行命令、不要创建本地计划文件。',
      '最终只输出一个 JSON 对象。',
    ]
      .filter(Boolean)
      .join('\n'),
    color: manager.color,
    modelId: manager.modelId,
    runtimeType: 'code-agent',
    codeAgentType: manager.codeAgentType,
    capabilityTags: manager.capabilityTags,
    toolPermissions: manager.toolPermissions,
    sandboxPolicy: 'workspace-write',
    contextPolicy: 'workspace-aware',
    approvalRequired: false,
    projectPath: input.workspacePath ?? null,
    originalProjectPath: input.workspacePath ?? null,
  }
  const runtime = runtimeRegistry.resolve(profile)
  const controller = new AbortController()
  let output = ''
  for await (const chunk of runtime.execute({
    sessionId: `manager-plan-${crypto.randomUUID()}`,
    prompt: buildManagerPlanUserPrompt(input),
    history: [],
    profile,
    signal: controller.signal,
    workspacePath: input.workspacePath,
    rawFinalOutput: true,
  })) {
    if (chunk.kind !== 'text') continue
    output += chunk.text
    if (output.length > 24_000) break
  }
  return output
}

function buildManagerPlanSystemPrompt(input: ManagerPlanInput) {
  return [
    '你是 AgentHub 群聊中的 Manager / Orchestrator，不是旧式 Planner。',
    '你的职责像 HiClaw Manager：理解人类目标，组织 Worker，创建任务房间，派活，监督，必要时追问或请求补员。',
    '本次你要输出“团队行动方案”，不是机械 DAG 模板。',
    '只能输出 JSON，不能 Markdown，不能解释，不能代码块。',
    '',
    '硬性边界：',
    '- Manager 只协调、分派、监督和总结，不亲自执行任务。',
    '- 每个执行任务必须分配给现有 Worker，不能分配给 Orchestrator。',
    '- 如果有两个或更多 Worker，行动方案必须让至少两个 Worker 实际参与，除非你能在 task description 里说明为什么只能单人执行。',
    '- 不要使用固定团队模板、关键词路由或静态场景规则。',
    '- 不要编造不存在的 Agent、文件、工具或 MCP。',
    '- 如果需要新增 Worker，本次不要静默创建，应通过上一层 memberProposals 申请；这里仅使用当前成员。',
    '- 每个 task description 要像 Manager 发给 Worker 的真实指令：说明目标、上下文、交付物、与其他 Worker 的协作方式、结果回报格式。',
    '- 每个任务产出必须写入共享任务目录 result.md，包含 STATUS、SUMMARY、DELIVERABLES、NOTES。',
    '',
    '输出 schema：',
    '{"collaborationMode":"pipeline|mapreduce|supervisor","title":string,"summary":string,"phases":[{"id":string,"title":string,"purpose":string,"taskIds":string[]}],"tasks":[{"id":string,"phaseId":string,"title":string,"description":string,"agentKey":string,"taskType":"read|research|design|code|test|review|synthesize","dependencies":string[],"parallelGroup":string?,"maxRetries":number?,"outputContract":{"requiredBlackboardWrites":[{"key":string,"schemaType":"fact|decision|risk|artifact_ref|diff_summary|test_result|task_output"}],"requiredArtifacts":string[],"allowedPaths":string[],"acceptanceCriteria":string[]},"validation":{"commands":string[],"requiresReview":boolean}}]}',
    '',
    input.managerSystemPrompt
      ? `Manager 角色设定 / SOUL：\n${input.managerSystemPrompt}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildManagerPlanUserPrompt(input: ManagerPlanInput) {
  const agentCatalog = input.agents.map((agent) => ({
    key: agent.key,
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType,
    description: agent.description,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: agent.capabilityTags,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: agent.sandboxPolicy,
    systemPrompt: agent.systemPrompt,
  }))
  const contracts = input.collaborationContracts?.length
    ? formatContractsForPlanner(input.collaborationContracts)
    : ''
  return JSON.stringify(
    {
      humanGoal: input.goal,
      language: 'zh-CN',
      workspacePath: input.workspacePath ?? null,
      currentAgents: agentCatalog,
      agentRelations: input.agentRelations ?? [],
      explicitCollaborationContracts: contracts || null,
      instruction:
        '请以 Manager 身份决定如何组织当前 Worker 完成目标，输出可执行的团队行动方案 JSON。',
    },
    null,
    2,
  )
}

function normalizeManagerPlanOutput(input: {
  runId: string
  goal: string
  generated: ManagerPlanOutput
  agents: ExecutionAgent[]
  contracts: CollaborationContract[]
  agentRelations: ExecutionPlan['agentRelations']
}): ExecutionPlan {
  const tasks = normalizeTasks(input.generated.tasks, input.agents, input.contracts)
  const assignmentError = validateRealWorkerAssignments({ agents: input.agents, tasks })
  if (assignmentError) throw new Error(`Manager 行动方案无效：${assignmentError}`)

  return {
    runId: input.runId,
    title: clean(input.generated.title) || titleFromGoal(input.goal),
    goal: input.goal,
    agents: input.agents,
    tasks,
    phases: normalizePhases(input.generated.phases, tasks),
    agentRelations: input.agentRelations,
    collaborationMode: normalizeMode(input.generated.collaborationMode),
  }
}

function normalizeTasks(
  rawTasks: ManagerPlanTask[] | undefined,
  agents: ExecutionAgent[],
  contracts: CollaborationContract[],
): ExecutionTask[] {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error('Manager 没有给出任何可执行 Worker 任务')
  }

  const agentByKey = new Map(agents.map((agent) => [agent.key, agent]))
  const rawIdToId = new Map<string, string>()
  const tasks: ExecutionTask[] = []

  rawTasks.forEach((task, index) => {
    const rawId = clean(task.id) || `task-${index + 1}`
    rawIdToId.set(rawId, crypto.randomUUID())
  })

  for (const [index, task] of rawTasks.entries()) {
    const title = clean(task.title)
    const description = clean(task.description)
    const agentKey = clean(task.agentKey)
    const agent = agentByKey.get(agentKey)
    if (!title || !description) {
      throw new Error(`Manager 任务 ${index + 1} 缺少 title 或 description`)
    }
    if (!agent) {
      throw new Error(`Manager 任务 "${title}" 引用了不存在的 Agent：${agentKey || '(empty)'}`)
    }
    if (agent.roleType === 'orchestrator') {
      throw new Error(`Manager 任务 "${title}" 被分配给 Orchestrator，执行任务必须交给 Worker`)
    }

    const rawId = clean(task.id) || `task-${index + 1}`
    const id = rawIdToId.get(rawId) ?? crypto.randomUUID()
    tasks.push({
      id,
      phaseId: clean(task.phaseId) || undefined,
      title,
      description,
      agentId: agent.id,
      taskType: normalizeTaskType(task.taskType),
      dependencies: Array.isArray(task.dependencies)
        ? task.dependencies
            .filter((dep): dep is string => typeof dep === 'string')
            .map((dep) => rawIdToId.get(dep) ?? dep)
        : [],
      parallelGroup: clean(task.parallelGroup) || undefined,
      maxRetries:
        typeof task.maxRetries === 'number'
          ? Math.max(0, Math.min(task.maxRetries, 5))
          : 1,
      outputContract: normalizeTaskOutputContract(task.outputContract, id),
      validation: normalizeTaskValidation(task.validation),
    })
  }

  const known = new Set(tasks.map((task) => task.id))
  const badDependency = tasks
    .flatMap((task) => task.dependencies.map((dep) => ({ task, dep })))
    .find((item) => !known.has(item.dep))
  if (badDependency) {
    throw new Error(`Manager 任务 "${badDependency.task.title}" 依赖了不存在的任务：${badDependency.dep}`)
  }

  applyContractHints(tasks, contracts)
  return tasks
}

function normalizePhases(phases: ManagerPlanOutput['phases'], tasks: ExecutionTask[]) {
  const normalized: NonNullable<ExecutionPlan['phases']> = []
  if (Array.isArray(phases)) {
    for (const phase of phases) {
      const id = clean(phase.id)
      if (!id || normalized.some((item) => item.id === id)) continue
      normalized.push({
        id,
        title: clean(phase.title) || id,
        purpose: clean(phase.purpose) || '推进团队协作',
        taskIds: [],
      })
    }
  }
  for (const task of tasks) {
    const phaseId = task.phaseId || 'manager-dispatch'
    task.phaseId = phaseId
    let phase = normalized.find((item) => item.id === phaseId)
    if (!phase) {
      phase = {
        id: phaseId,
        title: 'Manager 分派',
        purpose: 'Manager 组织 Worker 完成当前目标',
        taskIds: [],
      }
      normalized.push(phase)
    }
    if (!phase.taskIds.includes(task.id)) phase.taskIds.push(task.id)
  }
  return normalized
}

function normalizeMode(value: unknown): CollaborationMode {
  return value === 'pipeline' || value === 'mapreduce' || value === 'supervisor'
    ? value
    : 'supervisor'
}

function normalizeTaskType(value: unknown): ExecutionTask['taskType'] {
  const allowed = new Set(['read', 'research', 'design', 'code', 'test', 'review', 'synthesize'])
  return typeof value === 'string' && allowed.has(value)
    ? (value as ExecutionTask['taskType'])
    : undefined
}

function applyContractHints(tasks: ExecutionTask[], contracts: CollaborationContract[]) {
  if (!contracts.length) return
  const criteria = contracts.flatMap((contract) => [
    ...(contract.quality.acceptanceCriteria ?? []),
    ...(contract.quality.qualityGates ?? []),
  ])
  if (!criteria.length) return
  for (const task of tasks) {
    task.outputContract = {
      requiredBlackboardWrites: task.outputContract?.requiredBlackboardWrites ?? [],
      requiredArtifacts: task.outputContract?.requiredArtifacts ?? [],
      allowedPaths: task.outputContract?.allowedPaths ?? [],
      acceptanceCriteria: [
        ...(task.outputContract?.acceptanceCriteria ?? []),
        ...criteria.filter((item) => !(task.outputContract?.acceptanceCriteria ?? []).includes(item)),
      ],
    }
  }
}

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function formatPreview(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500)
}
