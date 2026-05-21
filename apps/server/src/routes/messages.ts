import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { sendMessageSchema } from '@agenthub/shared'
import {
  db,
  messages,
  sessions,
  workspaceAgents,
  workspaces,
  workspaceTasks,
  eq,
  asc,
} from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

const orchestratorPlanSchema = z.object({
  content: z.string().min(1).max(10000),
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

type PlanTask = {
  id: string
  title: string
  description: string
  agentKey: (typeof PLAN_AGENTS)[number]['key']
}

type OrchestratorPlan = {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: typeof PLAN_AGENTS
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
  .post('/:sessionId', zValidator('json', sendMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const { content, type, metadata } = c.req.valid('json')
    const [msg] = await db
      .insert(messages)
      .values({ sessionId, senderId: user.sub, senderType: 'user', type, content, metadata })
      .returning()
    // Trigger agent reply asynchronously (do not await to keep response fast)
    if (msg && !metadata?.skipAgentReply) {
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(sessionId, msg).catch(() => {})
      })
    }
    return c.json(msg)
  })
  .post('/:sessionId/orchestrator-plan', zValidator('json', orchestratorPlanSchema), async (c) => {
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const plan = buildOrchestratorPlan(content)
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
          systemPrompt: agent.systemPrompt,
          color: agent.color,
          orderIdx: index,
        }))
      )
      .returning()

    const agentByKey = new Map(parsed.agents.map((agent, index) => [agent.key, createdAgents[index]]))
    const taskResults: Array<{ taskId: string; sessionId: string; title: string; agentName: string }> = []

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
          runAgentReply(childSession.id, userMsg).catch(() => {})
        })
      }

      taskResults.push({
        taskId: workspaceTask.id,
        sessionId: childSession.id,
        title: task.title,
        agentName: agent?.name ?? 'Agent',
      })
    }

    return c.json({ workspaceId: workspace.id, tasks: taskResults })
  })

function buildOrchestratorPlan(content: string): OrchestratorPlan {
  const goal = content
    .replace(/@orchestrator/gi, '')
    .replace(/@协调器/g, '')
    .trim()
  const normalizedGoal = goal || '完成一个多 Agent 协作开发任务'
  const title = titleFromGoal(normalizedGoal)

  return {
    kind: 'orchestrator_plan',
    title,
    goal: normalizedGoal,
    summary: `我已把「${title}」拆成 3 个子任务。确认后会创建 Agent Group 并分发给 Architect、Coder、Reviewer。`,
    agents: PLAN_AGENTS,
    tasks: [
      {
        id: 'plan',
        title: '梳理目标与交付范围',
        description: `围绕「${normalizedGoal}」定义核心功能、页面/模块边界、数据流和验收标准。`,
        agentKey: 'architect',
      },
      {
        id: 'build',
        title: '实现核心功能与界面',
        description: `基于架构拆解产出可执行实现方案，优先给出关键代码、组件结构和小步验证方式。`,
        agentKey: 'coder',
      },
      {
        id: 'review',
        title: '审查风险与测试建议',
        description: `检查交互边界、异常状态、测试缺口和交付风险，并给出可直接执行的修复建议。`,
        agentKey: 'reviewer',
      },
    ],
  }
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
