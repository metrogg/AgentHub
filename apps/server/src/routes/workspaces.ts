import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { db, workspaces, workspaceAgents, workspaceTasks, sessions, messages, eq, and, desc, asc } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { logger } from '../lib/logger'

import {
  cleanProjectPath,
  ensureProjectDirectory,
  findWorkspaceByProjectPath,
  touchWorkspace,
} from '../services/workspace/utils'
import { pickNativeFolder } from '../services/workspace/folder-picker'
import { loadWorkspaceFull, ensureWorkspace, seedClassicAgents } from '../services/workspace/workspace-queries'
import { ensureGroupSession } from '../services/workspace/group-session'
import { workspaceAgentRunProfile, getActiveRunSessionIds } from '../services/workspace/agent-runtime'

// ---------- Validation schemas ----------

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  goal: z.string().max(2000).default(''),
  projectPath: z.string().max(1000).nullable().optional(),
  template: z.enum(['blank', 'classic']).optional(),
})

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  goal: z.string().max(2000).optional(),
  projectPath: z.string().max(1000).nullable().optional(),
})

const openWorkspaceFolderSchema = z.object({
  projectPath: z.string().max(1000).nullable().optional(),
})

const createAgentSchema = z.object({
  name: z.string().min(1).max(60),
  role: z.string().min(1).max(60),
  description: z.string().max(500).default(''),
  avatar: z.string().max(500).nullable().optional(),
  systemPrompt: z.string().max(4000).default(''),
  color: z.string().max(20).default('#6366f1'),
  modelId: z.string().max(120).nullable().optional(),
  runtimeType: z.enum(['llm', 'code-agent', 'mcp', 'a2a']).default('llm'),
  codeAgentType: z.enum(['codex', 'claude-code', 'opencode', 'gemini']).nullable().optional(),
  capabilityTags: z.array(z.string().max(40)).max(12).default([]),
  toolPermissions: z.array(z.string().max(80)).max(30).default([]),
  sandboxPolicy: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  contextPolicy: z.enum(['recent-only', 'pinned-recent', 'workspace-aware']).default('workspace-aware'),
  autoInvoke: z.boolean().default(true),
  approvalRequired: z.boolean().default(true),
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
  status: z.enum(['pending', 'running', 'done', 'failed']).optional(),
})

type AgentConfigPatch = z.input<typeof createAgentSchema> | z.infer<typeof updateAgentSchema>

