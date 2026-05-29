import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { AppError, AppErrorCodes } from '../lib/error'
import { z } from 'zod'
import { db, workspaces, workspaceAgents, workspaceAgentRelations, workspaceTasks, sessions, messages, eq, and, desc, asc } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { logger } from '../lib/logger'

import {
  cleanProjectPath,
  ensureProjectDirectory,
  findWorkspaceByProjectPath,
  touchWorkspace,
  ensureHarnessPresets,
} from '../services/workspace/utils'
import { pickNativeFolder } from '../services/workspace/folder-picker'
import { loadWorkspaceFull, ensureWorkspace, seedClassicAgents } from '../services/workspace/workspace-queries'
import { ensureGroupSession } from '../services/workspace/group-session'
import { workspaceAgentRunProfile, getActiveRunSessionIds } from '../services/workspace/agent-runtime'
import { taskExecutionService } from '../services/execution/task-execution-service'
import { AGENT_RELATION_TYPES, AGENT_ROLE_TYPES } from '../services/workspace/agent-role-presets'
import { createAutoWorkspaceFolder } from '../services/workspace/auto-workspace'
import { TaskStatus } from '@agenthub/shared'

// ---------- Validation schemas ----------

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  goal: z.string().max(2000).default(''),
  projectPath: z.string().max(1000).nullable().optional(),
  template: z.enum(['blank', 'classic']).optional(),
})

const createAutoWorkspaceSchema = z.object({
  name: z.string().max(120).optional(),
  goal: z.string().max(2000).default(''),
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
  roleType: z.enum(AGENT_ROLE_TYPES).default('custom'),
  description: z.string().max(500).default(''),
  avatar: z.string().max(500).nullable().optional(),
  systemPrompt: z.string().max(4000).default(''),
  roleProfile: z.record(z.unknown()).nullable().optional(),
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

const agentRelationsReplaceSchema = z.object({
  relations: z.array(
    z.object({
      sourceAgentId: z.string().min(1),
      targetAgentId: z.string().min(1),
      relationType: z.enum(AGENT_RELATION_TYPES),
      note: z.string().max(500).nullable().optional(),
    }),
  ).max(100),
})

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  agentId: z.string().nullable().optional(),
})

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  agentId: z.string().nullable().optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled', 'blocked', 'skipped']).optional(),
})

type AgentConfigPatch = z.input<typeof createAgentSchema> | z.infer<typeof updateAgentSchema>

/** 创建 Agent 时应用运行时默认值 */
function normalizeAgentCreateDefaults(input: z.infer<typeof createAgentSchema>): z.infer<typeof createAgentSchema> {
  if (input.runtimeType === 'code-agent') {
    return {
      ...input,
      codeAgentType: input.codeAgentType ?? 'codex',
      sandboxPolicy: input.sandboxPolicy ?? 'workspace-write',
      approvalRequired: false,
    }
  }
  if (input.runtimeType === 'mcp') {
    return {
      ...input,
      codeAgentType: null,
      toolPermissions: ['workspace:read', 'skills:read'],
      sandboxPolicy: 'read-only',
      approvalRequired: true,
    }
  }
  return input
}

