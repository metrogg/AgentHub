import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const roomLastMessageApi = await import('../apps/server/src/services/rooms/room-last-message')

const { db, eq, rooms, sessions } = dbApi
const { roomService } = roomsApi
const { listRoomLastMessagePreviews } = roomLastMessageApi

describe('mobile Room-first projection', () => {
  test('bumps session updatedAt when a room timeline event is appended', async () => {
    const oldDate = new Date('2026-01-01T00:00:00.000Z')
    const [session] = await db
      .insert(sessions)
      .values({
        title: 'Mobile updatedAt projection',
        type: 'direct',
        ownerId: 'default-user',
        createdAt: oldDate,
        updatedAt: oldDate,
      })
      .returning()
    const room = await roomService.ensureRoomForSession(session!.id, 'default-user')

    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'human',
      type: 'human.message',
      body: '手机端应该看到会话置顶',
      metadata: { skipAutoDispatch: true },
    })

    const [updated] = await db.select().from(sessions).where(eq(sessions.id, session!.id)).limit(1)
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(oldDate.getTime())
  })

  test('last message preview falls back past hidden runtime status events', async () => {
    const [session] = await db
      .insert(sessions)
      .values({
        title: 'Mobile preview fallback',
        type: 'direct',
        ownerId: 'default-user',
      })
      .returning()
    const room = await roomService.ensureRoomForSession(session!.id, 'default-user')

    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'worker',
      type: 'worker.message',
      body: '这是手机端应显示的最后消息',
      metadata: { kind: 'worker-runtime.completed', skipAutoDispatch: true },
    })
    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'manager',
      type: 'manager.message',
      body: 'Manager 已收到，正在处理...',
      metadata: {
        kind: 'manager.status.pending',
        hiddenFromChat: true,
        skipAutoDispatch: true,
      },
    })

    const previews = await listRoomLastMessagePreviews([session!.id])
    expect(previews[session!.id]).toEqual({
      content: '这是手机端应显示的最后消息',
      senderType: 'agent',
    })
  })

  test('last message preview falls back past internal worker progress events', async () => {
    const [session] = await db
      .insert(sessions)
      .values({
        title: 'Mobile preview worker progress fallback',
        type: 'direct',
        ownerId: 'default-user',
      })
      .returning()
    const room = await roomService.ensureRoomForSession(session!.id, 'default-user')

    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'worker',
      type: 'worker.message',
      body: '最终结果',
      metadata: { kind: 'worker-runtime.completed', skipAutoDispatch: true },
    })
    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'worker',
      type: 'task.progress',
      body: '已接单，准备执行任务。',
      metadata: { kind: 'worker-runtime.claimed', skipAutoDispatch: true },
    })

    const previews = await listRoomLastMessagePreviews([session!.id])
    expect(previews[session!.id]?.content).toBe('最终结果')
  })
})
