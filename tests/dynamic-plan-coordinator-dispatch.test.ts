import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const { runController } = await import('../apps/server/src/services/orchestrator/run-controller')
const { __messageRouteTestHooks } = await import('../apps/server/src/routes/messages')

const {
  db,
  artifacts,
  messages,
  orchestratorRuns,
  rooms,
  runtimeLeases,
  sessions,
  timelineEvents,
  workspaceAgents,
  workspaceTasks,
  workspaces,
  eq,
} = dbApi

type WorkerRuntime = typeof import('../apps/server/src/services/worker-runtime').WorkerRuntime
type WorkerRuntimeContext = typeof import('../apps/server/src/services/worker-runtime').WorkerRuntimeContext
type WorkerRuntimeEvent = typeof import('../apps/server/src/services/worker-runtime').WorkerRuntimeEvent
type WorkerRuntimeResult = typeof import('../apps/server/src/services/worker-runtime').WorkerRuntimeResult

describe('dynamic plan dispatch through CoordinatorRuntime', () => {
  test('executes a dynamic Orchestrator plan through task rooms and WorkerRuntime', async () => {
    const { workspace, session, message, orchestrator, researcher, builder } = await createPlanningFixture()
    const run = await runController.start({
      workspaceId: workspace.id,
      groupSessionId: session.id,
      goal: message.content,
      actor: orchestrator,
      decision: {
        action: 'plan',
        reason: 'dynamic test plan',
        message: 'I will coordinate workers through task rooms.',
        memberProposalCount: 0,
      },
    })

    const monitor = await __messageRouteTestHooks.startPlanRunWithCoordinatorAssignBatch({
      sessionId: session.id,
      workspaceId: workspace.id,
      ownerId: 'default-user',
      run,
      sourceMessage: message,
      executeInline: true,
      workerRuntime: new FakePlanWorkerRuntime(),
      plan: {
        kind: 'orchestrator_plan',
        title: '市场研究与页面交付',
        goal: message.content,
        summary: 'Research first, then build.',
        agents: [
          {
            key: 'researcher',
            name: 'Researcher',
            role: '市场研究',
            roleType: 'researcher',
            runtimeType: 'code-agent',
            codeAgentType: 'opencode',
          },
          {
            key: 'builder',
            name: 'Builder',
            role: '页面实现',
            roleType: 'coder',
            runtimeType: 'code-agent',
            codeAgentType: 'opencode',
          },
        ],
        phases: [
          {
            id: 'execution',
            title: '执行',
            purpose: '透明派发给 Worker',
            taskIds: ['research', 'build'],
          },
        ],
        tasks: [
          {
            id: 'research',
            title: '收集市场资料',
            description: '调研今天的 A 股、港股、美股市场情况。',
            agentKey: 'researcher',
            dependencies: [],
          },
          {
            id: 'build',
            title: '生成 HTML 报告',
            description: '基于研究结果生成 HTML 页面报告。',
            agentKey: 'builder',
            dependencies: ['research'],
          },
        ],
      },
    })

    expect(monitor.dispatchId).toBe(run.runId)
    expect(monitor.taskIds).toHaveLength(2)

    const runRows = await db.select().from(orchestratorRuns).where(eq(orchestratorRuns.id, run.runId))
    expect(runRows[0]?.status).toBe('completed')
    expect(runRows[0]?.plan?.schema).toBe('agenthub.hiclaw-lite.assign-batch.v1')
    expect(runRows[0]?.plan?.source).toBe('coordinator-runtime.assign')

    const taskRows = await db.select().from(workspaceTasks).where(eq(workspaceTasks.runId, run.runId))
    expect(taskRows).toHaveLength(2)
    const researchTask = taskRows.find((task) => task.title === '收集市场资料')
    const buildTask = taskRows.find((task) => task.title === '生成 HTML 报告')
    expect(researchTask?.status).toBe('done')
    expect(buildTask?.status).toBe('done')
    expect(researchTask?.agentId).toBe(researcher.id)
    expect(buildTask?.agentId).toBe(builder.id)
    expect(buildTask?.dependencies).toEqual([researchTask!.id])

    const taskRooms = await db.select().from(rooms).where(eq(rooms.runId, run.runId))
    expect(taskRooms).toHaveLength(2)
    expect(new Set(taskRooms.map((room) => room.kind))).toEqual(new Set(['task']))

    const groupRoom = await db.select().from(rooms).where(eq(rooms.sessionId, session.id))
    const groupTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, groupRoom[0]!.id))
    expect(groupTimeline.filter((event) => event.type === 'task.assigned')).toHaveLength(2)
    expect(groupTimeline.every((event) => event.metadata?.kind !== 'legacy-orchestrator-engine')).toBe(true)

    for (const taskRoom of taskRooms) {
      const taskTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, taskRoom.id))
      expect(taskTimeline.some((event) => event.type === 'task.assigned')).toBe(true)
      expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.started')).toBe(true)
      expect(taskTimeline.some((event) => event.type === 'artifact.created')).toBe(true)
      expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.completed')).toBe(true)
    }

    const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.runId, run.runId))
    expect(leaseRows).toHaveLength(2)
    expect(leaseRows.every((lease) => lease.status === 'released')).toBe(true)
    expect(new Set(leaseRows.map((lease) => lease.homeDir)).size).toBe(2)

    const artifactRows = await db.select().from(artifacts).where(eq(artifacts.runId, run.runId))
    expect(artifactRows).toHaveLength(2)
    expect(artifactRows.every((artifact) => artifact.objectKey?.includes('/tasks/'))).toBe(true)
  })
})

async function createPlanningFixture() {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Dynamic Plan Workspace',
      goal: 'Coordinate a transparent team.',
    })
    .returning()
  const [orchestrator] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Manager',
      role: 'AI 主管',
      roleType: 'orchestrator',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [researcher] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Researcher',
      role: '市场研究',
      roleType: 'researcher',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [builder] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Builder',
      role: '页面实现',
      roleType: 'coder',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [session] = await db
    .insert(sessions)
    .values({
      ownerId: 'default-user',
      title: 'Dynamic Plan Group',
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
      content: '调研今天全球市场并生成 HTML 报告',
      metadata: null,
    })
    .returning()
  return {
    workspace: workspace!,
    session: session!,
    message: message!,
    orchestrator: orchestrator!,
    researcher: researcher!,
    builder: builder!,
  }
}

class FakePlanWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield {
      type: 'progress',
      message: `开始执行：${context.prompt}`,
      progressPercent: 25,
    }
    yield {
      type: 'artifact',
      message: '写入阶段产物',
      artifact: {
        id: `artifact-${context.taskId}`,
        kind: 'file',
        title: `${context.taskId}.md`,
        path: `${context.taskId}.md`,
        content: `# ${context.prompt}`,
      },
    }
    return {
      runtimeType: this.runtimeType,
      status: 'completed',
      message: `完成：${context.prompt}`,
      artifacts: [
        {
          id: `artifact-${context.taskId}`,
          kind: 'file',
          title: `${context.taskId}.md`,
          path: `${context.taskId}.md`,
          content: `# ${context.prompt}`,
        },
      ],
    }
  }
}
