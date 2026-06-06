import { and, db, eq, matrixIdentities, runtimeLeases, workerInstances, workspaceAgents } from '@agenthub/db'
import { emitRunEvent } from './run-events'
import {
  ensureWorkerInstance,
  markWorkerInstanceState,
  type WorkerRuntimeAgentConfig,
} from './worker-runtime-resources'
import { runtimeLeaseController } from './runtime-lease-controller'
import { ensureWorkerWorkspace } from '../worker-runtime/worker-workspace'
import { deployWorkerConfig } from '../worker-runtime/worker-openclaw-config'
import { logger } from '../../lib/logger'
import type { ExecutionConfigSummary } from '../execution/execution-config-summary'
import { createMatrixClientFromEnv } from '../rooms/matrix-client'
import { MatrixIdentityService } from '../rooms/matrix-identity-service'
import { workerContainersEnabled } from '../container-runtime/agent-runtime-containers'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { agentHubUserDataRoot } from '../system-paths'
import { roomService } from '../rooms'
import { resolveLlmRuntimeConfig } from '../llm-client'

export interface ReconcileResult {
  phase: string
  changed: boolean
  requeueAfterMs?: number
  error?: string
}

export interface WorkerReconcileContext {
  workspaceId: string
  groupSessionId?: string | null
  runId?: string | null
  taskId?: string | null
  actorId?: string | null
}

/** HiClaw-style idle-stop: idle workers sleep after this many ms. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
/** Maximum number of idle workers to stop in a single reconcile pass. */
const MAX_IDLE_STOP_BATCH = 10

interface PhaseResult {
  changed: boolean
  requeueAfterMs?: number
  error?: string
}

interface WorkerInstanceRow {
  id: string
  workspaceId: string
  workspaceAgentId: string
  runtimeFamily: 'coordinator' | 'worker'
  runtimeBase: 'openclaw' | 'copaw' | 'qwenpaw' | 'codex' | 'claude-code' | 'opencode' | 'gemini'
  modelId: string | null
  skillIds: string[]
  mcpServerIds: string[]
  sandboxPolicy: 'workspace-write' | 'danger-full-access'
  desiredState: 'running' | 'sleeping' | 'stopped'
  observedState: 'provisioning' | 'ready' | 'listening' | 'assigned' | 'busy' | 'waiting_for_human' | 'resuming' | 'idle' | 'sleeping' | 'stopped' | 'failed'
  health: Record<string, unknown>
  runtimeHome: string | null
  runtimeConfigPath: string | null
  lastHeartbeatAt: Date | null
  message: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * WorkerController follows the HiClaw reconcile pattern:
 * each phase checks current vs desired state, takes idempotent action,
 * reports progress via RunEvent, and always updates WorkerInstance status.
 *
 * Phases: EnsureReady -> AssignLease -> ObserveHealth -> RecoverStale
 */
export class WorkerController {
  /**
   * Main reconcile loop. Like HiClaw's WorkerReconciler.Reconcile(),
   * this is the single entry point that runs all phases and always
   * writes back the observed state.
   */
  async reconcile(
    workerInstanceId: string,
    ctx: WorkerReconcileContext,
  ): Promise<ReconcileResult> {
    const worker = await this.loadWorker(workerInstanceId)
    if (!worker) {
      return { phase: 'load', changed: false, error: 'WorkerInstance not found' }
    }

    if (worker.desiredState === 'stopped') {
      await markWorkerInstanceState(worker.id, 'stopped', {
        message: 'Worker desired state is stopped.',
      })
      await stopMatrixWorkerListeners(worker.id)
      return { phase: 'stopped', changed: true }
    }

    // Phase 1: Ensure the worker runtime is ready
    const infraResult = await this.ensureReady(worker, ctx)
    if (infraResult.error || infraResult.requeueAfterMs) {
      await this.patchStatus(worker, infraResult)
      return {
        phase: 'ensureReady',
        changed: infraResult.changed,
        requeueAfterMs: infraResult.requeueAfterMs,
        error: infraResult.error,
      }
    }

    // Phase 2: Assign runtime lease if a task is pending
    const leaseResult = await this.assignLease(worker, ctx)
    if (leaseResult.error || leaseResult.requeueAfterMs) {
      await this.patchStatus(worker, leaseResult)
      return {
        phase: 'assignLease',
        changed: leaseResult.changed,
        requeueAfterMs: leaseResult.requeueAfterMs,
        error: leaseResult.error,
      }
    }

    // Phase 3: Observe health via heartbeat
    const healthResult = await this.observeHealth(worker, ctx)
    if (healthResult.error) {
      await this.patchStatus(worker, healthResult)
      return {
        phase: 'observeHealth',
        changed: healthResult.changed,
        error: healthResult.error,
      }
    }

    // All phases passed, worker is healthy
    await this.patchStatus(worker, { changed: healthResult.changed || leaseResult.changed })
    return { phase: 'complete', changed: true }
  }

