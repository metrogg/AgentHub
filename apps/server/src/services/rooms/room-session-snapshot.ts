import {
  and,
  asc,
  db,
  desc,
  eq,
  orchestratorRuns,
  roomParticipants,
  rooms,
  sessions,
  sql,
  taskThreads,
  timelineEvents,
} from '@agenthub/db'
import { AppError, AppErrorCodes } from '../../lib/error'
import { runController, type RunResourceSnapshot } from '../orchestrator/run-controller'
import { roomService } from './room-service'

type SessionRow = typeof sessions.$inferSelect
type RoomRow = typeof rooms.$inferSelect

export interface RoomSessionSnapshotInput {
  sessionId: string
  ownerId: string
  afterSequence?: number
  includeLegacy?: boolean
}

export async function loadRoomSessionSnapshot(input: RoomSessionSnapshotInput) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1)
  if (!session || session.ownerId !== input.ownerId) {
    throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
  }

  const room = await ensureSnapshotRoom(session, input.ownerId)
  const afterSequence = Number.isFinite(input.afterSequence ?? 0)
    ? Math.max(0, Math.floor(input.afterSequence ?? 0))
    : 0
  const [participants, timeline, activeRunId] = await Promise.all([
    db.select().from(roomParticipants).where(eq(roomParticipants.roomId, room.id)),
    db
      .select()
      .from(timelineEvents)
      .where(
        afterSequence > 0
          ? and(eq(timelineEvents.roomId, room.id), sql`${timelineEvents.sequence} > ${afterSequence}`)
          : eq(timelineEvents.roomId, room.id),
      )
      .orderBy(asc(timelineEvents.sequence)),
    resolveActiveRunId(session, room),
  ])

  const resourceSnapshot = activeRunId
    ? normalizeResourceSnapshot(await runController.loadResourceSnapshot(activeRunId))
    : emptyResourceSnapshot()
  const fullTimelineCursor = await loadTimelineCursor(room.id)

  return {
    session,
    room,
    participants,
    timeline,
    resources: resourceSnapshot,
    bindings: buildRoomSessionBindings(session, room, resourceSnapshot),
    cursors: {
      timelineSequence: fullTimelineCursor,
      resourceVersion: resourceVersion([session, room, ...timeline], resourceSnapshot),
    },
  }
}

async function ensureSnapshotRoom(session: SessionRow, ownerId: string): Promise<RoomRow> {
  const metadata = asRecord(session.metadata)
  const taskThreadId = stringValue(metadata.taskThreadId)
  if (metadata.kind === 'orchestrator-task' && taskThreadId) {
    try {
      const input = await roomService.buildTaskThreadRoomInput(taskThreadId, ownerId)
      return await roomService.ensureRoomForTaskThread(input)
    } catch {
      // Some legacy task sessions have incomplete metadata. They still get a
      // normal session room so the UI can recover without falling back to
      // messages as the current fact source.
    }
  }
  return roomService.ensureRoomForSession(session.id, ownerId)
}

async function resolveActiveRunId(session: SessionRow, room: RoomRow) {
  if (room.runId) return room.runId
  const metadata = asRecord(session.metadata)
  const metadataRunId = stringValue(metadata.orchestratorRunId)
  if (metadataRunId) return metadataRunId
  if (room.taskThreadId) {
    const [thread] = await db
      .select({ runId: taskThreads.runId })
      .from(taskThreads)
      .where(eq(taskThreads.id, room.taskThreadId))
      .limit(1)
    if (thread?.runId) return thread.runId
  }
  if (session.type === 'group') {
    const [run] = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.groupSessionId, session.id))
      .orderBy(desc(orchestratorRuns.updatedAt), desc(orchestratorRuns.createdAt))
      .limit(1)
    if (run?.id) return run.id
  }
  return null
}

async function loadTimelineCursor(roomId: string) {
  const [row] = await db
    .select({ sequence: timelineEvents.sequence })
    .from(timelineEvents)
    .where(eq(timelineEvents.roomId, roomId))
    .orderBy(desc(timelineEvents.sequence))
    .limit(1)
  return row?.sequence ?? 0
}

function emptyResourceSnapshot() {
  return {
    activeRun: null,
    run: null,
    counts: {
      tasksByStatus: {},
      taskThreadsByStatus: {},
      artifactsByStatus: {},
      runtimeLeasesByStatus: {},
      workerInstancesByState: {},
      totalTasks: 0,
      totalTaskThreads: 0,
      totalArtifacts: 0,
      totalRuntimeLeases: 0,
      totalWorkerInstances: 0,
    },
    tasks: [],
    taskThreads: [],
    artifacts: [],
    runtimeLeases: [],
    workerInstances: [],
  }
}

