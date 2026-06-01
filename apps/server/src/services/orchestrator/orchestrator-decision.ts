import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import { runtimeRegistry, type AgentProfile } from '../runtime'
import { extractJsonObject, parseJsonObject } from './planner'
import type { PlanningAgentInput } from './plan-generator'

export type OrchestratorDecisionAction = 'reply' | 'clarify' | 'plan'

export interface OrchestratorDecision {
  action: OrchestratorDecisionAction
  message?: string
  reason?: string
}

export const __orchestratorDecisionTestHooks = {
  buildHeuristicDecision,
}

interface DecideInput {
  content: string
  agents: PlanningAgentInput[]
  workspaceGoal?: string | null
  workspacePath?: string | null
}

const DECISION_SYSTEM = [
  '你是 AgentHub 群聊里的主 Agent（Orchestrator）。',
  '你收到用户在 Agent 群聊中的消息后，需要自己判断下一步动作。',
  '只能输出 JSON，不要 Markdown、不要解释、不要代码块。',
  '',
  '动作定义：',
  '- reply：普通寒暄、非常简单的问题、无需其他 Agent 干活的解释说明。',
  '- clarify：需要先问用户补充关键信息，否则无法合理分工。',
  '- plan：用户要求创建、开发、实现、设计、调研、分析、输出产物、修改项目、生成文件、做网页/应用/游戏/文档/报告/PDF/PPT/HTML，或任何需要多个 Agent 协作完成的工作。',
  '',
  '重要原则：',
  '- Orchestrator 只负责判断、协调、拆解和汇总，不亲自执行代码或产出文件。',
  '- 只要用户是在要求“做出某个东西”或“完成一项工作”，优先 action=plan。',
  '- 不要因为用户没有写明技术栈、文件类型或“游戏/网页”等关键词就回避计划；你要理解自然语言意图。',
  '- 如果只是缺少可选细节，但仍可合理默认，请 action=plan，不要过度追问。',
  '',
  '输出格式：{"action":"reply|clarify|plan","message":"给用户看的简短中文内容","reason":"内部判断理由"}',
].join('\n')

export async function decideOrchestratorAction(input: DecideInput): Promise<OrchestratorDecision> {
  const orchestrator = input.agents.find((agent) => agent.roleType === 'orchestrator')
  const workers = input.agents.filter((agent) => agent.roleType !== 'orchestrator')
  const prompt = [
    `用户消息：${input.content}`,
    input.workspaceGoal ? `群聊目标：${input.workspaceGoal}` : '',
    '',
    '当前成员：',
    ...input.agents.map((agent) =>
      [
        `- ${agent.name}`,
        agent.roleType ? `roleType=${agent.roleType}` : '',
        agent.role ? `role=${agent.role}` : '',
        agent.runtimeType ? `runtime=${agent.runtimeType}` : '',
      ]
        .filter(Boolean)
        .join('；'),
    ),
    '',
    `可执行成员数量：${workers.length}`,
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
      'Code-agent orchestrator decision returned non-JSON output; falling back to control LLM',
    )
    const fallbackOutput = await generateDecisionWithLlm(prompt, orchestrator?.modelId ?? undefined)
    const fallbackJsonText = extractJsonObject(fallbackOutput)
    if (fallbackJsonText) {
      output = fallbackOutput
      jsonText = fallbackJsonText
    }
  }
  if (!jsonText) {
    const heuristic = buildHeuristicDecision(input.content, workers.length)
    if (heuristic) return heuristic
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
      message: '当前群聊只有 Orchestrator，还没有可执行任务的 Agent。请先添加 Researcher、Designer、Builder 或 QA Reviewer 等成员。',
      reason: 'no worker agents',
    }
  }
  return {
    action,
    message: normalizeMessage(parsed.message),
    reason: normalizeMessage(parsed.reason),
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
    sandboxPolicy: 'read-only',
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

function buildHeuristicDecision(
  content: string,
  workerCount: number,
): OrchestratorDecision | null {
  const text = content.trim()
  if (!text) {
    return {
      action: 'reply',
      message: '我在。你可以直接描述要完成的目标，我会判断是否需要分派给团队成员。',
      reason: 'empty_or_short_message_fallback',
    }
  }

  const looksLikeWork =
    /创建|开发|实现|设计|调研|分析|输出|生成|修改|修复|写|做|页面|网站|应用|游戏|文档|报告|PDF|PPT|HTML|代码|部署|测试|验证|review|build|create|implement|fix|generate|analyze|design/i.test(
      text,
    )
  if (looksLikeWork) {
    if (workerCount === 0) {
      return {
        action: 'clarify',
        message:
          '当前群聊只有 Orchestrator，还没有可执行任务的 Agent。请先添加 Researcher、Designer、Builder 或 QA Reviewer 等成员。',
        reason: 'heuristic_no_worker_agents',
      }
    }
    return {
      action: 'plan',
      message: '我会先生成协作计划，并按任务分派给合适的成员执行。',
      reason: 'heuristic_artifact_or_work_request',
    }
  }

  return {
    action: 'reply',
    message: '收到。这个问题看起来不需要分派团队执行，我先直接回复。',
    reason: 'heuristic_simple_chat',
  }
}
