import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { alias } from 'drizzle-orm/sqlite-core'
import { db, eq, and, desc, asc, sql } from '@agenthub/db'
import {
  artifacts as artifactRecords,
  orchestratorRuns,
  executionLogs,
  workspaces,
  sessions,
  runtimeLeases,
  workspaceTasks,
  taskThreads,
} from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { listRunEvents } from '../services/orchestrator/run-events'
import { blackboard, Blackboard } from '../services/blackboard'
import type { BlackboardSchemaType } from '../services/blackboard-schemas'
import { OrchestratorEngine, type ExecutionTask } from '../services/orchestrator/orchestrator-engine'
import type { ConflictReport } from '../services/orchestrator/conflict-resolver'
import { runController, type RunResourceSnapshot } from '../services/orchestrator/run-controller'
import { buildAgUiEventsFromRunEvent } from '../services/protocols'
import { OrchestratorRunStatus } from '@agenthub/shared'

const taskThreadSessions = alias(sessions, 'task_thread_sessions')

export const orchestratorRunRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const user = c.get('user')
    const list = await tableSafe(
      db
        .select({
          id: orchestratorRuns.id,
          workspaceId: orchestratorRuns.workspaceId,
          groupSessionId: orchestratorRuns.groupSessionId,
          planMessageId: orchestratorRuns.planMessageId,
          status: orchestratorRuns.status,
          plan: orchestratorRuns.plan,
          summaryMessageId: orchestratorRuns.summaryMessageId,
          conflictReport: orchestratorRuns.conflictReport,
          createdAt: orchestratorRuns.createdAt,
          updatedAt: orchestratorRuns.updatedAt,
          workspaceName: workspaces.name,
          sessionTitle: sessions.title,
        })
        .from(orchestratorRuns)
        .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
        .leftJoin(sessions, eq(sessions.id, orchestratorRuns.groupSessionId))
        .where(eq(workspaces.ownerId, user.sub))
        .orderBy(desc(orchestratorRuns.createdAt)),
      [],
    )

    return c.json({
      items: await Promise.all(
        list.map(async (row) =>
          normalizeRunRow(
            row,
            await loadRunTasks(row.id),
            await loadRunArtifacts(row.id),
            await loadRunRuntimeLeases(row.id),
          ),
        ),
      ),
    })
  })
  .get('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await tableSafe(
      db
        .select({
          id: orchestratorRuns.id,
          workspaceId: orchestratorRuns.workspaceId,
          groupSessionId: orchestratorRuns.groupSessionId,
          planMessageId: orchestratorRuns.planMessageId,
          status: orchestratorRuns.status,
          plan: orchestratorRuns.plan,
          summaryMessageId: orchestratorRuns.summaryMessageId,
          conflictReport: orchestratorRuns.conflictReport,
          createdAt: orchestratorRuns.createdAt,
          updatedAt: orchestratorRuns.updatedAt,
          workspaceName: workspaces.name,
          sessionTitle: sessions.title,
        })
        .from(orchestratorRuns)
        .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
        .leftJoin(sessions, eq(sessions.id, orchestratorRuns.groupSessionId))
        .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
        .limit(1),
      [],
    )

    if (!run) throw new HTTPException(404, { message: 'Run not found' })
    const [resourceSnapshot, runEvents] = await Promise.all([
      runController.loadResourceSnapshot(id),
      listRunEvents(id),
    ])
    return c.json(
      normalizeRunRow(
        run,
        await loadRunTasks(id),
        await loadRunArtifacts(id),
        await loadRunRuntimeLeases(id),
        resourceSnapshot,
        runEvents.flatMap((event) => buildAgUiEventsFromRunEvent(normalizeRunEventForAgUi(event))),
      ),
    )
  })
  // Cancel a running orchestrator run and mark unfinished tasks as cancelled
  .post('/:id/cancel', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await db
      .select({
        id: orchestratorRuns.id,
        workspaceId: orchestratorRuns.workspaceId,
        groupSessionId: orchestratorRuns.groupSessionId,
        status: orchestratorRuns.status,
      })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    if (run.status === OrchestratorRunStatus.Cancelled || run.status === OrchestratorRunStatus.Completed || run.status === OrchestratorRunStatus.Failed) {
      return c.json({ run, activeRunCancelled: false })
    }

    const activeRunCancelled = OrchestratorEngine.cancelActiveRun(id)
    await runController.cancel({
      runId: id,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
    }, {
      reason: 'cancelled_by_user',
      taskErrorLog: 'Run cancelled by user',
      activeRunCancelled,
    })

    const [updated] = await db
      .select({
        id: orchestratorRuns.id,
        workspaceId: orchestratorRuns.workspaceId,
        groupSessionId: orchestratorRuns.groupSessionId,
        status: orchestratorRuns.status,
      })
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.id, id))
      .limit(1)

    return c.json({ run: updated ?? { ...run, status: OrchestratorRunStatus.Cancelled }, activeRunCancelled })
  })

  // Retry a failed task within a run
  .post('/:id/retry-task/:taskId', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')

    const [run] = await db
      .select({
        id: orchestratorRuns.id,
        workspaceId: orchestratorRuns.workspaceId,
        groupSessionId: orchestratorRuns.groupSessionId,
        status: orchestratorRuns.status,
        plan: orchestratorRuns.plan,
      })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    const [taskRow] = await db
      .select()
      .from(workspaceTasks)
      .where(and(eq(workspaceTasks.id, taskId), eq(workspaceTasks.runId, id)))
      .limit(1)

    if (!taskRow) {
      throw new HTTPException(404, { message: 'Task not found' })
    }

    if (taskRow.status !== 'failed' && taskRow.status !== 'cancelled') {
      return c.json({ ok: false, message: 'Only failed or cancelled tasks can be retried' }, 400)
    }

    const plan = run.plan as { tasks?: Array<{ id: string; agentId: string; title: string; description: string; dependencies: string[]; taskType?: string; maxRetries?: number; outputContract?: unknown; validation?: unknown }> } | null
    const planTask = plan?.tasks?.find((t) => t.id === taskId)
    if (!planTask) {
      throw new HTTPException(404, { message: 'Task not found in run plan' })
    }

    const engine = new OrchestratorEngine()
    const childSessions = new Map<string, { sessionId: string; workspaceId: string; projectPath?: string | null }>()
    childSessions.set(taskId, {
      sessionId: taskRow.sessionId ?? '',
      workspaceId: run.workspaceId,
      projectPath: null,
    })

    const result = await engine.retryTask({
      runId: id,
      groupSessionId: run.groupSessionId,
      workspaceId: run.workspaceId,
      run: {
        runId: id,
        workspaceId: run.workspaceId,
        groupSessionId: run.groupSessionId,
      },
      task: {
        id: taskId,
        agentId: planTask.agentId,
        title: planTask.title,
        description: planTask.description ?? '',
        dependencies: planTask.dependencies ?? [],
        taskType: planTask.taskType as ExecutionTask['taskType'],
        maxRetries: planTask.maxRetries ?? 2,
        outputContract: planTask.outputContract as ExecutionTask['outputContract'],
        validation: planTask.validation as ExecutionTask['validation'],
      },
      childSessions,
    })

    return c.json({ ok: true, result })
  })

  // Get timeline events for a run. Supports ?afterSequence=N for incremental
  // replay (frontend recovery after disconnect). When afterSequence=0, also
  // includes a resource snapshot for full state reconstruction.
  .get('/:id/events', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const afterSequence = parseInt(c.req.query('afterSequence') ?? '', 10) || undefined

    const [run] = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    const events = await listRunEvents(id, { afterSequence })
    const response: Record<string, unknown> = { items: events }

    // Include resource snapshot when recovering from sequence 0
    if (afterSequence === 0 || afterSequence === undefined) {
      const snapshot = await runController.loadResourceSnapshot(id)
      response.snapshot = {
        run: snapshot.run
          ? { id: snapshot.run.id, status: snapshot.run.status, goal: (snapshot.run.plan as Record<string, unknown> | null)?.goal ?? null }
          : null,
        tasks: snapshot.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          agentId: t.agentId,
          dependencies: t.dependencies,
          artifacts: t.artifacts,
          progressPercent: t.progressPercent,
          progressStatus: t.progressStatus,
        })),
        taskThreads: snapshot.taskThreads.map((thread) => ({
          id: thread.id,
          taskId: thread.taskId,
          sessionId: thread.sessionId,
          workspaceAgentId: thread.workspaceAgentId,
          workerInstanceId: thread.workerInstanceId,
          status: thread.status,
          sharedTaskRelativeRoot: thread.sharedTaskRelativeRoot ?? null,
          sharedTaskSpecPath: thread.sharedTaskSpecPath ?? null,
        })),
        runtimeLeases: snapshot.runtimeLeases.map((lease) => ({
          id: lease.id,
          taskId: lease.taskId,
          workerInstanceId: lease.workerInstanceId,
          provider: lease.provider,
          status: lease.status,
          cwd: lease.cwd,
        })),
        artifacts: snapshot.artifacts.map((artifact) => ({
          id: artifact.id,
          taskId: artifact.taskId,
          kind: artifact.kind,
          title: artifact.title,
          handoffPath: artifact.handoffPath,
          relativePath: artifact.relativePath,
          status: artifact.status,
        })),
        workerInstances: snapshot.workerInstances.map((worker) => ({
          id: worker.id,
          workspaceAgentId: worker.workspaceAgentId,
          runtimeFamily: worker.runtimeFamily,
          runtimeBase: worker.runtimeBase,
          observedState: worker.observedState,
          desiredState: worker.desiredState,
        })),
        counts: snapshot.counts,
      }
    }

    return c.json(response)
  })

  // Get first-class TaskThread resources for a run — the authoritative source
  // for task child sessions, replacing metadata-based reverse-engineering.
  .get('/:id/task-threads', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    const threads = await db
      .select({
        id: taskThreads.id,
        workspaceId: taskThreads.workspaceId,
        runId: taskThreads.runId,
        taskId: taskThreads.taskId,
        groupSessionId: taskThreads.groupSessionId,
        workspaceAgentId: taskThreads.workspaceAgentId,
        workerInstanceId: taskThreads.workerInstanceId,
        sessionId: taskThreads.sessionId,
        status: taskThreads.status,
        lastEventId: taskThreads.lastEventId,
        createdAt: taskThreads.createdAt,
        updatedAt: taskThreads.updatedAt,
        sessionTitle: sessions.title,
        sessionMetadata: sessions.metadata,
      })
      .from(taskThreads)
      .leftJoin(sessions, eq(sessions.id, taskThreads.sessionId))
      .where(eq(taskThreads.runId, id))
      .orderBy(asc(taskThreads.createdAt))

    const items = threads.map((thread) => ({
      id: thread.id,
      runId: thread.runId,
      taskId: thread.taskId,
      groupSessionId: thread.groupSessionId,
      workspaceAgentId: thread.workspaceAgentId,
      workerInstanceId: thread.workerInstanceId,
      sessionId: thread.sessionId,
      sessionTitle: thread.sessionTitle,
      status: thread.status,
      lastEventId: thread.lastEventId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      sharedTaskRelativeRoot:
        typeof thread.sessionMetadata === 'object' && thread.sessionMetadata
          ? (thread.sessionMetadata as Record<string, unknown>).sharedTaskRelativeRoot ?? null
          : null,
      sharedTaskSpecPath:
        typeof thread.sessionMetadata === 'object' && thread.sessionMetadata
          ? (thread.sessionMetadata as Record<string, unknown>).sharedTaskSpecPath ?? null
          : null,
    }))

    return c.json({ items })
  })

  // Get first-class artifacts registered for a run
  .get('/:id/artifacts', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    const items = await loadRunArtifacts(id)
    return c.json({ items: items.map(normalizeArtifactRowForTask) })
  })

  // Get the HiClaw-lite first-class resource snapshot for a run.
  .get('/:id/resource-snapshot', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    return c.json(normalizeResourceSnapshot(await runController.loadResourceSnapshot(id)))
  })

  // Get typed blackboard entries for a run
  .get('/:id/blackboard', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const schemaType = c.req.query('schemaType') as BlackboardSchemaType | undefined

    const [run] = await db
      .select({ id: orchestratorRuns.id, workspaceId: orchestratorRuns.workspaceId })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    const items = await blackboard.query({
      namespace: Blackboard.namespace(run.workspaceId, id),
      schemaType,
      orderBy: 'asc',
    })

    return c.json({ items })
  })

  // Get execution logs for a run
  .get('/:id/logs', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) throw new HTTPException(404, { message: 'Run not found' })

    const logs = await db
      .select()
      .from(executionLogs)
      .where(eq(executionLogs.runId, id))
      .orderBy(asc(executionLogs.createdAt))

    return c.json({ items: logs })
  })
  .get('/:id/conflicts', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await db
      .select({ conflictReport: orchestratorRuns.conflictReport })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) throw new HTTPException(404, { message: 'Run not found' })
    return c.json({ items: Array.isArray(run.conflictReport) ? run.conflictReport : [] })
  })

  // Resolve a conflict manually (approve/reject/override)
  .post('/:id/resolve-conflict', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const body = await c.req.json()
    const filePath = body?.filePath as string | undefined
    const resolution = body?.resolution as 'approved' | 'rejected' | 'overridden' | undefined
    const mergedContent = body?.mergedContent as string | undefined
    const notes = body?.notes as string | undefined

    if (!filePath || !resolution) {
      return c.json({ ok: false, message: 'filePath and resolution are required' }, 400)
    }

    const [run] = await db
      .select({ conflictReport: orchestratorRuns.conflictReport })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    const report = (run.conflictReport ?? []) as ConflictReport[]
    const idx = report.findIndex((item) => item.filePath === filePath)
    if (idx < 0) {
      return c.json({ ok: false, message: 'Conflict not found for filePath' }, 404)
    }

    const target = report[idx]!
    const updated: ConflictReport[] = [...report]
    updated[idx] = {
      ...target,
      resolution: resolution === 'approved' ? 'human-approved' : resolution === 'rejected' ? 'human-rejected' : 'human-overridden',
      mergedContent: mergedContent ?? target.mergedContent,
      notes: notes ? `${target.notes ?? ''}\n[用户决议] ${notes}`.trim() : target.notes,
    }

    await db
      .update(orchestratorRuns)
      .set({ conflictReport: updated, updatedAt: new Date() })
      .where(eq(orchestratorRuns.id, id))

    return c.json({ ok: true, item: updated[idx] })
  })

