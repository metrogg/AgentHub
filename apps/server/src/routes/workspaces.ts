import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import {
  db,
  workspaces,
  workspaceAgents,
  workspaceTasks,
  sessions,
  sessionMembers,
  messages,
  eq,
  and,
  desc,
  asc,
} from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

// ---------- Validation schemas ----------

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  goal: z.string().max(2000).default(''),
  template: z.enum(['blank', 'classic']).optional(),
})

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  goal: z.string().max(2000).optional(),
})

const createAgentSchema = z.object({
  name: z.string().min(1).max(60),
  role: z.string().min(1).max(60),
  systemPrompt: z.string().max(4000).default(''),
  color: z.string().max(20).default('#6366f1'),
})

const updateAgentSchema = createAgentSchema.partial()

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  agentId: z.string().nullable().optional(),
})

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  agentId: z.string().nullable().optional(),
  status: z.enum(['pending', 'running', 'done']).optional(),
})

// ---------- Helpers ----------

const CLASSIC_AGENTS: Array<z.infer<typeof createAgentSchema>> = [
  { name: 'Architect', role: '规划', systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑与依赖关系。', color: '#6366f1' },
  { name: 'Coder', role: '实现', systemPrompt: '你是实现者。负责代码实现、组件接入和小步验证。先理解上下文,再小步迭代。', color: '#10b981' },
  { name: 'Researcher', role: '研究', systemPrompt: '你是研究员。补充资料、比较方案、标记不确定点。给出参考来源。', color: '#f59e0b' },
  { name: 'Reviewer', role: '审查', systemPrompt: '你是审查者。检查风险、交互漏洞和缺失的测试。直接、克制、不绕弯。', color: '#ef4444' },
]

async function loadWorkspaceFull(id: string, ownerId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  if (!ws || ws.ownerId !== ownerId) {
    throw new HTTPException(404, { message: 'Workspace not found' })
  }
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, id))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.workspaceId, id))
    .orderBy(asc(workspaceTasks.orderIdx), asc(workspaceTasks.createdAt))
  return { workspace: ws, agents, tasks }
}

async function ensureWorkspace(id: string, ownerId: string) {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
  if (!ws || ws.ownerId !== ownerId) {
    throw new HTTPException(404, { message: 'Workspace not found' })
  }
  return ws
}

async function findGroupSession(workspaceId: string) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.type, 'group')))
    .limit(1)
  return session ?? null
}

async function syncGroupMembers(sessionId: string, workspaceId: string, ownerId: string) {
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  const existing = await db.select().from(sessionMembers).where(eq(sessionMembers.sessionId, sessionId))
  const keys = new Set(existing.map((member) => `${member.memberType}:${member.memberId}`))
  const wanted = [
    { memberType: 'user' as const, memberId: ownerId },
    { memberType: 'agent' as const, memberId: 'orchestrator' },
    ...agents.map((agent) => ({ memberType: 'agent' as const, memberId: agent.id })),
  ]
  const missing = wanted.filter((member) => !keys.has(`${member.memberType}:${member.memberId}`))
  if (missing.length) {
    await db.insert(sessionMembers).values(missing.map((member) => ({ sessionId, ...member })))
  }
}

async function ensureGroupSession(workspaceId: string, ownerId: string) {
  const ws = await ensureWorkspace(workspaceId, ownerId)
  let session = await findGroupSession(workspaceId)
  if (!session) {
    const [created] = await db
      .insert(sessions)
      .values({
        title: `${ws.name} / Agent Group`,
        type: 'group',
        ownerId,
        workspaceId,
      })
      .returning()
    if (!created) throw new HTTPException(500, { message: 'Failed to create group session' })
    session = created
  }
  await syncGroupMembers(session.id, workspaceId, ownerId)
  return session
}

function touchWorkspace(id: string) {
  return db.update(workspaces).set({ updatedAt: new Date() }).where(eq(workspaces.id, id))
}

// ---------- Routes ----------

