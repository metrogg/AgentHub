import { waitForCondition } from './setup'
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

const dbApi = await import('../packages/db/src/index')
const {
  controllerAuditEvents,
  db,
  eq,
  matrixIdentities,
  roomParticipants,
  rooms,
  sessions,
  timelineEvents,
  workerInstances,
  workspaceAgents,
  workspaces,
} = dbApi

const {
  ControllerApi,
  ReconcileQueue,
  applyControllerManifest,
  confirmControllerApplyApproval,
  condition,
  controllerReconcileQueue,
  describeControllerPlane,
  localCliWorkerBackend,
  runResidentWorkerSelfTest,
  resourceKey,
  resourceRef,
} = await import('../apps/server/src/services/controller-plane')
const { ensureWorkerAgentContract } = await import('../apps/server/src/services/agent-contract')
const { roomService } = await import('../apps/server/src/services/rooms')

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

  test('controller API recognizes QwenPaw Worker base but fails loudly until backend exists', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller QwenPaw Runtime Workspace',
        goal: 'Validate qwenpaw worker base is explicit and diagnostic',
      })
      .returning()
    const api = new ControllerApi()

    await expect(api.createWorker({
      workspaceId: workspace!.id,
      name: 'QwenPaw Resident Worker',
      runtimeBase: 'qwenpaw',
      modelId: 'test-model',
      role: 'Worker',
    })).rejects.toThrow(/QwenPaw Worker runtime is recognized but its WorkerBackend is not implemented yet/)
  })

  test('controller diagnostics marks existing QwenPaw resident Workers as blocked until backend exists', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'QwenPaw Diagnostics Workspace',
        goal: 'Validate qwenpaw diagnostics are explicit',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Legacy QwenPaw Worker',
        role: 'Resident Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: null,
        roleProfile: { workerRuntimeBase: 'qwenpaw' },
      })
      .returning()
    const [worker] = await db
      .insert(workerInstances)
      .values({
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        runtimeFamily: 'worker',
        runtimeBase: 'qwenpaw',
        modelId: 'test-model',
        observedState: 'listening',
        desiredState: 'running',
      })
      .returning()

    await db.insert(matrixIdentities).values({
      ownerType: 'worker',
      ownerId: worker!.id,
      serverName: 'agenthub.local',
      localpart: `qwenpaw-${worker!.id.slice(0, 8)}`,
      userId: `@qwenpaw-${worker!.id.slice(0, 8)}:agenthub.local`,
      accessToken: 'qwenpaw-worker-token',
      displayName: agent!.name,
    })
    await ensureWorkerAgentContract({
      workerInstanceId: worker!.id,
      agent: agent!,
      runtimeBase: 'qwenpaw',
      matrixUserId: `@qwenpaw-${worker!.id.slice(0, 8)}:agenthub.local`,
      runtimeConfigPath: 'qwenpaw.yaml',
      currentRooms: [],
    })

    const diagnostics = await describeControllerPlane()
    const workerRuntime = diagnostics.workerRuntimes.find((item) => item.workerInstanceId === worker!.id)
    expect(workerRuntime?.mode).toBe('resident-qwenpaw')
    expect(workerRuntime?.runtimeHealth.ready).toBe(false)
    expect(workerRuntime?.runtimeHealth.status).toBe('blocked')
    expect(workerRuntime?.runtimeHealth.state).toBe('resident-backend-not-implemented')
    expect(workerRuntime?.runtimeHealth.message).toContain('QwenPaw Worker runtime is recognized')
    expect(workerRuntime?.runtimeHealth.details?.implemented).toBe(false)
  })

  test('bridge Worker backend syncConfig refreshes the normalized Worker contract', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Bridge SyncConfig Workspace',
        goal: 'Validate bridge contract sync',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Bridge Sync Worker',
        role: 'Bridge Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        roleProfile: { workerRuntimeBase: 'opencode' },
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
        observedState: 'ready',
        desiredState: 'running',
      })
      .returning()

    const result = await localCliWorkerBackend.syncConfig(worker!.id)
    expect(result.synced).toBe(true)
    expect(result.details?.source).toBe('agenthub-worker-contract')
    expect(result.details?.runtimeBase).toBe('opencode')

    const diagnostics = await describeControllerPlane()
    const workerRuntime = diagnostics.workerRuntimes.find((item) => item.workerInstanceId === worker!.id)
    expect(workerRuntime?.contractReady).toBe(true)
    expect(workerRuntime?.contractFiles.soul).toBe(true)
    expect(workerRuntime?.contractFiles.agents).toBe(true)
    expect(workerRuntime?.contractFiles.runtime).toBe(true)
    expect(workerRuntime?.contractFiles.state).toBe(true)
    expect(workerRuntime?.mode).toBe('bridge')
  })

  test('bridge Worker backend inspect reports real CLI readiness instead of unknown ready', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Bridge Inspect Workspace',
        goal: 'Validate bridge backend inspect',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Bridge Inspect Worker',
        role: 'Bridge Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        roleProfile: { workerRuntimeBase: 'opencode' },
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
        observedState: 'ready',
        desiredState: 'running',
      })
      .returning()

    await localCliWorkerBackend.syncConfig(worker!.id)
    const inspected = await localCliWorkerBackend.inspect(worker!.id)

    expect(inspected.workerInstanceId).toBe(worker!.id)
    expect(inspected.state).toMatch(/^bridge-/)
    expect(inspected.state).not.toBe('unknown')
    expect(inspected.details?.source).toBe('inspectCodeAgentRuntime')
    expect(inspected.details?.runtimeBase).toBe('opencode')
    expect(inspected.details?.contractReady).toBe(true)
    expect(Array.isArray(inspected.details?.blockers)).toBe(true)
    expect(inspected.details?.inspection).toBeTruthy()
    expect(inspected.details?.parityOperations).toEqual(['inspect', 'health', 'syncConfig', 'start', 'stop'])

    const health = await localCliWorkerBackend.health(worker!.id)
    expect(health.workerInstanceId).toBe(worker!.id)
    expect(['ready', 'blocked']).toContain(health.status)
    expect(health.state).toMatch(/^bridge-/)
    expect(Array.isArray(health.blockers)).toBe(true)
    expect(health.details?.backendId).toBe('local-cli')
    expect(health.details?.source).toBe('inspectCodeAgentRuntime')
  }, 15_000)

  test('controller apply creates Worker resources from manifest objects', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Apply Worker Workspace',
        goal: 'Validate apply worker manifest',
      })
      .returning()
    const api = new ControllerApi({
      workerBackend: {
        id: 'apply-test-worker-backend',
        async ensureRuntime(input) {
          return { workerInstanceId: input.workerInstanceId, ready: true, state: 'ready' }
        },
        async start() {
          return { started: true }
        },
        async stop() {
          return { stopped: true }
        },
        async inspect(workerInstanceId) {
          return { workerInstanceId, ready: true, state: 'ready' }
        },
        async health(workerInstanceId) {
          return {
            workerInstanceId,
            ready: true,
            status: 'ready',
            state: 'ready',
            message: 'test backend ready',
            blockers: [],
            lastCheckedAt: new Date().toISOString(),
          }
        },
        async syncConfig(workerInstanceId) {
          return { synced: true, details: { workerInstanceId } }
        },
      },
    })

    const result = await applyControllerManifest(api, {
      resource: {
        apiVersion: 'agenthub.dev/v1alpha1',
        kind: 'Worker',
        metadata: { name: 'Applied Worker' },
        spec: {
          workspaceId: workspace!.id,
          runtimeBase: 'opencode',
          modelId: 'test-model',
          role: 'Applied Engineer',
          skillIds: ['task-management'],
          sandboxPolicy: { mode: 'workspace-write' },
          createDirectSession: false,
          announce: false,
        },
      },
    })

    expect(result.success).toBe(true)
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0]?.kind).toBe('Worker')
    expect(result.applied[0]?.approval).toMatchObject({
      level: 'recommended',
      required: false,
      provided: false,
    })
    expect(result.applied[0]?.auditEventId).toBeTruthy()
    expect(result.applied[0]?.audit).toMatchObject({
      operationId: 'workers.create',
      applyOperationId: 'apply.manifest',
      danger: 'write',
      manifestKind: 'Worker',
      manifestName: 'Applied Worker',
    })
    expect(result.applied[0]?.audit.fields).toMatchObject({
      workspaceId: workspace!.id,
      name: 'Applied Worker',
      runtimeBase: 'opencode',
      modelId: 'test-model',
    })

    const [auditRow] = await db
      .select()
      .from(controllerAuditEvents)
      .where(eq(controllerAuditEvents.id, result.applied[0]!.auditEventId!))
      .limit(1)
    expect(auditRow).toMatchObject({
      operationId: 'workers.create',
      applyOperationId: 'apply.manifest',
      danger: 'write',
      approvalLevel: 'recommended',
      approvalRequired: false,
      approvalProvided: false,
      manifestKind: 'Worker',
      manifestName: 'Applied Worker',
      workspaceId: workspace!.id,
      resourceKind: 'Worker',
    })
    expect(auditRow?.auditFields).toMatchObject({
      workspaceId: workspace!.id,
      runtimeBase: 'opencode',
      modelId: 'test-model',
    })
    expect(auditRow?.resultSummary?.workerInstanceId).toBeTruthy()

    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.name, 'Applied Worker'))
      .limit(1)
    expect(agent?.workspaceId).toBe(workspace!.id)
    expect(agent?.roleProfile?.workerRuntimeBase).toBe('opencode')
    expect(agent?.skillIds).toEqual(['task-management'])
    expect(agent?.sandboxPolicy).toBe('workspace-write')
  })

  test('controller apply validates Worker manifests before reconcile', async () => {
    const api = new ControllerApi()

    await expect(applyControllerManifest(api, {
      resource: {
        kind: 'Worker',
        metadata: { name: 'Missing Model Worker' },
        spec: {
          workspaceId: 'workspace-apply-validation',
          runtimeBase: 'opencode',
        },
      },
    })).rejects.toThrow(/spec\.modelId/)

    await expect(applyControllerManifest(api, {
      resource: {
        kind: 'Worker',
        metadata: { name: 'Bad Runtime Worker' },
        spec: {
          workspaceId: 'workspace-apply-validation',
          runtimeBase: 'llm',
          modelId: 'test-model',
        },
      },
    })).rejects.toThrow(/spec\.runtimeBase/)
  })

  test('controller apply can request Room-native approval before applying resources', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Apply Approval Workspace',
        goal: 'Validate Room-native Controller approval request',
      })
      .returning()
    const room = await roomService.createRoom({
      ownerId: 'default-user',
      workspaceId: workspace!.id,
      kind: 'group',
      title: 'Controller Approval Room',
    })
    const api = new ControllerApi({
      workerBackend: {
        id: 'apply-approval-worker-backend',
        async ensureRuntime(input) {
          return { workerInstanceId: input.workerInstanceId, ready: true, state: 'ready' }
        },
        async start() {
          return { started: true }
        },
        async stop() {
          return { stopped: true }
        },
        async inspect(workerInstanceId) {
          return { workerInstanceId, ready: true, state: 'ready' }
        },
        async health(workerInstanceId) {
          return {
            workerInstanceId,
            ready: true,
            status: 'ready',
            state: 'ready',
            message: 'test backend ready',
            blockers: [],
            lastCheckedAt: new Date().toISOString(),
          }
        },
        async syncConfig(workerInstanceId) {
          return { synced: true, details: { workerInstanceId } }
        },
      },
    })

    const manifest = {
      apiVersion: 'agenthub.dev/v1alpha1',
      kind: 'Worker',
      metadata: { name: 'Approval Worker' },
      spec: {
        workspaceId: workspace!.id,
        runtimeBase: 'opencode',
        modelId: 'test-model',
        createDirectSession: false,
        announce: false,
      },
    }
    const requested = await applyControllerManifest(api, {
      resource: manifest,
      approvalMode: 'request',
      requestApprovalRoomId: room.id,
      approvalRequest: {
        reason: 'Need human confirmation before adding a Worker.',
        requestedBy: 'manager-test',
      },
    })

    expect(requested.success).toBe(true)
    expect(requested.approvalRequested).toBe(true)
    expect(requested.applied).toHaveLength(0)
    expect(requested.approvalEventId).toBeTruthy()

    const [approvalEvent] = await db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.id, requested.approvalEventId!))
      .limit(1)
    expect(approvalEvent?.type).toBe('approval.requested')
    expect(approvalEvent?.metadata).toMatchObject({
      kind: 'controller.apply.approval.requested',
      actionType: 'controller_apply',
      status: 'pending',
      requestedBy: 'manager-test',
    })

    const beforeConfirm = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.name, 'Approval Worker'))
      .limit(1)
    expect(beforeConfirm).toHaveLength(0)

    const confirmed = await confirmControllerApplyApproval(api, {
      approvalEventId: requested.approvalEventId!,
      approvedBy: 'human-default',
      reason: 'Looks good.',
    })

    expect(confirmed.success).toBe(true)
    expect(confirmed.applied[0]?.approval).toMatchObject({
      level: 'recommended',
      provided: true,
      approvedBy: 'human-default',
      reason: 'Looks good.',
    })
    expect(confirmed.applied[0]?.auditEventId).toBeTruthy()

    const [updatedApprovalEvent] = await db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.id, requested.approvalEventId!))
      .limit(1)
    expect(updatedApprovalEvent?.metadata?.status).toBe('approved')
    expect(updatedApprovalEvent?.metadata?.resolution).toMatchObject({
      status: 'approved',
      resolvedBy: 'human-default',
      appliedCount: 1,
    })

    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.name, 'Approval Worker'))
      .limit(1)
    expect(agent?.workspaceId).toBe(workspace!.id)

    await expect(confirmControllerApplyApproval(api, {
      approvalEventId: requested.approvalEventId!,
      approvedBy: 'human-default',
    })).rejects.toThrow(/already been approved/)
  })

  test('controller apply validates Room manifest kind against Controller schema', async () => {
    const api = new ControllerApi()

    await expect(applyControllerManifest(api, {
      resource: {
        kind: 'Room',
        metadata: { name: 'Bad Room' },
        spec: {
          ownerId: 'default-user',
          title: 'Bad Room',
          kind: 'legacy-chat',
        },
      },
    })).rejects.toThrow(/spec\.kind/)
  })

  test('controller apply creates Team manifests with existing Worker members only', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Apply Team Workspace',
        goal: 'Validate team manifest apply',
      })
      .returning()
    const [workerAgent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'existing-builder',
        role: 'Worker',
        roleType: 'coder',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        modelId: 'test-model',
        roleProfile: { workerRuntimeBase: 'opencode' },
      })
      .returning()
    const api = new ControllerApi()

    const result = await applyControllerManifest(api, {
      resource: {
        kind: 'Team',
        metadata: { name: 'delivery-team' },
        spec: {
          workspaceId: workspace!.id,
          leaderName: 'delivery-lead',
          workers: ['existing-builder'],
          description: 'Coordinates implementation delivery.',
        },
      },
    })

    expect(result.success).toBe(true)
    expect(result.applied[0]?.kind).toBe('Team')
    expect(result.applied[0]?.result).toMatchObject({
      name: 'delivery-team',
      workspaceId: workspace!.id,
      memberIds: [workerAgent!.id],
      description: 'Coordinates implementation delivery.',
    })

    const [leader] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.name, 'delivery-lead'))
      .limit(1)
    expect(leader?.workspaceId).toBe(workspace!.id)
    expect(leader?.roleType).toBe('orchestrator')

    await expect(applyControllerManifest(api, {
      resource: {
        kind: 'Team',
        metadata: { name: 'bad-team' },
        spec: {
          workspaceId: workspace!.id,
          workers: ['missing-worker'],
        },
      },
    })).rejects.toThrow(/Apply a Worker manifest/)
  })

  test('controller apply creates Human manifests through Controller API', async () => {
    const api = new ControllerApi()

    const result = await applyControllerManifest(api, {
      resource: {
        kind: 'Human',
        metadata: { name: 'admin-user' },
        spec: {
          displayName: 'Admin User',
          email: 'admin@example.test',
          permissionLevel: '2',
        },
      },
    })

    expect(result.success).toBe(true)
    expect(result.applied[0]?.kind).toBe('Human')
    expect(result.applied[0]?.result).toMatchObject({
      name: 'admin-user',
      displayName: 'Admin User',
      permissionLevel: 2,
    })
  })

  test('controller apply reconciles Manager manifests into normalized contract workspace', async () => {
    const api = new ControllerApi()
    const managerId = `apply-manager-${Date.now()}`

    const result = await applyControllerManifest(api, {
      resource: {
        kind: 'Manager',
        metadata: { name: managerId },
        spec: {
          runtimeType: 'openclaw',
          controllerUrl: 'http://127.0.0.1:8000',
          matrixServerName: 'agenthub.local',
        },
      },
    })

    expect(result.success).toBe(true)
    expect(result.applied[0]?.kind).toBe('Manager')
    expect(result.applied[0]?.result).toMatchObject({
      phase: 'manager-contract-synced',
      ref: { kind: 'Manager', id: managerId },
    })
    const managerResult = result.applied[0]!.result as { snapshot: Record<string, string> }
    const snapshot = managerResult.snapshot
    expect(existsSync(snapshot.runtimePath)).toBe(true)
    expect(existsSync(snapshot.soulPath)).toBe(true)
    expect(existsSync(snapshot.agentsPath)).toBe(true)
    expect(existsSync(snapshot.skillsDir)).toBe(true)
    const runtime = JSON.parse(readFileSync(snapshot.runtimePath, 'utf8'))
    expect(runtime.runtimeFamily).toBe('manager')
    expect(runtime.runtimeType).toBe('openclaw')
    expect(runtime.controllerUrl).toBe('http://127.0.0.1:8000')
  })

  test('controller reconcile handles Manager resources through Manager contract sync', async () => {
    const api = new ControllerApi()
    const managerId = `reconcile-manager-${Date.now()}`

    const result = await api.handleReconcileRequest({
      ref: resourceRef('Manager', managerId),
      reason: 'test-manager-reconcile',
      requestedAt: new Date().toISOString(),
      payload: { runtimeType: 'qwenpaw' },
    })

    expect(result.phase).toBe('manager-contract-synced')
    expect(result.ref).toMatchObject({ kind: 'Manager', id: managerId })
    expect(result.snapshot).toMatchObject({ managerId, runtimeType: 'qwenpaw' })
  })

  test('controller apply can declaratively start and stop Manager runtime providers', async () => {
    let startCalls = 0
    let stopCalls = 0
    let running = false
    const status = () => ({
      runtimeType: 'openclaw',
      available: true,
      connectionMode: 'managed-process',
      syncReady: running,
      running,
      pid: running ? 1234 : null,
      workspace: 'manager-workspace',
      configPath: 'openclaw.json',
      binaryPath: 'openclaw',
      endpoint: null,
      stepEndpoint: null,
      healthEndpoint: null,
      error: null,
      diagnostics: { fake: true },
      startedAt: running ? new Date().toISOString() : null,
      uptime: running ? 1 : null,
    })
    const provider = {
      runtimeType: 'openclaw',
      status: async () => status(),
      ensureStarted: async () => {
        startCalls += 1
        running = true
        return status()
      },
      stop: async () => {
        stopCalls += 1
        running = false
        return status()
      },
      healthCheck: async () => ({ healthy: running }),
      getEndpointOrCommand: () => ({ command: 'openclaw gateway' }),
      createRuntime: () => {
        throw new Error('not used')
      },
    }
    const api = new ControllerApi({
      managerProviderResolver: (type) => type === 'openclaw' ? provider as any : null,
    })
    const managerId = `lifecycle-manager-${Date.now()}`

    const started = await applyControllerManifest(api, {
      resource: {
        kind: 'Manager',
        metadata: { name: managerId },
        spec: {
          runtimeType: 'openclaw',
          desiredState: 'running',
        },
      },
    })

    expect(startCalls).toBe(1)
    expect(started.success).toBe(true)
    expect(started.applied[0]?.result).toMatchObject({
      phase: 'manager-runtime-running',
      snapshot: {
        desiredState: 'running',
        runtimeLifecycle: {
          action: 'ensureStarted',
          phase: 'manager-runtime-running',
          status: { running: true },
        },
      },
    })

    const stopped = await api.reconcileManager({
      managerId,
      runtimeType: 'openclaw',
      desiredState: 'stopped',
    })

    expect(stopCalls).toBe(1)
    expect(stopped).toMatchObject({
      phase: 'manager-runtime-stopped',
      snapshot: {
        desiredState: 'stopped',
        runtimeLifecycle: {
          action: 'stop',
          phase: 'manager-runtime-stopped',
          status: { running: false },
        },
      },
    })
  })

  test('controller apply validates Manager lifecycle desiredState', async () => {
    const api = new ControllerApi()
    await expect(applyControllerManifest(api, {
      resource: {
        kind: 'Manager',
        metadata: { name: `bad-manager-${Date.now()}` },
        spec: {
          runtimeType: 'openclaw',
          desiredState: 'teleport',
        },
      },
    })).rejects.toThrow(/desiredState/)
  })

  test('controller API createWorker runs Member Reconcile stages and joins Matrix rooms', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Member Reconcile Workspace',
        goal: 'Validate member reconcile stages',
      })
      .returning()
    const api = new ControllerApi({
      workerBackend: {
        id: 'test-worker-backend',
        async ensureRuntime(input) {
          return {
            workerInstanceId: input.workerInstanceId,
            ready: true,
            state: 'ready',
            message: 'test backend ready',
          }
        },
        async start() {
          return { started: true }
        },
        async stop() {
          return { stopped: true }
        },
        async inspect(workerInstanceId) {
          return { workerInstanceId, ready: true, state: 'ready' }
        },
        async health(workerInstanceId) {
          return {
            workerInstanceId,
            ready: true,
            status: 'ready',
            state: 'ready',
            message: 'test backend ready',
            blockers: [],
            lastCheckedAt: new Date().toISOString(),
          }
        },
        async syncConfig(workerInstanceId) {
          return { synced: true, details: { workerInstanceId } }
        },
      },
    })

    const result = await api.createWorker({
      workspaceId: workspace!.id,
      ownerId: 'default-user',
      name: 'Room Joined Worker',
      runtimeBase: 'opencode',
      modelId: 'test-model',
      role: 'Engineer',
      roleType: 'coder',
      description: 'Own frontend implementation and report progress in Matrix rooms.',
      systemPrompt: 'Act as a careful frontend engineer inside AgentHub rooms.',
      roleProfile: {
        expertProfileId: 'frontend-engineer',
        outputContract: ['implementation_notes', 'changed_files'],
      },
      capabilityTags: ['frontend', 'implementation'],
      skillIds: ['task-management', 'file-sharing'],
      toolPermissions: ['chat', 'workspace:read', 'workspace:write'],
      contextPolicy: 'workspace-aware',
      createDirectSession: true,
      joinGroupRoom: true,
      announce: true,
    })

    expect(result.stages.map((stage) => stage.name)).toEqual([
      'ResolveMemberSpec',
      'ApplyWorkspaceAgent',
      'ApplyWorkerInstance',
      'JoinRooms',
      'AnnounceAndObserve',
    ])
    expect(result.worker?.kind).toBe('Worker')
    expect(result.runtimeBase).toBe('opencode')
    expect(result.groupRoom?.kind).toBe('group')
    expect(result.directSession?.metadata?.kind).toBe('agent-direct')
    expect(result.directRoom?.kind).toBe('direct')
    expect(result.participants.length).toBeGreaterThanOrEqual(2)
    expect(result.announcements).toHaveLength(1)

    const [agent] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, result.agentId)).limit(1)
    expect(agent?.codeAgentType).toBe('opencode')
    expect(agent?.modelId).toBe('test-model')
    expect(agent?.description).toContain('frontend implementation')
    expect(agent?.systemPrompt).toContain('frontend engineer')
    expect(agent?.capabilityTags).toEqual(['frontend', 'implementation'])
    expect(agent?.skillIds).toEqual(['task-management', 'file-sharing'])
    expect(agent?.toolPermissions).toEqual(['chat', 'workspace:read', 'workspace:write'])
    expect(agent?.contextPolicy).toBe('workspace-aware')
    expect(agent?.roleProfile?.expertProfileId).toBe('frontend-engineer')
    expect(agent?.roleProfile?.outputContract).toEqual(['implementation_notes', 'changed_files'])
    expect(agent?.roleProfile?.workerRuntimeBase).toBe('opencode')

    const [worker] = await db.select().from(workerInstances).where(eq(workerInstances.id, result.workerInstanceId)).limit(1)
    expect(worker?.workspaceAgentId).toBe(result.agentId)
    expect(worker?.runtimeBase).toBe('opencode')

    const workerParticipants = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.workerInstanceId, result.workerInstanceId))
    expect(workerParticipants.map((participant) => participant.roomId).sort()).toEqual(
      [result.groupRoom!.id, result.directRoom!.id].sort(),
    )

    const [announcement] = await db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.id, result.announcements[0]!.eventId))
      .limit(1)
    expect(announcement?.type).toBe('manager.message')
    expect(announcement?.metadata?.kind).toBe('member-reconcile.announced')

    const directSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceAgentId, result.agentId))
    expect(directSessions.some((session) => session.metadata?.createdFrom === 'member-reconcile')).toBe(true)

    const roomRows = await db.select().from(rooms).where(eq(rooms.workspaceId, workspace!.id))
    expect(roomRows.some((room) => room.kind === 'group')).toBe(true)
    expect(roomRows.some((room) => room.kind === 'direct')).toBe(true)
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
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Controller Diagnostics Workspace',
        goal: 'Validate worker runtime diagnostics',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Diagnostics Worker',
        role: 'Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        roleProfile: { workerRuntimeBase: 'opencode' },
      })
      .returning()
    const api = new ControllerApi()
    const resource = await api.applyWorker({
      workspaceId: workspace!.id,
      workspaceAgentId: agent!.id,
    })

    const diagnostics = await describeControllerPlane()

    expect(diagnostics.apiVersion).toBe('agenthub.dev/v1alpha1')
    expect(diagnostics.mode).toBe('in-process')
    expect(diagnostics.queue.registeredKinds).toContain('Manager')
    expect(diagnostics.queue.registeredKinds).toContain('Worker')
    expect(diagnostics.queue.registeredKinds).toContain('Room')
    expect(diagnostics.resources.workspaceAgents).toBeGreaterThanOrEqual(0)
    expect(diagnostics.resources.workerInstances).toBeGreaterThanOrEqual(0)
    expect(diagnostics.resources.rooms).toBeGreaterThanOrEqual(0)
    expect(diagnostics.boundaries.controllerOwns.join(' ')).toContain('Room')
    expect(diagnostics.boundaries.managerOwns.join(' ')).toContain('assign work')
    expect(diagnostics.boundaries.uiReadsFrom.join(' ')).toContain('Matrix Room timeline')
    const workerRuntime = diagnostics.workerRuntimes.find((item) => item.workerInstanceId === resource?.metadata.id)
    expect(workerRuntime?.agentName).toBe('Diagnostics Worker')
    expect(workerRuntime?.runtimeBase).toBe('opencode')
    expect(workerRuntime?.mode).toBe('bridge')
    expect(workerRuntime?.contractReady).toBe(true)
    expect(workerRuntime?.contractFiles.soul).toBe(true)
    expect(workerRuntime?.contractFiles.agents).toBe(true)
    expect(workerRuntime?.listenerManagedBy).toBe('none')
    expect(workerRuntime?.runtimeInspection?.runtimeType).toBe('code-agent')
    expect(workerRuntime?.runtimeInspection?.codeAgentType).toBe('opencode')
    expect(typeof workerRuntime?.runtimeInspection?.installed).toBe('boolean')
    expect(typeof workerRuntime?.runtimeInspection?.configured).toBe('boolean')
    expect(typeof workerRuntime?.runtimeInspection?.canExecute).toBe('boolean')
    expect(workerRuntime?.runtimeInspection?.cwdValid).toBe(true)
    expect(workerRuntime?.runtimeHealth.inspectedBy).toBe('bridge-cli')
    expect(typeof workerRuntime?.runtimeHealth.ready).toBe('boolean')
    expect(['ready', 'blocked', 'unknown']).toContain(workerRuntime?.runtimeHealth.status)
    expect(Array.isArray(workerRuntime?.runtimeHealth.blockers)).toBe(true)
    expect(typeof workerRuntime?.runtimeHealth.lastCheckedAt).toBe('string')
    if (workerRuntime?.runtimeInspection?.installed) {
      expect(workerRuntime.runtimeInspection.nativeProbe).toBeTruthy()
      expect(typeof workerRuntime.runtimeInspection.nativeProbe?.ok).toBe('boolean')
      expect(workerRuntime.runtimeInspection.doctorProbe).toBeTruthy()
      expect(typeof workerRuntime.runtimeInspection.doctorProbe?.supported).toBe('boolean')
      expect(typeof workerRuntime.runtimeInspection.doctorProbe?.ok).toBe('boolean')
      expect(workerRuntime.runtimeInspection.capabilityProbe).toBeTruthy()
      expect(Array.isArray(workerRuntime.runtimeInspection.capabilityProbe?.detected)).toBe(true)
      expect(typeof workerRuntime.runtimeInspection.capabilityProbe?.capabilities.auth).toBe('boolean')
      expect(workerRuntime.runtimeHealth.details?.capabilityProbe).toBeTruthy()
    }
  }, 20_000)

  test('resident Worker self-test checks readiness and observes Matrix probe replies', async () => {
    const previousWorkerBackend = process.env.AGENTHUB_WORKER_BACKEND
    const previousContainerRuntime = process.env.AGENTHUB_CONTAINER_RUNTIME
    process.env.AGENTHUB_WORKER_BACKEND = 'local'
    delete process.env.AGENTHUB_CONTAINER_RUNTIME
    try {
      const { worker, agent, room, participant } = await createResidentWorkerSelfTestFixture()
      await db
        .update(roomParticipants)
        .set({ workerInstanceId: null })
        .where(eq(roomParticipants.id, participant.id))

      const dryRun = await runResidentWorkerSelfTest({
        workerInstanceId: worker.id,
        ownerId: 'default-user',
        dispatch: false,
      })

      expect(dryRun.ok).toBe(true)
      expect(dryRun.runtimeBase).toBe('openclaw')
      expect(dryRun.dispatchAttempted).toBe(false)
      expect(dryRun.probeRoom?.roomId).toBe(room.id)
      expect(dryRun.checks.find((item) => item.id === 'contract-sync')?.ok).toBe(true)
      expect(dryRun.checks.find((item) => item.id === 'contract')?.ok).toBe(true)
      expect(dryRun.checks.find((item) => item.id === 'matrix-identity')?.ok).toBe(true)

      const running = runResidentWorkerSelfTest({
        workerInstanceId: worker.id,
        ownerId: 'default-user',
        dispatch: true,
        timeoutMs: 800,
      })

      await waitForCondition(
        async () => {
          const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
          return events.some((event) => event.metadata?.kind === 'worker-runtime.resident-self-test.request')
        },
        Boolean,
        { timeoutMs: 1000, description: 'resident self-test probe request' },
      )

      await roomService.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: participant.id,
        senderType: 'worker',
        type: 'worker.message',
        body: 'TASK_COMPLETED: resident-self-test-ok',
        metadata: {
          workerInstanceId: worker.id,
          workspaceAgentId: agent.id,
        },
      })

      const result = await running
      expect(result.ok).toBe(true)
      expect(result.dispatchAttempted).toBe(true)
      expect(result.dispatchEventId).toBeTruthy()
      expect(result.observedReply).toMatchObject({
        body: 'TASK_COMPLETED: resident-self-test-ok',
        protocol: 'TASK_COMPLETED',
      })
    } finally {
      if (previousWorkerBackend === undefined) {
        delete process.env.AGENTHUB_WORKER_BACKEND
      } else {
        process.env.AGENTHUB_WORKER_BACKEND = previousWorkerBackend
      }
      if (previousContainerRuntime === undefined) {
        delete process.env.AGENTHUB_CONTAINER_RUNTIME
      } else {
        process.env.AGENTHUB_CONTAINER_RUNTIME = previousContainerRuntime
      }
    }
  })
})