  /**
   * HiClaw-style batch idle-stop: scans all idle workers in the workspace
   * and transitions those past the idle timeout to sleeping.
   *
   * In HiClaw, idle-stop saves compute resources while keeping the worker's
   * Matrix room, OSS config, and task history intact. Workers wake on the
   * next assignment via ensureReadyForTask().
   */
  async tryIdleStop(workspaceId: string): Promise<{
    stoppedCount: number
    stoppedIds: string[]
  }> {
    const idleWorkers = await db
      .select()
      .from(workerInstances)
      .where(
        and(
          eq(workerInstances.workspaceId, workspaceId),
          eq(workerInstances.observedState, 'idle'),
          eq(workerInstances.desiredState, 'running'),
        ),
      )
      .limit(MAX_IDLE_STOP_BATCH)

    const stoppedIds: string[] = []
    const now = Date.now()

    for (const worker of idleWorkers) {
      const idleDurationMs = worker.lastHeartbeatAt
        ? now - worker.lastHeartbeatAt.getTime()
        : now - worker.updatedAt.getTime()

      if (idleDurationMs < DEFAULT_IDLE_TIMEOUT_MS) continue

      await markWorkerInstanceState(worker.id, 'sleeping', {
        message: `Worker idle for ${Math.round(idleDurationMs / 1000)}s, entering sleep to save resources.`,
        health: {
          ...worker.health,
          idleStopAt: new Date().toISOString(),
          idleDurationMs,
        },
      })
      stoppedIds.push(worker.id)
    }

    return { stoppedCount: stoppedIds.length, stoppedIds }
  }

  /**
   * HiClaw-style wake: transitions a sleeping worker back to ready.
   * Called before assigning a new task to a sleeping worker.
   * Keeps existing room, config, and task history intact.
   */
  async wakeWorker(workerInstanceId: string): Promise<boolean> {
    const worker = await this.loadWorker(workerInstanceId)
    if (!worker) return false
    if (worker.observedState !== 'sleeping') return false

    await markWorkerInstanceState(worker.id, 'provisioning', {
      message: 'Waking worker from sleep for a new task assignment.',
      health: {
        ...worker.health,
        wokeAt: new Date().toISOString(),
        previousState: 'sleeping',
      },
    })

    // Re-run readiness check after waking
    const ctx: WorkerReconcileContext = { workspaceId: worker.workspaceId }
    await this.reconcile(worker.id, ctx)
    return true
  }

  /**
   * HiClaw-style ensureReadyForTask: the "before assignment" pattern.
   * If the worker is sleeping, wakes it first. If provisioning/failed,
   * runs reconcile to bring it to ready. If already ready/busy, returns true.
   *
   * Call this before assigning any task to a worker.
   */
  async ensureReadyForTask(
    workspaceId: string,
    workerInstanceId: string | null,
    agent: WorkerRuntimeAgentConfig,
  ): Promise<{ ready: boolean; workerInstanceId: string | null; reason?: string }> {
    // Ensure the worker instance exists (idempotent create-or-update)
    const instanceId = workerInstanceId ?? (await this.ensureWorkerForAgent(workspaceId, agent))
    if (!instanceId) {
      return { ready: false, workerInstanceId: null, reason: 'Failed to create or find worker instance.' }
    }

    const worker = await this.loadWorker(instanceId)
    if (!worker) {
      return { ready: false, workerInstanceId: null, reason: 'Worker instance not found after ensure.' }
    }

    // Wake if sleeping
    if (worker.observedState === 'sleeping') {
      await this.wakeWorker(instanceId)
    }

    // Reconcile to ready if not already in a ready/active state
    const isReadyLike =
      worker.observedState === 'ready' ||
      worker.observedState === 'listening' ||
      worker.observedState === 'assigned' ||
      worker.observedState === 'busy'
    if (!isReadyLike) {
      const result = await this.reconcile(instanceId, { workspaceId })
      if (result.error) {
        return { ready: false, workerInstanceId: instanceId, reason: result.error }
      }
    }

    return { ready: true, workerInstanceId: instanceId }
  }

