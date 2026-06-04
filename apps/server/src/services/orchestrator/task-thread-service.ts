import { and, db, desc, eq, sessions, taskThreads, workspaceTasks } from '@agenthub/db'
import { AppError, AppErrorCodes } from '../../lib/error'
import { prepareSharedTaskDirectory } from './shared-task-directory'
import { type WorkerRuntimeAgentConfig } from './worker-runtime-resources'
import { workerController } from './worker-controller'
import { roomController, roomService } from '../rooms'

export interface EnsureTaskThreadInput {
  workspaceId: string
  runId: string
  taskId: string
  groupSessionId: string
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  sessionId: string
  ownerId: string
  taskTitle: string
  agentName?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  sharedTaskObjects?: Record<string, unknown> | null
}

export interface PrepareTaskRuntimeThreadInput {
  workspaceId: string
  workspaceName: string
  ownerId: string
  runId: string
  taskId: string
  groupSessionId: string
  projectPath?: string | null
  taskTitle: string
  taskDescription: string
  goal: string
  agent?: (WorkerRuntimeAgentConfig & { name: string; role?: string | null }) | null
  dependencies?: string[]
  acceptanceCriteria?: string[]
  requiredArtifacts?: string[]
}

export interface PreparedTaskRuntimeThread {
  sessionId: string
  workspaceId: string
  projectPath?: string | null
  taskThreadId: string
  workerInstanceId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  sharedTaskObjects?: Record<string, unknown> | null
}

export async function prepareTaskRuntimeThread(
  input: PrepareTaskRuntimeThreadInput,
): Promise<PreparedTaskRuntimeThread> {
  const sharedTaskDirectory = await prepareSharedTaskDirectory({
    projectPath: input.projectPath,
    runId: input.runId,
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    taskDescription: input.taskDescription,
    goal: input.goal,
    assignee: input.agent
      ? {
          id: input.agent.id,
          name: input.agent.name,
          role: input.agent.role,
        }
      : null,
    dependencies: input.dependencies,
    acceptanceCriteria: input.acceptanceCriteria,
    requiredArtifacts: input.requiredArtifacts,
  })

  const childSession = await ensureTaskThreadProjectionSession({
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    ownerId: input.ownerId,
    agent: input.agent ? { id: input.agent.id, name: input.agent.name } : null,
    taskTitle: input.taskTitle,
    runId: input.runId,
    taskId: input.taskId,
    groupSessionId: input.groupSessionId,
  })
  const workerInstanceId = input.agent
    ? await workerController.ensureWorkerForAgent(input.workspaceId, input.agent)
    : null

  const taskThread = await ensureTaskThread({
    workspaceId: input.workspaceId,
    runId: input.runId,
    taskId: input.taskId,
    groupSessionId: input.groupSessionId,
    workspaceAgentId: input.agent?.id ?? null,
    workerInstanceId: workerInstanceId ?? null,
    sessionId: childSession.id,
    ownerId: input.ownerId,
    taskTitle: input.taskTitle,
    agentName: input.agent?.name ?? null,
    sharedTaskRelativeRoot: sharedTaskDirectory?.relativeRoot ?? null,
    sharedTaskSpecPath: sharedTaskDirectory ? `${sharedTaskDirectory.relativeRoot}/spec.md` : null,
    sharedTaskObjects: sharedTaskDirectory?.objects ?? null,
  })

  await db
    .update(workspaceTasks)
    .set({
      sessionId: childSession.id,
      progressStatus: 'thread-prepared',
      updatedAt: new Date(),
    })
    .where(eq(workspaceTasks.id, input.taskId))

  return {
    sessionId: childSession.id,
    workspaceId: input.workspaceId,
    projectPath: input.projectPath ?? null,
    taskThreadId: taskThread.id,
    workerInstanceId: workerInstanceId ?? null,
    sharedTaskRelativeRoot: sharedTaskDirectory?.relativeRoot ?? null,
    sharedTaskSpecPath: sharedTaskDirectory ? `${sharedTaskDirectory.relativeRoot}/spec.md` : null,
    sharedTaskObjects: sharedTaskDirectory?.objects ?? null,
  }
}

