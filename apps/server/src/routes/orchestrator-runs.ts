import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { db, eq, and, desc, asc, sql } from '@agenthub/db'
import { orchestratorRuns, executionLogs, workspaces, sessions } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { listRunEvents } from '../services/orchestrator/run-events'

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
