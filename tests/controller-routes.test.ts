import './setup'
import { describe, expect, test } from 'bun:test'

const { app } = await import('../apps/server/src/app')
const dbApi = await import('../packages/db/src/index')
const {
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
