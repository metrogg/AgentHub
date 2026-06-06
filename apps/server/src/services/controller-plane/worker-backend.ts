import { workerRuntimeService } from '../worker-runtime'
import { workerController, type WorkerReconcileContext } from '../orchestrator/worker-controller'
import { db, eq, workerInstances } from '@agenthub/db'

export interface WorkerBackendInspectResult {
  workerInstanceId: string
  ready: boolean
  state?: string | null
  message?: string | null
  details?: Record<string, unknown>
}

export interface WorkerBackendEnsureInput {
  workerInstanceId: string
  context: WorkerReconcileContext
}

export interface WorkerBackendStartInput {
  roomId: string
  ownerId: string
  workspaceAgentId?: string | null
  prompt?: string | null
}

export interface WorkerBackendStopInput {
  workerInstanceId?: string | null
  roomId?: string | null
  reason?: string | null
}

export interface WorkerBackend {
  readonly id: string
  ensureRuntime(input: WorkerBackendEnsureInput): Promise<WorkerBackendInspectResult>
  start(input: WorkerBackendStartInput): Promise<{ started: boolean; details?: Record<string, unknown> }>
  stop(input: WorkerBackendStopInput): Promise<{ stopped: boolean; details?: Record<string, unknown> }>
  inspect(workerInstanceId: string): Promise<WorkerBackendInspectResult>
  syncConfig(workerInstanceId: string): Promise<{ synced: boolean; details?: Record<string, unknown> }>
}

export class LocalCliWorkerBackend implements WorkerBackend {
  readonly id = 'local-cli'

  async ensureRuntime(input: WorkerBackendEnsureInput): Promise<WorkerBackendInspectResult> {
    const [worker] = await db
      .select({ runtimeBase: workerInstances.runtimeBase })
      .from(workerInstances)
      .where(eq(workerInstances.id, input.workerInstanceId))
      .limit(1)
    if (worker?.runtimeBase === 'openclaw') {
      return {
        workerInstanceId: input.workerInstanceId,
        ready: false,
        state: 'resident-backend-required',
        message:
          'OpenClaw Worker requires a resident Worker backend. Enable AGENTHUB_WORKER_BACKEND=docker or AGENTHUB_CONTAINER_RUNTIME=docker.',
      }
    }

    const result = await workerController.reconcile(input.workerInstanceId, input.context)
    return {
      workerInstanceId: input.workerInstanceId,
      ready: !result.error,
      state: result.phase,
      message: result.error ?? null,
      details: {
        changed: result.changed,
        requeueAfterMs: result.requeueAfterMs ?? null,
      },
    }
  }

  async start(input: WorkerBackendStartInput): Promise<{ started: boolean; details?: Record<string, unknown> }> {
    const result = await workerRuntimeService.runTaskRoom({
      roomId: input.roomId,
      ownerId: input.ownerId,
      workspaceAgentId: input.workspaceAgentId,
      prompt: input.prompt,
      source: 'controller-plane.local-cli-worker-backend',
    })
    return {
      started: result.status !== 'failed',
      details: {
        roomId: result.roomId,
        status: result.status,
        runtimeType: result.runtimeType,
        appendedEventIds: result.appendedEventIds,
      },
    }
  }

  async stop(input: WorkerBackendStopInput): Promise<{ stopped: boolean; details?: Record<string, unknown> }> {
    const stoppedRoom = input.roomId ? await workerRuntimeService.stopTaskRoom(input.roomId) : false
    if (input.workerInstanceId) {
      await workerController.releaseWorker(input.workerInstanceId, {
        reason: input.reason ?? 'Controller Plane requested worker stop.',
      })
    }
    return {
      stopped: stoppedRoom || Boolean(input.workerInstanceId),
      details: {
        roomStopped: stoppedRoom,
        workerInstanceId: input.workerInstanceId ?? null,
      },
    }
  }

  async inspect(workerInstanceId: string): Promise<WorkerBackendInspectResult> {
    return {
      workerInstanceId,
      ready: true,
      state: 'unknown',
      message: 'Local CLI backend inspect is delegated to WorkerController resource status.',
    }
  }

  async syncConfig(workerInstanceId: string): Promise<{ synced: boolean; details?: Record<string, unknown> }> {
    return {
      synced: true,
      details: {
        workerInstanceId,
        source: 'worker-workspace',
      },
    }
  }
}

export const localCliWorkerBackend = new LocalCliWorkerBackend()
