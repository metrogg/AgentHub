import { and, db, eq, matrixIdentities, roomParticipants, workerInstances, workspaceAgents } from '@agenthub/db'
import {
  containerControllerUrl,
  containerLlmBaseUrl,
  containerMatrixUrl,
  ensureOpenClawRuntimeImage,
  OPENCLAW_RUNTIME_IMAGE,
  workerContainerName,
  workerContainersEnabled,
} from '../container-runtime/agent-runtime-containers'
import { dockerRuntime } from '../container-runtime/docker-runtime'
import { markWorkerInstanceState } from '../orchestrator/worker-runtime-resources'
import { workerController } from '../orchestrator/worker-controller'
import { deployWorkerConfig, getWorkerWorkspaceDir } from '../worker-runtime/worker-openclaw-config'
import { waitForWorkerReadiness } from '../worker-runtime/worker-readiness-reporter'
import { resolveLlmRuntimeConfig } from '../llm-client'
import { createMatrixClientFromEnv } from '../rooms/matrix-client'
import { MatrixIdentityService } from '../rooms/matrix-identity-service'
import { roomService } from '../rooms/room-service'
import { ensureWorkerAgentContractFromController } from '../agent-contract'
import {
  localCliWorkerBackend,
  loadWorkerOpenClawRoomBindings,
  workerBackendHealthFromInspect,
  type WorkerBackend,
  type WorkerBackendEnsureInput,
  type WorkerBackendHealthResult,
  type WorkerBackendInspectResult,
  type WorkerBackendStartInput,
  type WorkerBackendStopInput,
} from './worker-backend'

export class DockerWorkerBackend implements WorkerBackend {
  readonly id = 'docker-runtime'

  async ensureRuntime(input: WorkerBackendEnsureInput): Promise<WorkerBackendInspectResult> {
    if (!workerContainersEnabled()) return localCliWorkerBackend.ensureRuntime(input)

    const [worker] = await db
      .select()
      .from(workerInstances)
      .where(eq(workerInstances.id, input.workerInstanceId))
      .limit(1)
    if (!worker) {
      return {
        workerInstanceId: input.workerInstanceId,
        ready: false,
        state: 'missing',
        message: 'WorkerInstance not found.',
      }
    }

    if (worker.runtimeBase !== 'openclaw') {
      return localCliWorkerBackend.ensureRuntime(input)
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

    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.id, worker.workspaceAgentId))
      .limit(1)
    const workerName = agent?.name ?? worker.id
    await rebindWorkerRoomParticipants(worker.workspaceAgentId, worker.id)

