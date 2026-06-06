import { existsSync } from 'node:fs'
import {
  artifacts,
  db,
  matrixIdentities,
  orchestratorRuns,
  roomParticipants,
  rooms,
  runtimeLeases,
  taskThreads,
  workspaceAgents,
  workspaceTasks,
  workerInstances,
} from '@agenthub/db'
import { resolveWorkerAgentContractWorkspace } from '../agent-contract'
import { buildAgentProfile } from '../agents/profile-builder'
import { inspectCodeAgentRuntime, type CodeAgentRuntimeInspection } from '../code-agent-adapter'
import { workerContainersEnabled } from '../container-runtime/agent-runtime-containers'
import { controllerReconcileQueue } from './controller-reconciler'
import { dockerWorkerBackend } from './docker-worker-backend'
import { localCliWorkerBackend, type WorkerBackendInspectResult } from './worker-backend'

export type WorkerRuntimeDiagnosticMode = 'resident-openclaw' | 'resident-qwenpaw' | 'bridge'
export type WorkerRuntimeListenerOwner = 'runtime' | 'agenthub-supervisor' | 'none'
type BridgeCodeAgentType = 'codex' | 'claude-code' | 'opencode' | 'gemini'

export interface WorkerRuntimeDiagnostics {
  workerInstanceId: string
  workspaceId: string
  workspaceAgentId: string
  agentName: string
  runtimeBase: string
  mode: WorkerRuntimeDiagnosticMode
  observedState: string
  desiredState: string
  modelId: string | null
  runtimeHome: string | null
  runtimeConfigPath: string | null
  lastHeartbeatAt: Date | null
  lastError: string | null
  listenerManagedBy: WorkerRuntimeListenerOwner
  contractRoot: string
  contractReady: boolean
  contractFiles: {
    profile: boolean
    runtime: boolean
    soul: boolean
    agents: boolean
    state: boolean
    rooms: boolean
    tasks: boolean
    skillsDir: boolean
  }
  matrixIdentity: {
    userId: string | null
    displayName: string | null
    syncStatus: string | null
    lastSyncAt: string | null
    lastError: string | null
  }
  matrixParticipants: Array<{
    roomId: string
    roomKind: string
    providerRoomId: string
    participantId: string
    providerUserId: string | null
    status: string
  }>
  runtimeInspection: CodeAgentRuntimeInspection | null
  runtimeHealth: WorkerRuntimeHealth
}

export interface WorkerRuntimeHealth {
  ready: boolean
  status: 'ready' | 'blocked' | 'unknown'
  inspectedBy: 'bridge-cli' | 'worker-backend' | 'resource'
  state: string | null
  message: string | null
  blockers: string[]
  lastCheckedAt: string
  details?: Record<string, unknown>
}

export interface ControllerPlaneDiagnostics {
  apiVersion: 'agenthub.dev/v1alpha1'
  mode: 'in-process'
  queue: {
    running: boolean
    size: number
    pendingKeys: string[]
    registeredKinds: string[]
  }
  resources: {
    workspaceAgents: number
    workerInstances: number
    rooms: number
    roomParticipants: number
    runs: number
    tasks: number
    taskThreads: number
    runtimeLeases: number
    artifacts: number
  }
  boundaries: {
    controllerOwns: string[]
    managerOwns: string[]
    uiReadsFrom: string[]
  }
  workerRuntimes: WorkerRuntimeDiagnostics[]
}

export async function describeControllerPlane(): Promise<ControllerPlaneDiagnostics> {
  const [
    workspaceAgentRows,
    workerInstanceRows,
    roomRows,
    roomParticipantRows,
    runRows,
    taskRows,
    taskThreadRows,
    runtimeLeaseRows,
    artifactRows,
    workerRuntimeRows,
    agentRows,
    participantRows,
    roomDiagnosticsRows,
    matrixIdentityRows,
  ] = await Promise.all([
    db.select({ id: workspaceAgents.id }).from(workspaceAgents),
    db.select({ id: workerInstances.id }).from(workerInstances),
    db.select({ id: rooms.id }).from(rooms),
    db.select({ id: roomParticipants.id }).from(roomParticipants),
    db.select({ id: orchestratorRuns.id }).from(orchestratorRuns),
    db.select({ id: workspaceTasks.id }).from(workspaceTasks),
    db.select({ id: taskThreads.id }).from(taskThreads),
    db.select({ id: runtimeLeases.id }).from(runtimeLeases),
    db.select({ id: artifacts.id }).from(artifacts),
    db.select().from(workerInstances),
    db.select().from(workspaceAgents),
    db.select().from(roomParticipants),
    db.select().from(rooms),
    db.select().from(matrixIdentities),
  ])
  const workerRuntimes = await describeWorkerRuntimes({
    workers: workerRuntimeRows,
    agents: agentRows,
    participants: participantRows,
    rooms: roomDiagnosticsRows,
    matrixIdentities: matrixIdentityRows,
  })

  return {
    apiVersion: 'agenthub.dev/v1alpha1',
    mode: 'in-process',
    queue: controllerReconcileQueue.describe(),
    resources: {
      workspaceAgents: workspaceAgentRows.length,
      workerInstances: workerInstanceRows.length,
      rooms: roomRows.length,
      roomParticipants: roomParticipantRows.length,
      runs: runRows.length,
      tasks: taskRows.length,
      taskThreads: taskThreadRows.length,
      runtimeLeases: runtimeLeaseRows.length,
      artifacts: artifactRows.length,
    },
    boundaries: {
      controllerOwns: [
        'WorkerInstance readiness and lifecycle reconciliation',
        'Room and participant reconciliation',
        'Run, task, runtime lease, and artifact resource state',
      ],
      managerOwns: [
        'natural-language intent understanding',
        'whether to reply, clarify, propose members, assign work, or review results',
        'skill/tool selection inside OpenClaw/QwenPaw style Manager runtime',
      ],
      uiReadsFrom: [
        'Matrix Room timeline and participants',
        'Controller resource snapshots',
        'AG-UI projections derived from timeline/resource state',
      ],
    },
    workerRuntimes,
  }
}