function normalizeResourceSnapshot(snapshot: RunResourceSnapshot) {
  const run = snapshot.run
    ? {
        id: snapshot.run.id,
        workspaceId: snapshot.run.workspaceId,
        groupSessionId: snapshot.run.groupSessionId,
        status: snapshot.run.status,
        planMessageId: snapshot.run.planMessageId,
        summaryMessageId: snapshot.run.summaryMessageId,
        createdAt: snapshot.run.createdAt,
        updatedAt: snapshot.run.updatedAt,
      }
    : null
  return {
    activeRun: run,
    run,
    counts: snapshot.counts,
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      workspaceId: task.workspaceId,
      agentId: task.agentId,
      title: task.title,
      description: task.description,
      status: task.status,
      sessionId: task.sessionId,
      orderIdx: task.orderIdx,
      runId: task.runId,
      phaseId: task.phaseId,
      dependencies: task.dependencies,
      progressPercent: task.progressPercent,
      progressStatus: task.progressStatus,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      errorLog: task.errorLog,
      artifacts: task.artifacts,
    })),
    taskThreads: snapshot.taskThreads.map((thread) => ({
      id: thread.id,
      workspaceId: thread.workspaceId,
      runId: thread.runId,
      taskId: thread.taskId,
      groupSessionId: thread.groupSessionId,
      workspaceAgentId: thread.workspaceAgentId,
      workerInstanceId: thread.workerInstanceId,
      sessionId: thread.sessionId,
      status: thread.status,
      lastEventId: thread.lastEventId,
      sharedTaskRelativeRoot: thread.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: thread.sharedTaskSpecPath ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    })),
    artifacts: snapshot.artifacts.map((artifact) => ({
      artifactId: artifact.id,
      id: artifact.id,
      kind: artifact.kind,
      artifactKind: artifact.kind,
      title: artifact.title,
      description: artifact.description ?? undefined,
      filePath: artifact.relativePath ?? artifact.handoffPath ?? artifact.sourcePath ?? undefined,
      path: artifact.relativePath ?? undefined,
      sourcePath: artifact.sourcePath ?? undefined,
      handoffPath: artifact.handoffPath ?? undefined,
      handoffRelativePath: artifact.relativePath ?? undefined,
      mimeType: artifact.mimeType ?? undefined,
      size: artifact.size ?? undefined,
      checksum: artifact.checksum ?? undefined,
      status: artifact.status,
      visibility: artifact.visibility,
      source: 'artifact-store',
      taskId: artifact.taskId,
      roomId: artifact.roomId,
      taskThreadId: artifact.taskThreadId,
      storageProvider: artifact.storageProvider,
      bucket: artifact.bucket,
      objectKey: artifact.objectKey ?? undefined,
      storagePath: artifact.storagePath ?? undefined,
      workspaceAgentId: artifact.workspaceAgentId,
      workerInstanceId: artifact.workerInstanceId,
      metadata: artifact.metadata,
      createdAt: artifact.createdAt,
    })),
    runtimeLeases: snapshot.runtimeLeases.map((lease) => ({
      id: lease.id,
      runtimeLeaseId: lease.id,
      taskId: lease.taskId,
      workerInstanceId: lease.workerInstanceId,
      provider: lease.provider,
      status: lease.status,
      cwd: lease.cwd,
      homeDir: lease.homeDir,
      configDir: lease.configDir,
      cacheDir: lease.cacheDir,
      tmpDir: lease.tmpDir,
      dataDir: lease.dataDir,
      containerId: lease.containerId,
      sandboxId: lease.sandboxId,
      pid: lease.pid,
      startedAt: lease.startedAt,
      releasedAt: lease.releasedAt,
      error: lease.error,
      metadata: lease.metadata,
      createdAt: lease.createdAt,
      updatedAt: lease.updatedAt,
    })),
    workerInstances: snapshot.workerInstances.map((worker) => ({
      id: worker.id,
      workspaceId: worker.workspaceId,
      workspaceAgentId: worker.workspaceAgentId,
      runtimeFamily: worker.runtimeFamily,
      runtimeBase: worker.runtimeBase,
      modelId: worker.modelId,
      skillIds: worker.skillIds,
      mcpServerIds: worker.mcpServerIds,
      sandboxPolicy: worker.sandboxPolicy,
      desiredState: worker.desiredState,
      observedState: worker.observedState,
      health: worker.health,
      runtimeHome: worker.runtimeHome,
      runtimeConfigPath: worker.runtimeConfigPath,
      lastHeartbeatAt: worker.lastHeartbeatAt,
      message: worker.message,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
    })),
  }
}

function buildRoomSessionBindings(
  session: SessionRow,
  room: RoomRow,
  resources: ReturnType<typeof normalizeResourceSnapshot> | ReturnType<typeof emptyResourceSnapshot>,
) {
  const metadata = asRecord(session.metadata)
  const taskThreadId = room.taskThreadId ?? stringValue(metadata.taskThreadId)
  const taskThread = taskThreadId
    ? resources.taskThreads.find((thread) => thread.id === taskThreadId) ?? null
    : null
  return {
    parentGroupSessionId:
      room.kind === 'task'
        ? taskThread?.groupSessionId ?? stringValue(metadata.groupSessionId) ?? null
        : null,
    orchestratorRunId:
      resources.activeRun?.id ?? room.runId ?? stringValue(metadata.orchestratorRunId) ?? null,
    orchestratorTaskId:
      room.taskId ?? taskThread?.taskId ?? stringValue(metadata.orchestratorTaskId) ?? null,
    taskThreadId: taskThreadId ?? null,
  }
}

function resourceVersion(rows: unknown[], resources: ReturnType<typeof normalizeResourceSnapshot> | ReturnType<typeof emptyResourceSnapshot>) {
  const timestamps = [
    ...rows.map(readUpdatedTimestamp),
    ...resources.tasks.map(readUpdatedTimestamp),
    ...resources.taskThreads.map(readUpdatedTimestamp),
    ...resources.artifacts.map(readUpdatedTimestamp),
    ...resources.runtimeLeases.map(readUpdatedTimestamp),
    ...resources.workerInstances.map(readUpdatedTimestamp),
    resources.activeRun ? readUpdatedTimestamp(resources.activeRun) : 0,
  ]
  const max = Math.max(0, ...timestamps.filter((value) => Number.isFinite(value)))
  return max > 0 ? new Date(max).toISOString() : '0'
}

function readUpdatedTimestamp(value: unknown) {
  const record = asRecord(value)
  const candidate = record.updatedAt ?? record.createdAt
  if (candidate instanceof Date) return candidate.getTime()
  if (typeof candidate === 'string') {
    const parsed = Date.parse(candidate)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
