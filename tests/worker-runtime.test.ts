import { waitForCondition } from './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const roomBridgeApi = await import('../apps/server/src/services/rooms/room-chat-bridge')
const workerRuntimeApi = await import('../apps/server/src/services/worker-runtime')
const taskThreadApi = await import('../apps/server/src/services/orchestrator/task-thread-service')
const workerRuntimeResourcesApi = await import('../apps/server/src/services/orchestrator/worker-runtime-resources')
const agentRunnerApi = await import('../apps/server/src/services/agent-runner')

const {
  artifacts,
  db,
  messages,
  orchestratorRuns,
  sessions,
  taskClarifications,
  timelineEvents,
  workspaceAgents,
  workspaceTasks,
  workspaces,
  runtimeLeases,
  workerInstances,
  taskThreads,
  eq,
} = dbApi
const { roomService } = roomsApi
const { appendHumanMessageRoomFirst } = roomBridgeApi
const { WorkerRuntimeService } = workerRuntimeApi
const { ensureTaskThread } = taskThreadApi
const { ensureWorkerInstance } = workerRuntimeResourcesApi
const { joinRoom, leaveRoom } = agentRunnerApi
type WorkerRuntime = workerRuntimeApi.WorkerRuntime
type WorkerRuntimeContext = workerRuntimeApi.WorkerRuntimeContext
type WorkerRuntimeEvent = workerRuntimeApi.WorkerRuntimeEvent
type WorkerRuntimeResult = workerRuntimeApi.WorkerRuntimeResult