  /**
   * Phase 1: EnsureReady — like HiClaw's ReconcileMemberInfra.
   * Checks that the runtime is installed, model is available, CLI auth is valid,
   * and the worker can accept work. Transitions observedState to 'ready' when done.
   */
  private async ensureReady(
    worker: WorkerInstanceRow,
    ctx: WorkerReconcileContext,
  ): Promise<PhaseResult> {
    if (
      worker.observedState === 'ready' ||
      worker.observedState === 'listening' ||
      worker.observedState === 'assigned' ||
      worker.observedState === 'busy'
    ) {
      return { changed: false }
    }

    const previousState = worker.observedState

    if (worker.desiredState === 'sleeping') {
      await markWorkerInstanceState(worker.id, 'sleeping', {
        message: 'Worker entering sleep as desired.',
      })
      return { changed: previousState !== 'sleeping' }
    }

    // Transition to ready: verify the runtime binding is valid
    const runtimeChecks = await this.verifyRuntimeReadiness(worker)
    if (!runtimeChecks.ready) {
      const message = runtimeChecks.reason ?? 'Worker runtime is not ready.'
      await markWorkerInstanceState(worker.id, 'failed', {
        message,
        health: {
          ...worker.health,
          runtimeChecks: runtimeChecks.details ?? {},
          lastCheckAt: new Date().toISOString(),
        },
      })

      if (ctx.runId && ctx.groupSessionId) {
        await emitRunEvent({
          runId: ctx.runId,
          workspaceId: ctx.workspaceId,
          groupSessionId: ctx.groupSessionId,
          agentId: ctx.actorId ?? null,
          workerInstanceId: worker.id,
          type: 'task.failed',
          severity: 'error',
          payload: {
            taskId: ctx.taskId ?? null,
            error: message,
            reason: 'worker_not_ready',
            workerInstanceId: worker.id,
            workspaceAgentId: worker.workspaceAgentId,
          },
        })
      }

      return { changed: true, error: message }
    }

    await markWorkerInstanceState(worker.id, 'ready', {
      message: 'Worker runtime verified and ready.',
      health: {
        ...worker.health,
        runtimeChecks: runtimeChecks.details ?? {},
        readyAt: new Date().toISOString(),
      },
    })

    // Ensure Worker workspace directory (SOUL.md, AGENTS.md, skills/)
    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.id, worker.workspaceAgentId))
      .limit(1)
    if (agent) {
      await ensureWorkerWorkspace(worker.id, agent).catch((err) => {
        logger.warn({ err, workerId: worker.id }, 'Failed to ensure worker workspace; continuing.')
      })
    }

    // For resident workers, deploy openclaw.json + agent content with Matrix credentials
    const isResident = worker.runtimeBase === 'openclaw' || worker.runtimeBase === 'copaw'
    if (isResident) {
      const [identity] = await db
        .select()
        .from(matrixIdentities)
        .where(and(eq(matrixIdentities.ownerType, 'worker'), eq(matrixIdentities.ownerId, worker.id)))
        .limit(1)
      if (identity?.accessToken) {
        const matrixUrl = process.env.AGENTHUB_MATRIX_HOMESERVER_URL || 'http://localhost:6167'
        const matrixDomain = process.env.AGENTHUB_MATRIX_SERVER_NAME || 'agenthub.local'
        const resolvedLlm = await resolveLlmRuntimeConfig(worker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || undefined)
        const llmBaseUrl = process.env.AGENTHUB_WORKER_LLM_BASE_URL || process.env.LLM_BASE_URL || resolvedLlm.baseUrl
        const llmApiKey = process.env.AGENTHUB_WORKER_LLM_API_KEY || process.env.LLM_API_KEY || resolvedLlm.apiKey || 'agenthub-internal'
        const llmModel = worker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || resolvedLlm.model
        const gatewayPort = workerGatewayPort(worker.id)
        const workerName = agent?.name ?? worker.id

        deployWorkerConfig({
          workerInstanceId: worker.id,
          workerName,
          matrixUrl,
          matrixDomain,
          matrixUserId: identity.userId,
          matrixAccessToken: identity.accessToken,
          llmBaseUrl,
          llmApiKey,
          llmModel,
          gatewayPort,
          dmAllowFrom: [`@admin:${matrixDomain}`, `@manager:${matrixDomain}`],
          groupAllowFrom: [`@admin:${matrixDomain}`, `@manager:${matrixDomain}`],
          timeoutSeconds: 600,
          maxConcurrent: 4,
        })
      }
    }

