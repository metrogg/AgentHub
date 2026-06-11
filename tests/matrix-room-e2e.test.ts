import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')

const {
  db,
  matrixIdentities,
  roomParticipants,
  sessions,
  timelineEvents,
  workspaceAgents,
  workspaces,
  eq,
} = dbApi
const { MatrixRoomAdapter, RoomService } = roomsApi

describe('Matrix room adapter e2e contract', () => {
  test('creates a real Matrix-backed group room, joins identities, sends @mention, and records audit metadata', async () => {
    const matrix = createFakeMatrixHomeserver()
    try {
      const service = new RoomService(new MatrixRoomAdapter({
        homeserverUrl: matrix.url,
        serverName: 'matrix.e2e',
        autoInviteParticipants: true,
        autoJoinParticipants: true,
      }))
      const [workspace] = await db
        .insert(workspaces)
        .values({
          ownerId: 'default-user',
          name: 'Matrix E2E Workspace',
          goal: 'Verify real Matrix room adapter contract',
        })
        .returning()
      const [agent] = await db
        .insert(workspaceAgents)
        .values({
          workspaceId: workspace!.id,
          name: 'Matrix Worker',
          role: 'Respond in Matrix task rooms',
          roleType: 'builder',
          runtimeType: 'code-agent',
          codeAgentType: 'opencode',
        })
        .returning()
      const [session] = await db
        .insert(sessions)
        .values({
          ownerId: 'default-user',
          title: 'Matrix E2E Group',
          type: 'group',
          workspaceId: workspace!.id,
          metadata: { kind: 'workspace-agent-group' },
        })
        .returning()

      const room = await service.ensureRoomForSession(session!.id, 'default-user')
      const worker = await service.addWorkerParticipant(room.id, agent!.id)
      const participants = await service.listRoomParticipants(room.id, 'default-user')
      const manager = participants.find((participant) => participant.participantType === 'manager')!
      const human = participants.find((participant) => participant.participantType === 'human')!

      const humanEvent = await service.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: human.id,
        senderType: 'human',
        type: 'human.message',
        body: '大家好，看到的人打个招呼',
        metadata: { kind: 'chat.message' },
      })
      const mentionEvent = await service.appendMentionTimelineEvent({
        roomId: room.id,
        senderParticipantId: manager.id,
        senderType: 'manager',
        type: 'task.assigned',
        body: 'Matrix Worker，请确认你已收到任务。',
        mentionParticipantId: worker.id,
        metadata: { kind: 'matrix-e2e.assignment' },
      })

      expect(room.provider).toBe('matrix')
      expect(room.providerRoomId).toBe('!room-1:matrix.e2e')
      expect(worker.providerUserId).toMatch(/^@worker-/)
      expect(worker.metadata?.matrixMembership).toMatchObject({
        provider: 'matrix',
        providerRoomId: room.providerRoomId,
        invited: true,
        joined: true,
        joinedWithParticipantToken: true,
      })
      expect(humanEvent.providerEventId).toBe('$event-1')
      expect(mentionEvent.providerEventId).toBe('$event-2')

      const identities = await db.select().from(matrixIdentities)
      expect(new Set(identities.map((identity) => identity.ownerType))).toEqual(new Set(['human', 'manager', 'worker']))
      const participantRows = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, room.id))
      expect(participantRows.every((participant) => participant.status === 'joined')).toBe(true)
      const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
      expect(events.map((event) => event.sequence).slice(0, 2)).toEqual([1, 2])
      const assignmentEvent = events.find((event) => event.id === mentionEvent.id)
      expect(assignmentEvent?.metadata?.matrix).toMatchObject({
        roomId: room.providerRoomId,
        usedParticipantToken: true,
        mentions: [worker.providerUserId],
      })

      expect(matrix.requests.some((request) => request.method === 'POST' && request.path === '/_matrix/client/v3/createRoom')).toBe(true)
      expect(matrix.requests.filter((request) => request.path === '/_matrix/client/v3/register')).toHaveLength(3)
      expect(matrix.requests.filter((request) => request.path.endsWith('/invite'))).toHaveLength(3)
      expect(matrix.requests.filter((request) => request.path.startsWith('/_matrix/client/v3/join/'))).toHaveLength(5)
      const sentMessages = matrix.requests.filter((request) => request.path.includes('/send/m.room.message/'))
      expect(sentMessages).toHaveLength(2)
      expect(sentMessages[1]?.body?.['m.mentions']).toMatchObject({
        user_ids: [worker.providerUserId],
      })
      expect(sentMessages[1]?.body?.body).toContain('@Matrix Worker')
      expect(sentMessages[1]?.body?.body).not.toContain(worker.providerUserId)
    } finally {
      matrix.stop()
    }
  })
})

function createFakeMatrixHomeserver() {
  const requests: Array<{
    method: string
    path: string
    token: string | null
    body: Record<string, unknown> | null
  }> = []
  let roomCount = 0
  let eventCount = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await readJsonBody(request)
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
      requests.push({ method: request.method, path: url.pathname, token, body })

      if (request.method === 'GET' && url.pathname.startsWith('/_matrix/client/v3/directory/room/')) {
        return json({ errcode: 'M_NOT_FOUND', error: 'alias not found' }, 404)
      }
      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/createRoom') {
        roomCount += 1
        return json({ room_id: `!room-${roomCount}:matrix.e2e` })
      }
      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/register') {
        const username = String(body?.username ?? 'unknown')
        return json({
          user_id: `@${username}:matrix.e2e`,
          access_token: `token-${username}`,
        })
      }
      if (request.method === 'POST' && url.pathname === '/_matrix/client/v3/login') {
        const identifier = body?.identifier as Record<string, unknown> | undefined
        const username = String(identifier?.user ?? 'unknown')
        return json({
          user_id: `@${username}:matrix.e2e`,
          access_token: `token-${username}`,
        })
      }
      if (request.method === 'PUT' && url.pathname.includes('/displayname')) {
        return json({})
      }
      if (request.method === 'POST' && url.pathname.endsWith('/invite')) {
        return json({})
      }
      if (request.method === 'POST' && url.pathname.startsWith('/_matrix/client/v3/join/')) {
        return json({ room_id: decodeURIComponent(url.pathname.split('/').at(-1) ?? '') })
      }
      if (request.method === 'PUT' && url.pathname.includes('/send/m.room.message/')) {
        eventCount += 1
        return json({ event_id: `$event-${eventCount}` })
      }
      return json({ errcode: 'M_UNKNOWN', error: `Unhandled ${request.method} ${url.pathname}` }, 404)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  if (request.method === 'GET' || request.method === 'HEAD') return null
  const text = await request.text()
  if (!text.trim()) return null
  return JSON.parse(text) as Record<string, unknown>
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
