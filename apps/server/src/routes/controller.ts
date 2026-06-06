import { Hono, type Context } from 'hono'
import { and, db, eq, matrixIdentities, sessions } from '@agenthub/db'
import { AppError, AppErrorCodes } from '../lib/error'
import { logger } from '../lib/logger'
import { controllerApi } from '../services/controller-plane/controller-api'
import { dispatchAssignBatch } from '../services/controller-plane/task-dispatcher'
import type { RunControllerRunContext } from '../services/orchestrator/run-controller'

// ─── Auth Middleware ───────────────────────────────────────────────────

async function managerAuth(c: Context, next: () => Promise<void>) {
  const authHeader = c.req.header('authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw AppError.fromCode(AppErrorCodes.UNAUTHORIZED, 'Missing Authorization header')

  const [identity] = await db
    .select()
    .from(matrixIdentities)
    .where(and(eq(matrixIdentities.ownerType, 'manager'), eq(matrixIdentities.accessToken, token)))
    .limit(1)

  if (!identity) throw AppError.fromCode(AppErrorCodes.UNAUTHORIZED, 'Invalid Manager token')
  c.set('managerIdentity', identity)
  return next()
}

// ─── Routes ───────────────────────────────────────────────────────────

export const controllerRoutes = new Hono()
controllerRoutes.use('*', managerAuth)

// ─── Worker ───────────────────────────────────────────────────────────

controllerRoutes.post('/workers', async (c) => {
  const body = await c.req.json()
  const result = await controllerApi.createWorker({
    workspaceId: requireP(body, 'workspaceId'),
    name: requireP(body, 'name'),
    runtimeType: body.runtimeType || 'code-agent',
    runtimeBase: body.runtimeBase || body.workerRuntimeBase,
    codeAgentType: body.codeAgentType || body['code-agent'],
    modelId: body.modelId || body.model || null,
    skillIds: body.skillIds || body.skills || undefined,
    role: body.role,
    roleType: body.roleType,
    sandboxPolicy: body.sandboxPolicy,
  })
  return c.json({ success: true, ...result })
})

controllerRoutes.get('/workers', async (c) => {
  const workspaceId = requireQ(c, 'workspaceId')
  return c.json({ workers: await controllerApi.listWorkers(workspaceId) })
})

controllerRoutes.get('/workers/:id', async (c) => {
  const worker = await controllerApi.getWorker(c.req.param('id'))
  if (!worker) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Worker not found')
  return c.json(worker)
})

controllerRoutes.patch('/workers/:id', async (c) => {
  const body = await c.req.json()
  const result = await controllerApi.updateWorker(c.req.param('id'), {
    modelId: body.modelId,
    runtimeType: body.runtimeType,
    skillIds: body.skillIds,
  })
  return c.json({ success: true, worker: result })
})

controllerRoutes.delete('/workers/:id', async (c) => {
  const result = await controllerApi.deleteWorker(c.req.param('id'))
  return c.json(result)
})

controllerRoutes.post('/workers/:id/wake', async (c) => {
  await controllerApi.wakeWorker(c.req.param('id'))
  return c.json({ success: true, action: 'wake' })
})

controllerRoutes.post('/workers/:id/stop', async (c) => {
  await controllerApi.stopWorker({ workerInstanceId: c.req.param('id'), reason: 'api-stop' })
  return c.json({ success: true, action: 'stop' })
})

controllerRoutes.post('/workers/:id/sleep', async (c) => {
  await controllerApi.stopWorker({ workerInstanceId: c.req.param('id'), reason: 'api-sleep' })
  return c.json({ success: true, action: 'sleep' })
})

controllerRoutes.post('/workers/:id/reconcile', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const result = await controllerApi.reconcileWorker({
    workerInstanceId: c.req.param('id'),
    workspaceId: body.workspaceId || '',
  })
  return c.json({ success: true, result })
})

controllerRoutes.post('/worker/report-ready', async (c) => {
  const body = await c.req.json()
  const result = await controllerApi.reportWorkerReady(body.workerName || '')
  return c.json({ success: true, ...result })
})

// ─── Task ─────────────────────────────────────────────────────────────

controllerRoutes.post('/tasks', async (c) => {
  const body = await c.req.json()
  const workspaceId = requireP(body, 'workspaceId')
  const title = requireP(body, 'title')

  const [groupSession] = await db.select().from(sessions).where(eq(sessions.workspaceId, workspaceId)).limit(1)
  if (!groupSession) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, 'No session found for workspace')

  const fakeMessage = {
    id: `controller-task-${Date.now()}`,
    sessionId: groupSession.id,
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
  if (body.runId) {
    const ctx = await controllerApi.getRunContext(body.runId)
    if (ctx) runContext = ctx
  }

  const result = await dispatchAssignBatch({
    groupSession,
    ownerId: groupSession.ownerId,
    goal: fakeMessage.content,
    actions: [{
      type: 'assign',
      targetWorkerId: body.assignToAgentId || body['assign-to'] || undefined,
      taskTitle: title,
      taskDescription: body.spec || body.description || title,
      message: body.spec || title,
      reason: 'Controller API: create_task',
    }],
    runtimeType: body.runtimeType || 'code-agent',
    run: runContext,
  })

  return c.json({ success: true, result })
})

