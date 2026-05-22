import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { createSessionSchema } from '@agenthub/shared'
import { db, sessions, eq, desc } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

export const sessionRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const user = c.get('user')
    const list = await db
      .select()
      .from(sessions)
      .where(eq(sessions.ownerId, user.sub))
      .orderBy(desc(sessions.updatedAt))
    return c.json({ items: list })
  })
  .post('/', zValidator('json', createSessionSchema), async (c) => {
    const user = c.get('user')
    const input = c.req.valid('json')
    const [session] = await db
      .insert(sessions)
      .values({ title: input.title, type: input.type, ownerId: user.sub })
      .returning()
    if (!session) throw new HTTPException(500, { message: 'Failed to create session' })
    return c.json(session)
  })
  .get('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw new HTTPException(404, { message: 'Session not found' })
    }
    return c.json(session)
  })
  .delete('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw new HTTPException(404, { message: 'Session not found' })
    }
    await db.delete(sessions).where(eq(sessions.id, id))
    return c.body(null, 204)
  })
