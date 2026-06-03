import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import { runtimeRegistry, type AgentProfile } from '../runtime'
import { extractJsonObject, parseJsonObject } from './planner'
import type { PlanningAgentInput } from './plan-generator'
import { CORE_AGENT_EXPERT_PROFILES } from '@agenthub/shared'

export type OrchestratorDecisionAction = 'reply' | 'clarify' | 'plan'

export interface OrchestratorMemberProposal {
  expertProfileId: string
  name: string
  role: string
  category: string
  runtimeType: 'llm' | 'code-agent'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  color?: string
  capabilityTags: string[]
  reason: string
  expectedContribution: string
}

export interface OrchestratorDecision {
  action: OrchestratorDecisionAction
  message?: string
  reason?: string
  memberProposals?: OrchestratorMemberProposal[]
  replyTargetAgentId?: string
  replyTargetAgentName?: string
}

export interface ActiveTaskContextItem {
  taskId: string
  taskTitle: string
  taskStatus: string
  taskThreadStatus?: string | null
  agentId?: string | null
  agentName?: string | null
  progressStatus?: string | null
  awaitingClarification?: boolean
  updatedAt?: string | null
}

export const __orchestratorDecisionTestHooks = {
  buildHeuristicDecision,
  chooseReplyTargetFromActiveContext,
}

export interface DecideInput {
  content: string
  agents: PlanningAgentInput[]
  workspaceGoal?: string | null
  workspacePath?: string | null
  activeTaskContext?: ActiveTaskContextItem[]
  recentMessages?: Array<{
    senderType: 'user' | 'agent' | 'system'
    senderName?: string | null
    content: string
  }>
}

const DECISION_SYSTEM = [
  '你是 AgentHub 群聊里的主 Agent（Orchestrator）。',
  '你收到用户在 Agent 群聊中的消息后，需要自己判断下一步动作。',
  '这个群聊首先是“房间里的团队协作”，不是工单系统。不是所有消息都要进入规划流程。',
  '只能输出 JSON，不要 Markdown、不要解释、不要代码块。',
  '',
  '动作定义：',
  '- reply：普通寒暄、打招呼、追问进度、让某个成员自我介绍、轻量讨论、无需多人正式开工的说明或协调。',
  '- clarify：需要先问用户补充关键信息，否则无法合理分工。',
  '- plan：用户要求创建、开发、实现、设计、调研、分析、输出产物、修改项目、生成文件、做网页/应用/游戏/文档/报告/PDF/PPT/HTML，或任何需要多个 Agent 协作完成的工作。',
  '',
  '重要原则：',
  '- Orchestrator 只负责判断、协调、拆解和汇总，不亲自执行代码或产出文件。',
  '- 只有当用户明确在要求“做出某个东西”或“完成一项工作”时，优先 action=plan。',
  '- 如果用户只是在聊天、寒暄、点名、催进度、确认状态、让成员打招呼或自我介绍，优先 action=reply。',
  '- 如果消息本身更像房间内自然交流，而不是新的交付目标，不要为了显得主动就进入 plan。',
  '- 如果用户明显是在点某位现有成员发言、汇报、介绍自己，action=reply，并尽量填写 replyTargetAgentId；拿不准时可填写 replyTargetAgentName。',
  '- 如果用户是在追问当前执行情况、回应某个进行中的任务、回答某个澄清问题，优先让当前正在执行或刚刚发起澄清的成员直接回复，而不是让 Orchestrator 代答。',
  '- 如果房间里只有一个活跃中的 Worker，且用户是在追问进度/确认/补充信息，优先把 replyTarget 指向这个 Worker。',
  '- 如果当前成员能力明显不足，但可用核心模板里有合适的 Agent，请 action=clarify，并在 memberProposals 里给出 1-3 个建议补充的 Agent；不要静默创建或假装已有成员。',
  '- memberProposals[].expertProfileId 必须来自“可建议补充的核心 Agent 模板”，不能编造。',
  '- 不要因为用户没有写明技术栈、文件类型或“游戏/网页”等关键词就回避计划；你要理解自然语言意图。',
  '- 如果只是缺少可选细节，但仍可合理默认，请 action=plan，不要过度追问。',
  '',
  '示例：',
  '- “大家好”“你们在吗”“alice 出来汇报一下” => action=reply。',
  '- “给我做一个深圳技术大学介绍网站” => action=plan。',
  '- “你们现在做到哪了，谁在负责前端？” => action=reply。',
  '- “请调研今天 A 股港股美股并输出 HTML 报告” => action=plan。',
  '- “这个群现在缺少谁来做测试？”且确实缺少关键成员 => action=clarify。',
  '',
  '输出格式：{"action":"reply|clarify|plan","message":"给用户看的简短中文内容","reason":"内部判断理由","replyTargetAgentId":"应当直接回复的现有成员 id","replyTargetAgentName":"应当直接回复的现有成员名字","memberProposals":[{"expertProfileId":"模板 id","reason":"为什么需要","expectedContribution":"加入后负责什么"}]}',
].join('\n')

