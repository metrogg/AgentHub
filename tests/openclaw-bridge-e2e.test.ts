import { waitForCondition } from './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const bridgeApi = await import('../apps/server/src/services/rooms/room-chat-bridge')
const workerRuntimeApi = await import('../apps/server/src/services/worker-runtime')

const {
  db,
  artifacts,
  messages,
  orchestratorRuns,
  roomParticipants,
  rooms,
  runtimeLeases,
  sessions,
  taskThreads,
  timelineEvents,
  workspaceAgents,
  workspaceTasks,
  workspaces,
  eq,
} = dbApi
const { stepCoordinatorForGroupMessage } = bridgeApi
type WorkerRuntime = workerRuntimeApi.WorkerRuntime
type WorkerRuntimeContext = workerRuntimeApi.WorkerRuntimeContext
type WorkerRuntimeEvent = workerRuntimeApi.WorkerRuntimeEvent
type WorkerRuntimeResult = workerRuntimeApi.WorkerRuntimeResult

describe('OpenClaw Manager bridge e2e contract', () => {
  test('routes a group message through the active OpenClaw provider into assign, task room, lease, and WorkerRuntime', async () => {
    const { session, message, agentId } = await createGroupMessage()
    const bridge = createFakeOpenClawBridge(agentId)
    const previousEndpoint = process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT
    const previousRuntime = process.env.AGENTHUB_MANAGER_RUNTIME
    process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT = bridge.url
    delete process.env.AGENTHUB_MANAGER_RUNTIME

    try {
      const result = await stepCoordinatorForGroupMessage({
        session,
        userId: 'default-user',
        userName: 'Tester',
        message,
        workerRuntime: new FakeWorkerRuntime(),
      })

      expect(result.consumed).toBe(true)
      expect(result.actions).toHaveLength(1)
      expect(result.actions[0]?.type).toBe('assign')
      expect(result.reason).toContain('WorkerRuntime')
      expect(bridge.stepRequests).toHaveLength(1)
      expect(bridge.stepRequests[0]?.runtimeType).toBe('openclaw')
      expect(bridge.stepRequests[0]?.input?.context).toMatchObject({
        ownerId: 'default-user',
        roomId: result.roomId,
        groupSessionId: session.id,
      })
      expect(bridge.stepRequests[0]?.input?.timeline?.map((event: any) => event.type)).toEqual([
        'human.message',
        'manager.message',
      ])

      const groupTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, result.roomId))
      expect(groupTimeline.map((event) => event.type)).toEqual([
        'human.message',
        'manager.message',
        'manager.message',
        'system',
        'task.assigned',
      ])
      expect(groupTimeline[2]?.metadata?.kind).toBe('manager-runtime.thinking')
      expect(groupTimeline[3]?.metadata?.kind).toBe('manager-runtime.completed')
      expect(groupTimeline[4]?.metadata?.kind).toBe('manager.assign.dispatched')
      expect(groupTimeline.some((event) => event.metadata?.kind === 'coordinator.runtime-blocked')).toBe(false)

      const runRows = await waitForCondition(
        () => db.select().from(orchestratorRuns).where(eq(orchestratorRuns.groupSessionId, session.id)),
        (rows) => rows.length === 1 && rows[0]?.status === 'completed',
        { description: 'OpenClaw bridge assign run completed' },
      )
      expect(runRows).toHaveLength(1)
      expect(runRows[0]?.status).toBe('completed')
      expect(runRows[0]?.plan?.schema).toBe('agenthub.hiclaw-lite.assign-batch.v1')

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

      const taskTimeline = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, taskRoomRows[0]!.id))
      const assignedEvent = taskTimeline.find(
        (event) => event.type === 'task.assigned' && event.metadata?.kind === 'manager.assign.dispatched',
      )
      expect(assignedEvent?.metadata).toMatchObject({
        kind: 'manager.assign.dispatched',
        matrixExecutionBus: true,
        coordinationSource: 'matrix-mention',
      })
      expect(assignedEvent?.metadata?.mentionParticipantId).toBeTruthy()
      const [workerParticipant] = await db
        .select()
        .from(roomParticipants)
        .where(eq(roomParticipants.id, assignedEvent!.metadata!.mentionParticipantId as string))
      expect(workerParticipant?.workspaceAgentId).toBe(agentId)
      expect(workerParticipant?.workerInstanceId).toBe(threadRows[0]?.workerInstanceId)
      expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.started')).toBe(true)
      expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.progress')).toBe(true)
      expect(taskTimeline.some((event) => event.type === 'artifact.created')).toBe(true)
      expect(taskTimeline.some((event) => event.metadata?.kind === 'worker-runtime.completed')).toBe(true)

      const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.runId, runRows[0]!.id))
      expect(leaseRows).toHaveLength(1)
      expect(leaseRows[0]?.status).toBe('released')
      expect(leaseRows[0]?.homeDir).toBeTruthy()
      expect(leaseRows[0]?.configDir).toBeTruthy()

      const artifactRows = await db.select().from(artifacts).where(eq(artifacts.runId, runRows[0]!.id))
      expect(artifactRows).toHaveLength(1)
      expect(artifactRows[0]?.roomId).toBe(taskRoomRows[0]?.id)
      expect(artifactRows[0]?.objectKey).toContain('/tasks/')
    } finally {
      if (previousEndpoint === undefined) {
        delete process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT
      } else {
        process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT = previousEndpoint
      }
      if (previousRuntime === undefined) {
        delete process.env.AGENTHUB_MANAGER_RUNTIME
      } else {
        process.env.AGENTHUB_MANAGER_RUNTIME = previousRuntime
      }
      bridge.stop()
    }
  })
})

