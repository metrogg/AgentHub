import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { db, eq, and, desc, asc, sql } from '@agenthub/db'
import { orchestratorRuns, executionLogs, workspaces, sessions, workspaceTasks } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { emitRunEvent, listRunEvents } from '../services/orchestrator/run-events'
import { blackboard, Blackboard } from '../services/blackboard'
import type { BlackboardSchemaType } from '../services/blackboard-schemas'
import { OrchestratorEngine } from '../services/orchestrator/orchestrator-engine'

export const orchestratorRunRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)

  // List all orchestrator runs for current user (via workspace ownership)
  .get('/', async (c) => {
    const user = c.get('user')

    const list = await db
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
      .innerJoin(sessions, eq(sessions.id, orchestratorRuns.groupSessionId))
      .where(eq(workspaces.ownerId, user.sub))
      .orderBy(desc(orchestratorRuns.createdAt))

    return c.json({ items: list })
  })

  // Get single run detail
  .get('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await db
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
      .innerJoin(sessions, eq(sessions.id, orchestratorRuns.groupSessionId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    return c.json(run)
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

    if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed') {
      return c.json({ run, activeRunCancelled: false })
    }

    const activeRunCancelled = OrchestratorEngine.cancelActiveRun(id)
    await db
      .update(orchestratorRuns)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(orchestratorRuns.id, id))
    await db
      .update(workspaceTasks)
      .set({
        status: 'cancelled',
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

    return c.json({ run: updated ?? { ...run, status: 'cancelled' }, activeRunCancelled })
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

    // Verify run exists and belongs to user
    const [run] = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    const logs = await db
      .select()
      .from(executionLogs)
      .where(eq(executionLogs.runId, id))
      .orderBy(asc(executionLogs.createdAt))

    return c.json({ items: logs })
  })

  // Get conflict report for a run
  .get('/:id/conflicts', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')

    const [run] = await db
      .select({ conflictReport: orchestratorRuns.conflictReport })
      .from(orchestratorRuns)
      .innerJoin(workspaces, eq(workspaces.id, orchestratorRuns.workspaceId))
      .where(and(eq(orchestratorRuns.id, id), eq(workspaces.ownerId, user.sub)))
      .limit(1)

    if (!run) {
      throw new HTTPException(404, { message: 'Run not found' })
    }

    return c.json({ items: run.conflictReport ?? [] })
  })
