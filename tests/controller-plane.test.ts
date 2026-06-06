import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const {
  db,
  eq,
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
  })
})
