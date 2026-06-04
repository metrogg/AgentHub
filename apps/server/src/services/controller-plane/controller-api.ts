import {
  artifacts,
  db,
  eq,
  orchestratorRuns,
  roomParticipants,
  rooms,
  runtimeLeases,
  workspaceAgents,
  workspaceTasks,
  workerInstances,
} from '@agenthub/db'
import type { RoomKind, TimelineEventType } from '../rooms/types'
import { roomService } from '../rooms/room-service'
import { roomController } from '../rooms/room-controller'
import { runController, type RunControllerRunContext } from '../orchestrator/run-controller'
import { workerController } from '../orchestrator/worker-controller'
import { runtimeLeaseController } from '../orchestrator/runtime-lease-controller'
import { registerArtifactBatch } from '../orchestrator/artifact-controller'
import { localCliWorkerBackend, type WorkerBackend } from './worker-backend'
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

  constructor(options: ControllerApiOptions = {}) {
    this.workerBackend = options.workerBackend ?? localCliWorkerBackend
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
      modelId: agent.modelId,
      skillIds: agent.skillIds,
      sandboxPolicy: agent.sandboxPolicy,
    })
    if (!workerInstanceId) throw new Error('WorkerInstance was not created.')
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
}

export const controllerApi = new ControllerApi()

function isReadyWorkerState(state: string): boolean {
  return state === 'ready' || state === 'listening' || state === 'assigned' || state === 'busy' || state === 'idle'
}

function stringPayload(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
