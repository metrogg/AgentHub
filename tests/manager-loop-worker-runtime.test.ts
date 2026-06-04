import './setup'
import { describe, expect, test } from 'bun:test'
import type {
  WorkerRuntime,
  WorkerRuntimeContext,
  WorkerRuntimeEvent,
  WorkerRuntimeResult,
} from '../apps/server/src/services/worker-runtime'

const dbApi = await import('../packages/db/src/index')
const { managerLoopStep } = await import('../apps/server/src/services/orchestrator/manager-loop')
const { ensureTaskThread } = await import('../apps/server/src/services/orchestrator/task-thread-service')
const { ensureWorkerInstance } = await import('../apps/server/src/services/orchestrator/worker-runtime-resources')
const { roomService } = await import('../apps/server/src/services/rooms')

const {
  artifacts,
  db,
  eq,
  orchestratorRunEvents,
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

describe('ManagerLoop dispatches prepared task rooms through WorkerRuntime', () => {
  test('prepared pending task room is assigned and completed without legacy engine dispatch', async () => {
    const fixture = await createPreparedTaskRoomFixture()
    const runtime = new CompletingManagerLoopWorkerRuntime()

    const result = await managerLoopStep(fixture.run.id, {
      workerRuntime: runtime,
      executeInline: true,
    })

    expect(result.action).toBe('dispatch_pending')
    expect(result.dispatchedTaskIds).toEqual([fixture.task.id])
    expect(runtime.prompts).toEqual(['完成这份透明协作报告。'])

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, fixture.task.id))
    expect(taskRows[0]?.status).toBe('done')
    expect(taskRows[0]?.progressStatus).toBe('completed')

    const threadRows = await db.select().from(taskThreads).where(eq(taskThreads.id, fixture.thread.id))
    expect(threadRows[0]?.status).toBe('completed')

    const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, fixture.room.id))
    expect(
      participants.some(
        (participant) =>
          participant.participantType === 'worker' &&
          participant.workspaceAgentId === fixture.agent.id,
      ),
    ).toBe(true)

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, fixture.room.id))
    expect(events.some((event) => event.metadata?.kind === 'manager-loop.dispatch')).toBe(true)
    expect(events.some((event) => event.metadata?.kind === 'worker-runtime.started')).toBe(true)
    expect(events.some((event) => event.metadata?.kind === 'worker-runtime.progress')).toBe(true)
    expect(events.some((event) => event.type === 'artifact.created')).toBe(true)
    expect(
      events.some(
        (event) =>
          event.metadata?.kind === 'worker-runtime.completed' &&
          event.metadata?.status === 'completed',
      ),
    ).toBe(true)

    const artifactRows = await db.select().from(artifacts).where(eq(artifacts.taskId, fixture.task.id))
    expect(artifactRows).toHaveLength(1)
    expect(artifactRows[0]?.title).toBe('manager-loop-report.md')
    expect(artifactRows[0]?.objectKey).toContain('/tasks/')

    const runEvents = await db
      .select()
      .from(orchestratorRunEvents)
      .where(eq(orchestratorRunEvents.runId, fixture.run.id))
    expect(runEvents.some((event) => event.type === 'task.assigned')).toBe(true)
    expect(runEvents.some((event) => event.type === 'task.completed')).toBe(true)
    expect(
      runEvents.every(
        (event) => event.payload?.kind !== 'legacy-orchestrator-engine',
      ),
    ).toBe(true)
  })

  test('blocked task waiting for human is not redispatched by ManagerLoop', async () => {
    const fixture = await createPreparedTaskRoomFixture({
      taskStatus: 'blocked',
      progressStatus: 'awaiting_human_clarification',
      threadStatus: 'waiting_for_human',
    })
    const runtime = new CompletingManagerLoopWorkerRuntime()

    const result = await managerLoopStep(fixture.run.id, {
      workerRuntime: runtime,
      executeInline: true,
    })

    expect(result.action).toBe('waiting')
    expect(result.reason).toContain('waiting for human clarification')
    expect(result.dispatchedTaskIds).toEqual([])
    expect(result.reviewedTaskIds).toEqual([fixture.task.id])
    expect(runtime.prompts).toEqual([])

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, fixture.task.id))
    expect(taskRows[0]?.status).toBe('blocked')
    expect(taskRows[0]?.progressStatus).toBe('awaiting_human_clarification')
    const threadRows = await db.select().from(taskThreads).where(eq(taskThreads.id, fixture.thread.id))
    expect(threadRows[0]?.status).toBe('waiting_for_human')
  })
})