export async function decideOrchestratorAction(input: DecideInput): Promise<OrchestratorDecision> {
  const orchestrator = input.agents.find((agent) => agent.roleType === 'orchestrator')
  const workers = input.agents.filter((agent) => agent.roleType !== 'orchestrator')
  const prompt = [
    `用户消息：${input.content}`,
    input.workspaceGoal ? `群聊目标：${input.workspaceGoal}` : '',
    '',
    input.recentMessages?.length
      ? ['最近房间对话：', ...input.recentMessages.map(formatRecentMessage)].join('\n')
      : '',
    input.recentMessages?.length ? '' : '',
    input.activeTaskContext?.length
      ? [
          '当前活跃任务上下文：',
          ...input.activeTaskContext.map((task) =>
            [
              `- task=${task.taskTitle}`,
              `status=${task.taskStatus}`,
              task.taskThreadStatus ? `thread=${task.taskThreadStatus}` : '',
              task.agentName ? `agent=${task.agentName}` : '',
              task.awaitingClarification ? 'awaitingClarification=true' : '',
              task.progressStatus ? `progress=${task.progressStatus}` : '',
            ]
              .filter(Boolean)
              .join('；'),
          ),
        ].join('\n')
      : '',
    input.activeTaskContext?.length ? '' : '',
    '当前成员：',
    ...input.agents.map((agent) =>
      [
        `- ${agent.name}`,
        agent.roleType ? `roleType=${agent.roleType}` : '',
        agent.role ? `role=${agent.role}` : '',
        agent.runtimeType ? `runtime=${agent.runtimeType}` : '',
        agent.capabilityTags?.length ? `capabilities=${agent.capabilityTags.join(',')}` : '',
        readExpertProfileId(agent.roleProfile) ? `expertProfileId=${readExpertProfileId(agent.roleProfile)}` : '',
      ]
        .filter(Boolean)
        .join('；'),
    ),
    '',
    `可执行成员数量：${workers.length}`,
    '',
    '可建议补充的核心 Agent 模板（仅用于向用户申请补员，不能静默创建）：',
    ...availableExpertProfiles(input.agents).map((profile) =>
      [
        `- ${profile.id}`,
        `name=${profile.name}`,
        `role=${profile.role}`,
        `category=${profile.category}`,
        profile.capabilityTags.length ? `capabilities=${profile.capabilityTags.join(',')}` : '',
        profile.acceptsTaskTypes.length ? `accepts=${profile.acceptsTaskTypes.join(',')}` : '',
      ]
        .filter(Boolean)
        .join('；'),
    ),
  ]
    .filter(Boolean)
    .join('\n')

  let output = await generateDecisionOutput({
    prompt,
    orchestrator,
    workspacePath: input.workspacePath,
  })

  let jsonText = extractJsonObject(output)
  if (!jsonText && orchestrator?.runtimeType === 'code-agent') {
    logger.warn(
      {
        orchestratorId: orchestrator.id,
        orchestratorName: orchestrator.name,
        outputPreview: formatOutputPreview(output),
      },
      'Code-agent orchestrator decision returned non-JSON output',
    )
  }
  const candidateProposals = availableExpertProfiles(input.agents)
  if (!jsonText) {
    throw new Error(`Orchestrator 没有返回可解析的路由判断。原始输出片段：${formatOutputPreview(output)}`)
  }

  const parsed = parseJsonObject(jsonText) as Partial<OrchestratorDecision>
  const action = parsed.action
  if (action !== 'reply' && action !== 'clarify' && action !== 'plan') {
    throw new Error('Orchestrator 返回了无效的路由动作')
  }
  if (action === 'plan' && workers.length === 0) {
    return {
      action: 'clarify',
      message: '当前群聊只有 Orchestrator，还没有可执行任务的 Agent。请先添加合适的执行成员后再分发任务。',
      reason: 'no worker agents',
      memberProposals: normalizeMemberProposals(parsed.memberProposals, candidateProposals),
    }
  }
  const activeContextTarget = chooseReplyTargetFromActiveContext({
    action,
    agents: input.agents,
    activeTaskContext: input.activeTaskContext,
  })
  return {
    action,
    message: normalizeMessage(parsed.message),
    reason: normalizeMessage(parsed.reason),
    memberProposals: normalizeMemberProposals(parsed.memberProposals, candidateProposals),
    replyTargetAgentId:
      normalizeOptionalString(parsed.replyTargetAgentId) ?? activeContextTarget?.id,
    replyTargetAgentName:
      normalizeOptionalString(parsed.replyTargetAgentName) ?? activeContextTarget?.name,
  }
}

