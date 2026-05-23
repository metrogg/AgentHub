import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { sendMessageSchema } from '@agenthub/shared'
import {
  db,
  messages,
  sessions,
  sessionMembers,
  workspaceAgents,
  workspaces,
  workspaceTasks,
  eq,
  asc,
} from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import type { AgentRunProfile, MessageRow } from '../services/agent-runner'
import { streamReply } from '../services/llm'

const orchestratorPlanSchema = z.object({
  content: z.string().min(1).max(10000),
})

const updateOrchestratorPlanSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      agentKey: z.string().min(1).optional(),
      status: z.enum(['pending', 'running', 'done']).optional(),
    })
  ),
})

const PLAN_AGENTS = [
  {
    key: 'architect',
    name: 'Architect',
    role: '规划',
    color: '#6366f1',
    systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑与依赖关系。',
  },
  {
    key: 'coder',
    name: 'Coder',
    role: '实现',
    color: '#10b981',
    systemPrompt: '你是实现者。负责代码实现、组件接入和小步验证。先理解上下文,再小步迭代。',
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    role: '审查',
    color: '#ef4444',
    systemPrompt: '你是审查者。检查风险、交互漏洞和缺失的测试。直接、克制、不绕弯。',
  },
] as const

type PlanAgent = {
  key: string
  name: string
  role: string
  color: string
  systemPrompt: string
  description?: string
  modelId?: string | null
  runtimeType?: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | null
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

type PlanTask = {
  id: string
  title: string
  description: string
  agentKey: string
  status?: 'pending' | 'running' | 'done'
}

type OrchestratorPlan = {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: PlanAgent[]
  tasks: PlanTask[]
}

export const messageRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    return c.json({ items: list })
  })
  .post('/:sessionId/cancel', async (c) => {
    const sessionId = c.req.param('sessionId')
    const { cancelAgentReply } = await import('../services/agent-runner')
    return c.json({ cancelled: cancelAgentReply(sessionId) })
  })
  .post('/:sessionId', zValidator('json', sendMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const { content, type, metadata } = c.req.valid('json')
    const [msg] = await db
      .insert(messages)
      .values({ sessionId, senderId: user.sub, senderType: 'user', type, content, metadata })
      .returning()
    // Trigger agent reply asynchronously (do not await to keep response fast).
    if (msg && !metadata?.skipAgentReply) {
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
      if (session?.type === 'group' && session.workspaceId) {
        runGroupReplies(session.workspaceId, sessionId, msg, content).catch(() => {})
      } else {
        const profile = session ? await profileForDirectSession(session) : undefined
        import('../services/agent-runner').then(({ runAgentReply }) => {
          runAgentReply(sessionId, msg, profile).catch(() => {})
        })
      }
    }
    return c.json(msg)
  })
  .post('/:sessionId/orchestrator-plan', zValidator('json', orchestratorPlanSchema), async (c) => {
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session) throw new HTTPException(404, { message: 'Session not found' })
    const agentList = session.workspaceId
      ? await db
          .select()
          .from(workspaceAgents)
          .where(eq(workspaceAgents.workspaceId, session.workspaceId))
          .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
      : []
    const plan = await buildDynamicOrchestratorPlan(content, agentList)
    const [card] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'orchestrator',
        senderType: 'agent',
        type: 'task_card',
        content: plan.summary,
        metadata: { plan },
      })
      .returning()
    if (!card) throw new HTTPException(500, { message: 'Failed to create plan card' })
    return c.json(card)
  })
  .patch('/:sessionId/orchestrator-plan/:messageId', zValidator('json', updateOrchestratorPlanSchema), async (c) => {
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const { tasks } = c.req.valid('json')

    const [card] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!card || card.sessionId !== sessionId || card.type !== 'task_card') {
      throw new HTTPException(404, { message: 'Plan card not found' })
    }

    const parsed = parsePlan(card.metadata)
    if (!parsed) throw new HTTPException(400, { message: 'Invalid plan metadata' })

    const updates = new Map(tasks.map((task) => [task.id, task]))
    const agentKeys = new Set<string>(parsed.agents.map((agent) => agent.key))
    const nextPlan: OrchestratorPlan = {
      ...parsed,
      tasks: parsed.tasks.map((task) => {
        const patch = updates.get(task.id)
        if (!patch) return task
        return {
          ...task,
          agentKey: patch.agentKey && agentKeys.has(patch.agentKey) ? (patch.agentKey as PlanTask['agentKey']) : task.agentKey,
          status: patch.status ?? task.status,
        }
      }),
    }

    const metadata = card.metadata && typeof card.metadata === 'object' ? card.metadata : {}
    const [updated] = await db
      .update(messages)
      .set({ content: nextPlan.summary, metadata: { ...metadata, plan: nextPlan } })
      .where(eq(messages.id, messageId))
      .returning()
    if (!updated) throw new HTTPException(500, { message: 'Failed to update plan card' })
    return c.json(updated)
  })
  .post('/:sessionId/orchestrator-plan/:messageId/dispatch', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')

    const [card] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!card || card.sessionId !== sessionId || card.type !== 'task_card') {
      throw new HTTPException(404, { message: 'Plan card not found' })
    }

    const parsed = parsePlan(card.metadata)
    if (!parsed) throw new HTTPException(400, { message: 'Invalid plan metadata' })

    const [sourceSession] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (sourceSession?.type === 'group' && sourceSession.workspaceId && sourceSession.ownerId === user.sub) {
      return c.json(await dispatchPlanToExistingGroup(sourceSession, user.sub, parsed))
    }

    const [workspace] = await db
      .insert(workspaces)
      .values({ ownerId: user.sub, name: parsed.title, goal: parsed.goal })
      .returning()
    if (!workspace) throw new HTTPException(500, { message: 'Failed to create workspace' })

    const createdAgents = await db
      .insert(workspaceAgents)
      .values(
        parsed.agents.map((agent, index) => ({
          workspaceId: workspace.id,
          name: agent.name,
          role: agent.role,
          description: agent.description ?? '',
          systemPrompt: agent.systemPrompt,
          color: agent.color,
          modelId: agent.modelId ?? null,
          runtimeType: agent.runtimeType ?? 'llm',
          codeAgentType: agent.codeAgentType ?? null,
          capabilityTags: agent.capabilityTags ?? [],
          toolPermissions: agent.toolPermissions ?? [],
          sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
          orderIdx: index,
        }))
      )
      .returning()

    const agentByKey = new Map(parsed.agents.map((agent, index) => [agent.key, createdAgents[index]]))
    const taskResults: Array<{ taskId: string; sessionId: string; title: string; agentName: string }> = []
    const groupSession = await createWorkspaceGroupSession(workspace.id, workspace.name, user.sub, createdAgents)

    for (const [index, task] of parsed.tasks.entries()) {
      const agent = agentByKey.get(task.agentKey)
      const [workspaceTask] = await db
        .insert(workspaceTasks)
        .values({
          workspaceId: workspace.id,
          agentId: agent?.id ?? null,
          title: task.title,
          description: task.description,
          status: 'running',
          orderIdx: index,
        })
        .returning()
      if (!workspaceTask) continue

      const [childSession] = await db
        .insert(sessions)
        .values({
          title: `${workspace.name} / ${agent?.role ?? '任务'} / ${task.title.slice(0, 24)}`,
          type: 'direct',
          ownerId: user.sub,
          workspaceId: workspace.id,
          workspaceAgentId: agent?.id ?? null,
        })
        .returning()
      if (!childSession) continue

      await db
        .update(workspaceTasks)
        .set({ sessionId: childSession.id, updatedAt: new Date() })
        .where(eq(workspaceTasks.id, workspaceTask.id))

      const [userMsg] = await db
        .insert(messages)
        .values({
          sessionId: childSession.id,
          senderId: user.sub,
          senderType: 'user',
          type: 'text',
          content: buildDispatchPrompt(parsed, task, agent),
        })
        .returning()

      if (userMsg) {
        import('../services/agent-runner').then(({ runAgentReply }) => {
          runAgentReply(childSession.id, userMsg, agent ? toAgentProfile(agent, workspace.projectPath) : undefined)
            .then(() => markWorkspaceTaskDone(workspaceTask.id))
            .catch(() => {})
        })
      }

      taskResults.push({
        taskId: workspaceTask.id,
        sessionId: childSession.id,
        title: task.title,
        agentName: agent?.name ?? 'Agent',
      })
    }

    return c.json({ workspaceId: workspace.id, groupSessionId: groupSession.id, tasks: taskResults })
  })

