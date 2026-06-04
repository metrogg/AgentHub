import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const managerRuntimeApi = await import('../apps/server/src/services/manager-runtime')

const {
  db,
  roomParticipants,
  timelineEvents,
  workspaceAgents,
  workspaces,
  eq,
} = dbApi
const { roomService } = roomsApi
const { ManagerRuntimeService } = managerRuntimeApi
type ManagerRuntime = managerRuntimeApi.ManagerRuntime
type ManagerRuntimeEvent = managerRuntimeApi.ManagerRuntimeEvent
type ManagerStepInput = managerRuntimeApi.ManagerStepInput
type ManagerStepResult = managerRuntimeApi.ManagerStepResult

describe('ManagerRuntime Room timeline integration', () => {
  test('observes ordinary room chat and appends a manager reply event', async () => {
    const room = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Manager Test Room',
      metadata: { goal: 'Keep conversation natural' },
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

    const service = new ManagerRuntimeService(new FakeManagerRuntime('reply'))
    const result = await service.stepRoom({ roomId: room.id, ownerId: 'default-user', source: 'test' })

    expect(result.actions[0]?.type).toBe('reply')
    expect(result.appendedEventIds.length).toBeGreaterThan(0)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.some((event) => event.type === 'manager.message')).toBe(true)
  })

  test('writes assign actions as task.assigned events with a real worker participant', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Manager Workspace',
        goal: 'Research and build reports',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Researcher',
        role: 'Market researcher',
        roleType: 'researcher',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        capabilityTags: ['research', 'report'],
      })
      .returning()
    const room = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Manager Assignment Room',
      workspaceId: workspace!.id,
      metadata: { goal: workspace!.goal },
    })
    await roomService.addParticipant({
      roomId: room.id,
      participantType: 'manager',
      displayName: 'Manager',
      role: 'manager',
    })
    await roomService.addWorkerParticipant(room.id, agent!.id)

    const service = new ManagerRuntimeService(new FakeManagerRuntime('assign', agent!.id))
    const result = await service.stepRoom({ roomId: room.id, ownerId: 'default-user', source: 'test' })

    expect(result.actions[0]?.type).toBe('assign')
    const workers = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, room.id))
    expect(workers.some((participant) => participant.workspaceAgentId === agent!.id)).toBe(true)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.some((event) => event.type === 'task.assigned')).toBe(true)
  })
})

class FakeManagerRuntime implements ManagerRuntime {
  readonly runtimeType = 'openclaw' as const

  constructor(
    private readonly action: 'reply' | 'assign',
    private readonly workerId?: string,
  ) {}

  async *step(input: ManagerStepInput): AsyncGenerator<ManagerRuntimeEvent, ManagerStepResult> {
    yield { type: 'thinking', content: 'Processing...' }
    if (this.action === 'assign') {
      yield { type: 'completed', actions: [{
        type: 'assign',
        message: 'Researcher，请接手这项调研任务。',
        reason: `observed ${input.timeline.length} events`,
        targetWorkerId: this.workerId,
        taskTitle: '调研报告',
        taskDescription: '调研并输出报告。',
      }] }
      return {
        runtimeType: this.runtimeType,
        actions: [{
          type: 'assign',
          message: 'Researcher，请接手这项调研任务。',
          reason: `observed ${input.timeline.length} events`,
          targetWorkerId: this.workerId,
          taskTitle: '调研报告',
          taskDescription: '调研并输出报告。',
        }],
      }
    }
    yield { type: 'completed', actions: [{
      type: 'reply',
      message: '我在，大家也可以陆续打个招呼。',
      reason: `ordinary room chat with ${input.timeline.length} events`,
    }] }
    return {
      runtimeType: this.runtimeType,
      actions: [{
        type: 'reply',
        message: '我在，大家也可以陆续打个招呼。',
        reason: `ordinary room chat with ${input.timeline.length} events`,
      }],
    }
  }
}
