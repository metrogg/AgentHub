import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const bridgeApi = await import('../apps/server/src/services/rooms/room-chat-bridge')

const {
  db,
  artifacts,
  messages,
  rooms,
  runtimeLeases,
  workerInstances,
  orchestratorRuns,
  sessions,
  taskThreads,
  timelineEvents,
  workspaceAgents,
  workspaceTasks,
  workspaces,
  eq,
} = dbApi
const { stepCoordinatorForGroupMessage } = bridgeApi
type CoordinatorRuntime = typeof import('../apps/server/src/services/coordinator-runtime').CoordinatorRuntime
type CoordinatorStepInput = typeof import('../apps/server/src/services/coordinator-runtime').CoordinatorStepInput
type CoordinatorStepResult = typeof import('../apps/server/src/services/coordinator-runtime').CoordinatorStepResult
type WorkerRuntime = typeof import('../apps/server/src/services/worker-runtime').WorkerRuntime
type WorkerRuntimeContext = typeof import('../apps/server/src/services/worker-runtime').WorkerRuntimeContext
type WorkerRuntimeEvent = typeof import('../apps/server/src/services/worker-runtime').WorkerRuntimeEvent
type WorkerRuntimeResult = typeof import('../apps/server/src/services/worker-runtime').WorkerRuntimeResult