function normalizeNativeReadOnlyAgent<T extends AgentConfigPatch>(input: T): T {
  if (input.runtimeType !== 'mcp') return input
  return {
    ...input,
    codeAgentType: null,
    toolPermissions: ['workspace:read', 'skills:read'],
    sandboxPolicy: 'read-only',
    approvalRequired: true,
  }
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

  // Create
  .post('/', zValidator('json', createWorkspaceSchema), async (c) => {
    const user = c.get('user')
    const input = normalizeNativeReadOnlyAgent(c.req.valid('json'))
    const projectPath = ensureProjectDirectory(input.projectPath)
    const [ws] = await db
      .insert(workspaces)
      .values({ ownerId: user.sub, name: input.name, goal: input.goal, projectPath })
      .returning()
    if (!ws) throw new HTTPException(500, { message: 'Failed to create workspace' })

    if (input.template === 'classic') {
      await seedClassicAgents(ws.id)
    }
    return c.json(await loadWorkspaceFull(ws.id, user.sub))
  })

  // Open a native folder picker
  .post('/open-folder', async (c) => {
    const user = c.get('user')
    logger.info({ userId: user.sub }, 'Workspace open-folder request started')
    const body = await c.req.json().catch(() => ({}))
    const input = openWorkspaceFolderSchema.parse(body)
    let selectedPath: string | null = input.projectPath?.trim() || null
    try {
      selectedPath = selectedPath || (await pickNativeFolder())
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), userId: user.sub }, 'Folder picker failed')
      if (err instanceof HTTPException) throw err
      throw new HTTPException(500, { message: '打开文件夹选择器失败' })
    }
    if (!selectedPath) {
      logger.info({ userId: user.sub }, 'Folder picker cancelled by user')
      return c.json({ cancelled: true as const, projectPath: null, workspace: null })
    }

    logger.info({ userId: user.sub, selectedPath }, 'Folder selected, validating')
    const projectPath = ensureProjectDirectory(selectedPath)
    if (!projectPath) {
      logger.warn({ userId: user.sub, selectedPath }, 'Selected path is not a valid directory')
      return c.json({ cancelled: true as const, projectPath: null, workspace: null })
    }

    const existing = await findWorkspaceByProjectPath(user.sub, projectPath)
    if (existing) {
      await touchWorkspace(existing.id)
      logger.info({ userId: user.sub, projectPath, workspaceId: existing.id }, 'Existing workspace found')
      return c.json({
        cancelled: false as const,
        projectPath,
        workspace: (await loadWorkspaceFull(existing.id, user.sub)).workspace,
      })
    }
    logger.info({ userId: user.sub, projectPath }, 'New project path, creating workspace')
    return c.json({ cancelled: false as const, projectPath, workspace: null })
  })

  // Get full workspace
  .get('/:id', async (c) => {
    const user = c.get('user')
    return c.json(await loadWorkspaceFull(c.req.param('id'), user.sub))
  })

  // Update
  .patch('/:id', zValidator('json', updateWorkspaceSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    const input = normalizeNativeReadOnlyAgent(c.req.valid('json'))
    const patch = {
      ...input,
      ...(input.projectPath !== undefined ? { projectPath: ensureProjectDirectory(input.projectPath) } : {}),
      updatedAt: new Date(),
    }
    await db.update(workspaces).set(patch).where(eq(workspaces.id, id))
    return c.json(await loadWorkspaceFull(id, user.sub))
  })

  // Group session
  .post('/:id/group-session', async (c) => {
    const user = c.get('user')
    const session = await ensureGroupSession(c.req.param('id'), user.sub)
    return c.json({ session })
  })

  // Active runs
  .get('/:id/active-runs', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    const activeSessionIds = new Set(getActiveRunSessionIds())
    if (!activeSessionIds.size) return c.json({ items: [] })
    const workspaceSessions = await db.select().from(sessions).where(eq(sessions.workspaceId, id))
    return c.json({
      items: workspaceSessions
        .filter((session) => activeSessionIds.has(session.id))
        .map((session) => ({
          agentId: session.workspaceAgentId,
          sessionId: session.id,
        })),
    })
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
    const existing = await db.select({ id: workspaceAgents.id }).from(workspaceAgents).where(eq(workspaceAgents.workspaceId, id))
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
    await db.delete(workspaceAgents).where(and(eq(workspaceAgents.id, agentId), eq(workspaceAgents.workspaceId, id)))
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
    const existing = await db.select({ id: workspaceTasks.id }).from(workspaceTasks).where(eq(workspaceTasks.workspaceId, id))
    const [task] = await db
      .insert(workspaceTasks)
      .values({ workspaceId: id, title: input.title, description: input.description, agentId: input.agentId ?? null, orderIdx: existing.length })
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
    await db.delete(workspaceTasks).where(and(eq(workspaceTasks.id, taskId), eq(workspaceTasks.workspaceId, id)))
    await touchWorkspace(id)
    return c.body(null, 204)
  })

  // Dispatch task
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
      const [a] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, task.agentId)).limit(1)
      agent = a ?? null
    }

    let sessionId = task.sessionId
    if (!sessionId) {
      const title = `${ws.name} · ${agent?.role ?? '任务'} · ${task.title.slice(0, 24)}`
      const [session] = await db
        .insert(sessions)
        .values({ title, type: 'direct', ownerId: user.sub, workspaceId: id, workspaceAgentId: agent?.id ?? null })
        .returning()
      if (!session) throw new HTTPException(500, { message: 'Failed to create session' })
      sessionId = session.id
    }

    const promptLines = [
      agent ? `你是 ${agent.name}(${agent.role})。${agent.systemPrompt}` : '你是一个 Agent Group 中的协作 Agent。',
      ws.goal ? `\n协作组目标:${ws.goal}` : '',
      ws.projectPath ? `\n项目文件夹:${ws.projectPath}` : '',
      `\n你被分配的任务:${task.title}`,
      task.description ? `\n任务详情:${task.description}` : '',
      '\n请先给出独立的工作计划,再开始推进;遇到需要其他角色配合的事,请在结尾用「需协作:」列出。',
    ].filter(Boolean)
    const prompt = promptLines.join('')

    const [userMsg] = await db
      .insert(messages)
      .values({ sessionId, senderId: user.sub, senderType: 'user', type: 'text', content: prompt })
      .returning()

    await db.update(workspaceTasks).set({ sessionId, status: 'running', updatedAt: new Date() }).where(eq(workspaceTasks.id, taskId))

    if (userMsg) {
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(sessionId!, userMsg, agent ? workspaceAgentRunProfile(agent, ws.projectPath) : undefined)
          .then(async (result) => {
            await db.update(workspaceTasks).set({ status: result.ok ? 'done' : 'failed', updatedAt: new Date() }).where(eq(workspaceTasks.id, taskId))
          })
          .catch(async (err) => {
            await db.update(workspaceTasks).set({ status: 'failed', updatedAt: new Date(), errorLog: err?.message || 'Agent execution failed' }).where(eq(workspaceTasks.id, taskId))
          })
      })
    }

    await touchWorkspace(id)
    const [updated] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, taskId)).limit(1)
    return c.json({ task: updated, sessionId })
  })

  // Summary
  .post('/:id/summary', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const ws = await ensureWorkspace(id, user.sub)

    const taskList = await db.select().from(workspaceTasks).where(eq(workspaceTasks.workspaceId, id)).orderBy(asc(workspaceTasks.orderIdx))
    const agentList = await db.select().from(workspaceAgents).where(eq(workspaceAgents.workspaceId, id))
    const agentMap = new Map(agentList.map((a) => [a.id, a]))

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
      .values({ title: `${ws.name} · 协调汇总`, type: 'group', ownerId: user.sub, workspaceId: id })
      .returning()
    const session = summarySession[0]
    if (!session) throw new HTTPException(500, { message: 'Failed to create summary session' })

    const prompt = [
      `你是 Agent Group 的协调者。下面是各 Agent 的最新产出,请基于真实内容给出:`,
      `1) 整体进展评估  2) 不一致或风险点  3) 下一步统一行动方案与分派建议。`,
      `\n协作组目标:${ws.goal || '(未填写)'}`,
      ws.projectPath ? `\n项目文件夹:${ws.projectPath}` : '',
      `\n各 Agent 当前最新产出:\n\n${sections.join('\n\n')}`,
    ].join('')

    const [msg] = await db
      .insert(messages)
      .values({ sessionId: session.id, senderId: user.sub, senderType: 'user', type: 'text', content: prompt })
      .returning()

    if (msg) {
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(session.id, msg).catch(() => {})
      })
    }

    await touchWorkspace(id)
    return c.json({ sessionId: session.id })
  })
