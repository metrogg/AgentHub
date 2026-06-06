import './setup'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const workerRuntimeApi = await import('../apps/server/src/services/worker-runtime')
const taskThreadApi = await import('../apps/server/src/services/orchestrator/task-thread-service')
const workerRuntimeResourcesApi = await import('../apps/server/src/services/orchestrator/worker-runtime-resources')

const {
  db,
  eq,
  orchestratorRuns,
  sessions,
  timelineEvents,
  workspaceAgents,
  workspaceTasks,
  workspaces,
  runtimeLeases,
  workerInstances,
  taskThreads,
} = dbApi
const { roomService } = roomsApi
const { WorkerRuntimeService } = workerRuntimeApi
const { ensureTaskThread } = taskThreadApi
const { ensureWorkerInstance } = workerRuntimeResourcesApi
type WorkerRuntime = workerRuntimeApi.WorkerRuntime
type WorkerRuntimeContext = workerRuntimeApi.WorkerRuntimeContext
type WorkerRuntimeEvent = workerRuntimeApi.WorkerRuntimeEvent
type WorkerRuntimeResult = workerRuntimeApi.WorkerRuntimeResult

describe('WorkerRuntime modes', () => {
  test('EphemeralCodeAgentWorkerRuntime has correct kind and runtimeType', async () => {
    const { EphemeralCodeAgentWorkerRuntime } = await import(
      '../apps/server/src/services/worker-runtime/local-worker-runtime'
    )
    const agent = { name: 'Builder', runtimeType: 'code-agent', codeAgentType: 'opencode' } as any
    const runtime = new EphemeralCodeAgentWorkerRuntime(agent)
    expect(runtime.kind).toBe('ephemeral-code-agent')
    expect(runtime.runtimeType).toBe('code-agent')
  })

  test('ResidentRoomWorkerRuntime has correct kind for openclaw', async () => {
    const { ResidentRoomWorkerRuntime } = await import(
      '../apps/server/src/services/worker-runtime/resident-worker-runtime'
    )
    const runtime = new ResidentRoomWorkerRuntime({
      runtimeType: 'openclaw',
      workerParticipantId: 'p-test',
    })
    expect(runtime.kind).toBe('resident-openclaw')
    expect(runtime.runtimeType).toBe('openclaw')
  })

  test('ResidentRoomWorkerRuntime has correct kind for qwenpaw', async () => {
    const { ResidentRoomWorkerRuntime } = await import(
      '../apps/server/src/services/worker-runtime/resident-worker-runtime'
    )
    const runtime = new ResidentRoomWorkerRuntime({
      runtimeType: 'qwenpaw',
      workerParticipantId: 'p-test',
    })
    expect(runtime.kind).toBe('resident-qwenpaw')
    expect(runtime.runtimeType).toBe('qwenpaw')
  })

  test('OpenClaw worker config declares an explicit worker agent identity', async () => {
    const { generateWorkerOpenClawJson, openClawWorkerAgentId } = await import(
      '../apps/server/src/services/worker-runtime/worker-openclaw-config'
    )

    const config = generateWorkerOpenClawJson({
      workerInstanceId: 'worker-instance-1234567890',
      workerName: '技术写作专家',
      matrixUrl: 'http://localhost:6167',
      matrixDomain: 'agenthub.local',
      matrixUserId: '@worker-writer:agenthub.local',
      matrixAccessToken: 'token',
      managerMatrixUserId: '@manager:agenthub.local',
      llmBaseUrl: 'http://localhost:8000/v1',
      llmApiKey: 'test-key',
      llmModel: 'test-model',
      gatewayPort: 18880,
      dmAllowFrom: ['@manager:agenthub.local'],
      groupAllowFrom: ['@manager:agenthub.local'],
      rooms: [{
        roomId: 'room-1',
        providerRoomId: '!task-room:agenthub.local',
        kind: 'task',
        title: 'Task Room',
        participantId: 'worker-participant-1',
        allowFrom: ['@human-default:agenthub.local', '@manager:agenthub.local'],
      }],
      timeoutSeconds: 600,
      maxConcurrent: 4,
    }) as any

    expect(config.agents.defaults.skipBootstrap).toBe(true)
    expect(config.agents.list).toHaveLength(1)
    expect(config.agents.list[0]).toMatchObject({
      id: openClawWorkerAgentId('worker-instance-1234567890'),
      name: '技术写作专家',
      default: true,
      model: { primary: 'agenthub-llm/test-model' },
    })
    expect(config.agents.list[0].id).not.toBe('main')
    expect(config.agents.list[0].identity).toMatchObject({
      name: '技术写作专家',
    })
    expect(config.bindings).toEqual([
      {
        agentId: openClawWorkerAgentId('worker-instance-1234567890'),
        match: {
          channel: 'matrix',
          accountId: '*',
        },
      },
    ])
    expect(config.agents.list[0].groupChat.mentionPatterns).toContain('技术写作专家')
    expect(config.agents.list[0].groupChat.mentionPatterns).toContain('@worker-writer')
    expect(config.channels.matrix.groups['*']).toMatchObject({
      enabled: true,
      requireMention: true,
      autoReply: true,
    })
    expect(config.channels.matrix.groupAllowFrom).toContain('@manager:agenthub.local')
    expect(config.channels.matrix.groupAllowFrom).toContain('@human-default:agenthub.local')
    expect(config.channels.matrix.groups['!task-room:agenthub.local']).toMatchObject({
      enabled: true,
      requireMention: true,
      autoReply: true,
      skills: ['task-progress', 'file-sync'],
    })
    expect(config.channels.matrix.groups['!task-room:agenthub.local'].systemPrompt).toContain('Task Room')
  })

  test('OpenClaw launcher generates a resident Manager config with identity and Matrix binding', async () => {
    const previousAppDataDir = process.env.AGENTHUB_APP_DATA_DIR
    const tempRoot = mkdtempSync(join(tmpdir(), 'agenthub-openclaw-manager-'))
    process.env.AGENTHUB_APP_DATA_DIR = tempRoot

    try {
      const { OpenClawLauncher } = await import('../apps/server/src/services/manager-runtime/openclaw-launcher')
      const launcher = new OpenClawLauncher({
        matrixUrl: 'http://localhost:6167',
        matrixDomain: 'agenthub.local',
        matrixUserId: '@manager:agenthub.local',
        matrixAccessToken: 'token',
        llmBaseUrl: 'http://localhost:8000/v1',
        llmApiKey: 'test-key',
        llmModel: 'test-model',
      })
      const configPath = launcher.generateConfig()
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as any

      expect(config.agents.list[0].identity).toMatchObject({
        name: 'AgentHub Manager',
        emoji: '🧭',
      })
      expect(config.bindings).toEqual([
        {
          agentId: 'manager',
          match: {
            channel: 'matrix',
            accountId: '*',
          },
        },
      ])
    } finally {
      if (previousAppDataDir === undefined) {
        delete process.env.AGENTHUB_APP_DATA_DIR
      } else {
        process.env.AGENTHUB_APP_DATA_DIR = previousAppDataDir
      }
    }
  })

  test('runTaskRoom picks ResidentRoomWorkerRuntime when worker instance runtimeBase is openclaw', async () => {
    const { room, workerInstanceId } = await createTaskRoomFixtureWithRuntimeBase('openclaw')
    const service = new WorkerRuntimeService()
    const running = service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
    })

    const result = await running
    expect(result.status).toBe('waiting_for_human')
    expect(result.metadata?.dispatched).toBe(true)
    expect(result.metadata?.listener).toMatchObject({
      started: false,
      reason: 'resident_worker_openclaw_runs_own_sync',
    })

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const assignmentEvent = events.find(
      (e) => e.metadata?.kind === 'worker-runtime.resident-assignment',
    )
    expect(assignmentEvent).toBeTruthy()
    expect(assignmentEvent?.type).toBe('task.assigned')
  })

  test('runGroupMentionRoom uses ResidentRoomWorkerRuntime when worker instance runtimeBase is openclaw', async () => {
    const { room, agent, workerInstanceId } = await createGroupRoomFixtureWithRuntimeBase('openclaw')
    const service = new WorkerRuntimeService()
    const result = await service.runGroupMentionRoom({
      roomId: room.id,
      ownerId: 'default-user',
      workspaceAgentId: agent.id,
      sourceEventId: 'source-event-1',
      prompt: '@Builder 介绍一下自己',
    })

    expect(result.roomId).toBe(room.id)
    expect(result.appendedEventIds.length).toBeGreaterThan(0)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.some((e) => e.metadata?.kind === 'worker-runtime.group-mention-dispatched')).toBe(true)
    expect(events.some((e) => e.metadata?.kind === 'worker-runtime.resident-assignment')).toBe(true)
    expect(events.some((e) => e.metadata?.kind === 'worker-runtime.group-mention-failed')).toBe(false)
  })

  test('runTaskRoom picks EphemeralCodeAgentWorkerRuntime when worker instance runtimeBase is codex', async () => {
    const { room } = await createTaskRoomFixtureWithRuntimeBase('codex')
    const service = new WorkerRuntimeService()
    const result = await service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: new FakeWorkerRuntime(),
    })
    expect(result.status).toBe('completed')

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const startedEvent = events.find((e) => e.metadata?.kind === 'worker-runtime.started')
    expect(startedEvent).toBeTruthy()
  })

  test('stopTaskRoom dispatches resident stop request for resident mode', async () => {
    const { room, workerInstanceId } = await createTaskRoomFixtureWithRuntimeBase('openclaw')
    const service = new WorkerRuntimeService()
    const deferred = new DeferredResidentWorkerRuntime()
    const running = service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: deferred,
    })

    await deferred.started
    const stopped = await service.stopTaskRoom(room.id)
    expect(stopped).toBe(true)

    deferred.finish()
    await running

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const stopEvent = events.find(
      (e) => e.metadata?.kind === 'matrix.control.stop.resident-requested',
    )
    expect(stopEvent).toBeTruthy()
    expect(stopEvent?.metadata?.workerKind).toBe('resident-openclaw')
  })

  test('stopTaskRoom aborts ephemeral controller for ephemeral mode', async () => {
    const { room } = await createTaskRoomFixtureWithRuntimeBase('codex')
    const service = new WorkerRuntimeService()
    const deferred = new DeferredWorkerRuntime()
    const running = service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: deferred,
    })

    await deferred.started
    const stopped = await service.stopTaskRoom(room.id)
    expect(stopped).toBe(true)

    // Allow the aborted generator to finish via the race in DeferredWorkerRuntime
    const result = await running
    expect(result.status).toBe('cancelled')
  })
})

