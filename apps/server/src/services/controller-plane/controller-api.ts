import {
  and,
  artifacts,
  db,
  eq,
  matrixIdentities,
  orchestratorRuns,
  roomParticipants,
  rooms,
  runtimeLeases,
  sessions,
  workspaceAgents,
  workspaceTasks,
  workerInstances,
  workspaces,
} from '@agenthub/db'
import type { RoomKind, TimelineEventType } from '../rooms/types'
import { roomService } from '../rooms/room-service'
import { roomController } from '../rooms/room-controller'
import { ensureManagerParticipantForRoom } from '../rooms/manager-participant'
import { runController, type RunControllerRunContext } from '../orchestrator/run-controller'
import { workerController } from '../orchestrator/worker-controller'
import { runtimeLeaseController } from '../orchestrator/runtime-lease-controller'
import { registerArtifactBatch } from '../orchestrator/artifact-controller'
import type { ManagerAction } from '../manager-runtime'
import { ensureGroupSession } from '../workspace/session-manager'
import { workerContainersEnabled } from '../container-runtime/agent-runtime-containers'
import { dockerWorkerBackend } from './docker-worker-backend'
import { localCliWorkerBackend, type WorkerBackend } from './worker-backend'
import { MemberReconciler } from './member-reconciler'
import { dispatchAssignBatch } from './task-dispatcher'
import {
  condition,
  resourceRef,
  type ControllerResource,
  type ReconcileRequest,
  type ReconcileResult,
} from './resource-types'

export interface ControllerApiOptions {
  workerBackend?: WorkerBackend
}

export class ControllerApi {
  private readonly workerBackend: WorkerBackend
  private readonly memberReconciler: MemberReconciler

  constructor(options: ControllerApiOptions = {}) {
    this.workerBackend = options.workerBackend ?? (workerContainersEnabled() ? dockerWorkerBackend : localCliWorkerBackend)
    this.memberReconciler = new MemberReconciler(this.workerBackend)
  }

  async applyWorker(input: {
    workspaceId: string
    workspaceAgentId: string
    reason?: string | null
  }) {
    const agent = await this.loadWorkspaceAgent(input.workspaceAgentId)
    if (!agent || agent.workspaceId !== input.workspaceId) {
      throw new Error(`Workspace Agent ${input.workspaceAgentId} not found in workspace ${input.workspaceId}.`)
    }
    const workerInstanceId = await workerController.ensureWorkerForAgent(input.workspaceId, {
      id: agent.id,
      runtimeType: agent.runtimeType,
      codeAgentType: agent.codeAgentType,
      roleProfile: agent.roleProfile,
      modelId: agent.modelId,
      skillIds: agent.skillIds,
      sandboxPolicy: agent.sandboxPolicy,
    })
    if (!workerInstanceId) throw new Error('WorkerInstance was not created.')
    const runtime = await this.workerBackend.ensureRuntime({
      workerInstanceId,
      context: {
        workspaceId: input.workspaceId,
      },
    })
    if (!runtime.ready) {
      throw new Error(runtime.message ?? `Worker runtime ${runtime.state ?? 'unknown'} is not ready.`)
    }
    return this.getWorker(workerInstanceId)
  }

