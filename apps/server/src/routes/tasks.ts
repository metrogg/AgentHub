import { Hono } from 'hono'
import { db, tasks, eq, desc } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

export const taskRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/session/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const list = await db
      .select()
      .from(tasks)
      .where(eq(tasks.sessionId, sessionId))
      .orderBy(desc(tasks.createdAt))
    return c.json({ items: list })
  })
  .get('/:id', async (c) => {
    const id = c.req.param('id')
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    return c.json(task)
  })
