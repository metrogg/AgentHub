import './setup'
import { describe, expect, test } from 'bun:test'

const { app } = await import('../apps/server/src/app')
const dbApi = await import('../packages/db/src/index')
const {
  db,
  eq,
  matrixIdentities,
  timelineEvents,
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
})

async function createManagerToken() {
  const token = `manager-token-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await db.insert(matrixIdentities).values({
    ownerType: 'manager',
    ownerId: 'manager-http-test',
    serverName: 'agenthub.local',
    localpart: 'manager-http-test',
    userId: '@manager-http-test:agenthub.local',
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