async function createResidentWorkerSelfTestFixture() {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: 'Resident Self Test Workspace',
      goal: 'Validate resident Worker self-test',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: 'Resident Builder',
      role: 'Resident Worker',
      modelId: 'test-model',
      runtimeType: 'code-agent',
      codeAgentType: null,
      roleProfile: { workerRuntimeBase: 'openclaw' },
    })
    .returning()
  const [worker] = await db
    .insert(workerInstances)
    .values({
      workspaceId: workspace!.id,
      workspaceAgentId: agent!.id,
      runtimeFamily: 'worker',
      runtimeBase: 'openclaw',
      modelId: 'test-model',
      observedState: 'listening',
      desiredState: 'running',
    })
    .returning()
  await db.insert(matrixIdentities).values({
    ownerType: 'worker',
    ownerId: worker!.id,
    serverName: 'agenthub.local',
    localpart: `worker-${worker!.id.slice(0, 8)}`,
    userId: `@worker-${worker!.id.slice(0, 8)}:agenthub.local`,
    accessToken: 'resident-worker-token',
    displayName: agent!.name,
  })
  await ensureWorkerAgentContract({
    workerInstanceId: worker!.id,
    agent: agent!,
    runtimeBase: 'openclaw',
    matrixUserId: `@worker-${worker!.id.slice(0, 8)}:agenthub.local`,
    runtimeConfigPath: 'openclaw.json',
    currentRooms: [],
  })
  const [session] = await db
    .insert(sessions)
    .values({
      title: 'Resident Self Test Group',
      type: 'group',
      ownerId: 'default-user',
      workspaceId: workspace!.id,
    })
    .returning()
  const room = await roomService.ensureRoomForSession(session!.id, 'default-user')
  const participant = await roomService.addWorkerParticipant(room.id, agent!.id, worker!.id)
  return { workspace: workspace!, agent: agent!, worker: worker!, room, participant }
}