describe('Room chat bridge', () => {
  test('records group chat in room timeline and mirrors a coordinator reply', async () => {
    const { session, message } = await createGroupMessage()
    const result = await stepCoordinatorForGroupMessage({
      session,
      userId: 'default-user',
      userName: 'Tester',
      message,
      runtime: new FakeRuntime('reply'),
    })

    expect(result.consumed).toBe(true)
    expect(result.mirroredMessageIds).toHaveLength(1)

    const timeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, result.roomId))
    expect(timeline.map((event) => event.type)).toEqual(['human.message', 'manager.message', 'manager.message'])
    expect(timeline[0]?.metadata?.messageId).toBe(message.id)
    expect(timeline[1]?.metadata?.kind).toBe('coordinator.observing')
    expect(timeline[1]?.metadata?.sourceMessageId).toBe(message.id)
    expect(timeline[2]?.metadata?.kind).toBe('coordinator.action')
    expect(timeline[2]?.metadata?.actionType).toBe('reply')

    const mirrored = await db.select().from(messages).where(eq(messages.id, result.mirroredMessageIds[0]!)).limit(1)
    expect(mirrored[0]?.content).toBe('我在，大家也可以陆续打个招呼。')
    expect(mirrored[0]?.metadata?.actionType).toBe('reply')
    expect(mirrored[0]?.metadata?.roomId).toBe(result.roomId)
  })

  test('dispatches assign actions through real task room and WorkerRuntime', async () => {
    const { session, message, agentId } = await createGroupMessage()
    const result = await stepCoordinatorForGroupMessage({
      session,
      userId: 'default-user',
      userName: 'Tester',
      message,
      runtime: new FakeRuntime('assign', agentId),
      workerRuntime: new FakeWorkerRuntime(),
      executeInline: true,
    })

    expect(result.consumed).toBe(true)
    expect(result.mirroredMessageIds).toHaveLength(0)

    const timeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, result.roomId))
    expect(timeline.map((event) => event.type)).toEqual(['human.message', 'manager.message', 'task.assigned'])
    expect(timeline[1]?.metadata?.kind).toBe('coordinator.observing')
    expect(timeline[2]?.metadata?.kind).toBe('coordinator.assign.dispatched')

    const runRows = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.groupSessionId, session.id))
    expect(runRows).toHaveLength(1)

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.runId, runRows[0]!.id))
    expect(taskRows).toHaveLength(1)
    expect(taskRows[0]?.status).toBe('done')
    expect(taskRows[0]?.agentId).toBe(agentId)

    const threadRows = await db.select().from(taskThreads).where(eq(taskThreads.runId, runRows[0]!.id))
    expect(threadRows).toHaveLength(1)
    expect(threadRows[0]?.status).toBe('completed')
    expect(threadRows[0]?.workspaceAgentId).toBe(agentId)

    const taskRoomRows = await db.select().from(rooms).where(eq(rooms.runId, runRows[0]!.id))
    expect(taskRoomRows).toHaveLength(1)
    expect(taskRoomRows[0]?.taskThreadId).toBe(threadRows[0]?.id)

    const taskTimeline = await db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.roomId, taskRoomRows[0]!.id))
    expect(taskTimeline.some((event) => event.type === 'task.assigned')).toBe(true)
    expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.progress')).toBe(true)
    expect(taskTimeline.some((event) => event.type === 'artifact.created')).toBe(true)
    expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.completed')).toBe(true)

    const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.runId, runRows[0]!.id))
    expect(leaseRows).toHaveLength(1)
    expect(leaseRows[0]?.status).toBe('released')
    expect(leaseRows[0]?.homeDir).toBeTruthy()
    expect(leaseRows[0]?.cacheDir).toBeTruthy()

    const artifactRows = await db.select().from(artifacts).where(eq(artifacts.runId, runRows[0]!.id))
    expect(artifactRows).toHaveLength(1)
    expect(artifactRows[0]?.roomId).toBe(taskRoomRows[0]?.id)
    expect(artifactRows[0]?.objectKey).toContain('/tasks/')
  })

  test('dispatches multiple assign actions into one shared run with multiple task rooms', async () => {
    const { session, message, agentId, secondAgentId } = await createGroupMessage({
      extraAgents: [
        {
          name: 'Analyst',
          role: 'Analyze inputs',
          roleType: 'researcher',
        },
      ],
    })
    const result = await stepCoordinatorForGroupMessage({
      session,
      userId: 'default-user',
      userName: 'Tester',
      message,
      runtime: new MultiAssignRuntime([agentId, secondAgentId!]),
      workerRuntime: new FakeWorkerRuntime(),
      executeInline: true,
    })

    expect(result.consumed).toBe(true)

    const runRows = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.groupSessionId, session.id))
    expect(runRows).toHaveLength(1)
    expect(runRows[0]?.status).toBe('completed')
    expect(runRows[0]?.plan?.schema).toBe('agenthub.hiclaw-lite.assign-batch.v1')

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.runId, runRows[0]!.id))
    expect(taskRows).toHaveLength(2)
    expect(new Set(taskRows.map((task) => task.runId))).toEqual(new Set([runRows[0]!.id]))
    expect(new Set(taskRows.map((task) => task.agentId))).toEqual(new Set([agentId, secondAgentId]))
    expect(taskRows.every((task) => task.status === 'done')).toBe(true)

    const taskRoomRows = await db.select().from(rooms).where(eq(rooms.runId, runRows[0]!.id))
    expect(taskRoomRows).toHaveLength(2)
    expect(new Set(taskRoomRows.map((room) => room.runId))).toEqual(new Set([runRows[0]!.id]))

    const groupTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, result.roomId))
    expect(groupTimeline.map((event) => event.type)).toEqual([
      'human.message',
      'manager.message',
      'task.assigned',
      'task.assigned',
    ])
    expect(groupTimeline[1]?.metadata?.kind).toBe('coordinator.observing')
    expect(
      new Set(groupTimeline.slice(2).map((event) => event.metadata?.taskRoomId as string)),
    ).toEqual(new Set(taskRoomRows.map((room) => room.id)))

    for (const taskRoom of taskRoomRows) {
      const taskTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, taskRoom.id))
      expect(taskTimeline.some((event) => event.type === 'task.assigned')).toBe(true)
      expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.started')).toBe(true)
      expect(taskTimeline.some((event) => event.type === 'artifact.created')).toBe(true)
      expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.completed')).toBe(true)
    }

    const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.runId, runRows[0]!.id))
    expect(leaseRows).toHaveLength(2)
    expect(leaseRows.every((lease) => lease.status === 'released')).toBe(true)
    expect(new Set(leaseRows.map((lease) => lease.homeDir)).size).toBe(2)

    const artifactRows = await db.select().from(artifacts).where(eq(artifacts.runId, runRows[0]!.id))
    expect(artifactRows).toHaveLength(2)
    expect(new Set(artifactRows.map((artifact) => artifact.roomId))).toEqual(
      new Set(taskRoomRows.map((room) => room.id)),
    )
  })

  test('dispatches dependent assign actions as one run and executes dependency layers in order', async () => {
    const { session, message, agentId, secondAgentId } = await createGroupMessage({
      extraAgents: [
        {
          name: 'Reporter',
          role: 'Write reports',
          roleType: 'writer',
        },
      ],
    })
    const executionOrder: string[] = []
    const result = await stepCoordinatorForGroupMessage({
      session,
      userId: 'default-user',
      userName: 'Tester',
      message,
      runtime: new DependentAssignRuntime(agentId, secondAgentId!),
      workerRuntime: new RecordingWorkerRuntime(executionOrder),
      executeInline: true,
    })

    expect(result.consumed).toBe(true)

    const runRows = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.groupSessionId, session.id))
    expect(runRows).toHaveLength(1)
    expect(runRows[0]?.status).toBe('completed')

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.runId, runRows[0]!.id))
    expect(taskRows).toHaveLength(2)
    const firstTask = taskRows.find((task) => task.title === '收集事实')
    const secondTask = taskRows.find((task) => task.title === '撰写报告')
    expect(firstTask?.dependencies).toEqual([])
    expect(secondTask?.dependencies).toEqual([firstTask!.id])
    expect(runRows[0]?.plan?.tasks?.find((task: any) => task.taskKey === 'write')?.dependsOn).toEqual(['research'])
    expect(runRows[0]?.plan?.tasks?.find((task: any) => task.taskKey === 'write')?.dependencies).toEqual([
      firstTask!.id,
    ])
    expect(executionOrder).toEqual(['收集事实', '撰写报告'])

    const groupTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, result.roomId))
    const writeAssignment = groupTimeline.find((event) => event.metadata?.taskKey === 'write')
    expect(writeAssignment?.metadata?.dependsOn).toEqual(['research'])
    expect(writeAssignment?.metadata?.dependencyTaskIds).toEqual([firstTask!.id])
  })

  test('skips dependent assign tasks when an upstream dependency fails', async () => {
    const { session, message, agentId, secondAgentId } = await createGroupMessage({
      extraAgents: [
        {
          name: 'Reporter',
          role: 'Write reports',
          roleType: 'writer',
        },
      ],
    })
    const executionOrder: string[] = []
    const result = await stepCoordinatorForGroupMessage({
      session,
      userId: 'default-user',
      userName: 'Tester',
      message,
      runtime: new DependentAssignRuntime(agentId, secondAgentId!),
      workerRuntime: new FailingFirstWorkerRuntime(executionOrder),
      executeInline: true,
    })

    expect(result.consumed).toBe(true)

    const runRows = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.groupSessionId, session.id))
    expect(runRows).toHaveLength(1)
    expect(runRows[0]?.status).toBe('failed')

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.runId, runRows[0]!.id))
    const firstTask = taskRows.find((task) => task.title === '收集事实')
    const secondTask = taskRows.find((task) => task.title === '撰写报告')
    expect(firstTask?.status).toBe('failed')
    expect(secondTask?.status).toBe('failed')
    expect(secondTask?.progressStatus).toBe('skipped-by-dependency')
    expect(executionOrder).toEqual(['收集事实'])

    const taskRoomRows = await db.select().from(rooms).where(eq(rooms.runId, runRows[0]!.id))
    const skippedRoom = taskRoomRows.find((room) => room.taskId === secondTask!.id)
    const skippedTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, skippedRoom!.id))
    expect(skippedTimeline.some((event) => event.metadata?.kind === 'worker-runtime.skipped-by-dependency')).toBe(true)
  })

  test('keeps assign run open when a Worker asks for human clarification', async () => {
    const { session, message, agentId } = await createGroupMessage()
    const result = await stepCoordinatorForGroupMessage({
      session,
      userId: 'default-user',
      userName: 'Tester',
      message,
      runtime: new FakeRuntime('assign', agentId),
      workerRuntime: new ClarifyingWorkerRuntime(),
      executeInline: true,
    })

    expect(result.consumed).toBe(true)

    const runRows = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.groupSessionId, session.id))
    expect(runRows).toHaveLength(1)
    expect(runRows[0]?.status).toBe('running')

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.runId, runRows[0]!.id))
    expect(taskRows).toHaveLength(1)
    expect(taskRows[0]?.status).toBe('blocked')
    expect(taskRows[0]?.progressStatus).toBe('awaiting_human_clarification')

    const threadRows = await db.select().from(taskThreads).where(eq(taskThreads.runId, runRows[0]!.id))
    expect(threadRows[0]?.status).toBe('waiting_for_human')

    const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.runId, runRows[0]!.id))
    expect(leaseRows).toHaveLength(1)
    expect(leaseRows[0]?.status).toBe('waiting_for_human')

    const workerRows = await db.select().from(workerInstances).where(eq(workerInstances.id, leaseRows[0]!.workerInstanceId!))
    expect(workerRows[0]?.observedState).toBe('waiting_for_human')

    const taskRoomRows = await db.select().from(rooms).where(eq(rooms.runId, runRows[0]!.id))
    const taskTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, taskRoomRows[0]!.id))
    expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.clarification-requested')).toBe(true)
    expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.waiting-for-human')).toBe(true)
  })

  test('does not consume a room message when coordinator returns no action', async () => {
    const { session, message } = await createGroupMessage()
    const result = await stepCoordinatorForGroupMessage({
      session,
      userId: 'default-user',
      userName: 'Tester',
      message,
      runtime: new EmptyRuntime(),
    })

    expect(result.consumed).toBe(false)
    expect(result.reason).toContain('no actions')
    const timeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, result.roomId))
    expect(timeline.map((event) => event.type)).toEqual(['human.message', 'manager.message'])
    expect(timeline[1]?.metadata?.kind).toBe('coordinator.observing')
  })

  test('does not consume assign when dispatch cannot resolve a worker', async () => {
    const { session, message } = await createGroupMessage()
    const result = await stepCoordinatorForGroupMessage({
      session,
      userId: 'default-user',
      userName: 'Tester',
      message,
      runtime: new FakeRuntime('assign', 'missing-worker'),
      workerRuntime: new FakeWorkerRuntime(),
      executeInline: true,
    })

    expect(result.consumed).toBe(false)
    expect(result.reason).toContain('dispatch failed')
    const timeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, result.roomId))
    expect(timeline.map((event) => event.type)).toEqual(['human.message', 'manager.message'])
    expect(timeline[1]?.metadata?.kind).toBe('coordinator.observing')
  })
})

