import { existsSync } from 'node:fs'
import { and, db, eq, matrixIdentities, roomParticipants, rooms, workerInstances, workspaceAgents } from '@agenthub/db'
import { resolveWorkerAgentContractWorkspace } from '../agent-contract'
import { workerContainersEnabled } from '../container-runtime/agent-runtime-containers'
import { roomService } from '../rooms'
import { dockerWorkerBackend } from './docker-worker-backend'
import { localCliWorkerBackend, type WorkerBackendInspectResult } from './worker-backend'

export interface ResidentWorkerSelfTestInput {
  workerInstanceId: string
  ownerId: string
  dispatch?: boolean
  roomId?: string | null
  timeoutMs?: number
}

export interface ResidentWorkerSelfTestCheck {
  id: string
  label: string
  ok: boolean
  message: string
  details?: Record<string, unknown>
}

export interface ResidentWorkerSelfTestResult {
  ok: boolean
  workerInstanceId: string
  runtimeBase: string | null
  dispatchAttempted: boolean
  dispatchEventId: string | null
  probeRoom: {
    roomId: string
    roomKind: string
    providerRoomId: string
    participantId: string
  } | null
  observedReply: {
    eventId: string
    sequence: number
    body: string
    protocol: 'TASK_COMPLETED' | 'BLOCKED' | 'QUESTION' | 'PHASE_DONE' | 'NO_REPLY' | 'message'
  } | null
  checks: ResidentWorkerSelfTestCheck[]
  message: string
}

type WorkerReplyProtocol = NonNullable<ResidentWorkerSelfTestResult['observedReply']>['protocol']