async function buildDynamicOrchestratorPlan(
  content: string,
  agents: Array<typeof workspaceAgents.$inferSelect>
): Promise<OrchestratorPlan> {
  const goal = normalizeOrchestratorGoal(content)
  const planningAgents = agents.length ? agents.map(planAgentFromWorkspaceAgent) : fallbackPlanAgents()

  try {
    const generated = await generatePlanWithLlm(goal, planningAgents)
    const normalized = normalizeGeneratedPlan(goal, generated, planningAgents)
    if (normalized) return normalized
  } catch {
    // Keep task card creation reliable when model credentials are missing or JSON generation fails.
  }

  return buildOrchestratorPlan(content, planningAgents)
}

function buildOrchestratorPlan(content: string, agents = fallbackPlanAgents()): OrchestratorPlan {
  const normalizedGoal = normalizeOrchestratorGoal(content)
  const title = titleFromGoal(normalizedGoal)
  const selectedAgents = agents.length ? agents.slice(0, Math.max(1, Math.min(agents.length, 4))) : fallbackPlanAgents()
  const leadAgent = pickAgent(selectedAgents, ['规划', '架构', 'architect', 'plan']) ?? selectedAgents[0]!
  const buildAgent =
    pickAgent(selectedAgents, ['实现', '代码', 'coder', 'code', 'build']) ?? selectedAgents[1] ?? selectedAgents[0]!
  const reviewAgent =
    pickAgent(selectedAgents, ['审查', 'review', 'test', '风险']) ?? selectedAgents[2] ?? selectedAgents[selectedAgents.length - 1]!

  return {
    kind: 'orchestrator_plan',
    title,
    goal: normalizedGoal,
    summary: `我已根据当前 Agent 团队把「${title}」拆成 3 个子任务。确认后会创建或复用 Agent Group 并分发执行。`,
    agents: selectedAgents,
    tasks: [
      {
        id: 'plan',
        title: '梳理目标与交付范围',
        description: `围绕「${normalizedGoal}」定义核心目标、交付物、边界、依赖和验收标准。`,
        agentKey: leadAgent.key,
        status: 'pending',
      },
      {
        id: 'build',
        title: '实现核心功能与界面',
        description: '基于拆解结果产出可执行实现方案，优先完成关键路径、组件接入和小步验证。',
        agentKey: buildAgent.key,
        status: 'pending',
      },
      {
        id: 'review',
        title: '审查风险与测试建议',
        description: '检查交互边界、异常状态、测试缺口和交付风险，并给出可直接执行的修复建议。',
        agentKey: reviewAgent.key,
        status: 'pending',
      },
    ],
  }
}

