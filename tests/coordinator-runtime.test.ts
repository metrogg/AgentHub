import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const coordinatorApi = await import('../apps/server/src/services/coordinator-runtime')

const {
  db,
  roomParticipants,
  timelineEvents,
  workspaceAgents,
  workspaces,
  eq,
} = dbApi
const { roomService } = roomsApi
const { CoordinatorService, resolveCoordinatorRuntime } = coordinatorApi
type CoordinatorRuntime = coordinatorApi.CoordinatorRuntime
type CoordinatorStepInput = coordinatorApi.CoordinatorStepInput
type CoordinatorStepResult = coordinatorApi.CoordinatorStepResult

describe('CoordinatorRuntime Room timeline integration', () => {
  test('CoordinatorRuntime remains a local LLM compatibility layer', async () => {
    expect(resolveCoordinatorRuntime().runtimeType).toBe('local-llm')
    expect(resolveCoordinatorRuntime({ type: 'local-llm' }).runtimeType).toBe('local-llm')
    expect(resolveCoordinatorRuntime({ type: 'local-skill-runtime' as any }).runtimeType).toBe('local-llm')
    expect(resolveCoordinatorRuntime({ type: 'openclaw' as any }).runtimeType).toBe('local-llm')
    expect(resolveCoordinatorRuntime({ type: 'qwenpaw' as any }).runtimeType).toBe('local-llm')
  })

  test('observes ordinary room chat and appends a manager reply event', async () => {
    const room = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Coordinator Test Room',
      metadata: { goal: 'Keep conversation natural' },
    })
    const human = await roomService.addParticipant({
      roomId: room.id,
      participantType: 'human',
      userId: 'default-user',
      displayName: 'You',
      role: 'owner',
    })
    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderParticipantId: human.id,
      senderType: 'human',
      type: 'human.message',
      body: '大家好，看到的人打个招呼',
    })

    const service = new CoordinatorService(new FakeCoordinatorRuntime('reply'))
    const result = await service.stepRoom({ roomId: room.id, ownerId: 'default-user' })

    expect(result.actions[0]?.type).toBe('reply')
    expect(result.appendedEventIds).toHaveLength(1)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.map((event) => event.type)).toEqual(['human.message', 'manager.message'])
    expect(events[1]?.metadata?.actionType).toBe('reply')
  })

  test('writes assign actions as task.assigned events with a real worker participant', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Coordinator Workspace',
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
      title: 'Coordinator Assignment Room',
      workspaceId: workspace!.id,
      metadata: { goal: workspace!.goal },
    })
    await roomService.addWorkerParticipant(room.id, agent!.id)

    const service = new CoordinatorService(new FakeCoordinatorRuntime('assign', agent!.id))
    const result = await service.stepRoom({ roomId: room.id, ownerId: 'default-user' })

    expect(result.actions[0]?.type).toBe('assign')
    const workers = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, room.id))
    expect(workers.some((participant) => participant.workspaceAgentId === agent!.id)).toBe(true)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('task.assigned')
    expect(events[0]?.metadata?.targetWorkerId).toBe(agent!.id)
  })
})

class FakeCoordinatorRuntime implements CoordinatorRuntime {
  readonly runtimeType = 'local-llm' as const

  constructor(
    private readonly action: 'reply' | 'assign',
    private readonly workerId?: string,
  ) {}

  async step(input: CoordinatorStepInput): Promise<CoordinatorStepResult> {
    if (this.action === 'assign') {
      return {
        runtimeType: this.runtimeType,
        actions: [
          {
            type: 'assign',
            message: 'Researcher，请接手这项调研任务。',
            reason: `observed ${input.timeline.length} events`,
            targetWorkerId: this.workerId,
            taskTitle: '调研报告',
            taskDescription: '调研并输出报告。',
          },
        ],
      }
    }
    return {
      runtimeType: this.runtimeType,
      actions: [
        {
          type: 'reply',
          message: '我在，大家也可以陆续打个招呼。',
          reason: `ordinary room chat with ${input.timeline.length} events`,
        },
      ],
    }
  }
}
