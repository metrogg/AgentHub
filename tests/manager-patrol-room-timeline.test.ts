import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const { runManagerPatrol } = await import('../apps/server/src/services/orchestrator/manager-patrol')
const { ensureTaskThread } = await import('../apps/server/src/services/orchestrator/task-thread-service')
const { ensureWorkerInstance } = await import('../apps/server/src/services/orchestrator/worker-runtime-resources')
const { roomService } = await import('../apps/server/src/services/rooms')

const {
  db,
  eq,
  orchestratorRuns,
  roomParticipants,
  sessions,
  taskThreads,
  timelineEvents,
  workspaceAgents,
  workspaceTasks,
  workspaces,
  runtimeLeases,
} = dbApi

describe('ManagerPatrol Room timeline integration', () => {
  test('task timeout is visible in group and task room timelines', async () => {
    const fixture = await createRunningTaskFixture()

    const result = await runManagerPatrol()

    expect(result.timedOutTaskCount).toBeGreaterThanOrEqual(1)
    expect(result.actions.some((action) => action.kind === 'task_timeout' && action.taskId === fixture.task.id)).toBe(true)

    const groupRoom = await roomService.ensureRoomForSession(fixture.groupSession.id, 'default-user')
    const groupEvents = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, groupRoom.id))
    expect(
      groupEvents.some(
        (event) =>
          event.type === 'manager.message' &&
          event.metadata?.kind === 'manager-patrol-check' &&
          event.metadata?.taskId === fixture.task.id,
      ),
    ).toBe(true)

    const taskEvents = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, fixture.taskRoom.id))
    expect(
      taskEvents.some(
        (event) =>
          event.type === 'task.progress' &&
          event.metadata?.kind === 'manager-patrol-check' &&
          event.metadata?.taskId === fixture.task.id,
      ),
    ).toBe(true)

    const groupPatrolEvents = groupEvents.filter((event) => event.metadata?.kind === 'manager-patrol-check')
    expect(groupPatrolEvents.length).toBeGreaterThan(0)
  })

  test('stale worker heartbeat is visible in group and task room timelines', async () => {
    const fixture = await createRunningTaskFixture({
      startedAtMsAgo: 3 * 60 * 1000,
      heartbeatAtMsAgo: 9 * 60 * 1000,
    })

    const result = await runManagerPatrol()

    expect(result.staleWorkerCount).toBeGreaterThanOrEqual(1)
    expect(
      result.actions.some(
        (action) =>
          (action.kind === 'worker_stale' || action.kind === 'worker_failed') &&
          action.workerInstanceId === fixture.workerInstance?.id,
      ),
    ).toBe(true)

    const groupRoom = await roomService.ensureRoomForSession(fixture.groupSession.id, 'default-user')
    const groupEvents = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, groupRoom.id))
    expect(
      groupEvents.some(
        (event) =>
          event.type === 'manager.message' &&
          event.metadata?.kind === 'manager-patrol-check' &&
          event.metadata?.patrolKind === 'worker_stale' &&
          event.metadata?.workerInstanceId === fixture.workerInstance?.id,
      ),
    ).toBe(true)
    const groupWarning = groupEvents.find(
      (event) =>
        event.metadata?.kind === 'manager-patrol-check' &&
        event.metadata?.patrolKind === 'worker_stale' &&
        event.metadata?.workerInstanceId === fixture.workerInstance?.id,
    )
    expect(groupWarning?.metadata?.severity).toBe('warning')
    expect(groupWarning?.metadata?.leaseAction).toBe('none')
    expect(groupWarning?.metadata?.recoveryPolicy).toBe('manager_inspect_before_stale_or_fail')

    const taskEvents = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, fixture.taskRoom.id))
    expect(
      taskEvents.some(
        (event) =>
          event.type === 'task.progress' &&
          event.metadata?.kind === 'manager-patrol-check' &&
          event.metadata?.patrolKind === 'worker_stale' &&
          event.metadata?.workerInstanceId === fixture.workerInstance?.id,
      ),
    ).toBe(true)

    const [lease] = await db
      .select()
      .from(runtimeLeases)
      .where(eq(runtimeLeases.id, fixture.runtimeLease!.id))
      .limit(1)
    expect(lease?.status).toBe('running')
  })
})

