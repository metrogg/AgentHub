import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const {
  db,
  eq,
  orchestratorRunEvents,
  orchestratorRuns,
  sessions,
  workerInstances,
  workspaceAgents,
  workspaces,
} = dbApi
const { workerController } = await import('../apps/server/src/services/orchestrator/worker-controller')

describe('WorkerController heartbeat supervision', () => {
  test('stale heartbeat keeps busy Worker alive and asks Manager to inspect', async () => {
    const fixture = await createBusyWorkerFixture({
      heartbeatAtMsAgo: 16 * 60 * 1000,
    })

    const result = await workerController.reconcile(fixture.worker.id, {
      workspaceId: fixture.workspace.id,
      groupSessionId: fixture.run.groupSessionId,
      runId: fixture.run.id,
      actorId: fixture.agent.id,
    })

    expect(result.error).toBeUndefined()
    expect(result.phase).toBe('complete')

    const [worker] = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, fixture.worker.id))
      .limit(1)
    expect(worker?.observedState).toBe('busy')
    expect(worker?.health?.staleHeartbeat).toBe(true)
    expect(worker?.health?.staleReason).toBe('worker_heartbeat_stale')
    expect(worker?.message).toContain('Keeping the Worker busy')

    const events = await db
      .select()
      .from(orchestratorRunEvents)
      .where(eq(orchestratorRunEvents.runId, fixture.run.id))
    expect(events.some((event) => event.type === 'task.failed')).toBe(false)
    expect(events.some((event) =>
      event.type === 'manager.next_action' &&
      event.severity === 'warning' &&
      event.payload?.action === 'worker_heartbeat_stale' &&
      event.workerInstanceId === fixture.worker.id,
    )).toBe(true)
  })
})

async function createBusyWorkerFixture(input: { heartbeatAtMsAgo: number }) {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Worker Heartbeat Supervision Workspace',
      goal: 'Validate stale heartbeat does not fail long running work',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Long Running Worker',
      role: 'Worker',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
      modelId: 'test-model',
    })
    .returning()
  const [groupSession] = await db
    .insert(sessions)
    .values({
      workspaceId: workspace!.id,
      ownerId: 'default-user',
      title: 'Worker Heartbeat Supervision Group',
      type: 'group',
    })
    .returning()
  const [run] = await db
    .insert(orchestratorRuns)
    .values({
      workspaceId: workspace!.id,
      groupSessionId: groupSession!.id,
      status: 'running',
    })
    .returning()
  const [worker] = await db
    .insert(workerInstances)
    .values({
      workspaceId: workspace!.id,
      workspaceAgentId: agent!.id,
      runtimeFamily: 'worker',
      runtimeBase: 'opencode',
      modelId: 'test-model',
      observedState: 'busy',
      desiredState: 'running',
      lastHeartbeatAt: new Date(Date.now() - input.heartbeatAtMsAgo),
      health: {},
    })
    .returning()

  return {
    workspace: workspace!,
    agent: agent!,
    run: run!,
    worker: worker!,
  }
}