controllerRoutes.post('/tasks/:id/complete', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const task = await controllerApi.getTask(c.req.param('id'))
  if (!task) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Task not found')
  if (task.runId) {
    await controllerApi.completeTask({ runId: task.runId, taskId: task.id, title: task.title })
  }
  return c.json({ success: true, id: task.id })
})

controllerRoutes.post('/tasks/:id/fail', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const task = await controllerApi.getTask(c.req.param('id'))
  if (!task) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Task not found')
  if (task.runId) {
    await controllerApi.failTask({ runId: task.runId, taskId: task.id, error: body.error || 'Task failed' })
  }
  return c.json({ success: true, id: task.id })
})

controllerRoutes.post('/tasks/:id/cancel', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const task = await controllerApi.getTask(c.req.param('id'))
  if (!task) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Task not found')
  if (task.runId) {
    await controllerApi.cancelTask({ runId: task.runId, taskId: task.id, reason: body.reason || 'Cancelled' })
  }
  return c.json({ success: true, id: task.id })
})

// ─── Run ──────────────────────────────────────────────────────────────

controllerRoutes.post('/runs', async (c) => {
  const body = await c.req.json()
  const run = await controllerApi.createRun({
    workspaceId: requireP(body, 'workspaceId'),
    goal: requireP(body, 'goal'),
    groupSessionId: body.groupSessionId || '',
  })
  return c.json({ success: true, run })
})

controllerRoutes.get('/runs', async (c) => {
  const workspaceId = requireQ(c, 'workspaceId')
  return c.json({ runs: await controllerApi.listRuns(workspaceId) })
})

controllerRoutes.get('/runs/:id', async (c) => {
  const run = await controllerApi.getRunContext(c.req.param('id'))
  if (!run) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Run not found')
  const tasks = await controllerApi.listTasks(run.runId)
  return c.json({ run, tasks })
})

controllerRoutes.post('/runs/:id/cancel', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  await controllerApi.cancelRun({
    runId: c.req.param('id'),
    reason: body.reason || 'Cancelled by manager',
  })
  return c.json({ success: true })
})

// ─── Team ─────────────────────────────────────────────────────────────

controllerRoutes.post('/teams', async (c) => {
  const body = await c.req.json()
  const result = await controllerApi.createTeam({
    workspaceId: requireP(body, 'workspaceId'),
    name: requireP(body, 'name'),
    leaderName: body.leaderName,
    leaderModel: body.leaderModel,
    workers: body.workers,
    description: body.description,
  })
  return c.json({ success: true, team: result })
})

controllerRoutes.get('/teams', async (c) => {
  const workspaceId = requireQ(c, 'workspaceId')
  return c.json({ teams: await controllerApi.listTeams(workspaceId) })
})

controllerRoutes.get('/teams/:name', async (c) => {
  const workspaceId = c.req.query('workspaceId') || ''
  const team = await controllerApi.getTeam(workspaceId, c.req.param('name'))
  if (!team) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Team not found')
  return c.json({ team })
})

controllerRoutes.patch('/teams/:name', async (c) => {
  // Update team — for now just return success
  return c.json({ success: true, name: c.req.param('name') })
})

controllerRoutes.delete('/teams/:name', async (c) => {
  const workspaceId = c.req.query('workspaceId') || ''
  const result = await controllerApi.deleteTeam(workspaceId, c.req.param('name'))
  return c.json(result)
})

// ─── Human ────────────────────────────────────────────────────────────

controllerRoutes.post('/humans', async (c) => {
  const body = await c.req.json()
  const result = await controllerApi.createHuman({
    name: requireP(body, 'name'),
    displayName: body.displayName || body['display-name'] || body.name,
    email: body.email,
    permissionLevel: body.permissionLevel,
  })
  return c.json({ success: true, human: result })
})

controllerRoutes.get('/humans', async (c) => {
  return c.json({ humans: await controllerApi.listHumans() })
})

controllerRoutes.delete('/humans/:name', async (c) => {
  const result = await controllerApi.deleteHuman(c.req.param('name'))
  return c.json(result)
})

// ─── Apply ────────────────────────────────────────────────────────────

controllerRoutes.post('/apply', async (c) => {
  return c.json({ success: false, message: 'YAML apply not yet implemented. Use inline JSON.' })
})

// ─── Platform Status ──────────────────────────────────────────────────

controllerRoutes.get('/status', async (c) => {
  return c.json(await controllerApi.getPlatformStatus())
})

controllerRoutes.get('/workspace-state', async (c) => {
  const workspaceId = requireQ(c, 'workspaceId')
  return c.json(await controllerApi.getWorkspaceState(workspaceId))
})

controllerRoutes.post('/heartbeat', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  logger.info({ workspaceId: body.workspaceId }, 'Manager heartbeat received')
  return c.json({ success: true, action: 'heartbeat', timestamp: new Date().toISOString() })
})

// ─── Helpers ──────────────────────────────────────────────────────────

function requireP(body: Record<string, unknown>, key: string): string {
  const val = body[key]
  if (!val || typeof val !== 'string') {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `Missing required param: ${key}`)
  }
  return val
}

function requireQ(c: Context, key: string): string {
  const val = c.req.query(key)
  if (!val) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, `${key} is required`)
  return val
}