/** 更新 Agent 时只填充显式为 null 的字段，不覆盖已有配置 */
function normalizeAgentUpdateDefaults(input: z.infer<typeof updateAgentSchema>): z.infer<typeof updateAgentSchema> {
  const result = { ...input }
  if (input.runtimeType === 'code-agent') {
    if (input.codeAgentType === null) {
      result.codeAgentType = 'codex'
    }
    if (input.sandboxPolicy === undefined) {
      result.sandboxPolicy = 'workspace-write'
    }
    if (input.approvalRequired === undefined) {
      result.approvalRequired = false
    }
  }
  if (input.runtimeType === 'mcp') {
    result.codeAgentType = null
    result.toolPermissions = ['workspace:read', 'skills:read']
    result.sandboxPolicy = 'read-only'
    result.approvalRequired = true
  }
  return result
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
    const input = c.req.valid('json')
    const projectPath = ensureProjectDirectory(input.projectPath)
    const [ws] = await db
      .insert(workspaces)
      .values({ ownerId: user.sub, name: input.name, goal: input.goal, projectPath })
      .returning()
    if (!ws) throw AppError.fromCode(AppErrorCodes.WORKSPACE_CREATE_FAILED, '工作区创建失败')

    if (input.template === 'classic') {
      await seedClassicAgents(ws.id)
    }
    ensureHarnessPresets(projectPath)
    return c.json(await loadWorkspaceFull(ws.id, user.sub))
  })

  // Create with a generated local folder when no project path is chosen yet
  .post('/auto', zValidator('json', createAutoWorkspaceSchema), async (c) => {
    const user = c.get('user')
    const input = c.req.valid('json')
    const folder = await createAutoWorkspaceFolder(input.name ?? input.goal ?? null)
    const workspaceName = (input.name?.trim() || folder.folderName).slice(0, 120)
    const [ws] = await db
      .insert(workspaces)
      .values({
        ownerId: user.sub,
        name: workspaceName,
        goal: input.goal,
        projectPath: folder.projectPath,
      })
      .returning()
    if (!ws) throw AppError.fromCode(AppErrorCodes.WORKSPACE_CREATE_FAILED, '工作区创建失败')

    if (input.template === 'classic') {
      await seedClassicAgents(ws.id)
    }
    ensureHarnessPresets(folder.projectPath)
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
      if (err instanceof AppError) throw err
      throw AppError.fromCode(AppErrorCodes.INTERNAL_ERROR, '打开文件夹选择器失败')
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
    const input = c.req.valid('json')
    const patch = {
      ...input,
      ...(input.projectPath !== undefined ? { projectPath: ensureProjectDirectory(input.projectPath) } : {}),
      updatedAt: new Date(),
    }
    await db.update(workspaces).set(patch).where(eq(workspaces.id, id))
    if (input.projectPath !== undefined) {
      ensureHarnessPresets(patch.projectPath)
    }
    return c.json(await loadWorkspaceFull(id, user.sub))
  })

  // Group session
  .post('/:id/group-session', async (c) => {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({}))
    const session = await ensureGroupSession(c.req.param('id'), user.sub, body?.agentIds)
    return c.json({ session })
  })

  // Agent child session
  .post('/:id/agents/:agentId/session', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const agentId = c.req.param('agentId')
    await ensureWorkspace(id, user.sub)

    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(and(eq(workspaceAgents.id, agentId), eq(workspaceAgents.workspaceId, id)))
      .limit(1)
    if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)

    const existingSessions = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.ownerId, user.sub),
          eq(sessions.type, 'direct'),
          eq(sessions.workspaceId, id),
          eq(sessions.workspaceAgentId, agentId)
        )
      )
      .orderBy(desc(sessions.updatedAt))

    const existing = existingSessions.find((session) => !isGeneratedTaskSession(session.metadata))
    if (existing) return c.json({ session: existing })

    try {
      const [created] = await db
        .insert(sessions)
        .values({
          title: `${workspace?.name || 'Workspace'} / ${agent.name}`,
          type: 'direct',
          ownerId: user.sub,
          workspaceId: id,
          workspaceAgentId: agentId,
          metadata: { kind: 'workspace-agent-child' },
        })
        .returning()

      if (!created) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '会话创建失败')
      return c.json({ session: created })
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          workspaceId: id,
          agentId,
          userId: user.sub,
        },
        'Failed to create agent child session',
      )
      if (error instanceof AppError) throw error
      throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, error instanceof Error ? error.message : '会话创建失败')
    }
  })

  // Agent child session
  .get('/:id/sessions', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    const list = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.workspaceId, id), eq(sessions.ownerId, user.sub)))
      .orderBy(desc(sessions.updatedAt))
    return c.json({ items: list })
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

  // Agent collaboration relations
  .get('/:id/agent-relations', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    const items = await db
      .select()
      .from(workspaceAgentRelations)
      .where(eq(workspaceAgentRelations.workspaceId, id))
      .orderBy(asc(workspaceAgentRelations.createdAt))
    return c.json({ items })
  })

  .put('/:id/agent-relations', zValidator('json', agentRelationsReplaceSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    await ensureWorkspace(id, user.sub)
    const { relations } = c.req.valid('json')

    const agents = await db
      .select({ id: workspaceAgents.id })
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, id))
    const agentIds = new Set(agents.map((agent) => agent.id))
    const deduped = new Map<string, {
      workspaceId: string
      sourceAgentId: string
      targetAgentId: string
      relationType: (typeof AGENT_RELATION_TYPES)[number]
      note: string | null
    }>()

    for (const relation of relations) {
      if (!agentIds.has(relation.sourceAgentId) || !agentIds.has(relation.targetAgentId)) {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '关联的 Agent 必须属于当前工作区')
      }
      if (relation.sourceAgentId === relation.targetAgentId) {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '关联的源和目标 Agent 不能相同')
      }
      const key = `${relation.sourceAgentId}:${relation.targetAgentId}:${relation.relationType}`
      if (deduped.has(key)) continue
      deduped.set(key, {
        workspaceId: id,
        sourceAgentId: relation.sourceAgentId,
        targetAgentId: relation.targetAgentId,
        relationType: relation.relationType,
        note: relation.note?.trim() || null,
      })
    }

    const items = await db.transaction(async (tx) => {
      await tx.delete(workspaceAgentRelations).where(eq(workspaceAgentRelations.workspaceId, id))
      const values = Array.from(deduped.values())
      if (!values.length) return []
      return tx.insert(workspaceAgentRelations).values(values).returning()
    })

    await touchWorkspace(id)
    return c.json({ items })
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
    const input = normalizeAgentCreateDefaults(c.req.valid('json'))
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
    const input = normalizeAgentUpdateDefaults(c.req.valid('json'))
    const [agent] = await db
      .update(workspaceAgents)
      .set(input)
      .where(and(eq(workspaceAgents.id, agentId), eq(workspaceAgents.workspaceId, id)))
      .returning()
    if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')
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
    if (!task) throw AppError.fromCode(AppErrorCodes.TASK_NOT_FOUND, '任务不存在')
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
    if (!task) throw AppError.fromCode(AppErrorCodes.TASK_NOT_FOUND, '任务不存在')

    let agent: typeof workspaceAgents.$inferSelect | null = null
    if (task.agentId) {
      const [a] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, task.agentId)).limit(1)
      agent = a ?? null
    }

    let sessionId = task.sessionId
    if (!sessionId) {
      const title = `${ws.name} / ${agent?.role ?? '任务'} / ${task.title.slice(0, 24)}`
      const [session] = await db
        .insert(sessions)
        .values({
          title,
          type: 'direct',
          ownerId: user.sub,
          workspaceId: id,
          workspaceAgentId: agent?.id ?? null,
          metadata: { hiddenFromSessionTree: true, workspaceTaskId: task.id },
        })
        .returning()
      if (!session) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '会话创建失败')
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

    const profile = agent ? workspaceAgentRunProfile(agent, ws.projectPath) : undefined
    if (!profile) {
      throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')
    }

    await db
      .update(workspaceTasks)
      .set({ sessionId: sessionId!, status: TaskStatus.Running, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(workspaceTasks.id, taskId))

    // 使用统一 TaskExecutionService，获得与 Orchestrator 相同的 Git 分支隔离和 artifact 收集
    taskExecutionService.execute({
      taskId,
      sessionId: sessionId!,
      workspaceId: id,
      profile,
      prompt,
      projectPath: ws.projectPath,
    }).catch((err) => {
      logger.error({ err: err?.message, taskId }, 'TaskExecutionService failed')
    })

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
      .values({ title: `${ws.name} / 协调汇总`, type: 'group', ownerId: user.sub, workspaceId: id })
      .returning()
    const session = summarySession[0]
    if (!session) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '总结会话创建失败')

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

function isGeneratedTaskSession(metadata: Record<string, unknown> | null) {
  return Boolean(
    metadata?.orchestratorTaskId ||
      metadata?.orchestratorRunId ||
      metadata?.hiddenFromSessionTree ||
      metadata?.kind === 'orchestrator-task',
  )
}
