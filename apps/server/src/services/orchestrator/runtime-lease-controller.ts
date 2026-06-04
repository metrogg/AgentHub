import {
  db,
  eq,
  runtimeLeases,
} from '@agenthub/db'
import {
  createRuntimeLease,
  failRuntimeLease,
  markInterruptedRuntimeLeasesStale,
  markRuntimeLeaseReady,
  markRuntimeLeaseRunning,
  markRuntimeLeaseStale,
  markRuntimeLeaseWaitingForHuman,
  releaseRuntimeLease,
  type RuntimeLeaseRuntimeUpdate,
} from './worker-runtime-resources'

export interface RuntimeLeaseCreateInput {
  workspaceId: string
  runId?: string | null
  taskId?: string | null
  workerInstanceId?: string | null
  provider?: 'local-workdir' | 'docker-sandbox' | 'remote-container' | 'cloud'
  cwd?: string | null
  homeDir?: string | null
  configDir?: string | null
  cacheDir?: string | null
  tmpDir?: string | null
  dataDir?: string | null
  metadata?: Record<string, unknown>
}

export interface RuntimeLeaseRecoverInput {
  reason: string
  limit?: number
}

export interface RuntimeLeaseRecoverResult {
  staleLeaseCount: number
  affectedWorkerInstanceIds: string[]
}

/**
 * RuntimeLeaseController owns the lifecycle of runtime isolation units.
 *
 * Helpers in worker-runtime-resources remain the persistence primitives; new
 * kernel code should depend on this controller so startup recovery, task room
 * execution, patrol, and shutdown use one resource-control surface.
 */
export class RuntimeLeaseController {
  create(input: RuntimeLeaseCreateInput) {
    return createRuntimeLease(input)
  }

  markReady(runtimeLeaseId: string | null | undefined, input: RuntimeLeaseRuntimeUpdate = {}) {
    return markRuntimeLeaseReady(runtimeLeaseId, input)
  }

  markRunning(runtimeLeaseId: string | null | undefined, input: RuntimeLeaseRuntimeUpdate = {}) {
    return markRuntimeLeaseRunning(runtimeLeaseId, input)
  }

  markWaitingForHuman(
    runtimeLeaseId: string | null | undefined,
    input: {
      metadata?: Record<string, unknown>
      workerInstanceId?: string | null
      message?: string | null
    } = {},
  ) {
    return markRuntimeLeaseWaitingForHuman(runtimeLeaseId, input)
  }

  release(
    runtimeLeaseId: string | null | undefined,
    input: { metadata?: Record<string, unknown>; workerInstanceId?: string | null } = {},
  ) {
    return releaseRuntimeLease(runtimeLeaseId, input)
  }

  fail(
    runtimeLeaseId: string | null | undefined,
    input: {
      error?: string | null
      metadata?: Record<string, unknown>
      workerInstanceId?: string | null
    } = {},
  ) {
    return failRuntimeLease(runtimeLeaseId, input)
  }

  markStale(
    runtimeLeaseId: string | null | undefined,
    input: { error?: string | null; metadata?: Record<string, unknown> } = {},
  ) {
    return markRuntimeLeaseStale(runtimeLeaseId, input)
  }

  async recoverInterruptedLeases(
    input: RuntimeLeaseRecoverInput,
  ): Promise<RuntimeLeaseRecoverResult> {
    return markInterruptedRuntimeLeasesStale(input)
  }

  async reconcileWorkspace(workspaceId: string): Promise<{
    activeCount: number
    waitingForHumanCount: number
    staleCount: number
  }> {
    const rows = await db
      .select()
      .from(runtimeLeases)
      .where(eq(runtimeLeases.workspaceId, workspaceId))
      .limit(1000)
    return {
      activeCount: rows.filter((lease) => lease.status === 'creating' || lease.status === 'ready' || lease.status === 'running').length,
      waitingForHumanCount: rows.filter((lease) => lease.status === 'waiting_for_human').length,
      staleCount: rows.filter((lease) => lease.status === 'stale').length,
    }
  }
}

export const runtimeLeaseController = new RuntimeLeaseController()