async function loadRunTasks(runId: string) {
  return tableSafe(
    db
      .select({
        id: workspaceTasks.id,
        workspaceId: workspaceTasks.workspaceId,
        agentId: workspaceTasks.agentId,
        title: workspaceTasks.title,
        description: workspaceTasks.description,
        status: workspaceTasks.status,
        sessionId: workspaceTasks.sessionId,
        taskThreadId: taskThreads.id,
        taskThreadSessionId: taskThreads.sessionId,
        taskThreadStatus: taskThreads.status,
        workerInstanceId: taskThreads.workerInstanceId,
        taskThreadSessionMetadata: taskThreadSessions.metadata,
        orderIdx: workspaceTasks.orderIdx,
        runId: workspaceTasks.runId,
        phaseId: workspaceTasks.phaseId,
        dependencies: workspaceTasks.dependencies,
        artifacts: workspaceTasks.artifacts,
        progressPercent: workspaceTasks.progressPercent,
        progressStatus: workspaceTasks.progressStatus,
        startedAt: workspaceTasks.startedAt,
        completedAt: workspaceTasks.completedAt,
        errorLog: workspaceTasks.errorLog,
      })
      .from(workspaceTasks)
      .leftJoin(taskThreads, and(eq(taskThreads.runId, workspaceTasks.runId), eq(taskThreads.taskId, workspaceTasks.id)))
      .leftJoin(taskThreadSessions, eq(taskThreadSessions.id, taskThreads.sessionId))
      .where(eq(workspaceTasks.runId, runId))
      .orderBy(asc(workspaceTasks.orderIdx), asc(workspaceTasks.createdAt)),
    [],
  )
}

