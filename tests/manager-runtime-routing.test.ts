import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const managerRuntimeApi = await import('../apps/server/src/services/manager-runtime')

const {
  db,
  roomParticipants,
  timelineEvents,
  workerInstances,
  workspaceAgents,
  workspaces,
  eq,
} = dbApi
const { roomService } = roomsApi
const { ManagerRuntimeService } = managerRuntimeApi
const { ensureGroupSession } = await import('../apps/server/src/services/workspace/session-manager')
type ManagerRuntime = managerRuntimeApi.ManagerRuntime
type ManagerRuntimeEvent = managerRuntimeApi.ManagerRuntimeEvent
type ManagerStepInput = managerRuntimeApi.ManagerStepInput
type ManagerStepResult = managerRuntimeApi.ManagerStepResult

describe('ManagerRuntime primary room routing', () => {
  test('ManagerRuntimeService persists runtime events to room timeline', async () => {
    const room = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Manager Runtime Room',
      metadata: { goal: 'Natural team conversation' },
    })
    const human = await roomService.addParticipant({
      roomId: room.id,
      participantType: 'human',
      userId: 'default-user',
      displayName: 'You',
      role: 'owner',
    })
    await roomService.addParticipant({
      roomId: room.id,
      participantType: 'manager',
      displayName: 'Manager',
      role: 'manager',
    })
    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderParticipantId: human.id,
      senderType: 'human',
      type: 'human.message',
      body: '大家好，看到的人打个招呼',
    })

    const fakeRuntime = new FakeManagerRuntime([
      { type: 'thinking', content: '我先判断这是普通群聊，不创建任务。' },
      {
        type: 'tool_call',
        call: { id: 'call_1', name: 'controller.workers.list', arguments: {} },
      },
      {
        type: 'tool_result',
        result: {
          callId: 'call_1',
          toolName: 'controller.workers.list',
          success: true,
          output: 'No workers found.',
        },
      },
    ])
    const service = new ManagerRuntimeService(fakeRuntime)

    const result = await service.stepRoom({
      roomId: room.id,
      ownerId: 'default-user',
      source: 'test',
    })

    expect(fakeRuntime.lastInput?.context.ownerId).toBe('default-user')
    expect(result.runtimeType).toBe('openclaw')
    expect(result.actions[0]?.type).toBe('reply')
    expect(result.actions[0]?.message).toBe('我在，已看到你的消息。')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const kinds = events.map((event) => event.metadata?.kind)
    expect(kinds).toContain('manager-runtime.thinking')
    expect(kinds).toContain('manager-runtime.tool_call')
    expect(kinds).toContain('manager-runtime.tool_result')
    expect(kinds).toContain('manager-runtime.completed')
    expect(kinds).toContain('manager.action')
    expect(events.at(-1)?.type).toBe('manager.message')
    expect(events.at(-1)?.metadata?.managerRuntimeType).toBe('openclaw')
  })

  test('ManagerRuntime unsupported actions are visible but not converted', async () => {
    const room = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Unsupported Action Room',
    })
    const fakeRuntime = new FakeManagerRuntime([], {
      runtimeType: 'openclaw',
      actions: [{ type: 'request_approval', message: '需要人工确认。' }],
    })
    const service = new ManagerRuntimeService(fakeRuntime)

    const result = await service.stepRoom({
      roomId: room.id,
      ownerId: 'default-user',
      source: 'test',
    })

    expect(result.actions).toHaveLength(0)
    expect(result.rawActions[0]?.type).toBe('request_approval')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.map((event) => event.metadata?.kind)).toEqual([
      'manager-runtime.completed',
      'manager-runtime.unsupported-action',
    ])
  })

  test('ManagerRuntime create_worker action applies Member Reconcile and joins the current group room', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Manager Create Worker Workspace',
        goal: 'Validate Manager create_worker action',
      })
      .returning()
    const session = await ensureGroupSession(workspace!.id, 'default-user')
    const room = await roomService.ensureRoomForSession(session.id, 'default-user')

    const fakeRuntime = new FakeManagerRuntime([], {
      runtimeType: 'openclaw',
      actions: [{
        type: 'create_worker',
        message: '创建一位执行工程师',
        reason: '当前任务需要执行能力',
        metadata: {
          name: '执行工程师',
          role: '代码执行',
          reason: '当前任务需要执行能力',
          workerRuntimeBase: 'opencode',
          codeAgentType: 'opencode',
          modelId: 'test-model',
          skillIds: ['task-management'],
        },
      }],
      rawOutput: '{"actions":[{"type":"create_worker"}]}',
    })
    const service = new ManagerRuntimeService(fakeRuntime)

    const result = await service.stepRoom({
      roomId: room.id,
      ownerId: 'default-user',
      source: 'test-create-worker',
    })

    expect(result.actions[0]?.type).toBe('create_worker')

    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.name, '执行工程师'))
      .limit(1)
    expect(agent?.workspaceId).toBe(workspace!.id)
    expect(agent?.codeAgentType).toBe('opencode')
    expect(agent?.roleProfile?.workerRuntimeBase).toBe('opencode')

    const [worker] = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.workspaceAgentId, agent!.id))
      .limit(1)
    expect(worker?.runtimeBase).toBe('opencode')

    const participants = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.roomId, room.id))
    expect(participants.some((participant) => participant.workerInstanceId === worker!.id)).toBe(true)

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.some((event) => event.metadata?.kind === 'member-reconcile.announced')).toBe(true)
    const applied = events.find((event) => event.metadata?.kind === 'manager.action.create_worker.applied')
    expect(applied?.metadata?.workerInstanceId).toBe(worker!.id)
    expect(applied?.metadata?.stages).toBeArray()
  })
})

class FakeManagerRuntime implements ManagerRuntime {
  readonly runtimeType = 'openclaw' as const
  lastInput: ManagerStepInput | null = null

  constructor(
    private readonly events: ManagerRuntimeEvent[],
    private readonly result: ManagerStepResult = {
      runtimeType: 'openclaw',
      actions: [{ type: 'reply', message: '我在，已看到你的消息。' }],
      rawOutput: '{"actions":[{"type":"reply","message":"我在，已看到你的消息。"}]}',
    },
  ) {}

  async *step(input: ManagerStepInput): AsyncGenerator<ManagerRuntimeEvent, ManagerStepResult> {
    this.lastInput = input
    for (const event of this.events) {
      yield event
    }
    yield { type: 'completed', actions: this.result.actions }
    return this.result
  }
}
