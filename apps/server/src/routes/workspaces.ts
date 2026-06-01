import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { AppError, AppErrorCodes } from '../lib/error'
import { z } from 'zod'
import { db, workspaces, workspaceAgents, workspaceAgentRelations, workspaceTasks, sessions, eq, and, desc, asc } from '@agenthub/db'
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
import { loadWorkspaceFull, ensureWorkspace } from '../services/workspace/workspace-queries'
import { ensureGroupSession } from '../services/workspace/session-manager'
import { getActiveRunSessionIds } from '../services/workspace/agent-runtime'
import { AGENT_RELATION_TYPES, AGENT_ROLE_TYPES } from '../services/workspace/agent-role-presets'
import { createAutoWorkspaceFolder } from '../services/workspace/auto-workspace'

// ---------- Validation schemas ----------

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
  goal: z.string().max(2000).default(''),
  projectPath: z.string().max(1000).nullable().optional(),
})

const createAutoWorkspaceSchema = z.object({
  name: z.string().max(120).optional(),
  goal: z.string().max(2000).default(''),
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
  runtimeType: z.enum(['llm', 'code-agent']).default('code-agent'),
  codeAgentType: z.enum(['codex', 'claude-code', 'opencode', 'gemini']).nullable().optional(),
  capabilityTags: z.array(z.string().max(40)).max(12).default([]),
  skillIds: z.array(z.string().max(120)).max(40).default([]),
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
  return { ...input, codeAgentType: null }
}

/** 更新 Agent 时只填充显式为 null 的字段，不覆盖已有配置 */
function normalizeAgentUpdateDefaults(
  input: z.infer<typeof updateAgentSchema>,
  currentRuntimeType?: string | null,
): z.infer<typeof updateAgentSchema> {
  const result = { ...input }
  const normalizedCurrentRuntime = normalizeRuntimeType(currentRuntimeType)
  const nextRuntimeType = input.runtimeType ?? normalizedCurrentRuntime
  if (!input.runtimeType && currentRuntimeType && currentRuntimeType !== normalizedCurrentRuntime) {
    result.runtimeType = normalizedCurrentRuntime
  }
  if (nextRuntimeType === 'code-agent') {
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
  if (input.runtimeType === 'llm' && currentRuntimeType === 'code-agent' && input.modelId === undefined) {
    result.modelId = null
  }
  if (nextRuntimeType === 'llm') result.codeAgentType = null
  return result
}

function normalizeRuntimeType(value?: string | null): 'llm' | 'code-agent' {
  return value === 'llm' ? 'llm' : 'code-agent'
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

  // Deprecated: workspace/agent direct sessions were the old child-session entry.
  .post('/:id/agents/:agentId/session', async (c) => {
    throw AppError.fromCode(
      AppErrorCodes.VALIDATION_FAILED,
      '旧的 Workspace/Agent 子会话入口已停用；请从 Agent 私聊或群聊任务子对话进入。',
    )
  })

  // Workspace sessions
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
    const [current] = await db
      .select({ runtimeType: workspaceAgents.runtimeType })
      .from(workspaceAgents)
      .where(and(eq(workspaceAgents.id, agentId), eq(workspaceAgents.workspaceId, id)))
      .limit(1)
    if (!current) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 涓嶅瓨鍦?')
    const input = normalizeAgentUpdateDefaults(c.req.valid('json'), current.runtimeType)
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

