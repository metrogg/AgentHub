import { Hono, type Context } from 'hono'
import { and, db, desc, eq, matrixIdentities, orchestratorRuns, sessions, workspaceAgents, workspaceTasks, workerInstances } from '@agenthub/db'
import { AppError, AppErrorCodes } from '../lib/error'
import { logger } from '../lib/logger'
import { controllerApi } from '../services/controller-plane/controller-api'
import { dispatchAssignBatch } from '../services/controller-plane/task-dispatcher'
import type { RunControllerRunContext } from '../services/orchestrator/run-controller'

// Extend Hono context variables
declare module 'hono' {
  interface ContextVariableMap {
    managerIdentity: typeof matrixIdentities.$inferSelect
  }
}

const managerActionsRoutes = new Hono()

// ─── Auth Middleware: Bearer token must match Manager Matrix identity ──────
managerActionsRoutes.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    throw AppError.fromCode(AppErrorCodes.UNAUTHORIZED, 'Missing Authorization header')
  }

  const [identity] = await db
    .select()
    .from(matrixIdentities)
    .where(and(eq(matrixIdentities.ownerType, 'manager'), eq(matrixIdentities.accessToken, token)))
    .limit(1)

  if (!identity) {
    throw AppError.fromCode(AppErrorCodes.UNAUTHORIZED, 'Invalid Manager token')
  }

  c.set('managerIdentity', identity)
  return next()
})