async function loadRunArtifacts(runId: string) {
  return tableSafe(
    db
      .select({
        id: artifactRecords.id,
        workspaceId: artifactRecords.workspaceId,
        runId: artifactRecords.runId,
        taskId: artifactRecords.taskId,
        taskThreadId: artifactRecords.taskThreadId,
        workspaceAgentId: artifactRecords.workspaceAgentId,
        workerInstanceId: artifactRecords.workerInstanceId,
        kind: artifactRecords.kind,
        title: artifactRecords.title,
        description: artifactRecords.description,
        sourcePath: artifactRecords.sourcePath,
        handoffPath: artifactRecords.handoffPath,
        relativePath: artifactRecords.relativePath,
        mimeType: artifactRecords.mimeType,
        size: artifactRecords.size,
        checksum: artifactRecords.checksum,
        status: artifactRecords.status,
        visibility: artifactRecords.visibility,
        metadata: artifactRecords.metadata,
        createdAt: artifactRecords.createdAt,
        updatedAt: artifactRecords.updatedAt,
      })
      .from(artifactRecords)
      .where(eq(artifactRecords.runId, runId))
      .orderBy(asc(artifactRecords.createdAt)),
    [],
  )
}

async function loadRunRuntimeLeases(runId: string) {
  return tableSafe(
    db
      .select({
        id: runtimeLeases.id,
        workspaceId: runtimeLeases.workspaceId,
        runId: runtimeLeases.runId,
        taskId: runtimeLeases.taskId,
        workerInstanceId: runtimeLeases.workerInstanceId,
        provider: runtimeLeases.provider,
        status: runtimeLeases.status,
        cwd: runtimeLeases.cwd,
        homeDir: runtimeLeases.homeDir,
        configDir: runtimeLeases.configDir,
        cacheDir: runtimeLeases.cacheDir,
        tmpDir: runtimeLeases.tmpDir,
        dataDir: runtimeLeases.dataDir,
        containerId: runtimeLeases.containerId,
        sandboxId: runtimeLeases.sandboxId,
        pid: runtimeLeases.pid,
        startedAt: runtimeLeases.startedAt,
        releasedAt: runtimeLeases.releasedAt,
        error: runtimeLeases.error,
        metadata: runtimeLeases.metadata,
        createdAt: runtimeLeases.createdAt,
        updatedAt: runtimeLeases.updatedAt,
      })
      .from(runtimeLeases)
      .where(eq(runtimeLeases.runId, runId))
      .orderBy(asc(runtimeLeases.createdAt)),
    [],
  )
}

