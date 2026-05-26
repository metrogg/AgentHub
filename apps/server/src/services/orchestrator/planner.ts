import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import { harnessManager } from '../harness'
import type { ExecutionAgent, ExecutionPlan, ExecutionTask } from './types'

export interface PlannerInput {
  goal: string
  agents: ExecutionAgent[]
  workspacePath?: string | null
}

interface SpecModule {
  name: string
  responsibility: string
  interfaces: string[]
  dependsOn: string[]
}

interface ProjectSpec {
  goal: string
  modules: SpecModule[]
  dataFlow: string
  techStack: string
  fileLayout: string[]
}

export class Planner {
  async createPlan(input: PlannerInput): Promise<ExecutionPlan> {
    const { goal, agents, workspacePath } = input
    const runId = crypto.randomUUID()

    let specPhases: string | undefined
    if (workspacePath) {
      try {
        await harnessManager.loadFromWorkspace(workspacePath)
        const spec = harnessManager.findBestSpec(goal)
        if (spec) {
          specPhases = this.formatSpecPhases(spec)
          logger.info({ specId: spec.id, goal }, 'Planner matched Harness spec')
        }
      } catch (err: any) {
        logger.warn({ err: err?.message, workspacePath }, 'Planner failed to load Harness spec')
      }
    }

    // Spec-first：先让 LLM 输出架构规格，再基于规格生成任务计划
    let spec: ProjectSpec | undefined
    try {
      spec = await this.generateSpec(goal, agents, workspacePath)
      logger.info({ goal, moduleCount: spec.modules.length }, 'Planner generated spec')
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Planner spec generation failed, falling back to direct plan')
    }

    try {
      const generated = await this.generateWithLlm(goal, agents, spec, specPhases)
      const normalized = this.normalizeGeneratedPlan(runId, goal, generated, agents)
      if (normalized) return normalized
    } catch (error: any) {
      logger.warn({ err: error?.message }, 'Planner LLM generation failed, using fallback')
    }

    return this.buildFallbackPlan(runId, goal, agents, spec)
  }

  private formatSpecPhases(spec: import('../harness').HarnessSpec): string {
    const lines = [
      `【协作规范：${spec.name}】`,
      spec.description,
      '',
      '请按以下阶段组织任务（每个阶段可映射为 1 个或多个 task）：',
      ...spec.phases.map((p, i) => {
        const deps = p.dependsOn?.length ? `（依赖：${p.dependsOn.join('、')}）` : ''
        return `${i + 1}. ${p.name}：${p.description} ${deps}`
      }),
      '【规范结束】',
    ]
    return lines.join('\n')
  }

  private async generateSpec(goal: string, agents: ExecutionAgent[], workspacePath?: string | null): Promise<ProjectSpec> {
    const prompt = `请为以下项目生成一份架构规格说明（Spec）。

目标：${goal}

可用 Agent 团队：
${agents.map((a) => `- ${a.name}（${a.role}）：${a.description || '无描述'}`).join('\n')}

请返回 JSON（不要 Markdown 代码块）：
{
  "goal": "项目目标重述",
  "modules": [
    {
      "name": "模块名",
      "responsibility": "该模块的职责描述",
      "interfaces": ["对外暴露的接口/函数/类名"],
      "dependsOn": ["依赖的其他模块名"]
    }
  ],
  "dataFlow": "模块间数据流描述（200字以内）",
  "techStack": "建议技术栈",
  "fileLayout": ["建议的文件结构，如 src/engine.ts"]
}`
    let output = ''
    for await (const delta of streamReply([{ role: 'user', content: prompt }], '你是软件架构专家。')) {
      output += delta
      if (output.length > 15_000) break
    }
    const jsonText = extractJsonObject(output)
    if (!jsonText) throw new Error('Spec generation returned no JSON')
    const parsed = JSON.parse(jsonText) as Partial<ProjectSpec>
    return {
      goal: parsed.goal || goal,
      modules: parsed.modules || [],
      dataFlow: parsed.dataFlow || '',
      techStack: parsed.techStack || '',
      fileLayout: parsed.fileLayout || [],
    }
  }