function normalizeOrchestratorGoal(content: string) {
  return (
    content
      .replace(/@orchestrator/gi, '')
      .replace(/@协调器/g, '')
      .trim() || '完成一个多 Agent 协作任务'
  )
}

function fallbackPlanAgents(): PlanAgent[] {
  return PLAN_AGENTS.map((agent) => ({
    ...agent,
    runtimeType: 'llm' as const,
    capabilityTags: [],
    toolPermissions: ['chat'],
    sandboxPolicy: 'workspace-write' as const,
  }))
}

function planAgentFromWorkspaceAgent(agent: typeof workspaceAgents.$inferSelect): PlanAgent {
  return {
    key: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    color: agent.color,
    systemPrompt: agent.systemPrompt,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: agent.capabilityTags,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: agent.sandboxPolicy,
  }
}

function pickAgent(agents: PlanAgent[], keywords: string[]) {
  const lowered = keywords.map((keyword) => keyword.toLowerCase())
  return agents.find((agent) => {
    const text = [agent.name, agent.role, agent.description, agent.runtimeType, agent.codeAgentType, ...(agent.capabilityTags ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return lowered.some((keyword) => text.includes(keyword))
  })
}

async function generatePlanWithLlm(goal: string, agents: PlanAgent[]) {
  const agentCatalog = agents.map((agent) => ({
    key: agent.key,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: agent.capabilityTags ?? [],
    toolPermissions: agent.toolPermissions ?? [],
    sandboxPolicy: agent.sandboxPolicy,
    systemPrompt: agent.systemPrompt,
  }))
  const system = [
    'You are AgentHub Orchestrator.',
    'Create a concise multi-agent execution plan using only the provided agent keys.',
    'Return strict JSON only. Do not include Markdown fences or explanations.',
    'Schema: {"title":string,"summary":string,"tasks":[{"id":string,"title":string,"description":string,"agentKey":string,"status":"pending"}]}',
    'Use 2-6 tasks. Pick the most suitable agent for each task based on role, capabilities, runtime, tools, sandbox, and system prompt.',
  ].join('\n')
  const messagesForPlan = [
    {
      role: 'user' as const,
      content: JSON.stringify(
        {
          goal,
          agents: agentCatalog,
          language: 'zh-CN',
        },
        null,
        2
      ),
    },
  ]

  let output = ''
  for await (const delta of streamReply(messagesForPlan, system)) {
    output += delta
    if (output.length > 20_000) break
  }

  const jsonText = extractJsonObject(output)
  if (!jsonText) return null
  return JSON.parse(jsonText) as unknown
}

function normalizeGeneratedPlan(goal: string, generated: unknown, agents: PlanAgent[]): OrchestratorPlan | null {
  if (!generated || typeof generated !== 'object') return null
  const candidate = generated as {
    title?: unknown
    summary?: unknown
    tasks?: Array<{
      id?: unknown
      title?: unknown
      description?: unknown
      agentKey?: unknown
      status?: unknown
    }>
  }
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length === 0) return null

  const agentKeys = new Set(agents.map((agent) => agent.key))
  const tasks = candidate.tasks
    .slice(0, 6)
    .map((task, index): PlanTask | null => {
      const title = cleanPlanText(task.title)
      const description = cleanPlanText(task.description)
      const agentKey = typeof task.agentKey === 'string' && agentKeys.has(task.agentKey) ? task.agentKey : agents[0]?.key
      if (!title || !description || !agentKey) return null
      return {
        id: slugifyTaskId(cleanPlanText(task.id) || title, index),
        title,
        description,
        agentKey,
        status: task.status === 'running' || task.status === 'done' ? task.status : 'pending',
      }
    })
    .filter((task): task is PlanTask => Boolean(task))

  if (!tasks.length) return null
  const title = cleanPlanText(candidate.title) || titleFromGoal(goal)

  return {
    kind: 'orchestrator_plan',
    title,
    goal,
    summary: cleanPlanText(candidate.summary) || `我已根据当前 Agent 团队把「${title}」拆成 ${tasks.length} 个子任务。`,
    agents,
    tasks,
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

function parsePlan(metadata: unknown): OrchestratorPlan | null {
  const plan = (metadata as { plan?: unknown } | null)?.plan
  if (!plan || typeof plan !== 'object') return null
  const candidate = plan as OrchestratorPlan
  if (candidate.kind !== 'orchestrator_plan' || !Array.isArray(candidate.tasks)) return null
  return candidate
}

function buildDispatchPrompt(
  plan: OrchestratorPlan,
  task: PlanTask,
  agent?: typeof workspaceAgents.$inferSelect
) {
  return [
    agent ? `你是 ${agent.name}(${agent.role})。${agent.systemPrompt}` : '你是 AgentHub 协作 Agent。',
    `\n协作目标: ${plan.goal}`,
    `\n当前子任务: ${task.title}`,
    `\n任务说明: ${task.description}`,
    '\n请先给出简短工作计划，再产出结果。遇到需要其他 Agent 配合的内容，请在结尾用「需协作:」列出。',
  ].join('')
}

const ORCHESTRATOR_PROFILE: AgentRunProfile = {
  id: 'orchestrator',
  name: 'Orchestrator',
  role: 'Coordinator',
  color: '#111827',
  systemPrompt:
    'You are the AgentHub coordinator. Read the group chat context, clarify the goal, split work between agents, and keep the team aligned. Reply with concise next actions.',
}

function withWorkspacePath(profile: AgentRunProfile, projectPath?: string | null): AgentRunProfile {
  const trimmed = projectPath?.trim()
  return trimmed ? { ...profile, projectPath: trimmed } : profile
}

function toAgentProfile(agent: typeof workspaceAgents.$inferSelect, projectPath?: string | null): AgentRunProfile {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    color: agent.color,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: agent.capabilityTags,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: agent.sandboxPolicy,
    contextPolicy: agent.contextPolicy,
    approvalRequired: agent.approvalRequired,
    systemPrompt: agent.systemPrompt,
    projectPath: projectPath?.trim() || null,
  }
}

async function profileForDirectSession(session: typeof sessions.$inferSelect) {
  if (!session.workspaceAgentId) return undefined
  const [agent] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, session.workspaceAgentId)).limit(1)
  if (!agent || (session.workspaceId && agent.workspaceId !== session.workspaceId)) return undefined

  if (!session.workspaceId) return toAgentProfile(agent)
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1)
  return toAgentProfile(agent, workspace?.projectPath)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasMention(content: string, aliases: string[]) {
  const lower = content.toLowerCase()
  return aliases.some((alias) => {
    const token = alias.trim()
    if (!token) return false
    const normalized = token.toLowerCase()
    return lower.includes(`@${normalized}`) || new RegExp(`@\\s*${escapeRegExp(normalized)}\\b`, 'i').test(content)
  })
}