export async function ensureTaskThread(input: EnsureTaskThreadInput) {
  const existing = await findTaskThread(input.runId, input.taskId)
  if (existing) {
    const threadPatch: Partial<typeof taskThreads.$inferInsert> = {}
    if (existing.workspaceAgentId !== (input.workspaceAgentId ?? null)) {
      threadPatch.workspaceAgentId = input.workspaceAgentId ?? null
    }
    if (existing.workerInstanceId !== (input.workerInstanceId ?? null)) {
      threadPatch.workerInstanceId = input.workerInstanceId ?? null
    }
    if (existing.sessionId !== input.sessionId) {
      threadPatch.sessionId = input.sessionId
    }
    if (existing.groupSessionId !== input.groupSessionId) {
      threadPatch.groupSessionId = input.groupSessionId
    }

    let current = existing
    if (Object.keys(threadPatch).length > 0) {
      const [updated] = await db
        .update(taskThreads)
        .set({
          ...threadPatch,
          updatedAt: new Date(),
        })
        .where(eq(taskThreads.id, existing.id))
        .returning()
      current = updated ?? existing
    }
    await syncTaskThreadSessionMetadata(input.sessionId, {
      taskThreadId: current.id,
      groupSessionId: input.groupSessionId,
      runId: input.runId,
      taskId: input.taskId,
      workspaceAgentId: input.workspaceAgentId ?? null,
      workerInstanceId: input.workerInstanceId,
      status: current.status,
      sharedTaskRelativeRoot: input.sharedTaskRelativeRoot,
      sharedTaskSpecPath: input.sharedTaskSpecPath,
      sharedTaskObjects: input.sharedTaskObjects,
    })
    await ensureTaskThreadRoomTimeline(input, current.id)
    return current
  }

  const [created] = await db
    .insert(taskThreads)
    .values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      taskId: input.taskId,
      groupSessionId: input.groupSessionId,
      workspaceAgentId: input.workspaceAgentId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      sessionId: input.sessionId,
      status: 'prepared',
    })
    .returning()

  if (!created) {
    throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '任务子对话资源创建失败')
  }

  await syncTaskThreadSessionMetadata(input.sessionId, {
    taskThreadId: created.id,
    groupSessionId: input.groupSessionId,
    runId: input.runId,
    taskId: input.taskId,
    workspaceAgentId: input.workspaceAgentId ?? null,
    workerInstanceId: input.workerInstanceId,
    status: created.status,
    sharedTaskRelativeRoot: input.sharedTaskRelativeRoot,
    sharedTaskSpecPath: input.sharedTaskSpecPath,
    sharedTaskObjects: input.sharedTaskObjects,
  })
  await ensureTaskThreadRoomTimeline(input, created.id)
  return created
}

export async function updateTaskThreadStatus(
  taskThreadId: string | null | undefined,
  status: 'prepared' | 'assigned' | 'active' | 'waiting_for_human' | 'completed' | 'failed' | 'cancelled',
  lastEventId?: string | null,
) {
  if (!taskThreadId) return null
  const [updated] = await db
    .update(taskThreads)
    .set({
      status,
      lastEventId: lastEventId ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(taskThreads.id, taskThreadId))
    .returning()
  if (updated) {
    await syncTaskThreadSessionMetadata(updated.sessionId, {
      taskThreadId: updated.id,
      groupSessionId: updated.groupSessionId,
      runId: updated.runId,
      taskId: updated.taskId,
      workspaceAgentId: updated.workspaceAgentId,
      workerInstanceId: updated.workerInstanceId,
      status: updated.status,
    })
  }
  return updated ?? null
}

async function findTaskThread(runId: string, taskId: string) {
  const [thread] = await db
    .select()
    .from(taskThreads)
    .where(and(eq(taskThreads.runId, runId), eq(taskThreads.taskId, taskId)))
    .limit(1)
  return thread ?? null
}

async function ensureTaskThreadProjectionSession(input: {
  workspaceId: string
  workspaceName: string
  ownerId: string
  agent: { id: string; name: string } | null
  taskTitle: string | undefined
  runId: string
  taskId: string
  groupSessionId: string
}) {
  const existingThread = await findTaskThread(input.runId, input.taskId)
  if (existingThread) {
    const [projectedSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, existingThread.sessionId))
      .limit(1)
    if (
      projectedSession &&
      projectedSession.ownerId === input.ownerId &&
      projectedSession.workspaceId === input.workspaceId &&
      projectedSession.type === 'direct'
    ) {
      const title = taskThreadSessionTitle(input)
      const [updated] = await db
        .update(sessions)
        .set({
          workspaceAgentId: input.agent?.id ?? null,
          title,
          metadata: {
            ...(projectedSession.metadata ?? {}),
            kind: 'orchestrator-task',
            groupSessionId: input.groupSessionId,
            orchestratorRunId: input.runId,
            orchestratorTaskId: input.taskId,
            taskThreadId: existingThread.id,
            taskThreadStatus: existingThread.status,
            workspaceAgentId: input.agent?.id ?? undefined,
          },
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, projectedSession.id))
        .returning()
      return updated ?? projectedSession
    }
  }

  const existingSessions = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.ownerId, input.ownerId),
        eq(sessions.type, 'direct'),
        eq(sessions.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(desc(sessions.updatedAt))

  const matched = existingSessions.find((session) => {
    const metadata = session.metadata ?? {}
    return (
      metadata.kind === 'orchestrator-task' &&
      metadata.orchestratorRunId === input.runId &&
      metadata.orchestratorTaskId === input.taskId &&
      metadata.groupSessionId === input.groupSessionId
    )
  })

  const title = taskThreadSessionTitle(input)

  if (matched) {
    const nextMetadata = {
      ...(matched.metadata ?? {}),
      kind: 'orchestrator-task',
      groupSessionId: input.groupSessionId,
      orchestratorRunId: input.runId,
      orchestratorTaskId: input.taskId,
    }
    const [updated] = await db
      .update(sessions)
      .set({
        workspaceAgentId: input.agent?.id ?? null,
        title,
        metadata: nextMetadata,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, matched.id))
      .returning()
    return updated ?? matched
  }

  const [created] = await db
    .insert(sessions)
    .values({
      title,
      type: 'direct',
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      workspaceAgentId: input.agent?.id ?? null,
      metadata: {
        kind: 'orchestrator-task',
        groupSessionId: input.groupSessionId,
        orchestratorRunId: input.runId,
        orchestratorTaskId: input.taskId,
      },
    })
    .returning()
  if (!created) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '任务子对话创建失败')
  return created
}

