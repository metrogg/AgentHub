import { existsSync } from 'node:fs'
import { workerRuntimeService } from '../worker-runtime'
import { workerController, type WorkerReconcileContext } from '../orchestrator/worker-controller'
import { and, db, eq, matrixIdentities, roomParticipants, rooms, workerInstances, workspaceAgents } from '@agenthub/db'
import { openclawLauncher, preferredWorkerGatewayPort } from '../manager-runtime/openclaw-launcher'
import { markWorkerInstanceState } from '../orchestrator/worker-runtime-resources'
import { resolveLlmRuntimeConfig } from '../llm-client'
import { createMatrixClientFromEnv } from '../rooms/matrix-client'
import { MatrixIdentityService } from '../rooms/matrix-identity-service'
import { roomService } from '../rooms/room-service'
import {
  deployWorkerConfig,
  getWorkerWorkspaceDir,
  type WorkerOpenClawRoomBinding,
} from '../worker-runtime/worker-openclaw-config'
import { waitForWorkerReadiness } from '../worker-runtime/worker-readiness-reporter'
import { ensureWorkerAgentContractFromController, resolveWorkerAgentContractWorkspace } from '../agent-contract'
import { buildAgentProfile } from '../agents/profile-builder'
import { inspectCodeAgentRuntime } from '../code-agent-adapter'

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
    if (isQwenPawRuntimeBase(worker?.runtimeBase)) {
      return qwenPawWorkerBackendBlocked(input.workerInstanceId, worker?.runtimeBase)
    }
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
      const roomBindings = await loadWorkerOpenClawRoomBindings(latestWorker.id)
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
        groupAllowFrom: [`@admin:${matrixDomain}`, managerIdentity.userId, ...roomBindings.allowFrom],
        rooms: roomBindings.rooms,
        timeoutSeconds: 600,
        maxConcurrent: 4,
      })
      if (agent) {
        await ensureWorkerAgentContractFromController({
          workerInstanceId: latestWorker.id,
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
    const [worker] = await db.select().from(workerInstances).where(eq(workerInstances.id, workerInstanceId)).limit(1)
    if (!worker) {
      return {
        workerInstanceId,
        ready: false,
        state: 'missing',
        message: 'WorkerInstance not found.',
      }
    }
    if (isQwenPawRuntimeBase(worker?.runtimeBase)) {
      return qwenPawWorkerBackendBlocked(workerInstanceId, worker?.runtimeBase)
    }
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
    const bridgeInspection = await inspectBridgeWorkerBackend(worker)
    if (bridgeInspection) return bridgeInspection
    return {
      workerInstanceId,
      ready: true,
      state: 'unknown',
      message: 'Local CLI backend inspect is delegated to WorkerController resource status.',
    }
  }

  async syncConfig(workerInstanceId: string): Promise<{ synced: boolean; details?: Record<string, unknown> }> {
    const [worker] = await db.select().from(workerInstances).where(eq(workerInstances.id, workerInstanceId)).limit(1)
    if (isQwenPawRuntimeBase(worker?.runtimeBase)) {
      return {
        synced: false,
        details: {
          workerInstanceId,
          runtimeBase: worker?.runtimeBase ?? null,
          state: 'resident-backend-not-implemented',
          error: 'QwenPaw Worker runtime is recognized, but its WorkerBackend/config generator is not implemented yet.',
        },
      }
    }
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
      const roomBindings = await loadWorkerOpenClawRoomBindings(worker.id)
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
    if (!worker) {
      return {
        synced: false,
        details: {
          workerInstanceId,
          error: 'WorkerInstance not found.',
        },
      }
    }
    return {
      synced: true,
      details: {
        workerInstanceId,
        source: 'agenthub-worker-contract',
        runtimeBase: worker.runtimeBase,
        contractRoot: (await ensureWorkerAgentContractFromController({
          workerInstanceId: worker.id,
          runtimeBase: worker.runtimeBase,
          controllerUrl: process.env.AGENTHUB_CONTAINER_CONTROLLER_URL || process.env.AGENTHUB_CONTROLLER_URL || null,
          sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
        })).root,
      },
    }
  }
}

export const localCliWorkerBackend = new LocalCliWorkerBackend()

function isQwenPawRuntimeBase(runtimeBase?: string | null) {
  return runtimeBase === 'qwenpaw' || runtimeBase === 'copaw'
}

function qwenPawWorkerBackendBlocked(workerInstanceId: string, runtimeBase?: string | null): WorkerBackendInspectResult {
  return {
    workerInstanceId,
    ready: false,
    state: 'resident-backend-not-implemented',
    message:
      'QwenPaw Worker runtime is recognized, but its WorkerBackend is not implemented yet. Use OpenClaw for resident Workers now, or choose OpenCode / Claude Code / Codex / Gemini bridge.',
    details: {
      runtimeBase: runtimeBase ?? null,
      implemented: false,
      requiredNextStep: 'Implement QwenPaw/CoPaw workspace-mode WorkerBackend with Matrix channel config, process lifecycle, health, syncConfig, and resident self-test support.',
      fallback: 'No Codex/OpenCode/Claude/Gemini fallback is allowed for a QwenPaw Worker.',
    },
  }
}

async function inspectBridgeWorkerBackend(
  worker: typeof workerInstances.$inferSelect,
): Promise<WorkerBackendInspectResult | null> {
  const codeAgentType = bridgeCodeAgentType(worker.runtimeBase)
  if (!codeAgentType) return null

  const [agent] = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.id, worker.workspaceAgentId))
    .limit(1)
  if (!agent) {
    return {
      workerInstanceId: worker.id,
      ready: false,
      state: 'missing-agent',
      message: 'Bridge Worker inspect requires a WorkspaceAgent.',
      details: { runtimeBase: worker.runtimeBase },
    }
  }

  const contract = resolveWorkerAgentContractWorkspace(worker.id)
  const contractFiles = {
    profile: existsSync(contract.profilePath),
    runtime: existsSync(contract.runtimePath),
    soul: existsSync(contract.soulPath),
    agents: existsSync(contract.agentsPath),
    state: existsSync(contract.statePath),
    rooms: existsSync(contract.roomsPath),
    tasks: existsSync(contract.tasksPath),
    skillsDir: existsSync(contract.skillsPath),
  }
  const contractReady = Object.values(contractFiles).every(Boolean)
  const profile = buildAgentProfile(
    {
      ...agent,
      codeAgentType: agent.codeAgentType ?? codeAgentType,
      modelId: worker.modelId ?? agent.modelId,
    },
    contractReady ? contract.root : null,
  )
  const inspection = await inspectCodeAgentRuntime(profile, contractReady ? contract.root : null)
  const blockers = [
    ...(contractReady ? [] : ['Agent contract is incomplete; run syncConfig before starting this Worker.']),
    ...(inspection?.blockers ?? ['Bridge runtime inspection is unavailable']),
  ]
  const ready = Boolean(inspection?.canExecute) && blockers.length === 0
  return {
    workerInstanceId: worker.id,
    ready,
    state: ready ? 'bridge-ready' : 'bridge-blocked',
    message: ready
      ? `${inspection?.adapterName ?? codeAgentType} bridge runtime is ready.`
      : blockers[0] ?? `${codeAgentType} bridge runtime is blocked.`,
    details: {
      source: 'inspectCodeAgentRuntime',
      runtimeBase: worker.runtimeBase,
      codeAgentType,
      contractRoot: contract.root,
      contractReady,
      contractFiles,
      inspection,
      blockers,
      parityOperations: ['inspect', 'syncConfig', 'start', 'stop'],
      missingOperations: ['prepare', 'health'],
    },
  }
}

