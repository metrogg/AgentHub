import { workerRuntimeService } from '../worker-runtime'
import { workerController, type WorkerReconcileContext } from '../orchestrator/worker-controller'
import { and, db, eq, matrixIdentities, roomParticipants, workerInstances, workspaceAgents } from '@agenthub/db'
import { openclawLauncher, preferredWorkerGatewayPort } from '../manager-runtime/openclaw-launcher'
import { markWorkerInstanceState } from '../orchestrator/worker-runtime-resources'
import { resolveLlmRuntimeConfig } from '../llm-client'
import { createMatrixClientFromEnv } from '../rooms/matrix-client'
import { MatrixIdentityService } from '../rooms/matrix-identity-service'
import { roomService } from '../rooms/room-service'
import { deployWorkerConfig, getWorkerWorkspaceDir } from '../worker-runtime/worker-openclaw-config'
import { waitForWorkerReadiness } from '../worker-runtime/worker-readiness-reporter'
import { ensureWorkerAgentContract } from '../agent-contract'

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
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, input.workerInstanceId))
      .limit(1)
    if (worker?.runtimeBase === 'openclaw') {
      const opened = openclawLauncher.isAvailable()
      if (!opened) {
        return {
          workerInstanceId: input.workerInstanceId,
          ready: false,
          state: 'resident-backend-required',
          message:
            'OpenClaw Worker requires a resident Worker backend. Install OpenClaw locally or enable AGENTHUB_WORKER_BACKEND=docker / AGENTHUB_CONTAINER_RUNTIME=docker.',
        }
      }

      const reconciled = await workerController.reconcile(input.workerInstanceId, input.context)
      if (reconciled.error) {
        return {
          workerInstanceId: input.workerInstanceId,
          ready: false,
          state: reconciled.phase,
          message: reconciled.error,
          details: { reconcile: reconciled },
        }
      }

      const [latestWorker] = await db
        .select()
        .from(workerInstances)
        .where(eq(workerInstances.id, input.workerInstanceId))
        .limit(1)
      if (!latestWorker) {
        return {
          workerInstanceId: input.workerInstanceId,
          ready: false,
          state: 'missing',
          message: 'WorkerInstance not found.',
        }
      }

      const [agent] = latestWorker.workspaceAgentId
        ? await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, latestWorker.workspaceAgentId)).limit(1)
        : []
      const workerName = agent?.name ?? latestWorker.id
      const identity = await ensureOpenClawWorkerIdentity(latestWorker.id, workerName)
      if (!identity?.accessToken || !identity.userId) {
        return {
          workerInstanceId: latestWorker.id,
          ready: false,
          state: 'missing-matrix-identity',
          message: 'OpenClaw Worker requires a Matrix identity with access token.',
        }
      }

      await rebindWorkerRoomParticipants(latestWorker.workspaceAgentId, latestWorker.id)

      const managerIdentity = await ensureOpenClawManagerIdentity()
      const matrixDomain = process.env.AGENTHUB_MATRIX_SERVER_NAME || 'agenthub.local'
      const gatewayPort = preferredWorkerGatewayPort(latestWorker.id)
      const resolvedLlm = await resolveLlmRuntimeConfig(
        latestWorker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || undefined,
      )
      const configPath = deployWorkerConfig({
        workerInstanceId: latestWorker.id,
        workerName,
        matrixUrl: process.env.AGENTHUB_MATRIX_HOMESERVER_URL || 'http://localhost:6167',
        matrixDomain,
        matrixUserId: identity.userId,
        matrixAccessToken: identity.accessToken,
        managerMatrixUserId: managerIdentity.userId,
        llmBaseUrl: process.env.AGENTHUB_WORKER_LLM_BASE_URL || resolvedLlm.baseUrl,
        llmApiKey: process.env.AGENTHUB_WORKER_LLM_API_KEY || process.env.LLM_API_KEY || resolvedLlm.apiKey || 'agenthub-internal',
        llmModel: latestWorker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || resolvedLlm.model,
        gatewayPort,
        dmAllowFrom: [`@admin:${matrixDomain}`, managerIdentity.userId],
        groupAllowFrom: [`@admin:${matrixDomain}`, managerIdentity.userId],
        timeoutSeconds: 600,
        maxConcurrent: 4,
      })
      if (agent) {
        await ensureWorkerAgentContract({
          workerInstanceId: latestWorker.id,
          agent,
          runtimeBase: latestWorker.runtimeBase,
          matrixUserId: identity.userId,
          runtimeConfigPath: configPath,
          controllerUrl: process.env.AGENTHUB_CONTAINER_CONTROLLER_URL || process.env.AGENTHUB_CONTROLLER_URL || null,
          sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
        })
      }

      const started = openclawLauncher.launchWorker(latestWorker.id, {
        workspaceKey: latestWorker.id,
        displayName: workerName,
        gatewayPort,
        configPath,
      })
      if (!started) {
        return {
          workerInstanceId: latestWorker.id,
          ready: false,
          state: 'resident-backend-start-failed',
          message: 'Failed to launch local OpenClaw Worker process.',
        }
      }

      const readiness = await waitForWorkerReadiness({
        workerInstanceId: latestWorker.id,
        gatewayPort,
        maxWaitMs: 60_000,
      })
      if (!readiness.ready) {
        await markWorkerInstanceState(latestWorker.id, 'failed', {
          message: readiness.error ?? 'Local OpenClaw Worker did not become healthy.',
          runtimeHome: getWorkerWorkspaceDir(latestWorker.id),
          runtimeConfigPath: configPath,
          health: {
            backend: this.id,
            gatewayPort,
            matrixUserId: identity.userId,
          },
        })
        return {
          workerInstanceId: latestWorker.id,
          ready: false,
          state: 'resident-process-unhealthy',
          message: readiness.error ?? 'Local OpenClaw Worker did not become healthy.',
          details: { gatewayPort, configPath, workspaceDir: getWorkerWorkspaceDir(latestWorker.id) },
        }
      }

      await markWorkerInstanceState(latestWorker.id, 'listening', {
        message: 'Local OpenClaw Worker is running and listening via Matrix.',
        runtimeHome: getWorkerWorkspaceDir(latestWorker.id),
        runtimeConfigPath: configPath,
        health: {
          backend: this.id,
          gatewayPort,
          matrixUserId: identity.userId,
        },
      })
      return {
        workerInstanceId: latestWorker.id,
        ready: true,
        state: 'listening',
        message: 'Local OpenClaw Worker is running and listening via Matrix.',
        details: {
          mode: 'resident-process',
          workerInstanceId: latestWorker.id,
          gatewayPort,
          configPath,
          workspaceDir: getWorkerWorkspaceDir(latestWorker.id),
        },
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
      openclawLauncher.stopWorker(input.workerInstanceId)
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
    const workerStatus = openclawLauncher.getWorkerStatus(workerInstanceId)
    if (workerStatus) {
      return {
        workerInstanceId,
        ready: workerStatus.running,
        state: workerStatus.running ? 'resident-process-running' : 'resident-process-stopped',
        message: workerStatus.running
          ? 'Local OpenClaw Worker process is running.'
          : 'Local OpenClaw Worker process is stopped.',
        details: workerStatus as unknown as Record<string, unknown>,
      }
    }
    return {
      workerInstanceId,
      ready: true,
      state: 'unknown',
      message: 'Local CLI backend inspect is delegated to WorkerController resource status.',
    }
  }

  async syncConfig(workerInstanceId: string): Promise<{ synced: boolean; details?: Record<string, unknown> }> {
    const [worker] = await db.select().from(workerInstances).where(eq(workerInstances.id, workerInstanceId)).limit(1)
    if (worker?.runtimeBase === 'openclaw' && openclawLauncher.isAvailable()) {
      const [agent] = worker.workspaceAgentId
        ? await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, worker.workspaceAgentId)).limit(1)
        : []
      const workerName = agent?.name ?? workerInstanceId
      const identity = await ensureOpenClawWorkerIdentity(worker.id, workerName)
      const managerIdentity = await ensureOpenClawManagerIdentity()
      if (!identity?.accessToken || !identity.userId || !managerIdentity?.userId) {
        return {
          synced: false,
          details: {
            workerInstanceId,
            error: 'OpenClaw Worker config requires Worker and Manager Matrix identities with access tokens.',
          },
        }
      }
      const matrixDomain = process.env.AGENTHUB_MATRIX_SERVER_NAME || 'agenthub.local'
      const gatewayPort = preferredWorkerGatewayPort(worker.id)
      const resolvedLlm = await resolveLlmRuntimeConfig(worker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || undefined)
      const configPath = deployWorkerConfig({
        workerInstanceId: worker.id,
        workerName,
        matrixUrl: process.env.AGENTHUB_MATRIX_HOMESERVER_URL || 'http://localhost:6167',
        matrixDomain,
        matrixUserId: identity.userId,
        matrixAccessToken: identity.accessToken,
        managerMatrixUserId: managerIdentity.userId,
        llmBaseUrl: process.env.AGENTHUB_WORKER_LLM_BASE_URL || resolvedLlm.baseUrl,
        llmApiKey: process.env.AGENTHUB_WORKER_LLM_API_KEY || process.env.LLM_API_KEY || resolvedLlm.apiKey || 'agenthub-internal',
        llmModel: worker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || resolvedLlm.model,
        gatewayPort,
        dmAllowFrom: [`@admin:${matrixDomain}`, managerIdentity.userId],
        groupAllowFrom: [`@admin:${matrixDomain}`, managerIdentity.userId],
        timeoutSeconds: 600,
        maxConcurrent: 4,
      })
      if (agent) {
        await ensureWorkerAgentContract({
          workerInstanceId: worker.id,
          agent,
          runtimeBase: worker.runtimeBase,
          matrixUserId: identity.userId,
          runtimeConfigPath: configPath,
          controllerUrl: process.env.AGENTHUB_CONTAINER_CONTROLLER_URL || process.env.AGENTHUB_CONTROLLER_URL || null,
          sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
        })
      }
      return {
        synced: true,
        details: {
          workerInstanceId,
          workspaceDir: getWorkerWorkspaceDir(worker.id),
          configPath,
          gatewayPort,
        },
      }
    }
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

