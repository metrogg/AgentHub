import { streamReply } from '../llm'
import type { PlanningAgentInput } from './plan-generator'

export type OrchestratorDecisionAction = 'reply' | 'clarify' | 'plan'

export interface OrchestratorDecision {
  action: OrchestratorDecisionAction
  message?: string
  reason?: string
}

interface DecideInput {
  content: string
  agents: PlanningAgentInput[]
  workspaceGoal?: string | null
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

  let output = ''
  for await (const chunk of streamReply(
    [{ role: 'user', content: prompt }],
    DECISION_SYSTEM,
    orchestrator?.modelId ?? undefined,
  )) {
    output += chunk
    if (output.length > 4000) break
  }

  const jsonText = extractJsonObject(output)
  if (!jsonText) {
    throw new Error('Orchestrator 没有返回可解析的路由判断')
  }

  const parsed = JSON.parse(jsonText) as Partial<OrchestratorDecision>
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

function normalizeMessage(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 1200) : ''
}

function extractJsonObject(value: string) {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : ''
}