async function describeWorkerRuntimes(input: {
  workers: Array<typeof workerInstances.$inferSelect>
  agents: Array<typeof workspaceAgents.$inferSelect>
  participants: Array<typeof roomParticipants.$inferSelect>
  rooms: Array<typeof rooms.$inferSelect>
  matrixIdentities: Array<typeof matrixIdentities.$inferSelect>
}): Promise<WorkerRuntimeDiagnostics[]> {
  const agentsById = new Map(input.agents.map((agent) => [agent.id, agent]))
  const roomsById = new Map(input.rooms.map((room) => [room.id, room]))
  const rows = await Promise.all(
    input.workers.map(async (worker) => {
      const agent = agentsById.get(worker.workspaceAgentId)
      const participantRows = input.participants.filter((participant) => participant.workerInstanceId === worker.id)
      const identity = input.matrixIdentities.find((item) => item.ownerType === 'worker' && item.ownerId === worker.id)
        ?? input.matrixIdentities.find((item) => item.ownerType === 'worker' && item.ownerId === worker.workspaceAgentId)
        ?? input.matrixIdentities.find((item) => participantRows.some((participant) => participant.providerUserId === item.userId))
        ?? null
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
      const mode: WorkerRuntimeDiagnosticMode = worker.runtimeBase === 'openclaw'
        ? 'resident-openclaw'
        : worker.runtimeBase === 'qwenpaw' || worker.runtimeBase === 'copaw'
          ? 'resident-qwenpaw'
          : 'bridge'
      const listenerManagedBy: WorkerRuntimeListenerOwner = mode === 'bridge'
        ? (participantRows.length ? 'agenthub-supervisor' : 'none')
        : 'runtime'
      const matrixSync = asRecord(identity?.metadata?.matrixSync)
      const runtimeInspection = mode === 'bridge' && agent
        ? await inspectCodeAgentRuntime(
            buildAgentProfile(
              {
                ...agent,
                codeAgentType: agent.codeAgentType ?? bridgeCodeAgentType(worker.runtimeBase),
              },
              contract.root,
            ),
            contract.root,
          ).catch((error) => ({
            runtimeType: 'code-agent' as const,
            codeAgentType: bridgeCodeAgentType(worker.runtimeBase) ?? undefined,
            modelId: worker.modelId,
            modelLabel: worker.modelId ?? 'unconfigured',
            installed: false,
            configured: false,
            executionEnabled: false,
            cwdValid: existsSync(contract.root),
            canExecute: false,
            blockers: [error instanceof Error ? error.message : String(error)],
          }))
        : null
      const backendInspection = mode !== 'bridge'
        ? await inspectResidentWorkerRuntime(worker.id).catch((error) => ({
            workerInstanceId: worker.id,
            ready: false,
            state: 'inspect-failed',
            message: error instanceof Error ? error.message : String(error),
          }))
        : null
      const runtimeHealth = buildRuntimeHealth({
        mode,
        worker,
        contractReady: Object.values(contractFiles).every(Boolean),
        hasMatrixIdentity: Boolean(identity?.userId),
        runtimeInspection,
        backendInspection,
      })
      return {
        workerInstanceId: worker.id,
        workspaceId: worker.workspaceId,
        workspaceAgentId: worker.workspaceAgentId,
        agentName: agent?.name ?? worker.workspaceAgentId,
        runtimeBase: worker.runtimeBase,
        mode,
        observedState: worker.observedState,
        desiredState: worker.desiredState,
        modelId: worker.modelId,
        runtimeHome: worker.runtimeHome,
        runtimeConfigPath: worker.runtimeConfigPath,
        lastHeartbeatAt: worker.lastHeartbeatAt,
        lastError: readWorkerLastError(worker.health) ?? worker.message ?? null,
        listenerManagedBy,
        contractRoot: contract.root,
        contractReady: Object.values(contractFiles).every(Boolean),
        contractFiles,
        matrixIdentity: {
          userId: identity?.userId ?? null,
          displayName: identity?.displayName ?? null,
          syncStatus: stringOrNull(matrixSync?.status),
          lastSyncAt: stringOrNull(matrixSync?.lastSyncAt),
          lastError: stringOrNull(matrixSync?.lastError),
        },
        matrixParticipants: participantRows.map((participant) => {
          const room = roomsById.get(participant.roomId)
          return {
            roomId: participant.roomId,
            roomKind: room?.kind ?? 'unknown',
            providerRoomId: room?.providerRoomId ?? participant.roomId,
            participantId: participant.id,
            providerUserId: participant.providerUserId,
            status: participant.status,
          }
        }),
        runtimeInspection,
        runtimeHealth,
      }
    }),
  )
  return rows.sort((left, right) => left.agentName.localeCompare(right.agentName))
}

