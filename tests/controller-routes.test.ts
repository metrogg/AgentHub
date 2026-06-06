import './setup'
import { describe, expect, test } from 'bun:test'

const { app } = await import('../apps/server/src/app')
const dbApi = await import('../packages/db/src/index')
const {
  controllerAuditEvents,
  db,
  eq,
  matrixIdentities,
  roomParticipants,
  rooms,
  taskThreads,
  timelineEvents,
  workspaceAgents,
  workspaceTasks,
  workspaces,
} = dbApi

describe('Controller HTTP API', () => {
  test('requires a Manager Matrix token', async () => {
    const response = await app.request('/api/controller/status')
    expect(response.status).toBe(401)
  })

  test('exposes Room and Reconcile resources for Manager skills', async () => {
    const token = await createManagerToken()
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller HTTP Workspace',
        goal: 'Validate Controller HTTP surface',
      })
      .returning()

    const created = await controllerJson<{
      success: boolean
      room: { id: string; workspaceId: string; title: string }
    }>('/api/controller/rooms', token, {
      method: 'POST',
      body: {
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        title: 'Controller API Room',
        kind: 'group',
      },
    })

    expect(created.success).toBe(true)
    expect(created.room.workspaceId).toBe(workspace!.id)

    const eventResult = await controllerJson<{
      success: boolean
      event: { id: string; roomId: string; body: string }
    }>(`/api/controller/rooms/${created.room.id}/events`, token, {
      method: 'POST',
      body: {
        body: 'Controller API wrote a Manager room event.',
        metadata: { kind: 'controller-http.test' },
      },
    })

    expect(eventResult.success).toBe(true)
    expect(eventResult.event.roomId).toBe(created.room.id)

    const [event] = await db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.id, eventResult.event.id))
      .limit(1)
    expect(event?.metadata?.kind).toBe('controller-http.test')

    const events = await controllerJson<{ items: Array<{ id: string }> }>(
      `/api/controller/rooms/${created.room.id}/events?limit=10`,
      token,
    )
    expect(events.items.some((item) => item.id === eventResult.event.id)).toBe(true)

    const listed = await controllerJson<{ rooms: Array<{ id: string }> }>(
      `/api/controller/rooms?workspaceId=${encodeURIComponent(workspace!.id)}`,
      token,
    )
    expect(listed.rooms.some((room) => room.id === created.room.id)).toBe(true)

    const reconcile = await controllerJson<{
      success: boolean
      result: { phase: string; ref: { kind: string; id: string } }
    }>('/api/controller/reconcile', token, {
      method: 'POST',
      body: {
        kind: 'Room',
        id: created.room.id,
        workspaceId: workspace!.id,
        reason: 'controller-http-test',
      },
    })

    expect(reconcile.success).toBe(true)
    expect(reconcile.result.ref).toMatchObject({ kind: 'Room', id: created.room.id })
    expect(reconcile.result.phase).toBe('observed')
  })

  test('exposes Controller API schema for Manager skills', async () => {
    const token = await createManagerToken()
    const schema = await controllerJson<{
      schema: string
      auth: { type: string }
      invariants: string[]
      operations: Array<{
        id: string
        method: string
        path: string
        danger: string
        approval: string
        query?: Record<string, { required?: boolean; enum?: string[]; description: string }>
        body?: Record<string, { required?: boolean; enum?: string[]; description: string }>
      }>
    }>('/api/controller/schema', token)

    expect(schema.schema).toBe('agenthub.controller-api.v1alpha1')
    expect(schema.auth.type).toBe('manager-matrix-token')
    expect(schema.invariants.some((item) => item.includes('/api/controller/*'))).toBe(true)

    const workerCreate = schema.operations.find((item) => item.id === 'workers.create')
    expect(workerCreate?.method).toBe('POST')
    expect(workerCreate?.path).toBe('/api/controller/workers')
    expect(workerCreate?.body?.runtimeBase.required).toBe(true)
    expect(workerCreate?.body?.runtimeBase.enum).toContain('qwenpaw')
    expect(workerCreate?.body?.runtimeBase.enum).toContain('copaw')

    const taskAssign = schema.operations.find((item) => item.id === 'tasks.assign')
    expect(taskAssign?.path).toBe('/api/controller/tasks')
    expect(taskAssign?.body?.workspaceId.required).toBe(true)

    const mention = schema.operations.find((item) => item.id === 'rooms.mention_worker')
    expect(mention?.path).toBe('/api/controller/rooms/{roomId}/mentions')
    expect(mention?.danger).toBe('write')

    const apply = schema.operations.find((item) => item.id === 'apply.manifest')
    expect(apply?.path).toBe('/api/controller/apply')
    expect(apply?.body?.yaml.required).toBe(false)
    expect(apply?.body?.yaml.description).toContain('Manager, Worker, Room, Task, Team, Human')

    const teamCreate = schema.operations.find((item) => item.id === 'teams.create')
    expect(teamCreate?.path).toBe('/api/controller/teams')
    expect(teamCreate?.body?.workers?.enum).toBeUndefined()

    const humanCreate = schema.operations.find((item) => item.id === 'humans.create')
    expect(humanCreate?.path).toBe('/api/controller/humans')
    expect(humanCreate?.body?.permissionLevel?.description).toContain('permission level')

    const managerReconcile = schema.operations.find((item) => item.id === 'managers.reconcile')
    expect(managerReconcile?.path).toBe('/api/controller/reconcile')
    expect(managerReconcile?.body?.kind?.enum).toContain('Manager')
    expect(managerReconcile?.body?.payload?.description).toContain('desiredState=running|stopped|observed')

    const auditList = schema.operations.find((item) => item.id === 'audit.list')
    expect(auditList?.method).toBe('GET')
    expect(auditList?.path).toBe('/api/controller/audit-events')
    expect(auditList?.query?.workspaceId?.description).toContain('workspace id')
  })

  test('applies YAML Controller manifests through HTTP API', async () => {
    const token = await createManagerToken()
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Apply Workspace',
        goal: 'Validate YAML apply',
      })
      .returning()

    const applied = await controllerJson<{
      success: boolean
      applied: Array<{
        kind: string
        name: string | null
        approval: { level: string; required: boolean; provided: boolean }
        auditEventId: string | null
        audit: {
          operationId: string
          applyOperationId: string
          danger: string
          manifestKind: string
          manifestName: string | null
          fields: Record<string, unknown>
        }
        result: { id: string; title: string }
      }>
    }>('/api/controller/apply', token, {
      method: 'POST',
      body: {
        yaml: [
          'apiVersion: agenthub.dev/v1alpha1',
          'kind: Room',
          'metadata:',
          '  name: Applied Room',
          'spec:',
          '  ownerId: default-user',
          '  workspaceId: ' + workspace!.id,
          '  kind: group',
          '  title: Applied Room',
        ].join('\n'),
      },
    })

    expect(applied.success).toBe(true)
    expect(applied.applied[0]?.kind).toBe('Room')
    expect(applied.applied[0]?.name).toBe('Applied Room')
    expect(applied.applied[0]?.approval).toMatchObject({
      level: 'not_required',
      required: false,
      provided: false,
    })
    expect(applied.applied[0]?.auditEventId).toBeTruthy()
    expect(applied.applied[0]?.audit).toMatchObject({
      operationId: 'rooms.create',
      applyOperationId: 'apply.manifest',
      danger: 'write',
      manifestKind: 'Room',
      manifestName: 'Applied Room',
    })
    expect(applied.applied[0]?.audit.fields).toMatchObject({
      ownerId: 'default-user',
      workspaceId: workspace!.id,
      kind: 'group',
      title: 'Applied Room',
    })

    const [auditRow] = await db
      .select()
      .from(controllerAuditEvents)
      .where(eq(controllerAuditEvents.id, applied.applied[0]!.auditEventId!))
      .limit(1)
    expect(auditRow).toMatchObject({
      operationId: 'rooms.create',
      applyOperationId: 'apply.manifest',
      danger: 'write',
      approvalLevel: 'not_required',
      manifestKind: 'Room',
      manifestName: 'Applied Room',
      workspaceId: workspace!.id,
      resourceKind: 'Room',
      resourceId: applied.applied[0]!.result.id,
    })
    expect(auditRow?.auditFields).toMatchObject({
      ownerId: 'default-user',
      workspaceId: workspace!.id,
      kind: 'group',
    })

    const auditEvents = await controllerJson<{
      items: Array<{ id: string; operationId: string; workspaceId: string | null; auditFields: Record<string, unknown> }>
    }>(
      `/api/controller/audit-events?workspaceId=${encodeURIComponent(workspace!.id)}&operationId=rooms.create&limit=5`,
      token,
    )
    expect(auditEvents.items.some((item) => item.id === applied.applied[0]!.auditEventId)).toBe(true)
    expect(auditEvents.items[0]?.operationId).toBe('rooms.create')

    const [room] = await db
      .select()
      .from(rooms)
      .where(eq(rooms.id, applied.applied[0]!.result.id))
      .limit(1)
    expect(room?.title).toBe('Applied Room')
    expect(room?.workspaceId).toBe(workspace!.id)
  })

  test('assigns tasks through ControllerApi and writes Matrix mention-first task rooms', async () => {
    const token = await createManagerToken()
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Task Workspace',
        goal: 'Validate Controller task assignment',
      })
      .returning()
    const [workerAgent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'OpenCode Engineer',
        role: 'Implementation Worker',
        roleType: 'coder',
        description: 'Implements assigned tasks from Matrix rooms.',
        systemPrompt: 'Read SOUL.md, AGENTS.md, and the shared task contract before acting.',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        modelId: 'test-model',
        roleProfile: { workerRuntimeBase: 'opencode' },
        skillIds: ['task-management'],
      })
      .returning()

    const assigned = await controllerJson<{
      success: boolean
      result: {
        runId: string
        tasks: Array<{
          taskId: string
          taskThreadId: string
          taskRoomId: string
          childSessionId: string
          workerInstanceId: string | null
        }>
      }
    }>('/api/controller/tasks', token, {
      method: 'POST',
      body: {
        workspaceId: workspace!.id,
        title: 'Write task result contract',
        spec: 'Create result.md and report progress in the task room.',
        assignToAgentId: workerAgent!.id,
      },
    })

    expect(assigned.success).toBe(true)
    expect(assigned.result.runId).toBeString()
    expect(assigned.result.tasks).toHaveLength(1)
    const taskResult = assigned.result.tasks[0]!
    expect(taskResult.workerInstanceId).toBeString()

    const [task] = await db
      .select()
      .from(workspaceTasks)
      .where(eq(workspaceTasks.id, taskResult.taskId))
      .limit(1)
    expect(task?.workspaceId).toBe(workspace!.id)
    expect(task?.agentId).toBe(workerAgent!.id)
    expect(task?.runId).toBe(assigned.result.runId)
    expect(task?.progressStatus).toBe('thread-assigned')

    const [thread] = await db
      .select()
      .from(taskThreads)
      .where(eq(taskThreads.id, taskResult.taskThreadId))
      .limit(1)
    expect(thread?.workspaceAgentId).toBe(workerAgent!.id)
    expect(thread?.workerInstanceId).toBe(taskResult.workerInstanceId)
    expect(thread?.status).toBe('assigned')

    const [taskRoom] = await db
      .select()
      .from(rooms)
      .where(eq(rooms.id, taskResult.taskRoomId))
      .limit(1)
    expect(taskRoom?.kind).toBe('task')
    expect(taskRoom?.taskThreadId).toBe(taskResult.taskThreadId)

    const participants = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.roomId, taskResult.taskRoomId))
      .limit(10)
    const workerParticipant = participants.find((item) => item.workspaceAgentId === workerAgent!.id)
    expect(workerParticipant?.participantType).toBe('worker')

    const taskRoomEvents = await db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.roomId, taskResult.taskRoomId))
    const mention = taskRoomEvents.find(
      (event) =>
        event.type === 'task.assigned' &&
        event.metadata?.matrixExecutionBus === true &&
        event.metadata?.coordinationSource === 'matrix-mention',
    )
    expect(mention?.metadata?.mentionParticipantId).toBe(workerParticipant?.id)
    expect(mention?.metadata?.targetWorkerId).toBe(workerAgent!.id)
  })
})

async function createManagerToken() {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const token = `manager-token-${suffix}`
  const localpart = `manager-http-test-${suffix}`
  await db.insert(matrixIdentities).values({
    ownerType: 'manager',
    ownerId: localpart,
    serverName: 'agenthub.local',
    localpart,
    userId: `@${localpart}:agenthub.local`,
    accessToken: token,
    displayName: 'HTTP Test Manager',
  })
  return token
}

async function controllerJson<T>(
  path: string,
  token: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<T> {
  const response = await app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const body = await response.json()
  expect(response.status).toBeGreaterThanOrEqual(200)
  expect(response.status).toBeLessThan(300)
  return body as T
}