// ─── POST /api/internal/manager/actions ────────────────────────────────────
managerActionsRoutes.post('/actions', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as ManagerActionRequest
  const action = body.action
  const identity = c.get('managerIdentity')

  logger.info({ action, managerIdentityId: identity.id }, 'Manager action received')

  switch (action) {
    case 'create_task':
      return handleCreateTask(c, body.params)
    case 'create_worker':
      return handleCreateWorker(c, body.params)
    case 'list_workers':
      return handleListWorkers(c, body.params)
    case 'get_run_status':
      return handleGetRunStatus(c, body.params)
    case 'get_workspace_state':
      return handleGetWorkspaceState(c, body.params)
    case 'heartbeat':
      return handleHeartbeat(c, body.params, identity)
    default:
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Unknown manager action: ${action}`)
  }
})

// ─── GET /api/internal/manager/state ───────────────────────────────────────
managerActionsRoutes.get('/state', async (c) => {
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'workspaceId is required')
  }

  const [run] = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.workspaceId, workspaceId))
    .orderBy(desc(orchestratorRuns.createdAt))
    .limit(1)

  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.workspaceId, workspaceId))
    .orderBy(desc(workspaceTasks.createdAt))
    .limit(50)

  const workers = await db
    .select()
    .from(workerInstances)
    .where(eq(workerInstances.workspaceId, workspaceId))

  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))

  return c.json({
    workspaceId,
    latestRun: run ?? null,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      agentId: t.agentId,
      progressStatus: t.progressStatus,
      createdAt: t.createdAt,
    })),
    workers: workers.map((w) => ({
      id: w.id,
      workspaceAgentId: w.workspaceAgentId,
      runtimeBase: w.runtimeBase,
      observedState: w.observedState,
      lastHeartbeatAt: w.lastHeartbeatAt,
    })),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      runtimeType: a.runtimeType,
      codeAgentType: a.codeAgentType,
    })),
  })
})

// ─── Action Handlers ───────────────────────────────────────────────────────

interface ManagerActionRequest {
  action: string
  params?: Record<string, unknown>
}

async function handleCreateTask(c: Context, params: Record<string, unknown> | undefined) {
  const workspaceId = stringParam(params, 'workspaceId')
  const runId = stringParam(params, 'runId')
  const title = stringParam(params, 'title')
  const spec = stringParam(params, 'spec')
  const assignToWorkerInstanceId = stringParam(params, 'assignToWorkerInstanceId', true)
  const assignToAgentId = stringParam(params, 'assignToAgentId', true)

  const [workspace] = await db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId)).limit(1)
  if (!workspace) {
    throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, 'Workspace session not found')
  }

  let targetWorker: typeof workspaceAgents.$inferSelect | null = null
  if (assignToAgentId) {
    const [agent] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, assignToAgentId)).limit(1)
    targetWorker = agent ?? null
  } else if (assignToWorkerInstanceId) {
    const [instance] = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, assignToWorkerInstanceId))
      .limit(1)
    if (instance) {
      const [agent] = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.id, instance.workspaceAgentId))
        .limit(1)
      targetWorker = agent ?? null
    }
  }

  if (!targetWorker) {
    throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Target worker not found')
  }

  // Build a fake message for dispatch (matches messages table shape)
  const fakeMessage = {
    id: `manager-action-${Date.now()}`,
    sessionId: workspace.id,
    senderId: 'manager',
    senderType: 'system' as const,
    type: 'text',
    content: title,
    metadata: {},
    isPinned: false,
    replyToMessageId: null,
    createdAt: new Date(),
  }

  let runContext: RunControllerRunContext | undefined
  if (runId) {
    const [run] = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.id, runId))
      .limit(1)
    if (run) {
      runContext = {
        runId: run.id,
        workspaceId: run.workspaceId,
        groupSessionId: run.groupSessionId,
      }
    }
  }

  const result = await dispatchAssignBatch({
    groupSession: workspace,
    ownerId: workspace.ownerId,
    sourceMessage: fakeMessage as any,
    actions: [
      {
        type: 'assign',
        targetWorkerId: targetWorker.id,
        taskTitle: title,
        taskDescription: spec ?? title,
        message: spec ?? title,
        reason: 'Manager action: create_task',
      } as any,
    ],
    runtimeType: targetWorker.runtimeType ?? 'code-agent',
    run: runContext,
  })

  return c.json({ success: true, action: 'create_task', result })
}

async function handleCreateWorker(c: Context, params: Record<string, unknown> | undefined) {
  const workspaceId = stringParam(params, 'workspaceId')
  const name = stringParam(params, 'name')
  const runtimeType = stringParam(params, 'runtimeType', true) ?? 'code-agent'
  const codeAgentType = stringParam(params, 'codeAgentType', true) ?? 'codex'
  const modelId = stringParam(params, 'modelId', true)

  const existing = await db
    .select()
    .from(workspaceAgents)
    .where(and(eq(workspaceAgents.workspaceId, workspaceId), eq(workspaceAgents.name, name)))
    .limit(1)

  let agentId: string
  if (existing.length > 0 && existing[0]) {
    agentId = existing[0].id
  } else {
    const [inserted] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId,
        name,
        role: 'worker' as any,
        runtimeType: runtimeType as any,
        codeAgentType: codeAgentType as any,
        modelId: modelId ?? null,
        skillIds: [],
        toolPermissions: [],
        sandboxPolicy: 'workspace-write' as any,
      } as any)
      .returning()
    if (!inserted) throw new Error('Failed to create workspace agent')
    agentId = inserted.id
  }

  const worker = await controllerApi.applyWorker({ workspaceId, workspaceAgentId: agentId })

  return c.json({ success: true, action: 'create_worker', agentId, worker })
}

async function handleListWorkers(c: Context, params: Record<string, unknown> | undefined) {
  const workspaceId = stringParam(params, 'workspaceId')
  const workers = await controllerApi.listWorkers(workspaceId)
  return c.json({ success: true, action: 'list_workers', workers })
}

async function handleGetRunStatus(c: Context, params: Record<string, unknown> | undefined) {
  const runId = stringParam(params, 'runId')
  const [run] = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.id, runId))
    .limit(1)
  if (!run) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Run not found')
  }

  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.runId, runId))

  return c.json({ success: true, action: 'get_run_status', run, tasks })
}

async function handleGetWorkspaceState(c: Context, params: Record<string, unknown> | undefined) {
  const workspaceId = stringParam(params, 'workspaceId')
  const [workspace] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .limit(1)

  const tasks = await db
    .select()
    .from(workspaceTasks)
    .where(eq(workspaceTasks.workspaceId, workspaceId))
    .limit(50)

  const workers = await db
    .select()
    .from(workerInstances)
    .where(eq(workerInstances.workspaceId, workspaceId))

  return c.json({ success: true, action: 'get_workspace_state', workspace, tasks, workers })
}

async function handleHeartbeat(
  c: Context,
  params: Record<string, unknown> | undefined,
  identity: typeof matrixIdentities.$inferSelect,
) {
  const workspaceId = stringParam(params, 'workspaceId', true)
  logger.info({ managerIdentityId: identity.id, workspaceId }, 'Manager heartbeat received')

  return c.json({ success: true, action: 'heartbeat', timestamp: new Date().toISOString() })
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function stringParam(params: Record<string, unknown> | undefined, key: string, optional: true): string | undefined
function stringParam(params: Record<string, unknown> | undefined, key: string, optional?: false): string
function stringParam(params: Record<string, unknown> | undefined, key: string, optional = false): string | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) {
    if (optional) return undefined
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Missing required param: ${key}`)
  }
  if (typeof value !== 'string') {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Param ${key} must be a string`)
  }
  return value
}

export { managerActionsRoutes }
