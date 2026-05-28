import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import { harnessManager } from '../harness'
import { initializeRunLedger } from './run-ledger'
import type { ClarificationQuestion, ExecutionAgent, ExecutionPlan, ExecutionTask, TaskOutputContract, TaskValidation } from './types'

export interface PlannerInput {
  goal: string
  agents: ExecutionAgent[]
  agentRelations?: ExecutionPlan['agentRelations']
  workspacePath?: string | null
  useSpecFirst?: boolean
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
    const { goal, agentRelations = [], workspacePath, useSpecFirst = true } = input
    const runId = crypto.randomUUID()

    // 动态启用 Researcher：根据目标复杂度判断是否需要研究型 Agent
    const agents = this.maybeInjectResearcher(input.agents, goal)

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

    // Spec-first：根据 useSpecFirst 决定是否让 LLM 先输出架构规格
    let spec: ProjectSpec | undefined
    if (useSpecFirst !== false) {
      try {
        spec = await this.generateSpec(goal, agents, workspacePath)
        logger.info({ goal, moduleCount: spec.modules.length }, 'Planner generated spec')
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Planner spec generation failed, falling back to direct plan')
      }
    }

    try {
      const generated = await this.generateWithLlm(goal, agents, agentRelations, spec, specPhases)
      const normalized = this.normalizeGeneratedPlan(runId, goal, generated, agents)
      if (normalized) return initializeRunLedger({ ...normalized, agentRelations })
    } catch (error: any) {
      logger.warn({ err: error?.message }, 'Planner LLM generation failed, using fallback')
    }

    return initializeRunLedger({ ...this.buildFallbackPlan(runId, goal, agents, spec), agentRelations })
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

  /**
   * 动态启用 Researcher：根据目标复杂度判断是否需要研究型 Agent
   * 触发条件：涉及外部 API/SDK、新技术栈、方案比较、领域知识查询
   */
  private maybeInjectResearcher(agents: ExecutionAgent[], goal: string): ExecutionAgent[] {
    const hasResearcher = agents.some((a) => a.roleType === 'researcher')
    if (hasResearcher) return agents

    const lower = goal.toLowerCase()
    const researchTriggers = [
      'api', 'sdk', '第三方', '接入', '集成',
      '新技术', '新框架', '方案比较', '对比',
      '调研', '研究', '不了解', '怎么做',
      '最佳实践', '行业标准', '竞品',
      'docker', 'kubernetes', 'k8s', 'wasm',
      'websocket', 'graphql', 'grpc', 'mqtt',
      'oauth', 'jwt', 'sso', 'auth',
    ]

    const needsResearch = researchTriggers.some((t) => lower.includes(t))
    if (!needsResearch) return agents

    // 动态构造 researcher agent
    const researcher: ExecutionAgent = {
      id: `researcher-${crypto.randomUUID().slice(0, 8)}`,
      key: 'researcher',
      name: 'Researcher',
      role: '资料研究',
      roleType: 'researcher',
      description: '补充资料、比较方案、阅读上下文并标记不确定点。',
      color: '#f59e0b',
      runtimeType: 'llm',
      capabilityTags: ['research', 'sources', 'analysis'],
      toolPermissions: ['chat', 'workspace:read', 'skills:read'],
      sandboxPolicy: 'read-only',
      systemPrompt: '你是研究员。补充资料、比较方案、标记不确定点，给出来源和置信度。',
    }

    logger.info({ goal: goal.slice(0, 80) }, 'Planner dynamically injected Researcher')
    return [...agents, researcher]
  }

  /**
   * 根据目标关键词匹配 specialist agent
   * 如果团队中没有 specialist，回退到通用 agent
   */
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