describe('WorkerRuntime task room integration', () => {
  test('direct room hides runtime metadata and stream chunks behind one final worker reply', async () => {
    const { room, agent, session } = await createDirectRoomFixture()
    const service = new WorkerRuntimeService()
    const wsPayloads: any[] = []
    const fakeWs = {
      readyState: 1,
      send(payload: string) {
        wsPayloads.push(JSON.parse(payload))
      },
    } as any
    joinRoom(session.id, fakeWs)

    let result: Awaited<ReturnType<typeof service.runDirectRoom>>
    try {
      result = await service.runDirectRoom({
        roomId: room.id,
        ownerId: 'default-user',
        workspaceAgentId: agent.id,
        prompt: 'Hello direct worker',
        runtime: new ChunkyDirectWorkerRuntime(),
      })
    } finally {
      leaveRoom(session.id, fakeWs)
    }

    expect(result.appendedEventIds).toHaveLength(1)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const visibleWorkerEvents = events.filter(
      (event) =>
        event.senderType === 'worker' &&
        (event.type === 'worker.message' || event.type === 'task.progress') &&
        event.metadata?.hiddenFromChat !== true &&
        Boolean(event.body.trim()),
    )
    expect(visibleWorkerEvents).toHaveLength(1)
    expect(visibleWorkerEvents[0]?.type).toBe('worker.message')
    expect(visibleWorkerEvents[0]?.body).toBe('hello world')
    expect(visibleWorkerEvents[0]?.metadata?.codeAgentRun).toMatchObject({
      type: 'code-agent-run',
      status: 'completed',
      finalMessage: 'hello world',
      files: [
        {
          path: 'src/App.tsx',
          status: 'modified',
          diff: 'diff --git a/src/App.tsx b/src/App.tsx',
        },
      ],
    })
    expect(events.some((event) => event.body === 'Worker runtime metadata updated.')).toBe(false)
    expect(events.some((event) => event.type === 'worker.message' && event.body === 'hello')).toBe(false)
    expect(events.some((event) => event.type === 'worker.message' && event.body === ' world')).toBe(false)
    const metadataEvents = wsPayloads.filter((event) => event.type === 'message:metadata')
    expect(metadataEvents.map((event) => event.payload.codeAgentRun.status)).toEqual([
      'running',
      'completed',
    ])
  })

  test('task resources become active as soon as WorkerRuntime starts the task room', async () => {
    const { room } = await createTaskRoomFixture()
    const runtime = new DeferredWorkerRuntime()
    const service = new WorkerRuntimeService()
    const running = service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime,
    })

    await runtime.started

    let taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, room.taskId!))
    expect(taskRows[0]?.status).toBe('running')
    expect(taskRows[0]?.progressStatus).toBe('worker-runtime-started')
    let threadRows = await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId!))
    expect(threadRows[0]?.status).toBe('active')
    let leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId!))
    expect(leaseRows[0]?.status).toBe('running')
    const workerRows = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, leaseRows[0]!.workerInstanceId!))
    expect(workerRows[0]?.observedState).toBe('busy')

    const startedEvents = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(startedEvents.some((event) => event.metadata?.kind === 'worker-runtime.started')).toBe(true)

    runtime.finish()
    const result = await running
    expect(result.status).toBe('completed')
    taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, room.taskId!))
    expect(taskRows[0]?.status).toBe('done')
    threadRows = await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId!))
    expect(threadRows[0]?.status).toBe('completed')
    leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId!))
    expect(leaseRows[0]?.status).toBe('released')
  })

  test('running task room emits WorkerRuntime heartbeat into room timeline and stops after completion', async () => {
    const { room } = await createTaskRoomFixture()
    const runtime = new DeferredWorkerRuntime()
    const service = new WorkerRuntimeService()
    const running = service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime,
      heartbeatIntervalMs: 10,
    })

    await runtime.started
    await waitMs(35)

    let events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const heartbeatEvents = events.filter((event) => event.metadata?.kind === 'worker-runtime.heartbeat')
    expect(heartbeatEvents.length).toBeGreaterThanOrEqual(1)
    expect(heartbeatEvents[0]?.type).toBe('task.progress')
    expect(heartbeatEvents[0]?.metadata?.status).toBe('running')
    expect(heartbeatEvents[0]?.metadata?.taskId).toBe(room.taskId)

    const workerRowsDuringRun = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, heartbeatEvents[0]!.metadata!.workerInstanceId as string))
    expect(workerRowsDuringRun[0]?.observedState).toBe('busy')
    expect(workerRowsDuringRun[0]?.health?.heartbeatCount).toBeGreaterThanOrEqual(1)

    runtime.finish()
    await running
    events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const heartbeatCountAfterCompletion = events.filter(
      (event) => event.metadata?.kind === 'worker-runtime.heartbeat',
    ).length
    await waitMs(25)
    events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.filter((event) => event.metadata?.kind === 'worker-runtime.heartbeat')).toHaveLength(
      heartbeatCountAfterCompletion,
    )
  })

  test('worker accepts a task room assignment and writes progress/result timeline events', async () => {
    const { room } = await createTaskRoomFixture()

    const service = new WorkerRuntimeService()
    const result = await service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: new FakeWorkerRuntime(),
    })

    expect(result.status).toBe('completed')
    expect(result.appendedEventIds.length).toBeGreaterThanOrEqual(4)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.filter((event) => event.type === 'task.assigned').length).toBeGreaterThanOrEqual(1)
    const progressEvent = events.find((event) => event.metadata?.kind === 'worker-runtime.progress')
    expect(progressEvent?.type).toBe('task.progress')
    const artifactEvent = events.find((event) => event.metadata?.kind === 'worker-runtime.artifact')
    expect(artifactEvent?.type).toBe('artifact.created')
    expect(typeof artifactEvent?.metadata?.artifactId).toBe('string')
    expect(artifactEvent?.metadata?.artifact?.source).toBe('artifact-store')
    expect(typeof artifactEvent?.metadata?.artifact?.objectKey).toBe('string')
    const completedEvent = [...events].reverse().find((event) => event.metadata?.kind === 'worker-runtime.completed')
    expect(completedEvent?.metadata?.status).toBe('completed')

    const rows = await db.select().from(artifacts).where(eq(artifacts.roomId, room.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.objectKey).toContain('/tasks/')
    expect(rows[0]?.storageProvider).toBe('local-filesystem')
    expect(rows[0]?.storagePath).toBeTruthy()
  })

  test('worker clarification requests and partial artifacts are preserved in task room timeline', async () => {
    const { room } = await createTaskRoomFixture()
    const service = new WorkerRuntimeService()
    const result = await service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: new ClarifyingPartialWorkerRuntime(),
    })

    expect(result.status).toBe('waiting_for_human')
    expect(result.metadata?.waitingForHuman).toBe(true)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const clarificationEvent = events.find((event) => event.metadata?.kind === 'worker-runtime.clarification-requested')
    expect(clarificationEvent?.type).toBe('approval.requested')
    expect(clarificationEvent?.metadata?.question).toBe('需要确认报告口径吗？')
    expect(clarificationEvent?.metadata?.options).toEqual(['继续', '调整'])
    expect(typeof clarificationEvent?.metadata?.clarificationId).toBe('string')

    const clarificationRows = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, clarificationEvent!.metadata!.clarificationId as string))
    expect(clarificationRows).toHaveLength(1)
    expect(clarificationRows[0]?.status).toBe('pending')
    expect(clarificationRows[0]?.question).toBe('需要确认报告口径吗？')
    expect(clarificationRows[0]?.options).toEqual(['继续', '调整'])

    const artifactEvent = events.find((event) => event.metadata?.kind === 'worker-runtime.artifact')
    expect(artifactEvent?.type).toBe('artifact.created')
    expect(artifactEvent?.metadata?.status).toBe('partial')
    expect(artifactEvent?.metadata?.artifact?.status).toBe('partial')

    const waitingEvent = events.find((event) => event.metadata?.kind === 'worker-runtime.waiting-for-human')
    expect(waitingEvent?.type).toBe('task.progress')
    expect(waitingEvent?.metadata?.status).toBe('waiting_for_human')
    expect(waitingEvent?.metadata?.waitingForHuman).toBe(true)

    const rows = await db.select().from(artifacts).where(eq(artifacts.roomId, room.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('partial')
    expect(rows[0]?.objectKey).toContain('/tasks/')

    const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId!))
    expect(leaseRows[0]?.status).toBe('waiting_for_human')
    const workerRows = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, leaseRows[0]!.workerInstanceId!))
    expect(workerRows[0]?.observedState).toBe('waiting_for_human')
  })

  test('human answer in a task room resumes WorkerRuntime after a clarification request', async () => {
    const { room, childSession } = await createTaskRoomFixture()
    const service = new WorkerRuntimeService()
    const firstResult = await service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: new ClarifyingPartialWorkerRuntime(),
    })
    expect(firstResult.status).toBe('waiting_for_human')

    const [answer] = await db
      .insert(messages)
      .values({
        sessionId: childSession.id,
        senderId: 'default-user',
        senderType: 'user',
        type: 'text',
        content: '按最新市场数据继续，先给出可验证来源，再产出 HTML。',
      })
      .returning()

    const runtime = new ResumeAwareWorkerRuntime()
    await appendHumanMessageRoomFirst({
      session: childSession,
      userId: 'default-user',
      userName: 'Tester',
      content: answer!.content,
      type: answer!.type,
      metadata: { messageId: answer!.id },
      skipDispatch: true, // Test controls dispatch timing manually
    })
    const result = await service.resumeTaskRoomAfterHumanAnswer({
      roomId: room.id,
      ownerId: 'default-user',
      sourceMessageId: answer!.id,
      answer: answer!.content,
      runtime,
    })

    expect(result.consumed).toBe(true)
    expect(result.resumed).toBe(true)
    const events = await waitForCondition(
      () => db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id)),
      (items) =>
        runtime.prompts.length === 1 &&
        items.some(
          (event) =>
            event.metadata?.kind === 'worker-runtime.completed' &&
            event.metadata?.status === 'completed',
        ),
      { description: 'WorkerRuntime resume completion' },
    )
    expect(runtime.prompts[0]).toContain('用户已经在任务房间回答了 Worker 的澄清问题')
    expect(runtime.prompts[0]).toContain('按最新市场数据继续')

    const resumeEvent = events.find((event) => event.metadata?.kind === 'worker-runtime.resume-requested')
    expect(resumeEvent?.type).toBe('task.progress')
    expect(resumeEvent?.metadata?.sourceMessageId).toBe(answer!.id)
    expect(resumeEvent?.metadata?.answer).toContain('按最新市场数据继续')
    expect(typeof resumeEvent?.metadata?.clarificationId).toBe('string')
    expect(resumeEvent?.metadata?.clarificationStatus).toBe('answered')
    expect(events.some((event) => event.metadata?.kind === 'worker-runtime.started')).toBe(true)
    expect(
      events.some(
        (event) =>
          event.metadata?.kind === 'worker-runtime.completed' &&
          event.metadata?.status === 'completed',
      ),
    ).toBe(true)

    const rows = await db.select().from(artifacts).where(eq(artifacts.roomId, room.id))
    expect(rows.some((artifact) => artifact.title === 'final-report.html')).toBe(true)

    const clarificationRows = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, resumeEvent!.metadata!.clarificationId as string))
    expect(clarificationRows).toHaveLength(1)
    expect(clarificationRows[0]?.status).toBe('answered')
    expect(clarificationRows[0]?.answer).toContain('按最新市场数据继续')
    expect(clarificationRows[0]?.answeredAt).toBeInstanceOf(Date)

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, room.taskId!))
    expect(taskRows[0]?.status).toBe('done')
    expect(taskRows[0]?.progressStatus).toBe('completed')
    const threadRows = await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId!))
    expect(threadRows[0]?.status).toBe('completed')

    const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId!))
    expect(leaseRows[0]?.status).toBe('released')
    const workerRows = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, leaseRows[0]!.workerInstanceId!))
    expect(workerRows[0]?.observedState).toBe('idle')
  })

  test('duplicate human answer does not resume the same clarification twice', async () => {
    const { room, childSession } = await createTaskRoomFixture()
    const service = new WorkerRuntimeService()
    const firstResult = await service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: new ClarifyingPartialWorkerRuntime(),
    })
    expect(firstResult.status).toBe('waiting_for_human')

    const [answer] = await db
      .insert(messages)
      .values({
        sessionId: childSession.id,
        senderId: 'default-user',
        senderType: 'user',
        type: 'text',
        content: '继续，使用默认报告口径。',
      })
      .returning()

    const firstResumeRuntime = new ResumeAwareWorkerRuntime()
    await appendHumanMessageRoomFirst({
      session: childSession,
      userId: 'default-user',
      userName: 'Tester',
      content: answer!.content,
      type: answer!.type,
      metadata: { messageId: answer!.id },
      skipDispatch: true, // Test controls dispatch timing manually
    })
    const firstResume = await service.resumeTaskRoomAfterHumanAnswer({
      roomId: room.id,
      ownerId: 'default-user',
      sourceMessageId: answer!.id,
      answer: answer!.content,
      runtime: firstResumeRuntime,
    })
    expect(firstResume.consumed).toBe(true)
    expect(firstResume.resumed).toBe(true)
    await waitForCondition(
      () => db.select().from(artifacts).where(eq(artifacts.roomId, room.id)),
      (items) =>
        firstResumeRuntime.prompts.length === 1 &&
        items.some((artifact) => artifact.title === 'final-report.html'),
      { description: 'first clarification resume completion' },
    )
    expect(firstResumeRuntime.prompts).toHaveLength(1)

    const duplicateRuntime = new ResumeAwareWorkerRuntime()
    const duplicateResume = await service.resumeTaskRoomAfterHumanAnswer({
      roomId: room.id,
      ownerId: 'default-user',
      sourceMessageId: answer!.id,
      answer: answer!.content,
      runtime: duplicateRuntime,
    })

    expect(duplicateResume.consumed).toBe(true)
    expect(duplicateResume.resumed).toBe(true)
    expect(duplicateResume.reason).toContain('already recorded')
    expect(duplicateRuntime.prompts).toHaveLength(0)

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const resumeEvents = events.filter((event) => event.metadata?.kind === 'worker-runtime.resume-requested')
    expect(resumeEvents).toHaveLength(1)
    const finalArtifacts = await db.select().from(artifacts).where(eq(artifacts.roomId, room.id))
    expect(finalArtifacts.filter((artifact) => artifact.title === 'final-report.html')).toHaveLength(1)
  })

  test('a resumed Worker can ask another clarification and keep resources waiting', async () => {
    const { room, childSession } = await createTaskRoomFixture()
    const service = new WorkerRuntimeService()
    const firstResult = await service.runTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: new ClarifyingPartialWorkerRuntime(),
    })
    expect(firstResult.status).toBe('waiting_for_human')

    const [answer] = await db
      .insert(messages)
      .values({
        sessionId: childSession.id,
        senderId: 'default-user',
        senderType: 'user',
        type: 'text',
        content: '继续，但需要先确认最终输出语言。',
      })
      .returning()

    const runtime = new ReclarifyingWorkerRuntime()
    await appendHumanMessageRoomFirst({
      session: childSession,
      userId: 'default-user',
      userName: 'Tester',
      content: answer!.content,
      type: answer!.type,
      metadata: { messageId: answer!.id },
      skipDispatch: true, // Test controls dispatch timing manually
    })
    const resume = await service.resumeTaskRoomAfterHumanAnswer({
      roomId: room.id,
      ownerId: 'default-user',
      sourceMessageId: answer!.id,
      answer: answer!.content,
      runtime,
    })

    expect(resume.consumed).toBe(true)
    expect(resume.resumed).toBe(true)
    const events = await waitForCondition(
      () => db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id)),
      (items) =>
        runtime.prompts.length === 1 &&
        items.filter((event) => event.metadata?.kind === 'worker-runtime.clarification-requested').length === 2,
      { description: 'second clarification after resume' },
    )
    expect(runtime.prompts).toHaveLength(1)

    const clarificationEvents = events.filter(
      (event) => event.metadata?.kind === 'worker-runtime.clarification-requested',
    )
    expect(clarificationEvents).toHaveLength(2)
    expect(clarificationEvents[1]?.metadata?.question).toBe('最终报告需要中文还是英文？')
    const waitingEvents = events.filter((event) => event.metadata?.kind === 'worker-runtime.waiting-for-human')
    expect(waitingEvents).toHaveLength(2)
    expect(waitingEvents.at(-1)?.metadata?.clarificationQuestion).toBe('最终报告需要中文还是英文？')

    const clarificationRows = await db.select().from(taskClarifications).where(eq(taskClarifications.taskId, room.taskId!))
    expect(clarificationRows.filter((item) => item.status === 'answered')).toHaveLength(1)
    expect(clarificationRows.filter((item) => item.status === 'pending')).toHaveLength(1)

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, room.taskId!))
    expect(taskRows[0]?.status).toBe('blocked')
    expect(taskRows[0]?.progressStatus).toBe('awaiting_human_clarification')
    const threadRows = await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId!))
    expect(threadRows[0]?.status).toBe('waiting_for_human')
    const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId!))
    expect(leaseRows[0]?.status).toBe('waiting_for_human')
    const workerRows = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, leaseRows[0]!.workerInstanceId!))
    expect(workerRows[0]?.observedState).toBe('waiting_for_human')
  })

  test('reruns a failed task room through WorkerRuntime without legacy orchestrator retry', async () => {
    const { room } = await createTaskRoomFixture()
    const service = new WorkerRuntimeService()

    const failed = await service.rerunTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: new FailingWorkerRuntime(),
      source: 'test.failed-rerun',
    })

    expect(failed.status).toBe('failed')
    let taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, room.taskId!))
    expect(taskRows[0]?.status).toBe('failed')
    expect(taskRows[0]?.progressStatus).toBe('failed')
    let threadRows = await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId!))
    expect(threadRows[0]?.status).toBe('failed')
    let leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId!))
    expect(leaseRows[0]?.status).toBe('failed')

    const completed = await service.rerunTaskRoom({
      roomId: room.id,
      ownerId: 'default-user',
      runtime: new FakeWorkerRuntime(),
      source: 'test.manual-retry',
    })

    expect(completed.status).toBe('completed')
    taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, room.taskId!))
    expect(taskRows[0]?.status).toBe('done')
    expect(taskRows[0]?.progressStatus).toBe('completed')
    threadRows = await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId!))
    expect(threadRows[0]?.status).toBe('completed')
    leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId!))
    expect(leaseRows[0]?.status).toBe('released')

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.filter((event) => event.metadata?.kind === 'worker-runtime.started')).toHaveLength(2)
    expect(events.some((event) => event.metadata?.kind === 'worker-runtime.failed')).toBe(true)
    expect(events.some((event) => event.metadata?.kind === 'worker-runtime.completed')).toBe(true)
    const artifactRows = await db.select().from(artifacts).where(eq(artifacts.roomId, room.id))
    expect(artifactRows.some((artifact) => artifact.title === 'report.html')).toBe(true)
  })
})