export async function runResidentWorkerSelfTest(
  input: ResidentWorkerSelfTestInput,
): Promise<ResidentWorkerSelfTestResult> {
  const checks: ResidentWorkerSelfTestCheck[] = []
  const [worker] = await db
    .select()
    .from(workerInstances)
    .where(eq(workerInstances.id, input.workerInstanceId))
    .limit(1)

  if (!worker) {
    checks.push(check('worker', 'WorkerInstance', false, 'WorkerInstance not found.'))
    return finish({
      workerInstanceId: input.workerInstanceId,
      runtimeBase: null,
      dispatchAttempted: false,
      dispatchEventId: null,
      probeRoom: null,
      observedReply: null,
      checks,
    })
  }

  const resident = isResidentRuntimeBase(worker.runtimeBase)
  checks.push(check(
    'runtime-base',
    'Resident runtime base',
    resident,
    resident
      ? `${worker.runtimeBase} is a resident Worker runtime.`
      : `${worker.runtimeBase} is not a resident Worker runtime.`,
  ))

  const [agent] = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.id, worker.workspaceAgentId))
    .limit(1)
  checks.push(check('workspace-agent', 'WorkspaceAgent', Boolean(agent), agent ? agent.name : 'WorkspaceAgent not found.'))

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
  checks.push(check(
    'contract',
    'SOUL/AGENTS contract',
    contractReady,
    contractReady ? 'Worker contract is complete.' : `Missing contract files: ${missingKeys(contractFiles).join(', ')}`,
    { root: contract.root, files: contractFiles },
  ))

  const identity = await findWorkerMatrixIdentity(worker.id, worker.workspaceAgentId)
  checks.push(check(
    'matrix-identity',
    'Matrix identity',
    Boolean(identity?.userId && identity?.accessToken),
    identity?.userId
      ? identity.accessToken
        ? identity.userId
        : `${identity.userId} has no access token.`
      : 'Worker Matrix identity not found.',
  ))

  const participantRows = await findWorkerParticipants(worker.id, input.ownerId)
  checks.push(check(
    'room-participant',
    'Room participant',
    participantRows.length > 0,
    participantRows.length
      ? `${participantRows.length} joined room participant(s) found.`
      : 'Worker is not joined to any room owned by this user.',
  ))

  const backendInspection = resident
    ? await withTimeout(
        inspectResidentBackend(worker.id),
        2_000,
        {
          workerInstanceId: worker.id,
          ready: false,
          state: 'inspect-timeout',
          message: 'Resident backend inspection timed out.',
        },
      ).catch((error) => ({
        workerInstanceId: worker.id,
        ready: false,
        state: 'inspect-failed',
        message: error instanceof Error ? error.message : String(error),
      }))
    : null
  if (resident) {
    checks.push(check(
      'backend',
      'Resident backend',
      Boolean(backendInspection?.ready),
      backendInspection?.message ?? 'Resident backend inspection unavailable.',
      backendInspectionDetails(backendInspection),
    ))
  }

  const selected = selectProbeRoom(participantRows, input.roomId)
  checks.push(check(
    'probe-room',
    'Probe room',
    Boolean(selected),
    selected
      ? `${selected.room.kind} room is available for probe.`
      : input.roomId
        ? 'Requested room is not joined by this Worker or not owned by this user.'
        : 'No suitable group/direct/manager room found for probe.',
  ))

  let dispatchEventId: string | null = null
  let observedReply: ResidentWorkerSelfTestResult['observedReply'] = null
  if (input.dispatch) {
    if (!resident || !selected || !identity?.accessToken || !backendInspection?.ready) {
      checks.push(check(
        'dispatch',
        'Matrix @mention probe',
        false,
        'Dispatch skipped because resident readiness checks did not pass.',
      ))
    } else {
      const event = await roomService.appendMentionTimelineEvent({
        roomId: selected.room.id,
        senderType: 'system',
        type: 'task.assigned',
        body: [
          `@${selected.participant.displayName} AgentHub resident self-test.`,
          '请只回复一行：TASK_COMPLETED: resident-self-test-ok',
        ].join('\n'),
        metadata: {
          kind: 'worker-runtime.resident-self-test.request',
          workerInstanceId: worker.id,
          workspaceAgentId: worker.workspaceAgentId,
          skipAutoDispatch: true,
        },
        mentionParticipantId: selected.participant.id,
      })
      dispatchEventId = event.id
      observedReply = await waitForWorkerReply({
        roomId: selected.room.id,
        workerParticipantId: selected.participant.id,
        workerInstanceId: worker.id,
        afterSequence: event.sequence,
        timeoutMs: input.timeoutMs ?? 15_000,
      })
      checks.push(check(
        'dispatch',
        'Matrix @mention probe',
        Boolean(observedReply),
        observedReply
          ? `Observed Worker reply: ${observedReply.protocol}.`
          : 'No Worker reply observed before timeout.',
        { dispatchEventId },
      ))
    }
  }

  return finish({
    workerInstanceId: worker.id,
    runtimeBase: worker.runtimeBase,
    dispatchAttempted: Boolean(input.dispatch),
    dispatchEventId,
    probeRoom: selected
      ? {
          roomId: selected.room.id,
          roomKind: selected.room.kind,
          providerRoomId: selected.room.providerRoomId,
          participantId: selected.participant.id,
        }
      : null,
    observedReply,
    checks,
  })
}

async function inspectResidentBackend(workerInstanceId: string): Promise<WorkerBackendInspectResult> {
  const backend = workerContainersEnabled() ? dockerWorkerBackend : localCliWorkerBackend
  return backend.inspect(workerInstanceId)
}

async function findWorkerMatrixIdentity(workerInstanceId: string, workspaceAgentId: string) {
  const [byWorker] = await db
    .select()
    .from(matrixIdentities)
    .where(and(eq(matrixIdentities.ownerType, 'worker'), eq(matrixIdentities.ownerId, workerInstanceId)))
    .limit(1)
  if (byWorker) return byWorker
  const [byAgent] = await db
    .select()
    .from(matrixIdentities)
    .where(and(eq(matrixIdentities.ownerType, 'worker'), eq(matrixIdentities.ownerId, workspaceAgentId)))
    .limit(1)
  return byAgent ?? null
}