function taskThreadSessionTitle(input: {
  workspaceName: string
  agent: { id: string; name: string } | null
  taskTitle: string | undefined
}) {
  return input.agent
    ? `${input.workspaceName} / ${input.agent.name} / ${input.taskTitle?.slice(0, 24) || 'Task'}`
    : `${input.workspaceName} / ${input.taskTitle?.slice(0, 24) || 'Task'}`
}

async function syncTaskThreadSessionMetadata(
  sessionId: string,
  metadata: {
    taskThreadId: string
    groupSessionId: string
    runId: string
    taskId: string
    workspaceAgentId?: string | null
    workerInstanceId?: string | null
    status?: string | null
    sharedTaskRelativeRoot?: string | null
    sharedTaskSpecPath?: string | null
    sharedTaskObjects?: Record<string, unknown> | null
  },
) {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  if (!session) return
  await db
    .update(sessions)
    .set({
      workspaceAgentId: metadata.workspaceAgentId ?? null,
      metadata: {
        ...(session.metadata ?? {}),
        kind: 'orchestrator-task',
        taskThreadId: metadata.taskThreadId,
        groupSessionId: metadata.groupSessionId,
        orchestratorRunId: metadata.runId,
        orchestratorTaskId: metadata.taskId,
        workspaceAgentId: metadata.workspaceAgentId ?? undefined,
        workerInstanceId: metadata.workerInstanceId ?? undefined,
        taskThreadStatus: metadata.status ?? undefined,
        sharedTaskRelativeRoot: metadata.sharedTaskRelativeRoot ?? undefined,
        sharedTaskSpecPath: metadata.sharedTaskSpecPath ?? undefined,
        sharedTaskObjects: metadata.sharedTaskObjects ?? undefined,
      },
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
}

async function ensureTaskThreadRoomTimeline(input: EnsureTaskThreadInput, taskThreadId: string) {
  const room = await roomController.ensureTaskThreadRoomFromInput({
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    groupSessionId: input.groupSessionId,
    sessionId: input.sessionId,
    runId: input.runId,
    taskId: input.taskId,
    taskThreadId,
    title: input.taskTitle,
    workspaceAgentId: input.workspaceAgentId,
    workerInstanceId: input.workerInstanceId,
    metadata: {
      sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
      sharedTaskObjects: input.sharedTaskObjects ?? null,
    },
  })
  const events = await roomService.listTimelineEvents({ roomId: room.id, limit: 20 })
  const hasPreparedEvent = events.some((event) => event.metadata?.kind === 'task-thread-prepared')
  if (hasPreparedEvent) return
  await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'manager',
    type: 'task.assigned',
    body: input.agentName
      ? `Manager 已准备任务：${input.taskTitle}\n预计负责人：${input.agentName}`
      : `Manager 已准备任务：${input.taskTitle}\n预计负责人：待分配`,
    metadata: {
      kind: 'task-thread-prepared',
      taskThreadId,
      runId: input.runId,
      taskId: input.taskId,
      groupSessionId: input.groupSessionId,
      workspaceAgentId: input.workspaceAgentId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
      sharedTaskObjects: input.sharedTaskObjects ?? null,
    },
  })
}