function aliasesForAgent(agent: typeof workspaceAgents.$inferSelect) {
  const role = agent.role.toLowerCase()
  const name = agent.name.toLowerCase()
  const aliases = new Set([agent.name, name, agent.role, role, ...agent.capabilityTags])
  if (name.includes('coder') || role.includes('code') || role.includes('实现')) {
    aliases.add('coder')
    aliases.add('code')
    aliases.add('代码')
  }
  if (name.includes('architect') || role.includes('arch') || role.includes('规划')) {
    aliases.add('architect')
    aliases.add('架构')
    aliases.add('规划')
  }
  if (name.includes('review') || role.includes('review') || role.includes('审查')) {
    aliases.add('reviewer')
    aliases.add('review')
    aliases.add('审查')
  }
  if (name.includes('research') || role.includes('research') || role.includes('研究')) {
    aliases.add('researcher')
    aliases.add('research')
    aliases.add('研究')
  }
  return [...aliases]
}

async function runGroupReplies(workspaceId: string, sessionId: string, msg: MessageRow, content: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  const projectPath = workspace?.projectPath ?? null
  const agentList = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))

  const profiles: AgentRunProfile[] = []
  const seen = new Set<string>()
  const pushProfile = (profile: AgentRunProfile) => {
    if (seen.has(profile.id)) return
    seen.add(profile.id)
    profiles.push(profile)
  }

  if (hasMention(content, ['orchestrator', 'coordinator', 'agenthub', '协调器', '调度'])) {
    pushProfile(withWorkspacePath(ORCHESTRATOR_PROFILE, projectPath))
  }

  for (const agent of agentList) {
    if (hasMention(content, aliasesForAgent(agent))) {
      pushProfile(toAgentProfile(agent, projectPath))
    }
  }

  if (!profiles.length) {
    const autoAgents = agentList.filter((agent) => agent.autoInvoke)
    if (autoAgents.length === 1) {
      pushProfile(toAgentProfile(autoAgents[0]!, projectPath))
    } else {
      pushProfile(withWorkspacePath(ORCHESTRATOR_PROFILE, projectPath))
    }
  }

  const { runAgentReply } = await import('../services/agent-runner')
  for (const profile of profiles) {
    await runAgentReply(sessionId, msg, profile)
  }
}

