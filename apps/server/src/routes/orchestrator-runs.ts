import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { db, eq, and, desc, asc, sql } from '@agenthub/db'
import { orchestratorRuns, executionLogs, workspaces, sessions, workspaceTasks } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { emitRunEvent, listRunEvents } from '../services/orchestrator/run-events'
import { blackboard, Blackboard } from '../services/blackboard'
import type { BlackboardSchemaType } from '../services/blackboard-schemas'
import { OrchestratorEngine, type ExecutionTask } from '../services/orchestrator/orchestrator-engine'
import type { ConflictReport } from '../services/orchestrator/conflict-resolver'
import { TaskStatus, OrchestratorRunStatus } from '@agenthub/shared'

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
      items: list.map(normalizeRunRow),
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
    return c.json(normalizeRunRow(run))
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
    await db
      .update(orchestratorRuns)
      .set({ status: OrchestratorRunStatus.Cancelled, updatedAt: new Date() })
      .where(eq(orchestratorRuns.id, id))
    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Cancelled,
        completedAt: new Date(),
        errorLog: 'Run cancelled by user',
      })
      .where(and(eq(workspaceTasks.runId, id), sql`${workspaceTasks.status} in ('pending', 'running')`))
    await emitRunEvent({
      runId: id,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      type: 'run.cancelled',
      severity: 'warning',
      payload: { reason: 'cancelled_by_user', activeRunCancelled },
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

  // Get timeline events for a run
  .get('/:id/events', async (c) => {
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

    const events = await listRunEvents(id)
    return c.json({ items: events })
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

function normalizeRunRow<T extends { sessionTitle: string | null; conflictReport?: unknown }>(row: T) {
  return {
    ...row,
    sessionTitle: row.sessionTitle ?? 'Deleted session',
    conflictReport: Array.isArray(row.conflictReport) ? row.conflictReport : [],
  }
}

async function tableSafe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise
  } catch (error: any) {
    const message = String(error?.message ?? error ?? '')
    if (/no such table:\s*orchestrator_runs/i.test(message)) return fallback
    throw error
  }
}