async function findWorkerParticipants(workerInstanceId: string, ownerId: string) {
  return db
    .select({
      participant: roomParticipants,
      room: rooms,
    })
    .from(roomParticipants)
    .innerJoin(rooms, eq(roomParticipants.roomId, rooms.id))
    .where(
      and(
        eq(roomParticipants.workerInstanceId, workerInstanceId),
        eq(roomParticipants.participantType, 'worker'),
        eq(roomParticipants.status, 'joined'),
        eq(rooms.ownerId, ownerId),
      ),
    )
}

function selectProbeRoom(
  rows: Awaited<ReturnType<typeof findWorkerParticipants>>,
  roomId?: string | null,
) {
  const candidates = roomId ? rows.filter((row) => row.room.id === roomId) : rows
  return (
    candidates.find((row) => row.room.kind === 'group') ??
    candidates.find((row) => row.room.kind === 'manager_dm') ??
    candidates.find((row) => row.room.kind === 'direct') ??
    candidates[0] ??
    null
  )
}

async function waitForWorkerReply(input: {
  roomId: string
  workerParticipantId: string
  workerInstanceId: string
  afterSequence: number
  timeoutMs: number
}) {
  const deadline = Date.now() + Math.max(100, Math.min(input.timeoutMs, 60_000))
  while (Date.now() < deadline) {
    const events = await roomService.listTimelineEvents({
      roomId: input.roomId,
      afterSequence: input.afterSequence,
      limit: 100,
    })
    const reply = events.find((event) => {
      if (event.senderType !== 'worker') return false
      if (event.senderParticipantId === input.workerParticipantId) return true
      return event.metadata?.workerInstanceId === input.workerInstanceId
    })
    if (reply) {
      return {
        eventId: reply.id,
        sequence: reply.sequence,
        body: reply.body,
        protocol: classifyWorkerReply(reply.body),
      }
    }
    await sleep(250)
  }
  return null
}

function classifyWorkerReply(body: string): WorkerReplyProtocol {
  const trimmed = body.trim()
  if (/^TASK_COMPLETED:/s.test(trimmed)) return 'TASK_COMPLETED'
  if (/^BLOCKED:/s.test(trimmed)) return 'BLOCKED'
  if (/^QUESTION:/s.test(trimmed)) return 'QUESTION'
  if (/^PHASE\d+_DONE:/s.test(trimmed)) return 'PHASE_DONE'
  if (trimmed === 'NO_REPLY') return 'NO_REPLY'
  return 'message'
}

function isResidentRuntimeBase(runtimeBase: string) {
  return runtimeBase === 'openclaw' || runtimeBase === 'qwenpaw' || runtimeBase === 'copaw'
}

function check(
  id: string,
  label: string,
  ok: boolean,
  message: string,
  details?: Record<string, unknown>,
): ResidentWorkerSelfTestCheck {
  return { id, label, ok, message, ...(details ? { details } : {}) }
}

function finish(input: Omit<ResidentWorkerSelfTestResult, 'ok' | 'message'>): ResidentWorkerSelfTestResult {
  const ok = input.checks.every((item) => item.ok)
  return {
    ...input,
    ok,
    message: ok
      ? input.dispatchAttempted
        ? 'Resident Worker self-test passed and a Worker reply was observed.'
        : 'Resident Worker readiness checks passed.'
      : input.checks.find((item) => !item.ok)?.message ?? 'Resident Worker self-test failed.',
  }
}

function missingKeys(record: Record<string, boolean>) {
  return Object.entries(record)
    .filter(([, ok]) => !ok)
    .map(([key]) => key)
}

function backendInspectionDetails(
  result: WorkerBackendInspectResult | { workerInstanceId: string; ready: boolean; state: string; message: string } | null,
) {
  return result && 'details' in result ? result.details : undefined
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