async function createWorkspaceGroupSession(
  workspaceId: string,
  workspaceName: string,
  ownerId: string,
  agents: Array<typeof workspaceAgents.$inferSelect>
) {
  const [session] = await db
    .insert(sessions)
    .values({
      title: `${workspaceName} / Agent Group`,
      type: 'group',
      ownerId,
      workspaceId,
    })
    .returning()
  if (!session) throw new HTTPException(500, { message: 'Failed to create group session' })

  await db.insert(sessionMembers).values([
    { sessionId: session.id, memberType: 'user', memberId: ownerId },
    { sessionId: session.id, memberType: 'agent', memberId: 'orchestrator' },
    ...agents.map((agent) => ({ sessionId: session.id, memberType: 'agent' as const, memberId: agent.id })),
  ])

  return session
}

async function dispatchPlanToExistingGroup(
  session: typeof sessions.$inferSelect,
  ownerId: string,
  plan: OrchestratorPlan
) {
  if (!session.workspaceId) throw new HTTPException(400, { message: 'Session is not attached to a workspace' })

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1)
  if (!workspace || workspace.ownerId !== ownerId) {
    throw new HTTPException(404, { message: 'Workspace not found' })
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
    const matched = plan.agents.find((item) => {
      const key = item.key.toLowerCase()
      return name === item.name.toLowerCase() || name.includes(key) || role.includes(key)
    })
    if (matched) agentsByKey.set(matched.key, agent)
  }

  const createdAgents: Array<typeof workspaceAgents.$inferSelect> = []
  for (const [index, planAgent] of plan.agents.entries()) {
    if (agentsByKey.has(planAgent.key)) continue
    const [created] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace.id,
        name: planAgent.name,
        role: planAgent.role,
        description: planAgent.description ?? '',
        systemPrompt: planAgent.systemPrompt,
        color: planAgent.color,
        modelId: planAgent.modelId ?? null,
        runtimeType: planAgent.runtimeType ?? 'llm',
        codeAgentType: planAgent.codeAgentType ?? null,
        capabilityTags: planAgent.capabilityTags ?? [],
        toolPermissions: planAgent.toolPermissions ?? [],
        sandboxPolicy: planAgent.sandboxPolicy ?? 'workspace-write',
        orderIdx: existingAgents.length + index,
      })
      .returning()
    if (created) {
      agentsByKey.set(planAgent.key, created)
      createdAgents.push(created)
    }
  }

  if (createdAgents.length) {
    await db.insert(sessionMembers).values(
      createdAgents.map((agent) => ({
        sessionId: session.id,
        memberType: 'agent' as const,
        memberId: agent.id,
      }))
    )
  }

  const taskResults: Array<{ taskId: string; sessionId: string; title: string; agentName: string }> = []

  for (const [index, task] of plan.tasks.entries()) {
    const agent = agentsByKey.get(task.agentKey)
    const [workspaceTask] = await db
      .insert(workspaceTasks)
      .values({
        workspaceId: workspace.id,
        agentId: agent?.id ?? null,
        title: task.title,
        description: task.description,
        status: 'running',
        orderIdx: index,
      })
      .returning()
    if (!workspaceTask) continue

    const [childSession] = await db
      .insert(sessions)
      .values({
        title: `${workspace.name} / ${agent?.role ?? '任务'} / ${task.title.slice(0, 24)}`,
        type: 'direct',
        ownerId,
        workspaceId: workspace.id,
        workspaceAgentId: agent?.id ?? null,
      })
      .returning()
    if (!childSession) continue

    await db
      .update(workspaceTasks)
      .set({ sessionId: childSession.id, updatedAt: new Date() })
      .where(eq(workspaceTasks.id, workspaceTask.id))

    const [promptMsg] = await db
      .insert(messages)
      .values({
        sessionId: childSession.id,
        senderId: ownerId,
        senderType: 'user',
        type: 'text',
        content: buildDispatchPrompt(plan, task, agent),
      })
      .returning()

    if (promptMsg) {
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(childSession.id, promptMsg, agent ? toAgentProfile(agent, workspace.projectPath) : undefined)
          .then(() => markWorkspaceTaskDone(workspaceTask.id))
          .catch(() => {})
      })
    }

    taskResults.push({
      taskId: workspaceTask.id,
      sessionId: childSession.id,
      title: task.title,
      agentName: agent?.name ?? 'Agent',
    })
  }

  return { workspaceId: workspace.id, groupSessionId: session.id, tasks: taskResults }
}

async function markWorkspaceTaskDone(taskId: string) {
  await db
    .update(workspaceTasks)
    .set({ status: 'done', updatedAt: new Date() })
    .where(eq(workspaceTasks.id, taskId))
}