function normalizeRunRow<T extends { sessionTitle: string | null; conflictReport?: unknown }>(
  row: T,
  tasks: Awaited<ReturnType<typeof loadRunTasks>> = [],
  artifactRows: Awaited<ReturnType<typeof loadRunArtifacts>> = [],
  runtimeLeaseRows: Awaited<ReturnType<typeof loadRunRuntimeLeases>> = [],
  resourceSnapshot?: RunResourceSnapshot | null,
  agUiEvents?: ReturnType<typeof buildAgUiEventsFromRunEvent>,
) {
  const artifactRowsByTaskId = new Map<string, Array<(typeof artifactRows)[number]>>()
  for (const artifact of artifactRows) {
    if (!artifact.taskId) continue
    const rows = artifactRowsByTaskId.get(artifact.taskId) ?? []
    rows.push(artifact)
    artifactRowsByTaskId.set(artifact.taskId, rows)
  }
  const latestRuntimeLeaseByTaskId = new Map<string, (typeof runtimeLeaseRows)[number]>()
  for (const lease of runtimeLeaseRows) {
    if (!lease.taskId) continue
    latestRuntimeLeaseByTaskId.set(lease.taskId, lease)
  }

  const normalizedTasks = tasks.map((task) => {
    const latestLease = latestRuntimeLeaseByTaskId.get(task.id) ?? null
    return {
      ...task,
      artifacts: artifactRowsByTaskId.get(task.id)?.map(normalizeArtifactRowForTask) ?? task.artifacts,
      childSessionId: task.taskThreadSessionId ?? task.sessionId ?? null,
      taskThreadId: task.taskThreadId ?? null,
      taskThreadStatus: task.taskThreadStatus ?? null,
      sharedTaskRelativeRoot: stringValue(task.taskThreadSessionMetadata?.sharedTaskRelativeRoot),
      sharedTaskSpecPath: stringValue(task.taskThreadSessionMetadata?.sharedTaskSpecPath),
      workerInstanceId: task.workerInstanceId ?? latestLease?.workerInstanceId ?? null,
      runtimeLeaseId: latestLease?.id ?? null,
      runtimeLease: latestLease ? normalizeRuntimeLeaseRowForTask(latestLease) : null,
    }
  })
  const taskBoardSnapshot = buildTaskBoardSnapshot({
    runId: (row as { id?: string }).id ?? null,
    groupSessionId: (row as { groupSessionId?: string }).groupSessionId ?? null,
    status: (row as { status?: string }).status ?? null,
    plan: (row as { plan?: unknown }).plan ?? null,
    tasks: normalizedTasks,
  })

  return {
    ...row,
    sessionTitle: row.sessionTitle ?? 'Deleted session',
    conflictReport: Array.isArray(row.conflictReport) ? row.conflictReport : [],
    resourceSnapshot: resourceSnapshot ? normalizeResourceSnapshot(resourceSnapshot) : undefined,
    agUiEvents,
    runtimeActivitySnapshot: buildRuntimeActivitySnapshot({
      taskBoardSnapshot,
      agUiEvents,
    }),
    taskBoardSnapshot,
    tasks: normalizedTasks,
  }
}

