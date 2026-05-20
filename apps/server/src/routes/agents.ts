import { Hono } from 'hono'
import { db, agents, eq } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

export const agentRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const list = await db.select().from(agents).where(eq(agents.enabled, true))
    return c.json({ items: list })
  })
  .get('/:id', async (c) => {
    const id = c.req.param('id')
    const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1)
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    return c.json(agent)
  })