async function generateDecisionOutput(params: {
  prompt: string
  orchestrator?: PlanningAgentInput
  workspacePath?: string | null
}) {
  const { prompt, orchestrator, workspacePath } = params
  if (orchestrator?.runtimeType === 'code-agent') {
    return generateDecisionWithCodeAgent(prompt, orchestrator, workspacePath)
  }

  return generateDecisionWithLlm(prompt, orchestrator?.modelId ?? undefined)
}

async function generateDecisionWithLlm(prompt: string, modelId?: string | null) {
  let output = ''
  for await (const chunk of streamReply(
    [{ role: 'user', content: prompt }],
    DECISION_SYSTEM,
    modelId ?? undefined,
  )) {
    output += chunk
    if (output.length > 4000) break
  }
  return output
}

async function generateDecisionWithCodeAgent(
  prompt: string,
  orchestrator: PlanningAgentInput,
  workspacePath?: string | null,
) {
  const codeAgentType = normalizeCodeAgentType(orchestrator.codeAgentType)
  if (!codeAgentType) {
    throw new Error('Orchestrator 配置为 Code Agent，但没有绑定 Coding Tools 类型')
  }

  const profile: AgentProfile = {
    id: orchestrator.id,
    name: orchestrator.name,
    role: orchestrator.role ?? undefined,
    roleType: orchestrator.roleType ?? undefined,
    description: orchestrator.description ?? undefined,
    systemPrompt: [
      orchestrator.systemPrompt ?? undefined,
      DECISION_SYSTEM,
      '你本次只做群聊路由判断，不要修改文件、不要创建计划文件、不要运行命令。',
      '最终只能输出一个 JSON 对象。',
    ]
      .filter(Boolean)
      .join('\n'),
    color: orchestrator.color ?? undefined,
    modelId: orchestrator.modelId ?? null,
    runtimeType: 'code-agent',
    codeAgentType,
    capabilityTags: orchestrator.capabilityTags ?? [],
    toolPermissions: orchestrator.toolPermissions ?? [],
    sandboxPolicy: 'workspace-write',
    contextPolicy: 'workspace-aware',
    approvalRequired: false,
    projectPath: workspacePath ?? null,
    originalProjectPath: workspacePath ?? null,
  }
  const runtime = runtimeRegistry.resolve(profile)
  let output = ''
  for await (const chunk of runtime.execute({
    sessionId: `orchestrator-decision-${crypto.randomUUID()}`,
    prompt: [
      '请根据下面输入判断 Orchestrator 下一步动作。',
      '只输出 JSON，不要 Markdown，不要解释。',
      '',
      prompt,
    ].join('\n'),
    history: [],
    profile,
    signal: new AbortController().signal,
    workspacePath,
    rawFinalOutput: true,
  })) {
    if (chunk.kind !== 'text') continue
    output += chunk.text
    if (output.length > 4000) break
  }
  return output
}

function formatOutputPreview(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return '空输出'
  return normalized.slice(0, 300)
}

function normalizeCodeAgentType(value?: string | null): AgentProfile['codeAgentType'] | null {
  if (value === 'codex' || value === 'claude-code' || value === 'opencode' || value === 'gemini') {
    return value
  }
  return null
}

function normalizeMessage(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 1200) : ''
}

function normalizeOptionalString(value: unknown) {
  const normalized = normalizeMessage(value)
  return normalized || undefined
}