async function createGroupMessage(input: {
  extraAgents?: Array<{
    name: string
    role: string
    roleType: string
  }>
} = {}) {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Bridge Workspace',
      goal: 'Coordinate naturally',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Builder',
      role: 'Build things',
      roleType: 'builder',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  let secondAgentId: string | null = null
  for (const extraAgent of input.extraAgents ?? []) {
    const [created] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: extraAgent.name,
        role: extraAgent.role,
        roleType: extraAgent.roleType,
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
      })
      .returning()
    secondAgentId ??= created?.id ?? null
  }
  const [session] = await db
    .insert(sessions)
    .values({
      ownerId: 'default-user',
      title: 'Bridge Group',
      type: 'group',
      workspaceId: workspace!.id,
      metadata: { kind: 'workspace-agent-group' },
    })
    .returning()
  const [message] = await db
    .insert(messages)
    .values({
      sessionId: session!.id,
      senderId: 'default-user',
      senderType: 'user',
      type: 'text',
      content: '大家好，看到的人打个招呼',
      metadata: null,
    })
    .returning()
  return { workspace: workspace!, session: session!, message: message!, agentId: agent!.id, secondAgentId }
}

class FakeRuntime implements CoordinatorRuntime {
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
            message: 'Builder，请接手这个任务。',
            targetWorkerId: this.workerId,
            reason: `saw ${input.timeline.length} room events`,
            taskTitle: '构建任务',
            taskDescription: '执行构建。',
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
          reason: `saw ${input.timeline.length} room events`,
        },
      ],
    }
  }
}

