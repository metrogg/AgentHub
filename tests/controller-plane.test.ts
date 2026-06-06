import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const {
  db,
  eq,
  workerInstances,
  workspaceAgents,
  workspaces,
} = dbApi

const {
  ControllerApi,
  ReconcileQueue,
  condition,
  controllerReconcileQueue,
  describeControllerPlane,
  resourceKey,
  resourceRef,
} = await import('../apps/server/src/services/controller-plane')

describe('Controller Plane', () => {
  test('resource refs and conditions use stable control-plane shape', () => {
    const ref = resourceRef('Worker', 'worker-1', 'workspace-1')
    expect(resourceKey(ref)).toBe('workspace-1:Worker:worker-1')

    const ready = condition('Ready', 'true', {
      reason: 'listening',
      message: 'Worker Matrix listener is ready.',
      observedGeneration: 7,
    })
    expect(ready.type).toBe('Ready')
    expect(ready.status).toBe('true')
    expect(ready.reason).toBe('listening')
    expect(ready.observedGeneration).toBe(7)
    expect(ready.lastTransitionAt).toBeTruthy()
  })

  test('reconcile queue deduplicates by resource key and requeues delayed work', async () => {
    const queue = new ReconcileQueue()
    const calls: string[] = []
    queue.register('Worker', async (request) => {
      calls.push(request.reason)
      return {
        ref: request.ref,
        phase: calls.length === 1 ? 'first-pass' : 'second-pass',
        changed: calls.length === 1,
        requeueAfterMs: calls.length === 1 ? 5 : undefined,
      }
    })

    queue.enqueue({
      ref: resourceRef('Worker', 'worker-queue-test', 'workspace-queue-test'),
      reason: 'worker-created',
    })
    queue.enqueue({
      ref: resourceRef('Worker', 'worker-queue-test', 'workspace-queue-test'),
      reason: 'worker-updated',
    })

    expect(queue.size()).toBe(1)
    expect(queue.describe()).toMatchObject({
      running: false,
      size: 1,
      pendingKeys: ['workspace-queue-test:Worker:worker-queue-test'],
      registeredKinds: ['Worker'],
    })
    const first = await queue.drainOnce()
    expect(first).toHaveLength(1)
    expect(first[0]?.phase).toBe('first-pass')
    expect(calls[0]).toBe('worker-created,worker-updated')

    const early = await queue.drainOnce(Date.now())
    expect(early).toHaveLength(0)

    const second = await queue.drainOnce(Date.now() + 10)
    expect(second).toHaveLength(1)
    expect(second[0]?.phase).toBe('second-pass')
  })

  test('controller API applies a workspace agent into a Worker resource', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Plane Workspace',
        goal: 'Validate lightweight control plane',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Controller Worker',
        role: 'Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
        skillIds: ['task-management'],
        sandboxPolicy: 'workspace-write',
      })
      .returning()

    const api = new ControllerApi()
    const resource = await api.applyWorker({
      workspaceId: workspace!.id,
      workspaceAgentId: agent!.id,
      reason: 'test apply',
    })

    expect(resource?.kind).toBe('Worker')
    expect(resource?.spec.workspaceAgentId).toBe(agent!.id)
    expect(resource?.status.conditions.some((item) => item.type === 'Ready')).toBe(true)

    const [worker] = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.workspaceAgentId, agent!.id))
      .limit(1)
    expect(worker?.workspaceId).toBe(workspace!.id)
    expect(worker?.runtimeBase).toBe('codex')
  })

  test('controller API does not default a newly created Worker to Codex when runtime base is missing', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Missing Runtime Workspace',
        goal: 'Validate worker runtime base is explicit',
      })
      .returning()
    const api = new ControllerApi()

    await expect(api.createWorker({
      workspaceId: workspace!.id,
      name: 'Runtime Missing Worker',
      modelId: 'test-model',
      role: 'Worker',
    })).rejects.toThrow(/explicit worker runtime base/)
  })

  test('default controller reconcile queue dispatches Worker requests to ControllerApi', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Queue Workspace',
        goal: 'Validate default queue',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Queued Worker',
        role: 'Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
      })
      .returning()
    const api = new ControllerApi()
    const resource = await api.applyWorker({
      workspaceId: workspace!.id,
      workspaceAgentId: agent!.id,
    })

    controllerReconcileQueue.enqueue({
      ref: resourceRef('Worker', resource!.metadata.id, workspace!.id),
      reason: 'test-dispatch',
      payload: { workspaceId: workspace!.id },
    })
    const results = await controllerReconcileQueue.drainOnce()
    expect(results).toHaveLength(1)
    expect(results[0]?.ref.kind).toBe('Worker')
    expect(results[0]?.error).toBeUndefined()
  })

  test('controller plane diagnostics expose resource counts and ownership boundaries', async () => {
    const diagnostics = await describeControllerPlane()

    expect(diagnostics.apiVersion).toBe('agenthub.dev/v1alpha1')
    expect(diagnostics.mode).toBe('in-process')
    expect(diagnostics.queue.registeredKinds).toContain('Worker')
    expect(diagnostics.queue.registeredKinds).toContain('Room')
    expect(diagnostics.resources.workspaceAgents).toBeGreaterThanOrEqual(0)
    expect(diagnostics.resources.workerInstances).toBeGreaterThanOrEqual(0)
    expect(diagnostics.resources.rooms).toBeGreaterThanOrEqual(0)
    expect(diagnostics.boundaries.controllerOwns.join(' ')).toContain('Room')
    expect(diagnostics.boundaries.managerOwns.join(' ')).toContain('assign work')
    expect(diagnostics.boundaries.uiReadsFrom.join(' ')).toContain('Matrix Room timeline')
  })
})