async function createTaskRoomFixtureWithRuntimeBase(runtimeBase: string) {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Worker Runtime Modes Workspace',
      goal: 'Test runtime modes',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Builder',
      role: 'Build worker',
      roleType: 'coder',
      runtimeType: runtimeBase === 'openclaw' || runtimeBase === 'copaw' ? 'code-agent' : 'code-agent',
      codeAgentType: runtimeBase === 'openclaw' || runtimeBase === 'copaw' ? undefined : (runtimeBase as any),
    })
    .returning()
  const [groupSession] = await db
    .insert(sessions)
    .values({
      title: 'Modes Group',
      type: 'group',
      ownerId: 'default-user',
      workspaceId: workspace!.id,
    })
    .returning()
  const [childSession] = await db
    .insert(sessions)
    .values({
      title: 'Task Room',
      type: 'direct',
      ownerId: 'default-user',
      workspaceId: workspace!.id,
      metadata: { kind: 'orchestrator-task' },
    })
    .returning()
  const [run] = await db
    .insert(orchestratorRuns)
    .values({
      workspaceId: workspace!.id,
      groupSessionId: groupSession!.id,
    })
    .returning()
  const [task] = await db
    .insert(workspaceTasks)
    .values({
      workspaceId: workspace!.id,
      runId: run!.id,
      sessionId: childSession!.id,
      agentId: agent!.id,
      title: 'Build report',
      description: 'Build a report.',
    })
    .returning()

  const workerInstance = await ensureWorkerInstance({
    workspaceId: workspace!.id,
    agent: {
      id: agent!.id,
      runtimeType: agent!.runtimeType,
      codeAgentType: agent!.codeAgentType,
      modelId: agent!.modelId,
      skillIds: agent!.skillIds,
      sandboxPolicy: agent!.sandboxPolicy,
    },
  })

  // Override runtimeBase for mode testing
  await db
    .update(workerInstances)
    .set({ runtimeBase: runtimeBase as any })
    .where(eq(workerInstances.id, workerInstance!.id))

  const thread = await ensureTaskThread({
    workspaceId: workspace!.id,
    runId: run!.id,
    taskId: task!.id,
    groupSessionId: groupSession!.id,
    sessionId: childSession!.id,
    ownerId: 'default-user',
    workspaceAgentId: agent!.id,
    workerInstanceId: workerInstance?.id ?? null,
    taskTitle: task!.title,
    agentName: agent!.name,
  })

  await db.insert(runtimeLeases).values({
    workspaceId: workspace!.id,
    runId: run!.id,
    taskId: task!.id,
    workerInstanceId: thread.workerInstanceId,
    provider: 'local-workdir',
    status: 'ready',
    cwd: workspace!.projectPath ?? null,
    metadata: { source: 'worker-runtime-modes-test' },
  })

  const room = await roomService.ensureRoomForTaskThread({
    ownerId: 'default-user',
    workspaceId: workspace!.id,
    groupSessionId: groupSession!.id,
    sessionId: childSession!.id,
    runId: run!.id,
    taskId: task!.id,
    taskThreadId: thread.id,
    title: 'Task Room',
    workspaceAgentId: agent!.id,
    workerInstanceId: thread.workerInstanceId,
  })
  await roomService.addWorkerParticipant(room.id, agent!.id)
  await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'manager',
    type: 'task.assigned',
    body: '请构建报告。',
    metadata: { taskDescription: '构建报告并说明结果。' },
  })

  return { room, workspace: workspace!, agent: agent!, workerInstanceId: workerInstance!.id }
}