function chooseReplyTargetFromActiveContext(input: {
  action: OrchestratorDecisionAction
  agents: PlanningAgentInput[]
  activeTaskContext?: ActiveTaskContextItem[]
}) {
  if (input.action !== 'reply' || !input.activeTaskContext?.length) return null

  const workersById = new Map(
    input.agents
      .filter((agent) => agent.roleType !== 'orchestrator')
      .map((agent) => [agent.id, agent] as const),
  )

  const inflightTasks = input.activeTaskContext.filter((task) => {
    const agentId = normalizeOptionalString(task.agentId)
    return Boolean(agentId && workersById.has(agentId))
  })
  if (!inflightTasks.length) return null

  const clarificationTargets = uniqueActiveTaskAgents(
    inflightTasks.filter((task) => task.awaitingClarification),
    workersById,
  )
  if (clarificationTargets.length === 1) return clarificationTargets[0] ?? null

  const activeTargets = uniqueActiveTaskAgents(
    inflightTasks.filter(
      (task) =>
        task.taskThreadStatus === 'active' ||
        task.taskStatus === 'running' ||
        task.taskStatus === 'blocked',
    ),
    workersById,
  )
  if (activeTargets.length === 1) return activeTargets[0] ?? null

  const inflightTargets = uniqueActiveTaskAgents(inflightTasks, workersById)
  if (inflightTargets.length === 1) return inflightTargets[0] ?? null

  return null
}

function uniqueActiveTaskAgents(
  tasks: ActiveTaskContextItem[],
  workersById: Map<string, PlanningAgentInput>,
) {
  return Array.from(
    new Map(
      tasks
        .map((task) => normalizeOptionalString(task.agentId))
        .filter((agentId): agentId is string => Boolean(agentId))
        .map((agentId) => {
          const worker = workersById.get(agentId)
          return worker ? [agentId, { id: worker.id, name: worker.name }] : null
        })
        .filter((entry): entry is [string, { id: string; name: string }] => Boolean(entry)),
    ).values(),
  )
}

function availableExpertProfiles(agents: PlanningAgentInput[]) {
  const existingProfileIds = new Set(
    agents
      .map((agent) => readExpertProfileId(agent.roleProfile))
      .filter((id): id is string => Boolean(id)),
  )
  const existingNames = new Set(agents.map((agent) => normalizeText(agent.name)))
  return CORE_AGENT_EXPERT_PROFILES
    .filter((profile) => !existingProfileIds.has(profile.id) && !existingNames.has(normalizeText(profile.name)))
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      role: profile.role,
      category: profile.category,
      runtimeType: profile.runtimeType,
      codeAgentType: profile.codeAgentType ?? null,
      color: profile.color,
      capabilityTags: profile.capabilityTags.slice(0, 8),
      acceptsTaskTypes: profile.acceptsTaskTypes.slice(0, 6),
    }))
}

function normalizeMemberProposals(
  value: unknown,
  candidateProposals: ReturnType<typeof availableExpertProfiles>,
): OrchestratorMemberProposal[] {
  if (!Array.isArray(value)) return []
  const candidates = new Map(candidateProposals.map((profile) => [profile.id, profile]))
  const seen = new Set<string>()
  const proposals: OrchestratorMemberProposal[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as {
      expertProfileId?: unknown
      reason?: unknown
      expectedContribution?: unknown
    }
    if (typeof raw.expertProfileId !== 'string') continue
    const profile = candidates.get(raw.expertProfileId)
    if (!profile || seen.has(profile.id)) continue
    seen.add(profile.id)
    proposals.push({
      expertProfileId: profile.id,
      name: profile.name,
      role: profile.role,
      category: profile.category,
      runtimeType: profile.runtimeType,
      codeAgentType: profile.codeAgentType,
      color: profile.color,
      capabilityTags: profile.capabilityTags,
      reason: normalizeMessage(raw.reason),
      expectedContribution: normalizeMessage(raw.expectedContribution),
    })
    if (proposals.length >= 3) break
  }
  return proposals
}

function readExpertProfileId(roleProfile: unknown) {
  if (!roleProfile || typeof roleProfile !== 'object') return ''
  const value = (roleProfile as { expertProfileId?: unknown }).expertProfileId
  return typeof value === 'string' ? value : ''
}

function normalizeText(value?: string | null) {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function formatRecentMessage(message: NonNullable<DecideInput['recentMessages']>[number]) {
  const role =
    message.senderType === 'user' ? '用户' : message.senderType === 'agent' ? '成员' : '系统'
  const name = normalizeMessage(message.senderName).slice(0, 80)
  const prefix = name ? `${role}(${name})` : role
  return `- ${prefix}: ${normalizeMessage(message.content)}`
}

function buildHeuristicDecision(
  content: string,
  workerCount: number,
): OrchestratorDecision | null {
  void content
  void workerCount
  return null
}