    let [identity] = await db
      .select()
      .from(matrixIdentities)
      .where(and(eq(matrixIdentities.ownerType, 'worker'), eq(matrixIdentities.ownerId, worker.id)))
      .limit(1)
    if (!identity?.accessToken || !identity.userId) {
      try {
        const client = createMatrixClientFromEnv()
        const identityService = new MatrixIdentityService(client)
        identity = await identityService.ensureIdentity({
          ownerType: 'worker',
          ownerId: worker.id,
          displayName: workerName,
        })
      } catch (err) {
        return {
          workerInstanceId: worker.id,
          ready: false,
          state: 'matrix-identity-create-failed',
          message: `OpenClaw Worker container failed to create Matrix identity: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
    if (!identity?.accessToken || !identity.userId) {
      return {
        workerInstanceId: worker.id,
        ready: false,
        state: 'missing-matrix-identity',
        message: 'OpenClaw Worker container requires a Matrix identity with access token.',
      }
    }
    let [managerIdentity] = await db
      .select()
      .from(matrixIdentities)
      .where(and(eq(matrixIdentities.ownerType, 'manager'), eq(matrixIdentities.ownerId, 'manager')))
      .limit(1)
    if (!managerIdentity?.accessToken || !managerIdentity.userId) {
      try {
        const client = createMatrixClientFromEnv()
        const identityService = new MatrixIdentityService(client)
        managerIdentity = await identityService.ensureIdentity({
          ownerType: 'manager',
          ownerId: 'manager',
          displayName: 'Manager',
        })
      } catch (err) {
        return {
          workerInstanceId: worker.id,
          ready: false,
          state: 'manager-matrix-identity-create-failed',
          message: `OpenClaw Worker container failed to resolve Manager Matrix identity: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
    if (!managerIdentity?.userId) {
      return {
        workerInstanceId: worker.id,
        ready: false,
        state: 'missing-manager-matrix-identity',
        message: 'OpenClaw Worker container requires the Manager Matrix identity.',
      }
    }

    const matrixDomain = process.env.AGENTHUB_MATRIX_SERVER_NAME || 'agenthub.local'
    const gatewayPort = workerGatewayPort(worker.id)
    const roomBindings = await loadWorkerOpenClawRoomBindings(worker.id)
    const resolvedLlm = await resolveLlmRuntimeConfig(worker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || undefined)
    const configPath = deployWorkerConfig({
      workerInstanceId: worker.id,
      workerName,
      matrixUrl: containerMatrixUrl(),
      matrixDomain,
      matrixUserId: identity.userId,
      matrixAccessToken: identity.accessToken,
      managerMatrixUserId: managerIdentity.userId,
      llmBaseUrl: process.env.AGENTHUB_WORKER_LLM_BASE_URL || containerLlmBaseUrl() || resolvedLlm.baseUrl,
      llmApiKey: process.env.AGENTHUB_WORKER_LLM_API_KEY || process.env.LLM_API_KEY || resolvedLlm.apiKey || 'agenthub-internal',
      llmModel: worker.modelId || process.env.AGENTHUB_WORKER_LLM_MODEL || process.env.LLM_MODEL || resolvedLlm.model,
      gatewayPort,
      dmAllowFrom: [`@admin:${matrixDomain}`, managerIdentity.userId],
      groupAllowFrom: [`@admin:${matrixDomain}`, managerIdentity.userId, ...roomBindings.allowFrom],
      rooms: roomBindings.rooms,
      timeoutSeconds: 600,
      maxConcurrent: 4,
    })
    if (agent) {
      await ensureWorkerAgentContractFromController({
        workerInstanceId: worker.id,
        runtimeBase: worker.runtimeBase,
        matrixUserId: identity.userId,
        runtimeConfigPath: configPath,
        controllerUrl: containerControllerUrl(),
        sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
      })
    }

    const image = await ensureOpenClawRuntimeImage()
    if (!image.present) {
      await markWorkerInstanceState(worker.id, 'failed', {
        message: `OpenClaw runtime image unavailable: ${image.error || OPENCLAW_RUNTIME_IMAGE}`,
      })
      return {
        workerInstanceId: worker.id,
        ready: false,
        state: 'image-unavailable',
        message: image.error || `Image ${OPENCLAW_RUNTIME_IMAGE} unavailable.`,
      }
    }

    const containerName = workerContainerName(worker.id)
    const workspaceDir = getWorkerWorkspaceDir(worker.id)
    const started = await dockerRuntime.run({
      name: containerName,
      image: OPENCLAW_RUNTIME_IMAGE,
      volumes: [{ host: workspaceDir, container: '/workspace' }],
      env: {
        OPENCLAW_CONFIG_PATH: '/workspace/openclaw.json',
        OPENCLAW_NO_RESPAWN: '1',
        HOME: '/workspace',
        AGENTHUB_WORKER_INSTANCE_ID: worker.id,
      },
      ports: [{ host: gatewayPort, container: gatewayPort }],
      labels: {
        'dev.agenthub.kind': 'worker',
        'dev.agenthub.workerInstanceId': worker.id,
        'dev.agenthub.workspaceAgentId': worker.workspaceAgentId,
        'dev.agenthub.runtime': 'openclaw',
      },
      restart: 'unless-stopped',
    })

    const readiness = await waitForWorkerReadiness({
      workerInstanceId: worker.id,
      gatewayPort,
      maxWaitMs: 60_000,
    })
    if (!readiness.ready) {
      await markWorkerInstanceState(worker.id, 'failed', {
        message: readiness.error ?? 'OpenClaw Worker container did not become healthy.',
        health: {
          containerName,
          gatewayPort,
          container: started.container,
        },
      })
      return {
        workerInstanceId: worker.id,
        ready: false,
        state: 'container-unhealthy',
        message: readiness.error ?? 'OpenClaw Worker container did not become healthy.',
        details: { containerName, gatewayPort, container: started.container },
      }
    }

    await markWorkerInstanceState(worker.id, 'listening', {
      message: 'OpenClaw Worker container is running and listening via Matrix.',
      runtimeHome: workspaceDir,
      runtimeConfigPath: `${workspaceDir}/openclaw.json`,
      health: {
        containerName,
        gatewayPort,
        container: started.container,
        backend: this.id,
      },
    })
    return {
      workerInstanceId: worker.id,
      ready: true,
      state: 'listening',
      message: 'OpenClaw Worker container is running.',
      details: {
        containerName,
        gatewayPort,
        workspaceDir,
        container: started.container,
      },
    }
  }

  async start(input: WorkerBackendStartInput): Promise<{ started: boolean; details?: Record<string, unknown> }> {
    return localCliWorkerBackend.start(input)
  }

  async stop(input: WorkerBackendStopInput): Promise<{ stopped: boolean; details?: Record<string, unknown> }> {
    if (input.workerInstanceId) {
      await dockerRuntime.stop(workerContainerName(input.workerInstanceId))
    }
    const local = await localCliWorkerBackend.stop(input)
    return {
      stopped: local.stopped || Boolean(input.workerInstanceId),
      details: {
        ...local.details,
        containerName: input.workerInstanceId ? workerContainerName(input.workerInstanceId) : null,
      },
    }
  }

  async inspect(workerInstanceId: string): Promise<WorkerBackendInspectResult> {
    const containerName = workerContainerName(workerInstanceId)
    const container = await dockerRuntime.inspect(containerName)
    return {
      workerInstanceId,
      ready: container.running,
      state: container.status,
      message: container.running ? 'Worker container is running.' : 'Worker container is not running.',
      details: { containerName, container },
    }
  }

  async health(workerInstanceId: string): Promise<WorkerBackendHealthResult> {
    const [worker] = await db.select().from(workerInstances).where(eq(workerInstances.id, workerInstanceId)).limit(1)
    if (worker?.runtimeBase !== 'openclaw') return localCliWorkerBackend.health(workerInstanceId)
    return workerBackendHealthFromInspect(this.id, await this.inspect(workerInstanceId))
  }

  async syncConfig(workerInstanceId: string): Promise<{ synced: boolean; details?: Record<string, unknown> }> {
    const [worker] = await db.select().from(workerInstances).where(eq(workerInstances.id, workerInstanceId)).limit(1)
    if (worker?.runtimeBase !== 'openclaw') return localCliWorkerBackend.syncConfig(workerInstanceId)
    const contract = await ensureWorkerAgentContractFromController({
      workerInstanceId,
      runtimeBase: worker.runtimeBase,
      controllerUrl: containerControllerUrl(),
      sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
    })
    return {
      synced: true,
      details: {
        workerInstanceId,
        workspaceDir: getWorkerWorkspaceDir(workerInstanceId),
        configPath: `${getWorkerWorkspaceDir(workerInstanceId)}/openclaw.json`,
        contractRoot: contract.root,
      },
    }
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

export const dockerWorkerBackend = new DockerWorkerBackend()

async function rebindWorkerRoomParticipants(workspaceAgentId: string | null, workerInstanceId: string) {
  if (!workspaceAgentId) return
  const participantRows = await db
    .select({ roomId: roomParticipants.roomId })
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