function bridgeCodeAgentType(runtimeBase?: string | null): 'codex' | 'claude-code' | 'opencode' | 'gemini' | null {
  if (
    runtimeBase === 'codex' ||
    runtimeBase === 'claude-code' ||
    runtimeBase === 'opencode' ||
    runtimeBase === 'gemini'
  ) {
    return runtimeBase
  }
  return null
}

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

export async function loadWorkerOpenClawRoomBindings(workerInstanceId: string): Promise<{
  rooms: WorkerOpenClawRoomBinding[]
  allowFrom: string[]
}> {
  const rows = await db
    .select({
      roomId: rooms.id,
      providerRoomId: rooms.providerRoomId,
      kind: rooms.kind,
      title: rooms.title,
      participantType: roomParticipants.participantType,
      providerUserId: roomParticipants.providerUserId,
      status: roomParticipants.status,
    })
    .from(roomParticipants)
    .innerJoin(rooms, eq(rooms.id, roomParticipants.roomId))
    .where(eq(rooms.status, 'active'))

  const workerParticipants = await db
    .select({ roomId: roomParticipants.roomId, participantId: roomParticipants.id })
    .from(roomParticipants)
    .where(and(eq(roomParticipants.workerInstanceId, workerInstanceId), eq(roomParticipants.status, 'joined')))
  const targetRoomIds = new Set(workerParticipants.map((participant) => participant.roomId))
  const workerParticipantByRoomId = new Map(workerParticipants.map((participant) => [participant.roomId, participant.participantId]))

  const allowFrom = new Set<string>()
  const roomBindings: WorkerOpenClawRoomBinding[] = []
  for (const roomId of targetRoomIds) {
    const roomRows = rows.filter((row) => row.roomId === roomId)
    const room = roomRows[0]
    if (!room) continue
    const roomAllowFrom = roomRows
      .filter((row) => row.status === 'joined')
      .filter((row) => row.participantType === 'human' || row.participantType === 'manager')
      .map((row) => row.providerUserId)
      .filter((userId): userId is string => Boolean(userId))
    for (const userId of roomAllowFrom) allowFrom.add(userId)
    roomBindings.push({
      roomId: room.roomId,
      providerRoomId: room.providerRoomId,
      kind: room.kind,
      participantId: workerParticipantByRoomId.get(room.roomId) ?? null,
      title: room.title,
      allowFrom: roomAllowFrom,
    })
  }

  return {
    rooms: roomBindings,
    allowFrom: Array.from(allowFrom),
  }
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