async function createPreparedTaskRoomFixture(input: {
  taskStatus?: 'pending' | 'blocked'
  progressStatus?: string | null
  threadStatus?: 'prepared' | 'waiting_for_human'
} = {}) {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'ManagerLoop WorkerRuntime Workspace',
      goal: 'Verify ManagerLoop dispatch',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Worker',
      role: '执行透明任务',
      roleType: 'coder',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [groupSession] = await db
    .insert(sessions)
    .values({
      ownerId: 'default-user',
      title: 'ManagerLoop Dispatch Group',
      type: 'group',
      workspaceId: workspace!.id,
      metadata: { kind: 'workspace-agent-group' },
    })
    .returning()
  const [childSession] = await db
    .insert(sessions)
    .values({
      ownerId: 'default-user',
      title: 'Prepared Task Room',
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
      plan: {
        schema: 'agenthub.hiclaw-lite.manager-loop-test.v1',
        source: 'room-timeline',
      },
    })
    .returning()
  const [task] = await db
    .insert(workspaceTasks)
    .values({
      workspaceId: workspace!.id,
      runId: run!.id,
      sessionId: childSession!.id,
      agentId: agent!.id,
      title: '透明协作报告',
      description: '完成这份透明协作报告。',
      status: input.taskStatus ?? 'pending',
      progressStatus: input.progressStatus ?? 'thread-prepared',
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
  if (input.threadStatus && input.threadStatus !== 'prepared') {
    await db
      .update(taskThreads)
      .set({ status: input.threadStatus, updatedAt: new Date() })
      .where(eq(taskThreads.id, thread.id))
    thread.status = input.threadStatus
  }
  await db.insert(runtimeLeases).values({
    workspaceId: workspace!.id,
    runId: run!.id,
    taskId: task!.id,
    workerInstanceId: thread.workerInstanceId,
    provider: 'local-workdir',
    status: 'ready',
    cwd: workspace!.projectPath ?? null,
    homeDir: `manager-loop-home-${task!.id}`,
    configDir: `manager-loop-config-${task!.id}`,
    cacheDir: `manager-loop-cache-${task!.id}`,
    tmpDir: `manager-loop-tmp-${task!.id}`,
    dataDir: `manager-loop-data-${task!.id}`,
    metadata: { source: 'manager-loop-worker-runtime-test' },
  })
  const room = await roomService.ensureRoomForTaskThread({
    ownerId: 'default-user',
    workspaceId: workspace!.id,
    groupSessionId: groupSession!.id,
    sessionId: childSession!.id,
    runId: run!.id,
    taskId: task!.id,
    taskThreadId: thread.id,
    title: 'Prepared Task Room',
    workspaceAgentId: agent!.id,
    workerInstanceId: thread.workerInstanceId,
  })
  return {
    workspace: workspace!,
    agent: agent!,
    groupSession: groupSession!,
    childSession: childSession!,
    run: run!,
    task: task!,
    thread,
    room,
  }
}

class CompletingManagerLoopWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
  readonly prompts: string[] = []

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    this.prompts.push(context.prompt)
    yield {
      type: 'progress',
      message: `ManagerLoop 已派发：${context.prompt}`,
      progressPercent: 45,
    }
    yield {
      type: 'artifact',
      message: '登记 ManagerLoop 产物',
      artifact: {
        id: `manager-loop-artifact-${context.taskId}`,
        kind: 'file',
        title: 'manager-loop-report.md',
        path: 'manager-loop-report.md',
        content: '# ManagerLoop report',
      },
    }
    return {
      runtimeType: this.runtimeType,
      status: 'completed',
      message: 'ManagerLoop 派发的任务已完成。',
      artifacts: [
        {
          id: `manager-loop-artifact-${context.taskId}`,
          kind: 'file',
          title: 'manager-loop-report.md',
          path: 'manager-loop-report.md',
          content: '# ManagerLoop report',
        },
      ],
    }
  }
}