export const workspaceRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)

  // List
  .get('/', async (c) => {
    const user = c.get('user')
    const list = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.ownerId, user.sub))
      .orderBy(desc(workspaces.updatedAt))
    return c.json({ items: list })
  })

  // Create (optionally seed classic agent team)
  .post('/', zValidator('json', createWorkspaceSchema), async (c) => {
    const user = c.get('user')
    const input = c.req.valid('json')
    const [ws] = await db
      .insert(workspaces)
      .values({ ownerId: user.sub, name: input.name, goal: input.goal })
      .returning()
    if (!ws) throw new HTTPException(500, { message: 'Failed to create workspace' })

    if (input.template === 'classic') {
      await db.insert(workspaceAgents).values(
        CLASSIC_AGENTS.map((a, i) => ({ ...a, workspaceId: ws.id, orderIdx: i }))
      )
    }
    return c.json(await loadWorkspaceFull(ws.id, user.sub))
  })

  // Get full workspace (with agents + tasks)
  .get('/:id', async (c) => {
    const user = c.get('user')
    return c.json(await loadWorkspaceFull(c.req.param('id'), user.sub))
  })

  // Update
  .patch('/:id', zValidator('json', updateWorkspaceSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    const input = c.req.valid('json')
    await db
      .update(workspaces)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(workspaces.id, id))
    return c.json(await loadWorkspaceFull(id, user.sub))
  })

  // Open or create the shared Agent Group chat for a workspace.
  .post('/:id/group-session', async (c) => {
    const user = c.get('user')
    const session = await ensureGroupSession(c.req.param('id'), user.sub)
    return c.json({ session })
  })

  // Delete
  .delete('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    await db.delete(workspaces).where(eq(workspaces.id, id))
    return c.body(null, 204)
  })

  // ---- Agents ----
  .post('/:id/agents', zValidator('json', createAgentSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    const input = c.req.valid('json')
    const existing = await db
      .select({ id: workspaceAgents.id })
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, id))
    const [agent] = await db
      .insert(workspaceAgents)
      .values({ ...input, workspaceId: id, orderIdx: existing.length })
      .returning()
    await touchWorkspace(id)
    return c.json(agent)
  })

  .patch('/:id/agents/:agentId', zValidator('json', updateAgentSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const agentId = c.req.param('agentId')
    await ensureWorkspace(id, user.sub)
    const input = c.req.valid('json')
    const [agent] = await db
      .update(workspaceAgents)
      .set(input)
      .where(and(eq(workspaceAgents.id, agentId), eq(workspaceAgents.workspaceId, id)))
      .returning()
    if (!agent) throw new HTTPException(404, { message: 'Agent not found' })
    await touchWorkspace(id)
    return c.json(agent)
  })

  .delete('/:id/agents/:agentId', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const agentId = c.req.param('agentId')
    await ensureWorkspace(id, user.sub)
    await db
      .delete(workspaceAgents)
      .where(and(eq(workspaceAgents.id, agentId), eq(workspaceAgents.workspaceId, id)))
    // Detach tasks pointing to this agent
    await db
      .update(workspaceTasks)
      .set({ agentId: null })
      .where(and(eq(workspaceTasks.workspaceId, id), eq(workspaceTasks.agentId, agentId)))
    await touchWorkspace(id)
    return c.body(null, 204)
  })

  // ---- Tasks ----
  .post('/:id/tasks', zValidator('json', createTaskSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    const input = c.req.valid('json')
    const existing = await db
      .select({ id: workspaceTasks.id })
      .from(workspaceTasks)
      .where(eq(workspaceTasks.workspaceId, id))
    const [task] = await db
      .insert(workspaceTasks)
      .values({
        workspaceId: id,
        title: input.title,
        description: input.description,
        agentId: input.agentId ?? null,
        orderIdx: existing.length,
      })
      .returning()
    await touchWorkspace(id)
    return c.json(task)
  })

  .patch('/:id/tasks/:taskId', zValidator('json', updateTaskSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')
    await ensureWorkspace(id, user.sub)
    const input = c.req.valid('json')
    const [task] = await db
      .update(workspaceTasks)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(workspaceTasks.id, taskId), eq(workspaceTasks.workspaceId, id)))
      .returning()
    if (!task) throw new HTTPException(404, { message: 'Task not found' })
    await touchWorkspace(id)
    return c.json(task)
  })

  .delete('/:id/tasks/:taskId', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')
    await ensureWorkspace(id, user.sub)
    await db
      .delete(workspaceTasks)
      .where(and(eq(workspaceTasks.id, taskId), eq(workspaceTasks.workspaceId, id)))
    await touchWorkspace(id)
    return c.body(null, 204)
  })

  // Dispatch task: create session, send first prompt, mark task running
  .post('/:id/tasks/:taskId/dispatch', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')
    const ws = await ensureWorkspace(id, user.sub)

    const [task] = await db
      .select()
      .from(workspaceTasks)
      .where(and(eq(workspaceTasks.id, taskId), eq(workspaceTasks.workspaceId, id)))
      .limit(1)
    if (!task) throw new HTTPException(404, { message: 'Task not found' })

    let agent: typeof workspaceAgents.$inferSelect | null = null
    if (task.agentId) {
      const [a] = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.id, task.agentId))
        .limit(1)
      agent = a ?? null
    }

    // Reuse existing session if already dispatched
    let sessionId = task.sessionId
    if (!sessionId) {
      const title = `${ws.name} · ${agent?.role ?? '任务'} · ${task.title.slice(0, 24)}`
      const [session] = await db
        .insert(sessions)
        .values({
          title,
          type: 'direct',
          ownerId: user.sub,
          workspaceId: id,
          workspaceAgentId: agent?.id ?? null,
        })
        .returning()
      if (!session) throw new HTTPException(500, { message: 'Failed to create session' })
      sessionId = session.id
    }

    // Build prompt
    const promptLines = [
      agent
        ? `你是 ${agent.name}(${agent.role})。${agent.systemPrompt}`
        : '你是一个 Agent Group 中的协作 Agent。',
      ws.goal ? `\n协作组目标:${ws.goal}` : '',
      `\n你被分配的任务:${task.title}`,
      task.description ? `\n任务详情:${task.description}` : '',
      '\n请先给出独立的工作计划,再开始推进;遇到需要其他角色配合的事,请在结尾用「需协作:」列出。',
    ].filter(Boolean)
    const prompt = promptLines.join('')

    const [userMsg] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: user.sub,
        senderType: 'user',
        type: 'text',
        content: prompt,
      })
      .returning()

    await db
      .update(workspaceTasks)
      .set({ sessionId, status: 'running', updatedAt: new Date() })
      .where(eq(workspaceTasks.id, taskId))

    // Trigger agent reply asynchronously
    if (userMsg) {
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(sessionId!, userMsg).catch(() => {})
      })
    }

    await touchWorkspace(id)
    const [updated] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, taskId)).limit(1)
    return c.json({ task: updated, sessionId })
  })

  // Coordinator summary: aggregate latest agent output of every dispatched task
  .post('/:id/summary', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const ws = await ensureWorkspace(id, user.sub)

    const taskList = await db
      .select()
      .from(workspaceTasks)
      .where(eq(workspaceTasks.workspaceId, id))
      .orderBy(asc(workspaceTasks.orderIdx))
    const agentList = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, id))
    const agentMap = new Map(agentList.map((a) => [a.id, a]))

    // Pull last agent message per dispatched task
    const sections: string[] = []
    for (const t of taskList) {
      const agent = t.agentId ? agentMap.get(t.agentId) : null
      const heading = `### ${agent?.name ?? '未指派'}(${agent?.role ?? '-'}) · ${t.title} [${t.status}]`
      if (!t.sessionId) {
        sections.push(`${heading}\n(尚未派发)`)
        continue
      }
      const [lastAgentMsg] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, t.sessionId), eq(messages.senderType, 'agent')))
        .orderBy(desc(messages.createdAt))
        .limit(1)
      const body = lastAgentMsg?.content?.trim() || '(暂无 agent 回复)'
      sections.push(`${heading}\n${body}`)
    }

    const summarySession = await db
      .insert(sessions)
      .values({
        title: `${ws.name} · 协调汇总`,
        type: 'group',
        ownerId: user.sub,
        workspaceId: id,
      })
      .returning()
    const session = summarySession[0]
    if (!session) throw new HTTPException(500, { message: 'Failed to create summary session' })

    const prompt = [
      `你是 Agent Group 的协调者。下面是各 Agent 的最新产出,请基于真实内容给出:`,
      `1) 整体进展评估  2) 不一致或风险点  3) 下一步统一行动方案与分派建议。`,
      `\n协作组目标:${ws.goal || '(未填写)'}`,
      `\n各 Agent 当前最新产出:\n\n${sections.join('\n\n')}`,
    ].join('\n')

    const [msg] = await db
      .insert(messages)
      .values({
        sessionId: session.id,
        senderId: user.sub,
        senderType: 'user',
        type: 'text',
        content: prompt,
      })
      .returning()

    if (msg) {
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(session.id, msg).catch(() => {})
      })
    }

    await touchWorkspace(id)
    return c.json({ sessionId: session.id })
  })
