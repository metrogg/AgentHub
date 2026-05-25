import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import type { ExecutionAgent, ExecutionPlan, ExecutionTask } from './types'

export interface PlannerInput {
  goal: string
  agents: ExecutionAgent[]
}

export class Planner {
  async createPlan(input: PlannerInput): Promise<ExecutionPlan> {
    const { goal, agents } = input
    const runId = crypto.randomUUID()

    try {
      const generated = await this.generateWithLlm(goal, agents)
      const normalized = this.normalizeGeneratedPlan(runId, goal, generated, agents)
      if (normalized) return normalized
    } catch (error: any) {
      logger.warn({ err: error?.message }, 'Planner LLM generation failed, using fallback')
    }

    return this.buildFallbackPlan(runId, goal, agents)
  }

  private async generateWithLlm(goal: string, agents: ExecutionAgent[]): Promise<unknown> {
    const agentCatalog = agents.map((agent) => ({
      key: agent.key,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      runtimeType: agent.runtimeType,
      codeAgentType: agent.codeAgentType,
      capabilityTags: agent.capabilityTags,
      toolPermissions: agent.toolPermissions,
      sandboxPolicy: agent.sandboxPolicy,
      systemPrompt: agent.systemPrompt,
    }))

    const system = [
      'You are AgentHub Orchestrator.',
      'Create a concise multi-agent execution plan using only the provided agent keys.',
      'Return strict JSON only. Do not include Markdown fences or explanations.',
      'Schema: {"title":string,"summary":string,"tasks":[{"id":string,"title":string,"description":string,"agentKey":string,"dependencies":string[],"parallelGroup":string?,"maxRetries":number?}]}',
      'Use 2-6 tasks. Pick the most suitable agent for each task based on role, capabilities, runtime, tools, sandbox, and system prompt.',
      'If tasks can run in parallel, put them in the same parallelGroup.',
      'Dependencies should reference task ids, not agent keys.',
    ].join('\n')

    const messages = [
      {
        role: 'user' as const,
        content: JSON.stringify({ goal, agents: agentCatalog, language: 'zh-CN' }, null, 2),
      },
    ]

    let output = ''
    for await (const delta of streamReply(messages, system)) {
      output += delta
      if (output.length > 20_000) break
    }

    const jsonText = extractJsonObject(output)
    if (!jsonText) return null
    return JSON.parse(jsonText)
  }

  private normalizeGeneratedPlan(
    runId: string,
    goal: string,
    generated: unknown,
    agents: ExecutionAgent[],
  ): ExecutionPlan | null {
    if (!generated || typeof generated !== 'object') return null
    const candidate = generated as {
      title?: unknown
      summary?: unknown
      tasks?: Array<{
        id?: unknown
        title?: unknown
        description?: unknown
        agentKey?: unknown
        dependencies?: unknown
        parallelGroup?: unknown
        maxRetries?: unknown
      }>
    }

    if (!Array.isArray(candidate.tasks) || candidate.tasks.length === 0) return null

    const agentMap = new Map(agents.map((a) => [a.key, a]))
    const taskIds = new Set<string>()
    const tasks: ExecutionTask[] = []

    for (const [index, t] of candidate.tasks.entries()) {
      const title = cleanPlanText(t.title)
      const description = cleanPlanText(t.description)
      const agentKey = typeof t.agentKey === 'string' ? t.agentKey : ''
      const agent = agentMap.get(agentKey)
      if (!title || !description || !agent) continue

      const id = slugifyTaskId(cleanPlanText(t.id) || title, index)
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
        title,
        description,
        agentId: agent.id,
        dependencies: deps,
        parallelGroup: typeof t.parallelGroup === 'string' ? t.parallelGroup : undefined,
        maxRetries: typeof t.maxRetries === 'number' ? Math.max(0, Math.min(t.maxRetries, 5)) : 2,
      })
    }

    if (!tasks.length) return null

    return {
      runId,
      title: cleanPlanText(candidate.title) || titleFromGoal(goal),
      goal,
      agents,
      tasks,
    }
  }

  private buildFallbackPlan(runId: string, goal: string, agents: ExecutionAgent[]): ExecutionPlan {
    const title = titleFromGoal(goal)
    const selectedAgents = agents.length ? agents.slice(0, Math.max(1, Math.min(agents.length, 4))) : []

    const leadAgent = this.pickAgent(selectedAgents, ['规划', '架构', 'architect', 'plan']) ?? selectedAgents[0]!
    const buildAgent =
      this.pickAgent(selectedAgents, ['实现', '代码', 'coder', 'code', 'build']) ??
      selectedAgents[1] ??
      selectedAgents[0]!
    const reviewAgent =
      this.pickAgent(selectedAgents, ['审查', 'review', 'test', '风险']) ??
      selectedAgents[2] ??
      selectedAgents[selectedAgents.length - 1]!

    const tasks: ExecutionTask[] = [
      {
        id: 'plan',
        title: '梳理目标与交付范围',
        description: `围绕「${goal}」定义核心目标、交付物、边界、依赖和验收标准。`,
        agentId: leadAgent.id,
        dependencies: [],
        maxRetries: 2,
      },
      {
        id: 'build',
        title: '实现核心功能与界面',
        description: '基于拆解结果产出可执行实现方案，优先完成关键路径、组件接入和小步验证。',
        agentId: buildAgent.id,
        dependencies: ['plan'],
        maxRetries: 2,
      },
      {
        id: 'review',
        title: '审查风险与测试建议',
        description: '检查交互边界、异常状态、测试缺口和交付风险，并给出可直接执行的修复建议。',
        agentId: reviewAgent.id,
        dependencies: ['build'],
        maxRetries: 2,
      },
    ]

    return { runId, title, goal, agents: selectedAgents, tasks }
  }

  private pickAgent(agents: ExecutionAgent[], keywords: string[]) {
    const lowered = keywords.map((k) => k.toLowerCase())
    return agents.find((agent) => {
      const text = [agent.name, agent.role, agent.description, agent.runtimeType, agent.codeAgentType, ...(agent.capabilityTags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return lowered.some((keyword) => text.includes(keyword))
    })
  }
}

function extractJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}

function cleanPlanText(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 1200) : ''
}

function slugifyTaskId(value: string, index: number) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || `task-${index + 1}`
}

function titleFromGoal(goal: string) {
  const cleaned = goal.replace(/[。.!?？\n\r]/g, ' ').trim()
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}...` : cleaned || '多 Agent 协作任务'
}