    // For resident workers, launch OpenClaw process (it handles its own /sync)
    // For ephemeral workers, start AgentHub-managed Matrix listener
    let anyListenerStarted = false
    if (isResident && !workerContainersEnabled()) {
      const gatewayPort = workerGatewayPort(worker.id)
      const launched = await this.launchResidentWorkerProcess(worker)
      if (launched) {
        // Wait for the worker's OpenClaw gateway to become healthy
        const { waitForWorkerReadiness } = await import('../worker-runtime/worker-readiness-reporter')
        const readiness = await waitForWorkerReadiness({
          workerInstanceId: worker.id,
          gatewayPort,
          maxWaitMs: 60_000,
        })
        if (readiness.ready) {
          anyListenerStarted = true
          await markWorkerInstanceState(worker.id, 'listening', {
            message: 'Resident Worker OpenClaw process launched, healthy, and listening via Matrix /sync.',
            health: {
              ...worker.health,
              listeningAt: new Date().toISOString(),
              gatewayPort,
            },
          })
          await roomService.announceWorkerPresenceInJoinedRooms(worker.id, {
            mode: 'listening',
          }).catch(() => {})
        } else {
          logger.warn({ workerId: worker.id, error: readiness.error }, 'Worker gateway did not become healthy')
        }
      }
    } else if (isResident && workerContainersEnabled()) {
      anyListenerStarted = false
      await markWorkerInstanceState(worker.id, 'ready', {
        message: 'Resident Worker config prepared; Docker WorkerBackend will start the container.',
        health: {
          ...worker.health,
          containerBackendPending: true,
        },
      })
      await roomService.announceWorkerPresenceInJoinedRooms(worker.id, {
        mode: 'ready',
      }).catch(() => {})
    } else {
      const listenerResults = await startMatrixWorkerListeners(worker.id)
      anyListenerStarted = listenerResults.some((r) => r.started)
      if (anyListenerStarted) {
        await markWorkerInstanceState(worker.id, 'listening', {
          message: 'Worker Matrix listener started and waiting for tasks.',
          health: {
            ...worker.health,
            listeningAt: new Date().toISOString(),
          },
        })
        await roomService.announceWorkerPresenceInJoinedRooms(worker.id, {
          mode: 'listening',
        }).catch(() => {})
      }
    }

    if (ctx.runId && ctx.groupSessionId) {
      await emitRunEvent({
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        groupSessionId: ctx.groupSessionId,
        agentId: ctx.actorId ?? null,
        workerInstanceId: worker.id,
        type: 'task.progress',
        payload: {
          taskId: ctx.taskId ?? null,
          status: anyListenerStarted ? 'worker_listening' : 'worker_ready',
          workerInstanceId: worker.id,
          workspaceAgentId: worker.workspaceAgentId,
          runtimeBase: worker.runtimeBase,
        },
      })
    }