async function ensureOpenClawWorkerIdentity(workerInstanceId: string, displayName: string) {
  let [identity] = await db
    .select()
    .from(matrixIdentities)
    .where(and(eq(matrixIdentities.ownerType, 'worker'), eq(matrixIdentities.ownerId, workerInstanceId)))
    .limit(1)
  if (identity?.accessToken && identity.userId) return identity
  const client = createMatrixClientFromEnv()
  const identityService = new MatrixIdentityService(client)
  identity = await identityService.ensureIdentity({
    ownerType: 'worker',
    ownerId: workerInstanceId,
    displayName,
  })
  return identity
}

async function ensureOpenClawManagerIdentity() {
  let [identity] = await db
    .select()
    .from(matrixIdentities)
    .where(and(eq(matrixIdentities.ownerType, 'manager'), eq(matrixIdentities.ownerId, 'manager')))
    .limit(1)
  if (identity?.accessToken && identity.userId) return identity
  const client = createMatrixClientFromEnv()
  const identityService = new MatrixIdentityService(client)
  identity = await identityService.ensureIdentity({
    ownerType: 'manager',
    ownerId: 'manager',
    displayName: 'Manager',
  })
  return identity
}

async function rebindWorkerRoomParticipants(workspaceAgentId: string | null, workerInstanceId: string) {
  if (!workspaceAgentId) return
  const participantRows = await db
    .select({
      roomId: roomParticipants.roomId,
    })
    .from(roomParticipants)
    .where(
      and(
        eq(roomParticipants.participantType, 'worker'),
        eq(roomParticipants.workspaceAgentId, workspaceAgentId),
      ),
    )
  for (const row of participantRows) {
    await roomService.addWorkerParticipant(row.roomId, workspaceAgentId, workerInstanceId)
  }
}