async function inspectResidentWorkerRuntime(workerInstanceId: string): Promise<WorkerBackendInspectResult> {
  const backend = workerContainersEnabled() ? dockerWorkerBackend : localCliWorkerBackend
  return backend.inspect(workerInstanceId)
}

function buildRuntimeHealth(input: {
  mode: WorkerRuntimeDiagnosticMode
  worker: typeof workerInstances.$inferSelect
  contractReady: boolean
  hasMatrixIdentity: boolean
  runtimeInspection: CodeAgentRuntimeInspection | null
  backendInspection: WorkerBackendInspectResult | null
}): WorkerRuntimeHealth {
  const blockers: string[] = []
  if (!input.contractReady) blockers.push('Agent contract is incomplete')
  if (!input.hasMatrixIdentity) blockers.push('Matrix identity is missing')
  if (input.worker.observedState === 'failed') {
    blockers.push(readWorkerLastError(input.worker.health) ?? input.worker.message ?? 'WorkerInstance is failed')
  }

  if (input.mode === 'bridge') {
    if (!input.runtimeInspection) {
      blockers.push('Bridge runtime inspection is unavailable')
      return {
        ready: false,
        status: 'blocked',
        inspectedBy: 'bridge-cli',
        state: input.worker.observedState,
        message: blockers[0] ?? 'Bridge runtime inspection is unavailable',
        blockers,
        lastCheckedAt: new Date().toISOString(),
      }
    }
    blockers.push(...input.runtimeInspection.blockers)
    const ready = input.runtimeInspection.canExecute && blockers.length === 0
    return {
      ready,
      status: ready ? 'ready' : 'blocked',
      inspectedBy: 'bridge-cli',
      state: input.runtimeInspection.canExecute ? 'can-execute' : 'blocked',
      message: ready
        ? `${input.runtimeInspection.adapterName ?? input.runtimeInspection.codeAgentType ?? 'Bridge runtime'} is ready.`
        : blockers[0] ?? 'Bridge runtime is blocked.',
      blockers,
      lastCheckedAt: new Date().toISOString(),
      details: {
        codeAgentType: input.runtimeInspection.codeAgentType ?? null,
        command: input.runtimeInspection.command ?? null,
        nativeProbe: input.runtimeInspection.nativeProbe ?? null,
        doctorProbe: input.runtimeInspection.doctorProbe ?? null,
        capabilityProbe: input.runtimeInspection.capabilityProbe ?? null,
        modelId: input.runtimeInspection.modelId ?? null,
      },
    }
  }

  if (!input.backendInspection) {
    blockers.push('Resident backend inspection is unavailable')
    return {
      ready: false,
      status: 'blocked',
      inspectedBy: 'worker-backend',
      state: input.worker.observedState,
      message: blockers[0] ?? 'Resident backend inspection is unavailable',
      blockers,
      lastCheckedAt: new Date().toISOString(),
    }
  }

  if (!input.backendInspection.ready) {
    blockers.push(input.backendInspection.message ?? 'Resident runtime is not ready')
  }
  const ready = input.backendInspection.ready && blockers.length === 0
  return {
    ready,
    status: ready ? 'ready' : 'blocked',
    inspectedBy: 'worker-backend',
    state: input.backendInspection.state ?? input.worker.observedState,
    message: ready
      ? input.backendInspection.message ?? 'Resident runtime is ready.'
      : blockers[0] ?? input.backendInspection.message ?? 'Resident runtime is blocked.',
    blockers,
    lastCheckedAt: new Date().toISOString(),
    details: input.backendInspection.details,
  }
}

function readWorkerLastError(health: Record<string, unknown>) {
  return stringOrNull(health.lastError)
    ?? stringOrNull(health.error)
    ?? stringOrNull(asRecord(health.matrixSync)?.lastError)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function bridgeCodeAgentType(runtimeBase: string): BridgeCodeAgentType | null {
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