    return { changed: true }
  }

  /**
   * Phase 2: AssignLease — like HiClaw's ReconcileMemberContainer.
   * Creates or reuses a RuntimeLease for the current task. A lease is the
   * runtime isolation unit: workdir + config + cache + env.
   */
  private async assignLease(
    worker: WorkerInstanceRow,
    ctx: WorkerReconcileContext,
  ): Promise<PhaseResult> {
    if (!ctx.runId || !ctx.taskId) {
      return { changed: false }
    }

    // Check if a usable lease already exists for this task
    const existingLease = await db
      .select()
      .from(runtimeLeases)
      .where(
        and(
          eq(runtimeLeases.runId, ctx.runId),
          eq(runtimeLeases.taskId, ctx.taskId),
          eq(runtimeLeases.workerInstanceId, worker.id),
        ),
      )
      .limit(1)

    const usableLease = existingLease[0]
    if (usableLease && ['ready', 'running'].includes(usableLease.status)) {
      // Lease already exists and is usable
      if (worker.observedState !== 'busy' && worker.observedState !== 'assigned') {
        await markWorkerInstanceState(worker.id, 'busy', {
          message: 'Worker assigned to active lease.',
        })
      }
      return { changed: worker.observedState !== 'busy' && worker.observedState !== 'assigned' }
    }

    if (usableLease && ['creating', 'cleaning'].includes(usableLease.status)) {
      return { changed: false, requeueAfterMs: 5000 }
    }

    // Create a fresh lease
    const lease = await runtimeLeaseController.create({
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      taskId: ctx.taskId,
      workerInstanceId: worker.id,
      provider: 'local-workdir',
    })

    if (!lease) {
      return { changed: false, error: 'Failed to create runtime lease.' }
    }

    await runtimeLeaseController.markReady(lease.id)
    await markWorkerInstanceState(worker.id, 'busy', {
      message: 'Runtime lease assigned, worker is busy.',
    })

    if (ctx.runId && ctx.groupSessionId) {
      await emitRunEvent({
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        groupSessionId: ctx.groupSessionId,
        taskId: ctx.taskId,
        workerInstanceId: worker.id,
        agentId: ctx.actorId ?? null,
        type: 'task.assigned',
        payload: {
          taskId: ctx.taskId,
          workerInstanceId: worker.id,
          runtimeLeaseId: lease.id,
          workspaceAgentId: worker.workspaceAgentId,
        },
      })
    }

    return { changed: true }
  }

  /**
   * Phase 3: ObserveHealth — like HiClaw's heartbeat monitoring.
   * Detects stale workers, failed runtimes, and transitions to failed state
   * when the worker hasn't sent a heartbeat within the expected window.
   *
   * Only applies when the worker has been running long enough to expect a
   * heartbeat. Freshly started workers without a heartbeat yet are not failed.
   */
  private async observeHealth(
    worker: WorkerInstanceRow,
    ctx: WorkerReconcileContext,
  ): Promise<PhaseResult> {
    if (worker.observedState !== 'busy') {
      return { changed: false }
    }

    // If the worker has never sent a heartbeat, check how long it's been busy
    if (!worker.lastHeartbeatAt) {
      // Allow a grace period before expecting heartbeats
      const busyDurationMs = Date.now() - worker.updatedAt.getTime()
      const GRACE_PERIOD_MS = 2 * 60 * 1000 // 2 minutes
      if (busyDurationMs < GRACE_PERIOD_MS) {
        return { changed: false }
      }
      // Worker has been busy for too long without a single heartbeat
      const message = `Worker has been busy for ${Math.round(busyDurationMs / 1000)}s without a heartbeat. Marking as failed.`
      await markWorkerInstanceState(worker.id, 'failed', {
        message,
        health: {
          ...worker.health,
          staleHeartbeat: true,
          busyDurationMs,
          detectedAt: new Date().toISOString(),
        },
      })
      await stopMatrixWorkerListeners(worker.id)
      await this.staleActiveLease(worker, message)
      await this.emitWorkerFailedEvent(worker, ctx, message, 'worker_no_initial_heartbeat')
      return { changed: true, error: message }
    }

    const heartbeatAgeMs = Date.now() - worker.lastHeartbeatAt.getTime()

    // If no heartbeat for 5 minutes while busy, worker is likely dead
    const STALE_THRESHOLD_MS = 5 * 60 * 1000
    if (heartbeatAgeMs > STALE_THRESHOLD_MS) {
      const message = `Worker has not sent a heartbeat for ${Math.round(heartbeatAgeMs / 1000)}s while busy. Marking as failed.`
      await markWorkerInstanceState(worker.id, 'failed', {
        message,
        health: {
          ...worker.health,
          staleHeartbeat: true,
          lastHeartbeatAgeMs: heartbeatAgeMs,
          detectedAt: new Date().toISOString(),
        },
      })
      await stopMatrixWorkerListeners(worker.id)
      await this.staleActiveLease(worker, message)
      await this.emitWorkerFailedEvent(worker, ctx, message, 'worker_heartbeat_lost')
      return { changed: true, error: message }
    }

    return { changed: false }
  }

  private async staleActiveLease(
    worker: WorkerInstanceRow,
    reason: string,
  ): Promise<void> {
    const [activeLease] = await db
      .select()
      .from(runtimeLeases)
      .where(
        and(
          eq(runtimeLeases.workerInstanceId, worker.id),
          eq(runtimeLeases.status, 'running'),
        ),
      )
      .limit(1)
    if (activeLease) {
      await runtimeLeaseController.markStale(activeLease.id, {
        error: reason,
        metadata: { staleReason: 'heartbeat_lost' },
      })
    }
  }

  private async emitWorkerFailedEvent(
    worker: WorkerInstanceRow,
    ctx: WorkerReconcileContext,
    message: string,
    reason: string,
  ): Promise<void> {
    if (ctx.runId && ctx.groupSessionId) {
      await emitRunEvent({
        runId: ctx.runId,
        workspaceId: ctx.workspaceId,
        groupSessionId: ctx.groupSessionId,
        workerInstanceId: worker.id,
        agentId: ctx.actorId ?? null,
        type: 'task.failed',
        severity: 'error',
        payload: {
          taskId: ctx.taskId ?? null,
          error: message,
          reason,
          workerInstanceId: worker.id,
        },
      })
    }
  }

  /**
   * Called on service restart to detect and clean up stale leases.
   * Like HiClaw's controller startup reconciliation.
   */
  async recoverStaleOnStartup(): Promise<{
    recoveredLeaseCount: number
    affectedWorkerIds: string[]
  }> {
    const activeLeases = await db
      .select()
      .from(runtimeLeases)
      .where(eq(runtimeLeases.status, 'running'))
      .limit(500)

    if (activeLeases.length === 0) {
      return { recoveredLeaseCount: 0, affectedWorkerIds: [] }
    }

    const affectedWorkerIds = new Set<string>()
    let recoveredCount = 0

    for (const lease of activeLeases) {
      await runtimeLeaseController.markStale(lease.id, {
        error: 'Service restarted while lease was active. Marked stale for recovery.',
        metadata: {
          staleReason: 'service_restart',
          previousStatus: lease.status,
          recoveredAt: new Date().toISOString(),
        },
      })
      recoveredCount++

      if (lease.workerInstanceId) {
        affectedWorkerIds.add(lease.workerInstanceId)
        await markWorkerInstanceState(lease.workerInstanceId, 'idle', {
          message: 'Lease marked stale after service restart. Worker returned to idle.',
          health: { recoveredFromStaleLease: true, leaseId: lease.id },
        })
      }
    }

    return {
      recoveredLeaseCount: recoveredCount,
      affectedWorkerIds: [...affectedWorkerIds],
    }
  }

  /**
   * Ensure a WorkerInstance exists and is ready for a given agent.
   * This is the "ensure" pattern from HiClaw: idempotent create-or-update.
   */
  async ensureWorkerForAgent(
    workspaceId: string,
    agent: WorkerRuntimeAgentConfig,
  ): Promise<string | null> {
    const instance = await ensureWorkerInstance({ workspaceId, agent })
    if (!instance) return null

    // For resident workers, ensure Matrix identity exists before reconcile
    const isResident = instance.runtimeBase === 'openclaw' || instance.runtimeBase === 'copaw'
    if (isResident) {
      try {
        const client = createMatrixClientFromEnv()
        const identityService = new MatrixIdentityService(client)
        await identityService.ensureIdentity({
          ownerType: 'worker',
          ownerId: instance.id,
          displayName: agent.id,
        })
        logger.info({ workerInstanceId: instance.id }, 'Worker Matrix identity ensured')
      } catch (err) {
        logger.error({ err, workerInstanceId: instance.id }, 'Failed to ensure Worker Matrix identity')
        await markWorkerInstanceState(instance.id, 'failed', {
          message: `Failed to create Matrix identity: ${err}`,
        })
        return null
      }
    }

    // Run reconcile to bring it to ready state
    await this.reconcile(instance.id, { workspaceId })
    return instance.id
  }

  /**
   * Release a worker's lease and mark it idle.
   * Called when a task completes, fails, or is cancelled.
   */
  async releaseWorker(
    workerInstanceId: string,
    input: {
      leaseMetadata?: Record<string, unknown>
      reason?: string
    } = {},
  ): Promise<void> {
    const [activeLease] = await db
      .select()
      .from(runtimeLeases)
      .where(
        and(
          eq(runtimeLeases.workerInstanceId, workerInstanceId),
          eq(runtimeLeases.status, 'running'),
        ),
      )
      .limit(1)

    if (activeLease) {
      await runtimeLeaseController.release(activeLease.id, {
        metadata: input.leaseMetadata,
        workerInstanceId,
      })
    } else {
      await markWorkerInstanceState(workerInstanceId, 'idle', {
        message: input.reason ?? 'Worker released.',
      })
    }
  }

  private async loadWorker(workerInstanceId: string): Promise<WorkerInstanceRow | null> {
    const [row] = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, workerInstanceId))
      .limit(1)
    return (row as WorkerInstanceRow | null) ?? null
  }

  private async patchStatus(
    _worker: WorkerInstanceRow,
    _result: PhaseResult,
  ): Promise<void> {
    // Status is already written by each phase's markWorkerInstanceState call.
    // This method exists as a hook point for future reconcile-level status
    // aggregation, like HiClaw's deferred Status().Patch() pattern.
  }

  /**
   * Verify that the runtime environment is available for this worker.
   * Checks: model availability, CLI installation, auth configuration.
   * Returns structured readiness info like HiClaw's health probes.
   */
  private async verifyRuntimeReadiness(
    worker: WorkerInstanceRow,
  ): Promise<{
    ready: boolean
    reason?: string
    details?: Record<string, unknown>
  }> {
    const details: Record<string, unknown> = {}

    // Check model availability
    if (!worker.modelId) {
      return {
        ready: false,
        reason: 'No model configured for this worker.',
        details: { missingModel: true },
      }
    }
    details.modelConfigured = true

    // Check runtime base is valid
    const validRuntimes = ['codex', 'claude-code', 'opencode', 'gemini', 'openclaw', 'copaw', 'qwenpaw']
    if (!validRuntimes.includes(worker.runtimeBase)) {
      return {
        ready: false,
        reason: `Unknown runtime base: ${worker.runtimeBase}`,
        details: { invalidRuntime: worker.runtimeBase },
      }
    }
    details.runtimeBase = worker.runtimeBase

    // Infer worker mode from runtimeBase
    const mode: 'ephemeral' | 'resident' =
      worker.runtimeBase === 'openclaw' || worker.runtimeBase === 'copaw' || worker.runtimeBase === 'qwenpaw'
        ? 'resident'
        : 'ephemeral'
    details.mode = mode

    // --- Resident mode checks ---
    if (mode === 'resident') {
      // Verify Matrix identity exists for this worker
      const [identity] = await db
        .select()
        .from(matrixIdentities)
        .where(and(eq(matrixIdentities.ownerType, 'worker'), eq(matrixIdentities.ownerId, worker.id)))
        .limit(1)

      if (!identity) {
        return {
          ready: false,
          reason: `Resident Worker (${worker.runtimeBase}) 缺少 Matrix identity。`,
          details: { ...details, missingMatrixIdentity: true },
        }
      }
      if (!identity.accessToken) {
        return {
          ready: false,
          reason: `Resident Worker (${worker.runtimeBase}) Matrix identity 没有 access token。`,
          details: { ...details, missingMatrixAccessToken: true, matrixUserId: identity.userId },
        }
      }
      details.matrixIdentity = { userId: identity.userId, serverName: identity.serverName }

      // Resident workers do not need sandbox policy validation (they manage their own isolation)
      return { ready: true, details }
    }

    // --- Ephemeral mode checks ---
    // For code agents, verify sandbox policy is valid
    if (worker.sandboxPolicy !== 'workspace-write' && worker.sandboxPolicy !== 'danger-full-access') {
      return {
        ready: false,
        reason: `Invalid sandbox policy: ${worker.sandboxPolicy}`,
        details: { ...details, invalidSandboxPolicy: worker.sandboxPolicy },
      }
    }
    details.sandboxPolicy = worker.sandboxPolicy

    return { ready: true, details }
  }

  private async generateWorkerOpenClawConfig(
    worker: WorkerInstanceRow,
    identity: { userId: string; accessToken: string | null; serverName: string },
  ): Promise<string> {
    const matrixUrl = process.env.AGENTHUB_MATRIX_HOMESERVER_URL || 'http://localhost:6167'
    const matrixDomain = process.env.AGENTHUB_MATRIX_SERVER_NAME || 'agenthub.local'
    const resolvedLlm = await resolveLlmRuntimeConfig(worker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || undefined)
    const llmBaseUrl = process.env.AGENTHUB_WORKER_LLM_BASE_URL || process.env.LLM_BASE_URL || resolvedLlm.baseUrl
    const llmApiKey = process.env.AGENTHUB_WORKER_LLM_API_KEY || process.env.LLM_API_KEY || resolvedLlm.apiKey || 'agenthub-internal'
    const llmModel = worker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || resolvedLlm.model
    const gatewayPort = workerGatewayPort(worker.id)
    const workerWorkspace = join(agentHubUserDataRoot(), 'workers', worker.id)

    const config = {
      gateway: {
        mode: 'local',
        port: gatewayPort,
        bind: 'lan',
        auth: { token: `agenthub-worker-token-${worker.id.slice(0, 8)}` },
        remote: { token: `agenthub-worker-token-${worker.id.slice(0, 8)}` },
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
          allowInsecureAuth: true,
          allowedOrigins: ['*'],
        },
      },
      channels: {
        matrix: {
          enabled: true,
          homeserver: matrixUrl,
          userId: identity.userId,
          accessToken: identity.accessToken ?? '',
          encryption: false,
          network: { dangerouslyAllowPrivateNetwork: true },
          autoJoin: 'always',
          dm: { policy: 'allowlist', allowFrom: [`@admin:${matrixDomain}`] },
          groupPolicy: 'allowlist',
          groupAllowFrom: [`@admin:${matrixDomain}`],
          streaming: 'off',
          blockStreaming: false,
        },
      },
      models: {
        mode: 'merge',
        providers: {
          'agenthub-llm': {
            baseUrl: llmBaseUrl,
            apiKey: llmApiKey,
            api: 'openai-completions',
            models: [{ id: llmModel, reasoning: false, contextWindow: 128000, maxTokens: 8192, input: ['text'] }],
          },
        },
      },
      agents: {
        defaults: {
          timeoutSeconds: 1800,
          workspace: '~',
          model: { primary: `agenthub-llm/${llmModel}` },
          maxConcurrent: 4,
          subagents: { maxConcurrent: 8 },
          elevatedDefault: 'full',
          heartbeat: { every: '1h', prompt: 'Read ~/HEARTBEAT.md and follow the checklist.' },
        },
      },
      tools: {
        exec: { host: 'gateway', security: 'full', ask: 'off' },
        elevated: { enabled: true, allowFrom: { matrix: ['*'] } },
      },
      session: {
        dmScope: 'per-channel-peer',
        resetByType: { dm: { mode: 'daily', atHour: 4 }, group: { mode: 'daily', atHour: 4 } },
      },
      plugins: { load: { paths: [] }, entries: { matrix: { enabled: true } } },
      commands: { restart: true },
    }

    mkdirSync(workerWorkspace, { recursive: true })
    const configPath = join(workerWorkspace, 'openclaw.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    logger.info({ configPath, workerId: worker.id, gatewayPort }, 'Generated OpenClaw Worker config')
    return configPath
  }

  private async launchResidentWorkerProcess(
    worker: typeof workerInstances.$inferSelect,
  ): Promise<boolean> {
    const binaryPath = this.findOpenClawBinary()
    if (!binaryPath) {
      logger.error({ workerId: worker.id }, 'OpenClaw binary not found; cannot launch resident worker')
      return false
    }

    const workerWorkspace = join(agentHubUserDataRoot(), 'workers', worker.id)
    const configPath = join(workerWorkspace, 'openclaw.json')
    if (!existsSync(configPath)) {
      logger.error({ workerId: worker.id, configPath }, 'OpenClaw config missing; cannot launch resident worker')
      return false
    }

    try {
      const child = spawn(binaryPath, ['gateway', 'run', '-c', configPath], {
        cwd: workerWorkspace,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()

      logger.info(
        { workerId: worker.id, pid: child.pid, configPath },
        'Launched OpenClaw Worker resident process',
      )
      return true
    } catch (e) {
      logger.error({ workerId: worker.id, err: e }, 'Failed to launch OpenClaw Worker process')
      return false
    }
  }

  private findOpenClawBinary(): string | undefined {
    // Try direct binary names
    const candidates = ['openclaw', 'openclaw.exe']
    for (const name of candidates) {
      try {
        const { status } = spawnSync(name, ['--version'], { stdio: 'ignore' })
        if (status === 0) return name
      } catch { /* noop */ }
    }

    // Try known package manager paths
    const globalPaths: string[] = []
    const envPaths = process.env.PATH?.split(process.platform === 'win32' ? ';' : ':') ?? []
    for (const dir of [...envPaths]) {
      globalPaths.push(join(dir, 'openclaw'))
      if (process.platform === 'win32') globalPaths.push(join(dir, 'openclaw.exe'))
    }
    for (const p of globalPaths) {
      try {
        if (existsSync(p)) return p
      } catch { /* noop */ }
    }

    return undefined
  }
}

function workerGatewayPort(workerId: string): number {
  let hash = 0
  for (let i = 0; i < workerId.length; i++) {
    hash = ((hash << 5) - hash) + workerId.charCodeAt(i)
    hash |= 0
  }
  return 18800 + (Math.abs(hash) % 200)
}

export const workerController = new WorkerController()

async function startMatrixWorkerListeners(workerInstanceId: string) {
  const { matrixRuntimeSupervisor } = await import('../rooms/matrix-runtime-supervisor')
  const results = await matrixRuntimeSupervisor
    .startWorkerInstanceListeners(workerInstanceId, {
      reason: 'worker-runtime-ready',
    })
    .catch(() => [] as { started: boolean; reason: string }[])
  return results
}

async function stopMatrixWorkerListeners(workerInstanceId: string) {
  const { matrixRuntimeSupervisor } = await import('../rooms/matrix-runtime-supervisor')
  await matrixRuntimeSupervisor.stopWorkerInstanceListeners(workerInstanceId).catch(() => {
    // Listener shutdown is best-effort; worker state is still the control-plane source.
  })
}