async function createGroupRoomFixtureWithRuntimeBase(runtimeBase: string) {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Worker Group Runtime Workspace',
      goal: 'Test group mention runtime modes',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Builder',
      role: 'Build worker',
      roleType: 'coder',
      runtimeType: runtimeBase === 'openclaw' || runtimeBase === 'copaw' ? 'code-agent' : 'code-agent',
      codeAgentType: runtimeBase === 'openclaw' || runtimeBase === 'copaw' ? undefined : (runtimeBase as any),
    })
    .returning()
  const [session] = await db
    .insert(sessions)
    .values({
      title: 'Modes Group Mention',
      type: 'group',
      ownerId: 'default-user',
      workspaceId: workspace!.id,
    })
    .returning()

  const workerInstance = await ensureWorkerInstance({
    workspaceId: workspace!.id,
    agent: {
      id: agent!.id,
      runtimeType: agent!.runtimeType,
      codeAgentType: agent!.codeAgentType,
      modelId: agent!.modelId,
      skillIds: agent!.skillIds,
      sandboxPolicy: agent!.sandboxPolicy,
    },
  })
  await db
    .update(workerInstances)
    .set({ runtimeBase: runtimeBase as any })
    .where(eq(workerInstances.id, workerInstance!.id))

  const room = await roomService.ensureRoomForSession(session!.id, 'default-user')
  await roomService.addWorkerParticipant(room.id, agent!.id, workerInstance!.id)
  await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'human',
    type: 'human.message',
    body: '大家好',
    metadata: {},
  })
  return { room, workspace: workspace!, agent: agent!, workerInstanceId: workerInstance!.id }
}

class FakeWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
  readonly kind = 'ephemeral-code-agent' as const

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield { type: 'progress', message: `收到任务：${context.prompt}`, progressPercent: 25 }
    yield { type: 'message', message: '正在生成报告。' }
    return { runtimeType: this.runtimeType, kind: this.kind, status: 'completed', message: '报告已完成。' }
  }
}

class DeferredWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
  readonly kind = 'ephemeral-code-agent' as const
  private resolveStarted!: () => void
  private resolveFinish!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve
  })
  private readonly finished = new Promise<void>((resolve) => {
    this.resolveFinish = resolve
  })

  finish() {
    this.resolveFinish()
  }

  async *executeTask(
    _context: WorkerRuntimeContext,
    signal?: AbortSignal,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    this.resolveStarted()
    const aborted = new Promise<'aborted'>((resolve) => {
      if (signal?.aborted) {
        resolve('aborted')
        return
      }
      signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    const outcome = await Promise.race([this.finished.then(() => 'finished' as const), aborted])
    if (outcome === 'aborted') {
      return { runtimeType: this.runtimeType, kind: this.kind, status: 'cancelled', message: '长任务已取消。' }
    }
    yield { type: 'progress', message: '长任务现在继续并完成。', progressPercent: 80 }
    return { runtimeType: this.runtimeType, kind: this.kind, status: 'completed', message: '长任务已完成。' }
  }
}

class DeferredResidentWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'openclaw' as const
  readonly kind = 'resident-openclaw' as const
  private resolveStarted!: () => void
  private resolveFinish!: () => void
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve
  })
  private readonly finished = new Promise<void>((resolve) => {
    this.resolveFinish = resolve
  })

  finish() {
    this.resolveFinish()
  }

  async *executeTask(): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    this.resolveStarted()
    await this.finished
    yield { type: 'progress', message: 'Resident Worker 已收到停止前的测试释放。', progressPercent: 10 }
    return {
      runtimeType: this.runtimeType,
      kind: this.kind,
      status: 'waiting_for_human',
      message: 'Resident Worker 仍由外部 Matrix listener 继续处理。',
    }
  }
}
