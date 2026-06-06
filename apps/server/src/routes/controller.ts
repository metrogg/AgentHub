import { Hono, type Context } from 'hono'
import { and, db, eq, matrixIdentities } from '@agenthub/db'
import { AppError, AppErrorCodes } from '../lib/error'
import { logger } from '../lib/logger'
import { controllerApi } from '../services/controller-plane/controller-api'
import { controllerReconcileQueue, resourceRef, type ControllerResourceKind } from '../services/controller-plane'

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
    ownerId: body.ownerId || null,
    groupSessionId: body.groupSessionId || body.sessionId || null,
    joinGroupRoom: Boolean(body.joinGroupRoom),
    createDirectSession: body.createDirectSession !== false,
    announce: body.announce !== false,
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

// ─── Room ────────────────────────────────────────────────────────────

controllerRoutes.post('/rooms', async (c) => {
  const body = await c.req.json()
  const room = await controllerApi.createRoom({
    ownerId: body.ownerId || 'default-user',
    kind: body.kind || 'group',
    title: requireP(body, 'title'),
    workspaceId: body.workspaceId || null,
  })
  return c.json({ success: true, room })
})

controllerRoutes.get('/rooms', async (c) => {
  const workspaceId = c.req.query('workspaceId') || null
  const ownerId = c.req.query('ownerId') || null
  if (!workspaceId && !ownerId) {
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'workspaceId or ownerId is required')
  }
  const rooms = await controllerApi.listRooms({ workspaceId, ownerId })
  return c.json({ rooms })
})

controllerRoutes.get('/rooms/:id', async (c) => {
  const room = await controllerApi.getRoom(c.req.param('id'))
  if (!room) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, 'Room not found')
  const participants = await controllerApi.listRoomParticipants(room.id)
  return c.json({ room, participants })
})

controllerRoutes.post('/rooms/:id/reconcile', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const result = await controllerApi.reconcileRoom({
    roomId: c.req.param('id'),
    sessionId: body.sessionId || null,
    taskThreadId: body.taskThreadId || null,
    ownerId: body.ownerId || 'default-user',
  })
  return c.json({ success: true, result })
})

controllerRoutes.get('/rooms/:id/participants', async (c) => {
  const participants = await controllerApi.listRoomParticipants(c.req.param('id'))
  return c.json({ participants })
})

controllerRoutes.get('/rooms/:id/events', async (c) => {
  const afterSequence = Number(c.req.query('afterSequence') ?? 0)
  const limit = Number(c.req.query('limit') ?? 100)
  const items = await controllerApi.listRoomEvents({
    roomId: c.req.param('id'),
    afterSequence: Number.isFinite(afterSequence) ? afterSequence : 0,
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 100,
  })
  return c.json({ items })
})

controllerRoutes.post('/rooms/:id/participants/workers', async (c) => {
  const body = await c.req.json()
  const participant = await controllerApi.addWorkerParticipant({
    roomId: c.req.param('id'),
    workspaceAgentId: requireP(body, 'workspaceAgentId'),
    workerInstanceId: body.workerInstanceId || null,
  })
  return c.json({ success: true, participant })
})

controllerRoutes.post('/rooms/:id/events', async (c) => {
  const body = await c.req.json()
  const event = await controllerApi.appendRoomEvent({
    roomId: c.req.param('id'),
    senderType: body.senderType || 'manager',
    type: body.type || 'manager.message',
    body: requireP(body, 'body'),
    metadata: objectPayload(body.metadata),
  })
  return c.json({ success: true, event })
})

controllerRoutes.post('/rooms/:id/mentions', async (c) => {
  const body = await c.req.json()
  const event = await controllerApi.mentionRoomParticipant({
    roomId: c.req.param('id'),
    workspaceAgentId: requireP(body, 'workspaceAgentId'),
    body: requireP(body, 'body'),
    ownerId: body.ownerId || 'default-user',
    senderType: body.senderType || 'manager',
    type: body.type || 'task.assigned',
  })
  return c.json({ success: true, event })
})

// ─── Task ─────────────────────────────────────────────────────────────

controllerRoutes.post('/tasks', async (c) => {
  const body = await c.req.json()
  const result = await controllerApi.assignTask({
    workspaceId: requireP(body, 'workspaceId'),
    title: requireP(body, 'title'),
    description: body.description || null,
    spec: body.spec || null,
    message: body.message || null,
    goal: body.goal || null,
    targetWorkerId: body.targetWorkerId || body.assignToAgentId || body['assign-to'] || null,
    taskKey: body.taskKey || null,
    dependsOn: Array.isArray(body.dependsOn) ? body.dependsOn : undefined,
    runId: body.runId || null,
    groupSessionId: body.groupSessionId || body.sessionId || null,
    ownerId: body.ownerId || null,
    runtimeType: body.runtimeType || 'code-agent',
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

// ─── RuntimeLease / Artifact ──────────────────────────────────────────

controllerRoutes.post('/runtime-leases/reconcile', async (c) => {
  const body = await c.req.json()
  const snapshot = await controllerApi.reconcileRuntimeLeases(requireP(body, 'workspaceId'))
  return c.json({ success: true, snapshot })
})

controllerRoutes.get('/artifacts', async (c) => {
  const runId = c.req.query('runId') || null
  const taskId = c.req.query('taskId') || null
  if (!runId && !taskId) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'runId or taskId is required')
  const artifacts = await controllerApi.listArtifacts({ runId, taskId })
  return c.json({ artifacts })
})

controllerRoutes.post('/artifacts', async (c) => {
  const body = await c.req.json()
  const result = await controllerApi.registerArtifacts({
    workspaceId: requireP(body, 'workspaceId'),
    runId: requireP(body, 'runId'),
    taskId: requireP(body, 'taskId'),
    artifacts: Array.isArray(body.artifacts) ? body.artifacts : [objectPayload(body.artifact)],
    roomId: body.roomId || null,
    taskThreadId: body.taskThreadId || null,
    workspaceAgentId: body.workspaceAgentId || null,
    workerInstanceId: body.workerInstanceId || null,
    groupSessionId: body.groupSessionId || null,
  })
  return c.json({ success: true, result })
})

// ─── Reconcile ────────────────────────────────────────────────────────

controllerRoutes.post('/reconcile', async (c) => {
  const body = await c.req.json()
  const kind = requireControllerKind(body.kind)
  const id = requireP(body, 'id')
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null
  const request = {
    ref: resourceRef(kind, id, workspaceId),
    reason: typeof body.reason === 'string' && body.reason ? body.reason : 'controller-api',
    requestedAt: new Date().toISOString(),
    payload: objectPayload(body.payload),
  }
  if (body.enqueue === true) {
    controllerReconcileQueue.enqueue(request)
    return c.json({ success: true, enqueued: true, queue: controllerReconcileQueue.describe(), request })
  }
  const result = await controllerApi.handleReconcileRequest(request)
  return c.json({ success: !result.error, result })
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

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requireControllerKind(value: unknown): ControllerResourceKind {
  const allowed: ControllerResourceKind[] = [
    'Manager',
    'Worker',
    'Team',
    'Human',
    'Room',
    'Run',
    'Task',
    'TaskThread',
    'RuntimeLease',
    'Artifact',
  ]
  if (typeof value === 'string' && allowed.includes(value as ControllerResourceKind)) {
    return value as ControllerResourceKind
  }
  throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Invalid controller resource kind')
}