class EmptyRuntime implements CoordinatorRuntime {
  readonly runtimeType = 'local-llm' as const

  async step(): Promise<CoordinatorStepResult> {
    return {
      runtimeType: this.runtimeType,
      actions: [],
    }
  }
}

class MultiAssignRuntime implements CoordinatorRuntime {
  readonly runtimeType = 'local-llm' as const

  constructor(private readonly workerIds: string[]) {}

  async step(input: CoordinatorStepInput): Promise<CoordinatorStepResult> {
    return {
      runtimeType: this.runtimeType,
      actions: this.workerIds.map((workerId, index) => ({
        type: 'assign',
        message: `Worker ${index + 1}，请接手这个任务。`,
        targetWorkerId: workerId,
        reason: `saw ${input.timeline.length} room events`,
        taskTitle: `团队任务 ${index + 1}`,
        taskDescription: `执行团队任务 ${index + 1}。`,
      })),
    }
  }
}

class DependentAssignRuntime implements CoordinatorRuntime {
  readonly runtimeType = 'local-llm' as const

  constructor(
    private readonly firstWorkerId: string,
    private readonly secondWorkerId: string,
  ) {}

  async step(): Promise<CoordinatorStepResult> {
    return {
      runtimeType: this.runtimeType,
      actions: [
        {
          type: 'assign',
          message: '请先收集事实。',
          targetWorkerId: this.firstWorkerId,
          taskKey: 'research',
          taskTitle: '收集事实',
          taskDescription: '先收集事实。',
        },
        {
          type: 'assign',
          message: '请基于事实写报告。',
          targetWorkerId: this.secondWorkerId,
          taskKey: 'write',
          dependsOn: ['research'],
          taskTitle: '撰写报告',
          taskDescription: '基于收集事实撰写报告。',
        },
      ],
    }
  }
}

class FakeWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield {
      type: 'progress',
      message: `收到任务：${context.prompt}`,
      progressPercent: 40,
    }
    yield {
      type: 'artifact',
      message: '任务报告',
      artifact: {
        id: 'bridge-artifact',
        kind: 'file',
        title: 'assign-result.md',
        path: 'assign-result.md',
        content: '# done',
      },
    }
    return {
      runtimeType: this.runtimeType,
      status: 'completed',
      message: '任务已完成。',
      artifacts: [
        {
          id: 'bridge-artifact',
          kind: 'file',
          title: 'assign-result.md',
          path: 'assign-result.md',
          content: '# done',
        },
      ],
    }
  }
}

class RecordingWorkerRuntime extends FakeWorkerRuntime {
  constructor(private readonly executionOrder: string[]) {
    super()
  }

  override async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    const title = context.prompt.includes('撰写报告') ? '撰写报告' : '收集事实'
    this.executionOrder.push(title)
    return yield* super.executeTask(context)
  }
}

class FailingFirstWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const

  constructor(private readonly executionOrder: string[]) {}

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    const title = context.prompt.includes('撰写报告') ? '撰写报告' : '收集事实'
    this.executionOrder.push(title)
    yield {
      type: 'progress',
      message: `收到任务：${context.prompt}`,
      progressPercent: 20,
    }
    if (title === '收集事实') {
      return {
        runtimeType: this.runtimeType,
        status: 'failed',
        message: '上游研究失败。',
      }
    }
    return {
      runtimeType: this.runtimeType,
      status: 'completed',
      message: '下游报告完成。',
    }
  }
}

class ClarifyingWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const

  async *executeTask(): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield {
      type: 'clarification',
      message: '需要用户确认输出口径。',
      question: '需要用户确认输出口径。',
      options: ['继续', '调整'],
    }
    return {
      runtimeType: this.runtimeType,
      status: 'failed',
      message: '等待用户确认输出口径。',
    }
  }
}
