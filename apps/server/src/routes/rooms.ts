import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { roomService } from '../services/rooms'
import { describeMatrixDiagnostics } from '../services/rooms/matrix-diagnostics'
import { loadRoomSessionSnapshot } from '../services/rooms/room-session-snapshot'

const createRoomSchema = z.object({
  kind: z.enum(['group', 'manager_dm', 'task', 'direct', 'human_intervention']),
  title: z.string().min(1).max(200),
  topic: z.string().max(1000).nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  taskThreadId: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const ensureSessionRoomSchema = z.object({
  sessionId: z.string().min(1),
})

const ensureTaskThreadRoomSchema = z.object({
  taskThreadId: z.string().min(1),
})

const addParticipantSchema = z.object({
  participantType: z.enum(['human', 'manager', 'worker', 'system']),
  displayName: z.string().min(1).max(120),
  role: z.enum(['owner', 'manager', 'member', 'observer', 'system']).optional(),
  userId: z.string().nullable().optional(),
  workspaceAgentId: z.string().nullable().optional(),
  workerInstanceId: z.string().nullable().optional(),
  providerUserId: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
})

const appendEventSchema = z.object({
  senderParticipantId: z.string().nullable().optional(),
  senderType: z.enum(['human', 'manager', 'worker', 'system']),
  type: z.enum([
    'human.message',
    'manager.message',
    'worker.message',
    'task.assigned',
    'task.progress',
    'artifact.created',
    'approval.requested',
    'system',
  ]),
  body: z.string().max(100_000).optional(),
  metadata: z.record(z.unknown()).optional(),
  providerEventId: z.string().optional(),
})

export const roomRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const user = c.get('user')
    const workspaceId = c.req.query('workspaceId') ?? null
    return c.json({ items: await roomService.listRooms(user.sub, workspaceId) })
  })
  .post('/', zValidator('json', createRoomSchema), async (c) => {
    const user = c.get('user')
    const input = c.req.valid('json')
    const room = await roomService.createRoom({
      ownerId: user.sub,
      kind: input.kind,
      title: input.title,
      topic: input.topic,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      taskThreadId: input.taskThreadId,
      metadata: input.metadata,
    })
    await roomService.addParticipant({
      roomId: room.id,
      participantType: 'human',
      userId: user.sub,
      displayName: user.username,
      role: 'owner',
    })
    return c.json(room)
  })
  .post('/ensure/session', zValidator('json', ensureSessionRoomSchema), async (c) => {
    const user = c.get('user')
    return c.json(await roomService.ensureRoomForSession(c.req.valid('json').sessionId, user.sub))
  })
  .post('/ensure/task-thread', zValidator('json', ensureTaskThreadRoomSchema), async (c) => {
    const user = c.get('user')
    const input = await roomService.buildTaskThreadRoomInput(c.req.valid('json').taskThreadId, user.sub)
    return c.json(await roomService.ensureRoomForTaskThread(input))
  })
  .get('/matrix/diagnostics', async (c) => {
    return c.json(await describeMatrixDiagnostics())
  })
  .get('/session/:sessionId/snapshot', async (c) => {
    const user = c.get('user')
    const afterSequence = Number(c.req.query('afterSequence') ?? 0)
    const includeLegacy = c.req.query('includeLegacy') === 'true'
    return c.json(
      await loadRoomSessionSnapshot({
        sessionId: c.req.param('sessionId'),
        ownerId: user.sub,
        afterSequence: Number.isFinite(afterSequence) ? afterSequence : 0,
        includeLegacy,
      }),
    )
  })
  .get('/:roomId', async (c) => {
    const user = c.get('user')
    return c.json(await roomService.getRoomForOwner(c.req.param('roomId'), user.sub))
  })
  .get('/:roomId/participants', async (c) => {
    const user = c.get('user')
    return c.json({ items: await roomService.listRoomParticipants(c.req.param('roomId'), user.sub) })
  })
  .post('/:roomId/participants', zValidator('json', addParticipantSchema), async (c) => {
    const user = c.get('user')
    const roomId = c.req.param('roomId')
    await roomService.getRoomForOwner(roomId, user.sub)
    return c.json(await roomService.addParticipant({ roomId, ...c.req.valid('json') }))
  })
  .get('/:roomId/timeline', async (c) => {
    const user = c.get('user')
    const roomId = c.req.param('roomId')
    await roomService.getRoomForOwner(roomId, user.sub)
    const afterSequence = Number(c.req.query('afterSequence') ?? 0)
    const limit = Number(c.req.query('limit') ?? 100)
    return c.json({
      items: await roomService.listTimelineEvents({
        roomId,
        afterSequence: Number.isFinite(afterSequence) ? afterSequence : 0,
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    })
  })
  .post('/:roomId/timeline', zValidator('json', appendEventSchema), async (c) => {
    const user = c.get('user')
    const roomId = c.req.param('roomId')
    await roomService.getRoomForOwner(roomId, user.sub)
    return c.json(await roomService.appendTimelineEvent({ roomId, ...c.req.valid('json') }))
  })