async function createGroupMessage() {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'OpenClaw Bridge Workspace',
      goal: 'Route through OpenClaw Manager bridge',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Builder',
      role: 'Build the assigned deliverable',
      roleType: 'builder',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [session] = await db
    .insert(sessions)
    .values({
      ownerId: 'default-user',
      title: 'OpenClaw Bridge Group',
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
      content: '请 Builder 做一个可验证的小任务',
      metadata: null,
    })
    .returning()
  return { workspace: workspace!, session: session!, message: message!, agentId: agent!.id }
}

function createFakeOpenClawBridge(targetWorkerId: string) {
  const stepRequests: any[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, runtimeType: 'openclaw' })
      }
      if (request.method === 'POST' && url.pathname === '/step') {
        const body = await request.json()
        stepRequests.push(body)
        return json({
          actions: [
            {
              type: 'assign',
              targetWorkerId,
              taskKey: 'openclaw-e2e-task',
              taskTitle: 'OpenClaw bridge task',
              taskDescription: 'Complete the task through a real task room and WorkerRuntime.',
              message: '@Builder 请通过任务房间完成这个验证任务。',
              reason: 'OpenClaw bridge selected Builder from the room workers.',
              metadata: { bridge: 'fake-openclaw-e2e' },
            },
          ],
        })
      }
      return json({ error: `Unhandled ${request.method} ${url.pathname}` }, 404)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stepRequests,
    stop: () => server.stop(true),
  }
}

class FakeWorkerRuntime implements WorkerRuntime {
  readonly runtimeType = 'code-agent' as const
  readonly kind = 'ephemeral-code-agent' as const

  async *executeTask(
    context: WorkerRuntimeContext,
  ): AsyncGenerator<WorkerRuntimeEvent, WorkerRuntimeResult, unknown> {
    yield {
      type: 'progress',
      message: `收到任务：${context.prompt}`,
      progressPercent: 50,
    }
    yield {
      type: 'artifact',
      message: 'OpenClaw bridge 验证报告',
      artifact: {
        id: 'openclaw-bridge-artifact',
        kind: 'file',
        title: 'openclaw-bridge-result.md',
        path: 'openclaw-bridge-result.md',
        content: '# OpenClaw bridge e2e done',
      },
    }
    return {
      runtimeType: this.runtimeType,
      kind: this.kind,
      status: 'completed',
      message: 'OpenClaw bridge task completed.',
      artifacts: [
        {
          id: 'openclaw-bridge-artifact',
          kind: 'file',
          title: 'openclaw-bridge-result.md',
          path: 'openclaw-bridge-result.md',
          content: '# OpenClaw bridge e2e done',
        },
      ],
    }
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
