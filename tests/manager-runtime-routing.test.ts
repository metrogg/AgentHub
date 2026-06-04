import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const coordinatorApi = await import('../apps/server/src/services/coordinator-runtime')
const managerRuntimeApi = await import('../apps/server/src/services/manager-runtime')

const {
  db,
  timelineEvents,
  eq,
} = dbApi
const { roomService } = roomsApi
const { CoordinatorService } = coordinatorApi
const { ManagerRuntimeService } = managerRuntimeApi
type ManagerRuntime = managerRuntimeApi.ManagerRuntime
type ManagerRuntimeEvent = managerRuntimeApi.ManagerRuntimeEvent
type ManagerStepInput = managerRuntimeApi.ManagerStepInput
type ManagerStepResult = managerRuntimeApi.ManagerStepResult

describe('ManagerRuntime primary room routing', () => {
  test('CoordinatorService defaults to ManagerRuntime and persists runtime events', async () => {
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
    const service = new CoordinatorService(undefined, {
      managerService: new ManagerRuntimeService(fakeRuntime),
      useManagerRuntimeByDefault: true,
    })

    const result = await service.stepRoom({ roomId: room.id, ownerId: 'default-user' })

    expect(fakeRuntime.lastInput?.context.ownerId).toBe('default-user')
    expect(result.runtimeType).toBe('local-skill-runtime')
    expect(result.actions[0]?.type).toBe('reply')
    expect(result.actions[0]?.message).toBe('我在，已看到你的消息。')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.map((event) => event.metadata?.kind)).toEqual([
      undefined,
      'manager-runtime.thinking',
      'manager-runtime.tool_call',
      'manager-runtime.tool_result',
      'manager-runtime.completed',
      'coordinator.action',
    ])
    expect(events.at(-1)?.type).toBe('manager.message')
    expect(events.at(-1)?.metadata?.managerRuntimeType).toBe('local-skill-runtime')
  })

  test('ManagerRuntime unsupported actions are visible but not converted', async () => {
    const room = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Unsupported Action Room',
    })
    const fakeRuntime = new FakeManagerRuntime([], {
      runtimeType: 'local-skill-runtime',
      actions: [{ type: 'create_worker', message: '需要创建新 Worker。' }],
      toolCalls: [],
      toolResults: [],
      iterations: 1,
    })
    const service = new ManagerRuntimeService(fakeRuntime)

    const result = await service.stepRoom({
      roomId: room.id,
      ownerId: 'default-user',
      source: 'test',
    })

    expect(result.actions).toHaveLength(0)
    expect(result.rawActions[0]?.type).toBe('create_worker')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.map((event) => event.metadata?.kind)).toEqual([
      'manager-runtime.completed',
      'manager-runtime.unsupported-action',
    ])
  })
})

class FakeManagerRuntime implements ManagerRuntime {
  readonly runtimeType = 'local-skill-runtime' as const
  lastInput: ManagerStepInput | null = null

  constructor(
    private readonly events: ManagerRuntimeEvent[],
    private readonly result: ManagerStepResult = {
      runtimeType: 'local-skill-runtime',
      actions: [{ type: 'reply', message: '我在，已看到你的消息。' }],
      toolCalls: [],
      toolResults: [],
      iterations: 1,
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