function buildTaskBoardSnapshot(input: {
  runId: string | null
  groupSessionId: string | null
  status: string | null
  plan: unknown
  tasks: Array<Record<string, unknown>>
}) {
  const plan = input.plan && typeof input.plan === 'object' && !Array.isArray(input.plan)
    ? (input.plan as Record<string, unknown>)
    : null
  if (!plan || !input.runId || !input.groupSessionId) return undefined

  const taskLedger =
    plan.taskLedger && typeof plan.taskLedger === 'object' && !Array.isArray(plan.taskLedger)
      ? (plan.taskLedger as Record<string, unknown>)
      : null
  const progressLedger =
    plan.progressLedger && typeof plan.progressLedger === 'object' && !Array.isArray(plan.progressLedger)
      ? (plan.progressLedger as Record<string, unknown>)
      : null
  const planTasks = Array.isArray(plan.tasks) ? plan.tasks : []
  const ledgerTasks = Array.isArray(taskLedger?.tasks) ? taskLedger.tasks : []
  const tasksSource = ledgerTasks.length > 0 ? ledgerTasks : planTasks
  const planTasksById = new Map(
    planTasks
      .map((task) => recordValue(task))
      .filter((task): task is Record<string, unknown> => Boolean(task?.id))
      .map((task) => [String(task.id), task] as const),
  )
  const ledgerTasksById = new Map(
    ledgerTasks
      .map((task) => recordValue(task))
      .filter((task): task is Record<string, unknown> => Boolean(task?.id))
      .map((task) => [String(task.id), task] as const),
  )
  const runTasksById = new Map(
    input.tasks
      .map((task) => [String(task.id), task] as const),
  )
  const phasesSource =
    Array.isArray(taskLedger?.phases) && taskLedger.phases.length
      ? taskLedger.phases
      : Array.isArray(plan.phases)
        ? plan.phases
        : []
  const agentNames = new Map(
    Array.isArray(plan.agents)
      ? plan.agents
          .map((agent) => recordValue(agent))
          .filter((agent): agent is Record<string, unknown> => Boolean(agent?.id))
          .map((agent) => [String(agent.id), stringValue(agent.name) ?? stringValue(agent.key) ?? 'Agent'] as const)
      : [],
  )

  const tasks = tasksSource
    .map((task) => recordValue(task))
    .filter((task): task is Record<string, unknown> => Boolean(task?.id))
    .map((task) => {
      const id = String(task.id)
      const ledgerTask = ledgerTasksById.get(id) ?? task
      const planTask = planTasksById.get(id) ?? task
      const runTask = runTasksById.get(id)
      const status =
        normalizeTaskBoardTaskStatusFromTaskThread(stringValue(runTask?.taskThreadStatus)) ??
        normalizeTaskBoardTaskStatus(stringValue(runTask?.status)) ??
        normalizeTaskBoardTaskStatus(stringValue(ledgerTask.status)) ??
        'pending'
      const agentId =
        stringValue(runTask?.agentId) ??
        stringValue(ledgerTask.agentId) ??
        stringValue(planTask.agentId) ??
        id

      return {
        id,
        phaseId:
          stringValue(runTask?.phaseId) ??
          stringValue(ledgerTask.phaseId) ??
          stringValue(planTask.phaseId) ??
          'execution',
        title:
          stringValue(runTask?.title) ??
          stringValue(ledgerTask.title) ??
          stringValue(planTask.title) ??
          id,
        description:
          stringValue(runTask?.description) ??
          stringValue(ledgerTask.description) ??
          stringValue(planTask.description) ??
          '',
        agentId,
        agentName:
          agentNames.get(agentId) ??
          stringValue(planTask.agentName) ??
          stringValue(ledgerTask.agentName) ??
          stringValue(runTask?.agentName) ??
          'Agent',
        taskType: stringValue(planTask.taskType) ?? undefined,
        status,
        progress: numberValue(runTask?.progressPercent) ?? undefined,
        progressStatus: stringValue(runTask?.progressStatus) ?? undefined,
        dependencies:
          stringArrayValue(runTask?.dependencies) ??
          stringArrayValue(ledgerTask.dependencies) ??
          stringArrayValue(planTask.dependencies) ??
          [],
        childSessionId:
          stringValue(runTask?.childSessionId) ??
          stringValue(task.childSessionId) ??
          stringValue(planTask.childSessionId) ??
          null,
        taskThreadId:
          stringValue(runTask?.taskThreadId) ??
          stringValue(task.taskThreadId) ??
          stringValue(planTask.taskThreadId) ??
          null,
        taskThreadStatus:
          stringValue(runTask?.taskThreadStatus) ??
          stringValue(task.taskThreadStatus) ??
          stringValue(planTask.taskThreadStatus) ??
          null,
        workerInstanceId:
          stringValue(runTask?.workerInstanceId) ??
          stringValue(task.workerInstanceId) ??
          stringValue(planTask.workerInstanceId) ??
          null,
        runtimeLeaseId:
          stringValue(runTask?.runtimeLeaseId) ??
          stringValue(task.runtimeLeaseId) ??
          stringValue(planTask.runtimeLeaseId) ??
          null,
        sharedTaskRelativeRoot:
          stringValue(runTask?.sharedTaskRelativeRoot) ??
          stringValue(task.sharedTaskRelativeRoot) ??
          stringValue(planTask.sharedTaskRelativeRoot) ??
          null,
        sharedTaskSpecPath:
          stringValue(runTask?.sharedTaskSpecPath) ??
          stringValue(task.sharedTaskSpecPath) ??
          stringValue(planTask.sharedTaskSpecPath) ??
          null,
        artifactCount:
          Array.isArray(runTask?.artifacts)
            ? runTask.artifacts.length
            : numberValue(task.artifactCount) ?? undefined,
        artifacts: Array.isArray(runTask?.artifacts) ? runTask.artifacts : [],
        outputSummary:
          stringValue(ledgerTask.outputSummary) ??
          stringValue(planTask.outputSummary) ??
          undefined,
        validationStatus:
          stringValue(ledgerTask.validationStatus) ??
          stringValue(planTask.validationStatus) ??
          undefined,
        contractStatus:
          stringValue(ledgerTask.contractStatus) ??
          stringValue(planTask.contractStatus) ??
          undefined,
        executionConfig: recordValue(runTask?.executionConfig) ?? recordValue(planTask.executionConfig) ?? undefined,
      }
    })

  const phases = applyTaskBoardSnapshotStatuses(
    phasesSource.map((phase) => {
      const item = recordValue(phase) ?? {}
      return {
        id: stringValue(item.id) ?? 'execution',
        title: stringValue(item.title) ?? '执行',
        purpose: stringValue(item.purpose) ?? '',
        taskIds: stringArrayValue(item.taskIds) ?? [],
        status: 'pending' as const,
      }
    }),
    tasks,
  )

  return {
    runId: input.runId,
    title: stringValue(plan.title) ?? '',
    goal: stringValue(plan.goal) ?? '',
    collaborationMode: stringValue(plan.collaborationMode) ?? 'mapreduce',
    phases,
    tasks,
    status: normalizeTaskBoardRunStatus(stringValue(progressLedger?.status) ?? input.status) ?? 'running',
    sessionId: input.groupSessionId,
  }
}