async function createDirectRoomFixture() {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Direct Worker Runtime Workspace',
      goal: 'Run direct rooms',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Direct Builder',
      role: 'Direct worker',
      roleType: 'coder',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [session] = await db
    .insert(sessions)
    .values({
      title: 'Direct Builder',
      type: 'direct',
      ownerId: 'default-user',
      workspaceId: workspace!.id,
      workspaceAgentId: agent!.id,
      metadata: { kind: 'agent-direct', savedAgentId: agent!.id },
    })
    .returning()
  const room = await roomService.createRoom({
    kind: 'direct',
    ownerId: 'default-user',
    workspaceId: workspace!.id,
    sessionId: session!.id,
    title: 'Direct Builder',
    metadata: { kind: 'agent-direct' },
  })
  await roomService.addWorkerParticipant(room.id, agent!.id)
  await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'human',
    type: 'human.message',
    body: 'Hello direct worker',
    metadata: { messageId: 'direct-human-message', skipAutoDispatch: true },
  })
  return { room, workspace: workspace!, agent: agent!, session: session! }
}

async function createTaskRoomFixture() {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Worker Runtime Workspace',
      goal: 'Run task rooms',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Builder',
      role: 'Build worker',
      roleType: 'coder',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [groupSession] = await db
    .insert(sessions)
    .values({
      title: 'Worker Runtime Group',
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
      title: 'Build HTML report',
      description: 'Build an HTML report.',
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
    homeDir: `test-home-${task!.id}`,
    configDir: `test-config-${task!.id}`,
    cacheDir: `test-cache-${task!.id}`,
    tmpDir: `test-tmp-${task!.id}`,
    dataDir: `test-data-${task!.id}`,
    metadata: { source: 'worker-runtime-test' },
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
    body: '请构建一个 HTML 报告。',
    metadata: {
      taskDescription: '构建 HTML 报告并说明结果。',
    },
  })
  return { room, workspace: workspace!, agent: agent!, groupSession: groupSession!, childSession: childSession!, run: run!, task: task!, thread }
}

class ChunkyDirectWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
  readonly kind = 'ephemeral-code-agent' as const

  async *executeTask(): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield {
      type: 'progress',
      message: 'Direct worker started.',
      progressPercent: 5,
    }
    yield {
      type: 'progress',
      message: 'Worker runtime metadata updated.',
      metadata: { sessionId: 'direct-runtime-session' },
    }
    yield {
      type: 'metadata',
      metadata: {
        codeAgentRun: {
          type: 'code-agent-run',
          status: 'running',
          runtime: 'opencode',
          command: 'opencode',
          durationMs: 10,
          exitCode: 0,
          commands: [],
          files: [],
          toolCalls: [],
          artifacts: [],
          partialSuccess: false,
          reviewRequired: true,
          steps: [],
        },
      },
    }
    yield {
      type: 'message',
      message: 'hello',
    }
    yield {
      type: 'message',
      message: ' world',
    }
    return {
      runtimeType: this.runtimeType,
      status: 'completed',
      message: 'hello world',
      sessionId: 'direct-runtime-session',
      metadata: {
        codeAgentRun: {
          type: 'code-agent-run',
          status: 'completed',
          runtime: 'opencode',
          command: 'opencode',
          durationMs: 42,
          exitCode: 0,
          commands: [],
          files: [
            {
              path: 'src/App.tsx',
              status: 'modified',
              diff: 'diff --git a/src/App.tsx b/src/App.tsx',
            },
          ],
          toolCalls: [],
          artifacts: [
            {
              id: 'diff-src-app',
              type: 'diff',
              title: 'src/App.tsx',
              filePath: 'src/App.tsx',
              diff: 'diff --git a/src/App.tsx b/src/App.tsx',
            },
          ],
          finalMessage: 'hello world',
          partialSuccess: false,
          reviewRequired: true,
          steps: [],
        },
      },
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
      progressPercent: 25,
    }
    yield {
      type: 'message',
      message: '我正在生成报告。',
    }
    yield {
      type: 'artifact',
      message: 'HTML 报告',
      artifact: {
        id: 'artifact-1',
        kind: 'file',
        title: 'report.html',
        path: 'report.html',
        content: '<html><body>report</body></html>',
      },
    }
    return {
      runtimeType: this.runtimeType,
      status: 'completed',
      message: '报告已完成。',
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'file',
          title: 'report.html',
          path: 'report.html',
          content: '<html><body>report</body></html>',
        },
      ],
    }
  }
}

class DeferredWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
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
    yield {
      type: 'progress',
      message: '长任务现在继续并完成。',
      progressPercent: 80,
    }
    return {
      runtimeType: this.runtimeType,
      status: 'completed',
      message: '长任务已完成。',
    }
  }
}

class ClarifyingPartialWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const

  async *executeTask(): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield {
      type: 'clarification',
      message: '需要确认报告口径吗？',
      question: '需要确认报告口径吗？',
      options: ['继续', '调整'],
    }
    yield {
      type: 'artifact',
      message: '部分报告草稿',
      status: 'partial',
      artifact: {
        id: 'partial-report',
        kind: 'file',
        title: 'partial-report.md',
        path: 'partial-report.md',
        content: '# partial',
      },
    }
    return {
      runtimeType: this.runtimeType,
      status: 'failed',
      message: '等待用户澄清后才能继续。',
      artifacts: [
        {
          id: 'partial-report',
          kind: 'file',
          title: 'partial-report.md',
          path: 'partial-report.md',
          content: '# partial',
        },
      ],
    }
  }
}

class FailingWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield {
      type: 'progress',
      message: `准备执行但会失败：${context.prompt}`,
      progressPercent: 30,
    }
    yield {
      type: 'failed',
      message: '模拟 WorkerRuntime 失败。',
    }
    return {
      runtimeType: this.runtimeType,
      status: 'failed',
      message: '模拟 WorkerRuntime 失败。',
    }
  }
}

class ResumeAwareWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
  readonly prompts: string[] = []

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    this.prompts.push(context.prompt)
    yield {
      type: 'progress',
      message: '已收到用户澄清，继续执行。',
      progressPercent: 70,
    }
    yield {
      type: 'artifact',
      message: '最终 HTML 报告',
      artifact: {
        id: 'final-report',
        kind: 'file',
        title: 'final-report.html',
        path: 'final-report.html',
        content: '<html><body>final</body></html>',
      },
    }
    return {
      runtimeType: this.runtimeType,
      status: 'completed',
      message: '已根据用户澄清完成最终报告。',
      artifacts: [
        {
          id: 'final-report',
          kind: 'file',
          title: 'final-report.html',
          path: 'final-report.html',
          content: '<html><body>final</body></html>',
        },
      ],
    }
  }
}

class ReclarifyingWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
  readonly prompts: string[] = []

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    this.prompts.push(context.prompt)
    yield {
      type: 'progress',
      message: '已收到第一轮澄清，继续分析输出语言。',
      progressPercent: 60,
    }
    yield {
      type: 'clarification',
      message: '最终报告需要中文还是英文？',
      question: '最终报告需要中文还是英文？',
      options: ['中文', '英文'],
    }
    return {
      runtimeType: this.runtimeType,
      status: 'failed',
      message: '等待确认输出语言后继续。',
    }
  }
}

function waitMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