  async getWorker(workerInstanceId: string): Promise<ControllerResource<'Worker'> | null> {
    const [worker] = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, workerInstanceId))
      .limit(1)
    if (!worker) return null
    return {
      apiVersion: 'agenthub.dev/v1alpha1',
      kind: 'Worker',
      metadata: {
        id: worker.id,
        workspaceId: worker.workspaceId,
        generation: Number(worker.updatedAt?.getTime?.() ?? 1),
        createdAt: worker.createdAt?.toISOString?.() ?? null,
        updatedAt: worker.updatedAt?.toISOString?.() ?? null,
      },
      spec: {
        workspaceAgentId: worker.workspaceAgentId,
        runtimeFamily: worker.runtimeFamily,
        runtimeBase: worker.runtimeBase,
        modelId: worker.modelId,
        skillIds: worker.skillIds,
        sandboxPolicy: worker.sandboxPolicy,
        desiredState: worker.desiredState,
      },
      status: {
        observedGeneration: Number(worker.updatedAt?.getTime?.() ?? 1),
        desiredState: worker.desiredState,
        observedState: worker.observedState,
        health: worker.health,
        runtimeHome: worker.runtimeHome,
        runtimeConfigPath: worker.runtimeConfigPath,
        lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString?.() ?? null,
        message: worker.message,
        conditions: [
          condition('Ready', isReadyWorkerState(worker.observedState) ? 'true' : 'false', {
            reason: worker.observedState,
            message: worker.message,
          }),
        ],
      },
    }
  }

  async listWorkers(workspaceId: string) {
    const agents = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, workspaceId))
    const instances = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.workspaceId, workspaceId))
    return agents.map((agent) => ({
      agent,
      workerInstance: instances.find((instance) => instance.workspaceAgentId === agent.id) ?? null,
    }))
  }

  async reconcileWorker(input: {
    workerInstanceId: string
    workspaceId: string
    groupSessionId?: string | null
    runId?: string | null
    taskId?: string | null
    actorId?: string | null
  }): Promise<ReconcileResult> {
    const result = await this.workerBackend.ensureRuntime({
      workerInstanceId: input.workerInstanceId,
      context: {
        workspaceId: input.workspaceId,
        groupSessionId: input.groupSessionId,
        runId: input.runId,
        taskId: input.taskId,
        actorId: input.actorId,
      },
    })
    return {
      ref: resourceRef('Worker', input.workerInstanceId, input.workspaceId),
      phase: result.state ?? 'worker-backend',
      changed: true,
      error: result.ready ? undefined : (result.message ?? 'Worker backend is not ready.'),
      snapshot: result.details,
    }
  }

  wakeWorker(workerInstanceId: string) {
    return workerController.wakeWorker(workerInstanceId)
  }

  async stopWorker(input: { workerInstanceId?: string | null; roomId?: string | null; reason?: string | null }) {
    return this.workerBackend.stop(input)
  }

  idleStopWorkers(workspaceId: string) {
    return workerController.tryIdleStop(workspaceId)
  }

  async createRun(input: {
    workspaceId: string
    groupSessionId: string
    goal: string
    actor?: { id?: string | null; name?: string | null } | null
  }) {
    return runController.start(input)
  }

  async listRuns(workspaceId: string) {
    return db.select().from(orchestratorRuns).where(eq(orchestratorRuns.workspaceId, workspaceId))
  }

  async getRunContext(runId: string): Promise<RunControllerRunContext | null> {
    const [run] = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.id, runId))
      .limit(1)
    if (!run) return null
    return {
      runId: run.id,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
    }
  }

  async reconcileRun(input: { runId: string; workspaceId?: string | null; groupSessionId?: string | null }) {
    const loaded = await this.getRunContext(input.runId)
    const run = loaded ?? {
      runId: input.runId,
      workspaceId: input.workspaceId ?? '',
      groupSessionId: input.groupSessionId ?? '',
    }
    return runController.reconcile(run)
  }

  async cancelRun(input: { runId: string; reason: string; workspaceId?: string | null; groupSessionId?: string | null }) {
    const loaded = await this.getRunContext(input.runId)
    const run = loaded ?? {
      runId: input.runId,
      workspaceId: input.workspaceId ?? '',
      groupSessionId: input.groupSessionId ?? '',
    }
    await runController.cancel(run, { reason: input.reason })
  }

  async listTasks(runId: string) {
    return db.select().from(workspaceTasks).where(eq(workspaceTasks.runId, runId))
  }

  async assignTask(input: {
    workspaceId: string
    title: string
    description?: string | null
    spec?: string | null
    message?: string | null
    goal?: string | null
    targetWorkerId?: string | null
    assignToAgentId?: string | null
    taskKey?: string | null
    dependsOn?: string[]
    runId?: string | null
    groupSessionId?: string | null
    ownerId?: string | null
    runtimeType?: string | null
  }) {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1)
    if (!workspace) throw new Error(`Workspace ${input.workspaceId} not found.`)
    const ownerId = input.ownerId ?? workspace.ownerId
    if (ownerId !== workspace.ownerId) throw new Error(`Owner ${ownerId} cannot assign tasks in workspace ${workspace.id}.`)

    const groupSession = input.groupSessionId
      ? await this.loadWorkspaceGroupSession(input.groupSessionId, input.workspaceId)
      : await ensureGroupSession(input.workspaceId, ownerId)
    if (!groupSession) throw new Error(`Group session ${input.groupSessionId} not found in workspace ${input.workspaceId}.`)

    const runContext = input.runId ? await this.getRunContext(input.runId) : null
    const description = input.spec?.trim() || input.description?.trim() || input.message?.trim() || input.title
    const action: ManagerAction = {
      type: 'assign',
      targetWorkerId: input.targetWorkerId ?? input.assignToAgentId ?? undefined,
      taskKey: input.taskKey ?? undefined,
      dependsOn: input.dependsOn,
      taskTitle: input.title,
      taskDescription: description,
      message: input.message?.trim() || description,
      reason: 'Controller API: task.assign',
    }

    return dispatchAssignBatch({
      groupSession,
      ownerId,
      goal: input.goal?.trim() || input.title,
      actions: [action],
      runtimeType: input.runtimeType ?? 'code-agent',
      run: runContext ?? undefined,
    })
  }

  async getTask(taskId: string) {
    const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, taskId)).limit(1)
    return task ?? null
  }

  async completeTask(input: {
    runId: string
    taskId: string
    title?: string | null
    progressStatus?: string | null
  }) {
    const run = await this.getRunContext(input.runId)
    if (!run) throw new Error(`Run ${input.runId} not found.`)
    await runController.markTaskCompleted(run, {
      taskId: input.taskId,
      title: input.title,
      progressStatus: input.progressStatus ?? 'completed',
    })
  }

  async failTask(input: {
    runId: string
    taskId: string
    error?: string | null
    progressStatus?: string | null
  }) {
    const run = await this.getRunContext(input.runId)
    if (!run) throw new Error(`Run ${input.runId} not found.`)
    await runController.markTaskFailed(run, {
      taskId: input.taskId,
      error: input.error ?? 'Task failed by Controller API.',
      progressStatus: input.progressStatus ?? 'failed',
    })
  }

  async createRoom(input: {
    ownerId: string
    kind?: RoomKind
    title: string
    workspaceId?: string | null
  }) {
    return roomService.createRoom({
      ownerId: input.ownerId,
      kind: input.kind ?? 'group',
      title: input.title,
      workspaceId: input.workspaceId ?? undefined,
    })
  }

  async listRooms(input: { workspaceId?: string | null; ownerId?: string | null }) {
    const predicates = []
    if (input.workspaceId) predicates.push(eq(rooms.workspaceId, input.workspaceId))
    if (input.ownerId) predicates.push(eq(rooms.ownerId, input.ownerId))
    if (predicates.length === 0) return []
    return db
      .select()
      .from(rooms)
      .where(predicates.length === 1 ? predicates[0] : and(...predicates))
  }

  async getRoom(roomId: string) {
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1)
    return room ?? null
  }

  listRoomEvents(input: { roomId: string; afterSequence?: number; limit?: number }) {
    return roomService.listTimelineEvents({
      roomId: input.roomId,
      afterSequence: input.afterSequence ?? 0,
      limit: input.limit ?? 100,
    })
  }

  async reconcileRoom(input: {
    roomId?: string | null
    sessionId?: string | null
    taskThreadId?: string | null
    ownerId: string
  }): Promise<ReconcileResult> {
    if (input.taskThreadId) {
      const result = await roomController.reconcileTaskThreadRoom(input.taskThreadId, input.ownerId)
      return {
        ref: resourceRef('Room', result.roomId),
        phase: result.phase,
        changed: result.changed,
      }
    }
    if (input.sessionId) {
      const result = await roomController.reconcileSessionRoom(input.sessionId, input.ownerId)
      return {
        ref: resourceRef('Room', result.roomId),
        phase: result.phase,
        changed: result.changed,
      }
    }
    if (input.roomId) {
      const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
      return {
        ref: resourceRef('Room', input.roomId, room?.workspaceId ?? null),
        phase: room ? 'observed' : 'missing',
        changed: false,
        error: room ? undefined : 'Room not found.',
      }
    }
    throw new Error('reconcileRoom requires roomId, sessionId, or taskThreadId.')
  }

  appendRoomEvent(input: {
    roomId: string
    senderType?: 'human' | 'manager' | 'worker' | 'system'
    type?: TimelineEventType
    body: string
    metadata?: Record<string, unknown>
  }) {
    return roomService.appendTimelineEvent({
      roomId: input.roomId,
      senderType: input.senderType ?? 'manager',
      type: input.type ?? 'manager.message',
      body: input.body,
      metadata: input.metadata,
    })
  }

  async mentionRoomParticipant(input: {
    roomId: string
    workspaceAgentId: string
    body: string
    ownerId?: string | null
    senderType?: 'human' | 'manager' | 'worker' | 'system'
    type?: TimelineEventType
  }) {
    const participants = await roomService.listRoomParticipants(input.roomId, input.ownerId ?? 'default-user')
    const target = participants.find((participant) => participant.workspaceAgentId === input.workspaceAgentId)
    if (!target) throw new Error(`Worker ${input.workspaceAgentId} is not a participant of room ${input.roomId}.`)
    return roomService.appendMentionTimelineEvent({
      roomId: input.roomId,
      mentionParticipantId: target.id,
      senderType: input.senderType ?? 'manager',
      type: input.type ?? 'task.assigned',
      body: input.body,
    })
  }

  addWorkerParticipant(input: {
    roomId: string
    workspaceAgentId: string
    workerInstanceId?: string | null
  }) {
    return roomService.addWorkerParticipant(
      input.roomId,
      input.workspaceAgentId,
      input.workerInstanceId ?? null,
    )
  }

  async listRoomParticipants(roomId: string) {
    return db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))
  }

  reconcileRuntimeLeases(workspaceId: string) {
    return runtimeLeaseController.reconcileWorkspace(workspaceId)
  }

  async registerArtifacts(input: {
    workspaceId: string
    runId: string
    taskId: string
    artifacts: Array<Record<string, unknown>>
    roomId?: string | null
    taskThreadId?: string | null
    workspaceAgentId?: string | null
    workerInstanceId?: string | null
    groupSessionId?: string | null
  }) {
    return registerArtifactBatch(input)
  }

  async listArtifacts(input: { runId?: string | null; taskId?: string | null }) {
    if (input.taskId) return db.select().from(artifacts).where(eq(artifacts.taskId, input.taskId))
    if (input.runId) return db.select().from(artifacts).where(eq(artifacts.runId, input.runId))
    return []
  }

  async handleReconcileRequest(request: ReconcileRequest): Promise<ReconcileResult> {
    switch (request.ref.kind) {
      case 'Worker':
        return this.reconcileWorker({
          workerInstanceId: request.ref.id,
          workspaceId: request.ref.workspaceId ?? stringPayload(request.payload, 'workspaceId') ?? '',
          groupSessionId: stringPayload(request.payload, 'groupSessionId'),
          runId: stringPayload(request.payload, 'runId'),
          taskId: stringPayload(request.payload, 'taskId'),
          actorId: stringPayload(request.payload, 'actorId'),
        })
      case 'Run': {
        const snapshot = await this.reconcileRun({
          runId: request.ref.id,
          workspaceId: request.ref.workspaceId,
          groupSessionId: stringPayload(request.payload, 'groupSessionId'),
        })
        return {
          ref: request.ref,
          phase: 'run-snapshot',
          changed: false,
          snapshot: {
            counts: snapshot.counts,
            runStatus: snapshot.run?.status ?? null,
          },
        }
      }
      case 'Room':
        return this.reconcileRoom({
          roomId: request.ref.id,
          ownerId: stringPayload(request.payload, 'ownerId') ?? 'default-user',
          sessionId: stringPayload(request.payload, 'sessionId'),
          taskThreadId: stringPayload(request.payload, 'taskThreadId'),
        })
      case 'RuntimeLease': {
        const workspaceId = request.ref.workspaceId ?? stringPayload(request.payload, 'workspaceId')
        if (!workspaceId) {
          return {
            ref: request.ref,
            phase: 'missing-workspace',
            changed: false,
            error: 'RuntimeLease reconcile requires workspaceId.',
          }
        }
        const snapshot = await this.reconcileRuntimeLeases(workspaceId)
        return {
          ref: request.ref,
          phase: 'runtime-lease-workspace',
          changed: false,
          snapshot,
        }
      }
      default:
        return {
          ref: request.ref,
          phase: 'unsupported-kind',
          changed: false,
          error: `ControllerApi does not reconcile ${request.ref.kind} yet.`,
        }
    }
  }

  // ─── Worker Lifecycle (HiClaw-style) ──────────────────────────────────

  async createWorker(input: {
    workspaceId: string
    name: string
    runtimeType?: string
    runtimeBase?: string
    workerRuntimeBase?: string
    codeAgentType?: string
    modelId?: string | null
    skillIds?: string[]
    role?: string
    roleType?: string
    description?: string
    systemPrompt?: string
    roleProfile?: Record<string, unknown> | null
    color?: string
    capabilityTags?: string[]
    toolPermissions?: string[]
    sandboxPolicy?: string
    contextPolicy?: string
    autoInvoke?: boolean
    approvalRequired?: boolean
    ownerId?: string | null
    groupSessionId?: string | null
    joinGroupRoom?: boolean
    createDirectSession?: boolean
    announce?: boolean
  }) {
    return this.memberReconciler.reconcile(input)
  }

  async updateWorker(workerInstanceId: string, input: {
    modelId?: string
    runtimeType?: string
    skillIds?: string[]
  }) {
    const [existing] = await db.select().from(workerInstances).where(eq(workerInstances.id, workerInstanceId)).limit(1)
    if (!existing) throw new Error(`Worker ${workerInstanceId} not found`)

    const updates: Record<string, unknown> = {}
    if (input.modelId) updates.modelId = input.modelId
    if (input.runtimeType) updates.runtimeBase = input.runtimeType
    if (input.skillIds) updates.skillIds = input.skillIds

    if (Object.keys(updates).length > 0) {
      await db.update(workerInstances).set(updates).where(eq(workerInstances.id, workerInstanceId))
    }

    if (input.modelId && existing.workspaceAgentId) {
      await db.update(workspaceAgents).set({ modelId: input.modelId }).where(eq(workspaceAgents.id, existing.workspaceAgentId))
    }

    return this.getWorker(workerInstanceId)
  }

  async deleteWorker(workerInstanceId: string) {
    const [existing] = await db.select().from(workerInstances).where(eq(workerInstances.id, workerInstanceId)).limit(1)
    if (!existing) throw new Error(`Worker ${workerInstanceId} not found`)

    await this.stopWorker({ workerInstanceId, reason: 'api-delete' })
    await db.delete(workerInstances).where(eq(workerInstances.id, workerInstanceId))
    if (existing.workspaceAgentId) {
      await db.delete(workspaceAgents).where(eq(workspaceAgents.id, existing.workspaceAgentId))
    }
    return { deleted: true, id: workerInstanceId }
  }

  async reportWorkerReady(workerName: string) {
    const [agent] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.name, workerName)).limit(1)
    if (!agent) return { found: false, workerName }

    const [worker] = await db.select().from(workerInstances).where(eq(workerInstances.workspaceAgentId, agent.id)).limit(1)
    if (!worker) return { found: false, workerName }

    const { markWorkerInstanceState } = await import('../orchestrator/worker-runtime-resources')
    await markWorkerInstanceState(worker.id, 'ready', {
      message: 'Worker reported ready via API.',
      health: { ...worker.health, reportedReadyAt: new Date().toISOString() },
    })
    return { found: true, workerName, workerInstanceId: worker.id }
  }

  // ─── Task Lifecycle ─────────────────────────────────────────────────

  async cancelTask(input: { runId: string; taskId: string; reason?: string }) {
    const run = await this.getRunContext(input.runId)
    if (!run) throw new Error(`Run ${input.runId} not found.`)
    await runController.markTaskCancelled(run, {
      taskId: input.taskId,
      reason: input.reason || 'Cancelled by API.',
    })
  }

  // ─── Team Management (HiClaw-style) ─────────────────────────────────

  async createTeam(input: {
    workspaceId: string
    name: string
    leaderName?: string
    leaderModel?: string
    workers?: string[]
    description?: string
  }) {
    let leaderAgentId: string | null = null
    if (input.leaderName) {
      const [existing] = await db.select().from(workspaceAgents)
        .where(and(eq(workspaceAgents.workspaceId, input.workspaceId), eq(workspaceAgents.name, input.leaderName)))
        .limit(1)
      if (existing) {
        leaderAgentId = existing.id
      } else {
        const [inserted] = await db.insert(workspaceAgents).values({
          workspaceId: input.workspaceId,
          name: input.leaderName,
          role: 'team-leader',
          roleType: 'orchestrator' as any,
          runtimeType: 'code-agent' as any,
          codeAgentType: null,
          roleProfile: { managerRuntimeType: 'openclaw' },
          modelId: null,
        }).returning()
        leaderAgentId = inserted?.id ?? null
      }
    }

    const memberIds = await this.resolveExistingTeamMembers(input.workspaceId, input.workers ?? [])

    // Ensure group session and room exist, and reconcile participants (HiClaw model)
    const [workspace] = await db
      .select({ ownerId: workspaces.ownerId })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1)
    if (workspace) {
      const { ensureGroupSession } = await import('../workspace/session-manager')
      const session = await ensureGroupSession(input.workspaceId, workspace.ownerId)
      const room = await roomService.ensureRoomForSession(session.id, workspace.ownerId)
      await ensureManagerParticipantForRoom(room.id)
      for (const agentId of memberIds) {
        await roomService.addWorkerParticipant(room.id, agentId)
      }
      if (leaderAgentId) {
        await roomService.addWorkerParticipant(room.id, leaderAgentId)
      }
    }

    return { name: input.name, workspaceId: input.workspaceId, leaderAgentId, memberIds, description: input.description ?? null }
  }

  async listTeams(workspaceId: string) {
    const agents = await db.select().from(workspaceAgents).where(eq(workspaceAgents.workspaceId, workspaceId))
    const leaders = agents.filter(a => a.roleType === 'orchestrator')
    const workers = agents.filter(a => a.roleType !== 'orchestrator')
    return leaders.map(leader => ({ name: leader.name, leader, members: workers }))
  }

  async getTeam(workspaceId: string, teamName: string) {
    const [leader] = await db.select().from(workspaceAgents)
      .where(and(
        eq(workspaceAgents.workspaceId, workspaceId),
        eq(workspaceAgents.name, teamName),
      ))
      .limit(1)
    if (!leader) return null
    const allAgents = await db.select().from(workspaceAgents).where(eq(workspaceAgents.workspaceId, workspaceId))
    const members = allAgents.filter(a => a.roleType !== 'orchestrator')
    return { name: teamName, leader, members }
  }

  async deleteTeam(workspaceId: string, teamName: string) {
    await db.delete(workspaceAgents)
      .where(and(eq(workspaceAgents.workspaceId, workspaceId), eq(workspaceAgents.name, teamName)))
    return { deleted: true, name: teamName }
  }

  private async resolveExistingTeamMembers(workspaceId: string, workers: string[]) {
    if (workers.length === 0) return []
    const agents = await db.select().from(workspaceAgents).where(eq(workspaceAgents.workspaceId, workspaceId))
    const memberIds: string[] = []
    for (const workerRef of workers) {
      const agent = agents.find((item) => item.id === workerRef || item.name === workerRef)
      if (!agent) {
        throw new Error(`Team member ${workerRef} does not exist in workspace ${workspaceId}. Apply a Worker manifest before adding it to a Team.`)
      }
      if (agent.roleType === 'orchestrator') {
        throw new Error(`Team member ${workerRef} is a leader/orchestrator, not a Worker member.`)
      }
      memberIds.push(agent.id)
    }
    return memberIds
  }

  // ─── Human Management (HiClaw-style) ────────────────────────────────

  async createHuman(input: { name: string; displayName: string; email?: string; permissionLevel?: number }) {
    let matrixUserId: string | null = null
    try {
      const { createMatrixClientFromEnv } = await import('../rooms/matrix-client')
      const { MatrixIdentityService } = await import('../rooms/matrix-identity-service')
      const client = createMatrixClientFromEnv()
      const identityService = new MatrixIdentityService(client)
      const identity = await identityService.ensureIdentity({
        ownerType: 'human',
        ownerId: input.name,
        displayName: input.displayName,
      })
      matrixUserId = identity.userId ?? null
    } catch (err) {
      // Matrix identity creation is best-effort
    }
    return { name: input.name, displayName: input.displayName, matrixUserId, permissionLevel: input.permissionLevel ?? 1 }
  }

  async listHumans() {
    return db.select().from(matrixIdentities).where(eq(matrixIdentities.ownerType, 'human'))
  }

  async deleteHuman(name: string) {
    await db.delete(matrixIdentities)
      .where(and(eq(matrixIdentities.ownerType, 'human'), eq(matrixIdentities.ownerId, name)))
    return { deleted: true, name }
  }

  // ─── Workspace & Platform State ─────────────────────────────────────

  async getWorkspaceState(workspaceId: string) {
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    const tasks = await db.select().from(workspaceTasks).where(eq(workspaceTasks.workspaceId, workspaceId)).limit(50)
    const workers = await db.select().from(workerInstances).where(eq(workerInstances.workspaceId, workspaceId))
    const agents = await db.select().from(workspaceAgents).where(eq(workspaceAgents.workspaceId, workspaceId))
    const [run] = await db.select().from(orchestratorRuns)
      .where(eq(orchestratorRuns.workspaceId, workspaceId))
      .orderBy(orchestratorRuns.createdAt)
      .limit(1)
    return {
      workspaceId,
      latestRun: run ?? null,
      tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status, agentId: t.agentId, progressStatus: t.progressStatus, createdAt: t.createdAt })),
      workers: workers.map(w => ({ id: w.id, workspaceAgentId: w.workspaceAgentId, runtimeBase: w.runtimeBase, observedState: w.observedState, lastHeartbeatAt: w.lastHeartbeatAt })),
      agents: agents.map(a => ({ id: a.id, name: a.name, runtimeType: a.runtimeType, codeAgentType: a.codeAgentType })),
    }
  }

  async getPlatformStatus() {
    const allWorkspaces = await db.select().from(workspaces)
    const allWorkers = await db.select().from(workerInstances)
    const allRuns = await db.select().from(orchestratorRuns)
    return {
      workspaces: allWorkspaces.length,
      workers: allWorkers.length,
      runs: allRuns.length,
      workersByState: {
        ready: allWorkers.filter(w => w.observedState === 'ready').length,
        busy: allWorkers.filter(w => w.observedState === 'busy').length,
        sleeping: allWorkers.filter(w => w.observedState === 'sleeping').length,
        failed: allWorkers.filter(w => w.observedState === 'failed').length,
      },
      runsByState: {
        running: allRuns.filter(r => r.status === 'running').length,
        completed: allRuns.filter(r => r.status === 'completed').length,
        failed: allRuns.filter(r => r.status === 'failed').length,
      },
    }
  }

  async buildWorkspaceSnapshot(workspaceId: string) {
    const [agent] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.workspaceId, workspaceId)).limit(1)
    const workerRows = await db.select().from(workerInstances).where(eq(workerInstances.workspaceId, workspaceId))
    const runRows = await db.select().from(orchestratorRuns).where(eq(orchestratorRuns.workspaceId, workspaceId))
    const leaseRows = await db.select().from(runtimeLeases).where(eq(runtimeLeases.workspaceId, workspaceId))
    const roomRows = await db.select().from(rooms).where(eq(rooms.workspaceId, workspaceId))
    return {
      workspaceId,
      hasAgents: Boolean(agent),
      counts: {
        workers: workerRows.length,
        runs: runRows.length,
        runtimeLeases: leaseRows.length,
        rooms: roomRows.length,
      },
    }
  }

  private async loadWorkspaceAgent(workspaceAgentId: string) {
    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.id, workspaceAgentId))
      .limit(1)
    return agent ?? null
  }

  private async loadWorkspaceGroupSession(sessionId: string, workspaceId: string) {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.workspaceId, workspaceId)))
      .limit(1)
    return session ?? null
  }
}

export const controllerApi = new ControllerApi()

function isReadyWorkerState(state: string): boolean {
  return state === 'ready' || state === 'listening' || state === 'assigned' || state === 'busy' || state === 'idle'
}

function stringPayload(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