function normalizeTaskBoardTaskStatus(value: string | null) {
  if (
    value === 'pending' ||
    value === 'assigned' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'blocked' ||
    value === 'cancelled'
  ) {
    return value
  }
  return null
}

function normalizeTaskBoardTaskStatusFromTaskThread(value: string | null) {
  if (value === 'prepared') return 'pending'
  if (value === 'assigned') return 'assigned'
  if (value === 'active') return 'running'
  if (value === 'completed') return 'done'
  if (value === 'failed' || value === 'cancelled') return value
  return null
}

function normalizeTaskBoardRunStatus(value: string | null) {
  if (
    value === 'planning' ||
    value === 'running' ||
    value === 'synthesizing' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  return null
}

function applyTaskBoardSnapshotStatuses(
  phases: Array<{
    id: string
    title: string
    purpose: string
    taskIds: string[]
    status: 'pending' | 'active' | 'completed'
  }>,
  tasks: Array<{ id: string; status: string }>,
) {
  return phases.map((phase) => {
    const phaseTasks = phase.taskIds
      .map((id) => tasks.find((task) => task.id === id))
      .filter((task): task is { id: string; status: string } => Boolean(task))
    if (!phaseTasks.length) return { ...phase, status: 'pending' as const }
    if (phaseTasks.some((task) => task.status === 'assigned' || task.status === 'running' || task.status === 'blocked')) {
      return { ...phase, status: 'active' as const }
    }
    if (phaseTasks.every((task) => task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')) {
      return { ...phase, status: 'completed' as const }
    }
    return { ...phase, status: 'pending' as const }
  })
}

function normalizeRunEventForAgUi(event: Awaited<ReturnType<typeof listRunEvents>>[number]) {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {}
  const timestampMs =
    event.createdAt instanceof Date
      ? event.createdAt.getTime()
      : typeof event.createdAt === 'string'
        ? Date.parse(event.createdAt)
        : undefined
  return {
    runId: event.runId,
    groupSessionId: event.groupSessionId,
    taskId: event.taskId,
    threadId: event.threadId ?? null,
    workerInstanceId: event.workerInstanceId ?? null,
    agentId: event.agentId,
    type: event.type,
    payload: {
      ...payload,
      sequence: event.sequence,
      taskThreadId: event.threadId ?? payload.taskThreadId,
      workerInstanceId: event.workerInstanceId ?? payload.workerInstanceId,
    },
    severity: event.severity,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
  }
}

function normalizeResourceSnapshot(snapshot: RunResourceSnapshot) {
  return {
    run: snapshot.run
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
      : null,
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
    artifacts: snapshot.artifacts.map(normalizeArtifactRowForTask),
    runtimeLeases: snapshot.runtimeLeases.map(normalizeRuntimeLeaseRowForTask),
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

function buildRuntimeActivitySnapshot(input: {
  taskBoardSnapshot?: ReturnType<typeof buildTaskBoardSnapshot>
  agUiEvents?: ReturnType<typeof buildAgUiEventsFromRunEvent>
}) {
  const taskBoardSnapshot = input.taskBoardSnapshot
  const sessionId = taskBoardSnapshot?.sessionId ?? null

  if (taskBoardSnapshot?.tasks?.length) {
    const runningTask = taskBoardSnapshot.tasks.find((task) => task.status === 'running')
    if (runningTask && sessionId) {
      return {
        agentTyping: true,
        agentActivity: {
          sessionId,
          agentId: runningTask.agentId ?? null,
          agentName: runningTask.agentName ?? null,
          phase: 'executing',
          startedAt: null,
        },
        source: 'task-board',
      }
    }
  }

  if (Array.isArray(input.agUiEvents) && input.agUiEvents.length && sessionId) {
    const agUiProjection = deriveRuntimeActivityFromAgUiEvents(input.agUiEvents, sessionId)
    if (agUiProjection) return agUiProjection
  }

  if (taskBoardSnapshot?.status === 'planning' && sessionId) {
    return {
      agentTyping: true,
      agentActivity: {
        sessionId,
        agentId: null,
        agentName: 'Orchestrator',
        phase: 'planning',
        startedAt: null,
      },
      source: 'task-board',
    }
  }

  if (taskBoardSnapshot?.status === 'synthesizing' && sessionId) {
    return {
      agentTyping: true,
      agentActivity: {
        sessionId,
        agentId: null,
        agentName: 'Orchestrator',
        phase: 'synthesizing',
        startedAt: null,
      },
      source: 'task-board',
    }
  }

  return {
    agentTyping: false,
    agentActivity: null,
    source: 'none',
  }
}

function deriveRuntimeActivityFromAgUiEvents(
  events: NonNullable<ReturnType<typeof buildAgUiEventsFromRunEvent>>,
  sessionId: string,
) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = recordValue(events[index])
    if (!event) continue
    const type = stringValue(event.type)
    if (type === 'RUN_FINISHED') {
      return {
        agentTyping: false,
        agentActivity: null,
        source: 'ag-ui',
      }
    }
    if (type !== 'CUSTOM') continue

    const name = stringValue(event.name)
    const value = recordValue(event.value)
    if (!name || !value) continue

    if (name === 'agenthub.task.status') {
      const status = stringValue(value.status)
      if (status === 'running' || status === 'assigned') {
        return {
          agentTyping: true,
          agentActivity: {
            sessionId,
            agentId: stringValue(value.agentId),
            agentName: stringValue(value.agentName),
            phase: status === 'running' ? 'executing' : 'assigned',
            startedAt: null,
          },
          source: 'ag-ui',
        }
      }
      continue
    }

    if (name === 'agenthub.run.status') {
      const status = stringValue(value.status)
      if (status === 'synthesizing') {
        return {
          agentTyping: true,
          agentActivity: {
            sessionId,
            agentId: null,
            agentName: 'Orchestrator',
            phase: 'synthesizing',
            startedAt: null,
          },
          source: 'ag-ui',
        }
      }
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        return {
          agentTyping: false,
          agentActivity: null,
          source: 'ag-ui',
        }
      }
      continue
    }

    if (name === 'agenthub.manager.status') {
      const phase =
        stringValue(value.phase) ??
        stringValue(value.action) ??
        stringValue(value.status)
      if (!phase) continue
      return {
        agentTyping: true,
        agentActivity: {
          sessionId,
          agentId: stringValue(value.actorAgentId),
          agentName: stringValue(value.actorName) ?? 'Orchestrator',
          phase,
          startedAt: null,
        },
        source: 'ag-ui',
      }
    }
  }

  return null
}

function normalizeArtifactRowForTask(artifact: Awaited<ReturnType<typeof loadRunArtifacts>>[number]) {
  return {
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
    taskThreadId: artifact.taskThreadId,
    workspaceAgentId: artifact.workspaceAgentId,
    workerInstanceId: artifact.workerInstanceId,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt,
  }
}

function normalizeRuntimeLeaseRowForTask(lease: Awaited<ReturnType<typeof loadRunRuntimeLeases>>[number]) {
  return {
    id: lease.id,
    runtimeLeaseId: lease.id,
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
  }
}

async function tableSafe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise
  } catch (error: any) {
    const message = String(error?.message ?? error ?? '')
    if (/no such table:\s*orchestrator_runs/i.test(message)) return fallback
    if (/no such table:\s*artifacts/i.test(message)) return fallback
    if (/no such table:\s*runtime_leases/i.test(message)) return fallback
    throw error
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArrayValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string')
}