  private async generateWithLlm(
    goal: string,
    agents: ExecutionAgent[],
    spec?: ProjectSpec,
    specPhases?: string,
  ): Promise<unknown> {
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

    const specBlock = spec
      ? `
【架构规格】
项目目标：${spec.goal}
模块划分：
${spec.modules.map((m) => `- ${m.name}：${m.responsibility}（依赖：${m.dependsOn.join('、') || '无'}）`).join('\n')}
数据流：${spec.dataFlow}
技术栈：${spec.techStack}
建议文件结构：${spec.fileLayout.join(', ')}
【规格结束】
请严格按照以上模块划分分配任务，每个模块对应 1 个 task。`
      : ''

    const system = [
      'You are AgentHub Orchestrator.',
      'Create a concise multi-agent execution plan using only the provided agent keys.',
      'Return strict JSON only. Do not include Markdown fences or explanations.',
      'Schema: {"title":string,"summary":string,"tasks":[{"id":string,"title":string,"description":string,"agentKey":string,"dependencies":string[],"parallelGroup":string?,"maxRetries":number?}]}',
      'Use 2-6 tasks. Pick the most suitable agent for each task based on role, capabilities, runtime, tools, sandbox, and system prompt.',
      'If tasks can run in parallel, put them in the same parallelGroup.',
      'Dependencies should reference task ids, not agent keys.',
      'Each task must include its output contract: what files/interfaces it will produce, so downstream tasks know what to depend on.',
      specBlock,
      specPhases || '',
    ].filter(Boolean).join('\n')

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

  private buildFallbackPlan(runId: string, goal: string, agents: ExecutionAgent[], spec?: ProjectSpec): ExecutionPlan {
    const title = titleFromGoal(goal)
    const selectedAgents = agents.length ? agents.slice(0, Math.max(1, Math.min(agents.length, 4))) : []

    // 如果有 Spec，按模块生成 fallback 任务
    if (spec && spec.modules.length > 0) {
      const tasks: ExecutionTask[] = []
      const agentMap = new Map(selectedAgents.map((a) => [a.id, a]))
      const moduleToTaskId = new Map<string, string>()

      for (let i = 0; i < spec.modules.length; i++) {
        const m = spec.modules[i]!
        const taskId = slugifyTaskId(m.name, i)
        moduleToTaskId.set(m.name, taskId)
        // 根据模块职责匹配 Agent
        const keywords = [m.name, ...m.responsibility.split(/\s+/)]
        const matched = this.pickAgent(selectedAgents, keywords) ?? selectedAgents[i % selectedAgents.length]!
        tasks.push({
          id: taskId,
          title: `实现模块：${m.name}`,
          description: `${m.responsibility}\n需暴露接口：${m.interfaces.join('、') || '无'}\n技术栈：${spec.techStack}`,
          agentId: matched.id,
          dependencies: m.dependsOn
            .map((dep) => moduleToTaskId.get(dep))
            .filter((d): d is string => Boolean(d)),
          maxRetries: 2,
        })
      }

      // 如果只有一个模块，追加 review 任务
      if (tasks.length === 1 && selectedAgents.length > 1) {
        const reviewer = this.pickAgent(selectedAgents, ['审查', 'review', 'test']) ?? selectedAgents[selectedAgents.length - 1]!
        tasks.push({
          id: 'review',
          title: '审查与测试',
          description: `检查「${goal}」的交互边界、异常状态和测试缺口。`,
          agentId: reviewer.id,
          dependencies: [tasks[0]!.id],
          maxRetries: 2,
        })
      }

      return { runId, title, goal, agents: selectedAgents, tasks }
    }

    // 无 Spec 时的经典三阶段 fallback
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