  /**
   * Coder 专业化：根据目标判断任务类型，给 build task 添加 specialist 标签
   */
  private inferSpecialistTags(goal: string): string[] {
    const lower = goal.toLowerCase()
    const tags: string[] = []
    if (lower.includes('react') || lower.includes('vue') || lower.includes('frontend') || lower.includes('ui') || lower.includes('页面') || lower.includes('组件')) {
      tags.push('frontend')
    }
    if (lower.includes('api') || lower.includes('backend') || lower.includes('server') || lower.includes('数据库') || lower.includes('db')) {
      tags.push('backend')
    }
    if (lower.includes('docker') || lower.includes('ci') || lower.includes('deploy') || lower.includes('k8s') || lower.includes('devops')) {
      tags.push('devops')
    }
    return tags
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
    agentRelations: ExecutionPlan['agentRelations'] = [],
    spec?: ProjectSpec,
    specPhases?: string,
  ): Promise<unknown> {
    const agentCatalog = agents.map((agent) => ({
      key: agent.key,
      name: agent.name,
      role: agent.role,
      roleType: agent.roleType,
      description: agent.description,
      roleProfile: agent.roleProfile,
      upstreamRelations: agentRelations
        .filter((relation) => relation.targetAgentId === agent.id)
        .map((relation) => `${relation.relationType}:${relation.sourceAgentId}`),
      downstreamRelations: agentRelations
        .filter((relation) => relation.sourceAgentId === agent.id)
        .map((relation) => `${relation.relationType}:${relation.targetAgentId}`),
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
      'Schema: {"title":string,"summary":string,"clarificationQuestions":[{"id":string,"question":string,"options":string[]}],"phases":[{"id":string,"title":string,"purpose":string,"taskIds":string[]}],"tasks":[{"id":string,"phaseId":string,"title":string,"description":string,"agentKey":string,"taskType":"read|research|design|code|test|review|synthesize","dependencies":string[],"parallelGroup":string?,"maxRetries":number?,"outputContract":{"requiredBlackboardWrites":[{"key":string,"schemaType":"fact|decision|risk|artifact_ref|diff_summary|test_result|task_output"}],"requiredArtifacts":string[],"allowedPaths":string[],"acceptanceCriteria":string[]},"validation":{"commands":string[],"requiresReview":boolean}}]}',
      'Use 2-6 tasks. Pick the most suitable agent for each task based on role, capabilities, runtime, tools, sandbox, and system prompt.',
      'If tasks can run in parallel, put them in the same parallelGroup.',
      'Dependencies should reference task ids, not agent keys.',
      'Each task must include its output contract: what files/interfaces it will produce, so downstream tasks know what to depend on.',
      'If the goal is ambiguous or missing critical details (tech stack, scope, constraints, data sources, auth method, UI framework, etc.), include 1-3 clarificationQuestions. Each question should have 2-4 options. If the goal is clear enough, return an empty array.',
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

    if (!Array.isArray(candidate.tasks) || candidate.tasks.length === 0) return null

    const agentMap = new Map(agents.map((a) => [a.key, a]))
    const taskIds = new Set<string>()
    const rawIdToUuid = new Map<string, string>()
    const tasks: ExecutionTask[] = []

    for (const [index, t] of candidate.tasks.entries()) {
      const title = cleanPlanText(t.title)
      const description = cleanPlanText(t.description)
      const agentKey = typeof t.agentKey === 'string' ? t.agentKey : ''
      const agent = agentMap.get(agentKey)
      if (!title || !description || !agent) continue

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
        agentId: agent.id,
        taskType: parseTaskType(t.taskType),
        dependencies: deps,
        parallelGroup: typeof t.parallelGroup === 'string' ? t.parallelGroup : undefined,
        maxRetries: typeof t.maxRetries === 'number' ? Math.max(0, Math.min(t.maxRetries, 5)) : 2,
        outputContract: normalizeTaskOutputContract(t.outputContract, id),
        validation: normalizeTaskValidation(t.validation),
      })
    }

    if (!tasks.length) return null

    // 将依赖中的 rawId 替换为 UUID
    for (const task of tasks) {
      task.dependencies = task.dependencies.map((dep) => rawIdToUuid.get(dep) ?? dep)
    }

    // 提取并规范化 phases
    const phases = this.normalizePhases(candidate.phases, tasks, rawIdToUuid)

    // Extract clarification questions
    const clarificationQuestions: ClarificationQuestion[] = []
    if (Array.isArray(candidate.clarificationQuestions)) {
      for (const q of candidate.clarificationQuestions) {
        if (!q || typeof q !== 'object') continue
        const question = cleanPlanText(q.question)
        if (!question) continue
        const options = Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : []
        clarificationQuestions.push({
          id: typeof q.id === 'string' ? q.id : `cq-${clarificationQuestions.length}`,
          question,
          options: options.length > 0 ? options : undefined,
        })
      }
    }

    return {
      runId,
      title: cleanPlanText(candidate.title) || titleFromGoal(goal),
      goal,
      agents,
      tasks,
      phases: phases.length > 0 ? phases : undefined,
      clarificationQuestions: clarificationQuestions.length > 0 ? clarificationQuestions : undefined,
    }
  }

  private normalizePhases(
    phases: unknown,
    tasks: ExecutionTask[],
    rawIdToUuid: Map<string, string>,
  ): import('./types').OrchestratorPhase[] {
    const normalized: import('./types').OrchestratorPhase[] = []
    if (Array.isArray(phases)) {
      for (const phase of phases) {
        if (!phase || typeof phase !== 'object') continue
        const item = phase as { id?: unknown; title?: unknown; purpose?: unknown; taskIds?: unknown }
        const id = cleanPlanText(item.id)
        if (!id || normalized.some((existing) => existing.id === id)) continue
        const rawTaskIds = Array.isArray(item.taskIds)
          ? item.taskIds.filter((taskId): taskId is string => typeof taskId === 'string')
          : []
        const taskIds = rawTaskIds.map((tid) => rawIdToUuid.get(tid) ?? tid).filter(Boolean) as string[]
        normalized.push({
          id,
          title: cleanPlanText(item.title) || this.phaseTitleFromId(id),
          purpose: cleanPlanText(item.purpose) || this.phasePurposeFromId(id),
          taskIds,
        })
      }
    }

    for (const [index, task] of tasks.entries()) {
      const phaseId = task.phaseId ?? this.inferTaskPhase(task, index)
      task.phaseId = phaseId
      let phase = normalized.find((item) => item.id === phaseId)
      if (!phase) {
        phase = {
          id: phaseId,
          title: this.phaseTitleFromId(phaseId),
          purpose: this.phasePurposeFromId(phaseId),
          taskIds: [],
        }
        normalized.push(phase)
      }
      if (!phase.taskIds.includes(task.id)) phase.taskIds.push(task.id)
    }

    return normalized
  }

  private inferTaskPhase(task: Pick<ExecutionTask, 'id' | 'title' | 'description'>, index: number): string {
    const text = `${task.id} ${task.title} ${task.description}`.toLowerCase()
    if (/(plan|analysis|scan|read|理解|梳理|分析|调研)/i.test(text)) return 'analysis'
    if (/(design|方案|架构|设计)/i.test(text)) return 'design'
    if (/(build|code|implement|实现|开发|修改)/i.test(text)) return 'implementation'
    if (/(review|test|verify|审查|测试|验证|风险)/i.test(text)) return 'verification'
    if (/(summary|synthesize|汇总|总结)/i.test(text)) return 'synthesis'
    return index === 0 ? 'analysis' : 'execution'
  }

  private phaseTitleFromId(id: string): string {
    if (id === 'analysis') return '分析'
    if (id === 'design') return '设计'
    if (id === 'implementation') return '实现'
    if (id === 'verification') return '验证'
    if (id === 'synthesis') return '汇总'
    return '执行'
  }

  private phasePurposeFromId(id: string): string {
    if (id === 'analysis') return '理解目标和上下文'
    if (id === 'design') return '确定方案和边界'
    if (id === 'implementation') return '完成核心实现'
    if (id === 'verification') return '验证质量和风险'
    if (id === 'synthesis') return '汇总协作产出'
    return '推进当前任务'
  }

  private buildFallbackPlan(runId: string, goal: string, agents: ExecutionAgent[], spec?: ProjectSpec): ExecutionPlan {
    const title = titleFromGoal(goal)
    const selectedAgents = agents.length ? agents.slice(0, Math.max(1, Math.min(agents.length, 4))) : []

    // 如果有 Spec，按模块生成 fallback 任务
    if (spec && spec.modules.length > 0) {
      const tasks: ExecutionTask[] = []
      const moduleToTaskId = new Map<string, string>()

      for (let i = 0; i < spec.modules.length; i++) {
        const m = spec.modules[i]!
        const taskId = crypto.randomUUID()
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
        const reviewId = crypto.randomUUID()
        tasks.push({
          id: reviewId,
          title: '审查与测试',
          description: `检查「${goal}」的交互边界、异常状态和测试缺口。`,
          agentId: reviewer.id,
          dependencies: [tasks[0]!.id],
          maxRetries: 2,
        })
      }

      return { runId, title, goal, agents: selectedAgents, tasks }
    }

    // 无 Spec 时的经典三阶段 fallback，支持 Coder 专业化匹配
    const leadAgent = this.pickAgent(selectedAgents, ['规划', '架构', 'architect', 'plan']) ?? selectedAgents[0]!

    // 尝试 specialist 匹配，如果没有则回退到通用 coder
    const specialistTags = this.inferSpecialistTags(goal)
    const buildAgent =
      (specialistTags.length > 0
        ? this.pickAgent(selectedAgents, [...specialistTags, 'coder', 'code'])
        : undefined) ??
      this.pickAgent(selectedAgents, ['实现', '代码', 'coder', 'code', 'build']) ??
      selectedAgents[1] ??
      selectedAgents[0]!

    const reviewAgent =
      this.pickAgent(selectedAgents, ['审查', 'review', 'test', '风险']) ??
      selectedAgents[2] ??
      selectedAgents[selectedAgents.length - 1]!

    const planId = crypto.randomUUID()
    const buildId = crypto.randomUUID()
    const reviewId = crypto.randomUUID()

    const specialistHint = specialistTags.length > 0 ? `（专长方向: ${specialistTags.join(', ')}）` : ''
    const tasks: ExecutionTask[] = [
      {
        id: planId,
        title: '梳理目标与交付范围',
        description: `围绕「${goal}」定义核心目标、交付物、边界、依赖和验收标准。`,
        agentId: leadAgent.id,
        dependencies: [],
        maxRetries: 2,
      },
      {
        id: buildId,
        title: `实现核心功能与界面${specialistHint}`,
        description: `基于拆解结果产出可执行实现方案，优先完成关键路径、组件接入和小步验证。${specialistHint}`,
        agentId: buildAgent.id,
        dependencies: [planId],
        maxRetries: 2,
      },
      {
        id: reviewId,
        title: '审查风险与测试建议',
        description: '检查交互边界、异常状态、测试缺口和交付风险，并给出可直接执行的修复建议。',
        agentId: reviewAgent.id,
        dependencies: [buildId],
        maxRetries: 2,
      },
    ]

    return { runId, title, goal, agents: selectedAgents, tasks }
  }
}

export function normalizeTaskOutputContract(value: unknown, taskId: string): TaskOutputContract | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as {
    requiredBlackboardWrites?: unknown
    requiredArtifacts?: unknown
    allowedPaths?: unknown
    acceptanceCriteria?: unknown
  }
  const requiredBlackboardWrites = Array.isArray(item.requiredBlackboardWrites)
    ? item.requiredBlackboardWrites
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null
          const candidate = entry as { key?: unknown; schemaType?: unknown }
          const key = cleanPlanText(candidate.key) || `task_${taskId}_output`
          const schemaType = parseBlackboardSchemaType(candidate.schemaType)
          return schemaType ? { key, schemaType } : null
        })
        .filter((entry): entry is TaskOutputContract['requiredBlackboardWrites'][number] => Boolean(entry))
    : []
  const requiredArtifacts = arrayOfStrings(item.requiredArtifacts)
  const allowedPaths = arrayOfStrings(item.allowedPaths)
  const acceptanceCriteria = arrayOfStrings(item.acceptanceCriteria)
  if (!requiredBlackboardWrites.length && !requiredArtifacts.length && !allowedPaths.length && !acceptanceCriteria.length) return undefined
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

export function parseBlackboardSchemaType(value: unknown): TaskOutputContract['requiredBlackboardWrites'][number]['schemaType'] | undefined {
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

export function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => cleanPlanText(item)).filter(Boolean).slice(0, 12)
}

export function extractJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}

export function cleanPlanText(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 1200) : ''
}

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