async function createRunningTaskFixture(input: {
  startedAtMsAgo?: number
  heartbeatAtMsAgo?: number
} = {}) {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Patrol Room Timeline Workspace',
      goal: 'Keep task supervision visible',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Worker',
      role: '执行巡检任务',
      roleType: 'coder',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [groupSession] = await db
    .insert(sessions)
    .values({
      ownerId: 'default-user',
      title: 'Patrol Group',
      type: 'group',
      workspaceId: workspace!.id,
      metadata: { kind: 'workspace-agent-group' },
    })
    .returning()
  const [childSession] = await db
    .insert(sessions)
    .values({
      ownerId: 'default-user',
      title: 'Patrol Task',
      type: 'direct',
      workspaceId: workspace!.id,
      metadata: { kind: 'orchestrator-task' },
    })
    .returning()
  const [run] = await db
    .insert(orchestratorRuns)
    .values({
      workspaceId: workspace!.id,
      groupSessionId: groupSession!.id,
      status: 'running',
      plan: { source: 'manager-patrol-room-timeline-test' },
    })
    .returning()
  const startedAt = new Date(Date.now() - (input.startedAtMsAgo ?? 11 * 60 * 1000))
  const [task] = await db
    .insert(workspaceTasks)
    .values({
      workspaceId: workspace!.id,
      runId: run!.id,
      sessionId: childSession!.id,
      agentId: agent!.id,
      title: '长时间运行任务',
      description: '保持运行直到 ManagerPatrol 发现超时。',
      status: 'running',
      progressStatus: 'running',
      startedAt,
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
  await db.update(taskThreads).set({ status: 'active' }).where(eq(taskThreads.id, thread.id))
  let runtimeLease: typeof runtimeLeases.$inferSelect | null = null
  if (workerInstance) {
    const [insertedRuntimeLease] = await db
      .insert(runtimeLeases)
      .values({
        workspaceId: workspace!.id,
        runId: run!.id,
        taskId: task!.id,
        workerInstanceId: workerInstance.id,
        provider: 'local-workdir',
        status: 'running',
        cwd: workspace!.projectPath ?? null,
        homeDir: `patrol-home-${task!.id}`,
        configDir: `patrol-config-${task!.id}`,
        cacheDir: `patrol-cache-${task!.id}`,
        tmpDir: `patrol-tmp-${task!.id}`,
        dataDir: `patrol-data-${task!.id}`,
        startedAt,
      })
      .returning()
    runtimeLease = insertedRuntimeLease ?? null
    await db
      .update(dbApi.workerInstances)
      .set({
        observedState: 'busy',
        lastHeartbeatAt: new Date(Date.now() - (input.heartbeatAtMsAgo ?? 0)),
        updatedAt: new Date(),
      })
      .where(eq(dbApi.workerInstances.id, workerInstance.id))
  }
  const taskRoom = await roomService.ensureRoomForTaskThread({
    ownerId: 'default-user',
    workspaceId: workspace!.id,
    groupSessionId: groupSession!.id,
    sessionId: childSession!.id,
    runId: run!.id,
    taskId: task!.id,
    taskThreadId: thread.id,
    title: '任务：长时间运行任务',
    workspaceAgentId: agent!.id,
    workerInstanceId: workerInstance?.id ?? null,
  })
  await roomService.addWorkerParticipant(taskRoom.id, agent!.id)
  const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, taskRoom.id))
  expect(participants.some((participant) => participant.workspaceAgentId === agent!.id)).toBe(true)

  return {
    workspace: workspace!,
    agent: agent!,
    groupSession: groupSession!,
    childSession: childSession!,
    run: run!,
    task: task!,
    thread,
    taskRoom,
    workerInstance,
    runtimeLease: runtimeLease ?? null,
  }
}
