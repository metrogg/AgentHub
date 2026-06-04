import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const { runtimeLeaseController } = await import('../apps/server/src/services/orchestrator/runtime-lease-controller')

const {
  db,
  eq,
  runtimeLeases,
  workerInstances,
  workspaceAgents,
  workspaces,
} = dbApi

describe('RuntimeLeaseController', () => {
  test('recovers interrupted active leases through the controller surface', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Runtime Lease Workspace',
        goal: 'Recover stale runtime lease',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Lease Worker',
        role: 'Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
      })
      .returning()
    const [worker] = await db
      .insert(workerInstances)
      .values({
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        runtimeFamily: 'worker',
        runtimeBase: 'codex',
        modelId: 'test-model',
        observedState: 'busy',
      })
      .returning()
    const lease = await runtimeLeaseController.create({
      workspaceId: workspace!.id,
      workerInstanceId: worker!.id,
      cwd: 'C:/agenthub/runtime-lease-test/work',
      homeDir: 'C:/agenthub/runtime-lease-test/home',
    })
    await runtimeLeaseController.markRunning(lease?.id, {
      metadata: { test: true },
    })

    const result = await runtimeLeaseController.recoverInterruptedLeases({
      reason: 'test recovery',
    })
    expect(result.staleLeaseCount).toBeGreaterThanOrEqual(1)
    expect(result.affectedWorkerInstanceIds).toContain(worker!.id)

    const [leaseRow] = await db.select().from(runtimeLeases).where(eq(runtimeLeases.id, lease!.id))
    expect(leaseRow?.status).toBe('stale')
    expect(leaseRow?.error).toBe('test recovery')
    expect(leaseRow?.metadata?.previousStatus).toBe('running')

    const [workerRow] = await db.select().from(workerInstances).where(eq(workerInstances.id, worker!.id))
    expect(workerRow?.observedState).toBe('failed')
    expect(workerRow?.health?.staleRuntimeLease).toBe(true)
  })

  test('summarizes workspace lease states for reconcile diagnostics', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Runtime Lease Summary Workspace',
        goal: 'Summarize runtime lease state',
      })
      .returning()

    const readyLease = await runtimeLeaseController.create({ workspaceId: workspace!.id })
    await runtimeLeaseController.markReady(readyLease?.id)
    const waitingLease = await runtimeLeaseController.create({ workspaceId: workspace!.id })
    await runtimeLeaseController.markWaitingForHuman(waitingLease?.id, {
      message: 'Need clarification',
    })

    const summary = await runtimeLeaseController.reconcileWorkspace(workspace!.id)
    expect(summary.activeCount).toBe(1)
    expect(summary.waitingForHumanCount).toBe(1)
    expect(summary.staleCount).toBe(0)
  })
})
