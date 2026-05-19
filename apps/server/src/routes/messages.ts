import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { sendMessageSchema } from '@agenthub/shared'
import { db, messages, eq, asc } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

export const messageRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    return c.json({ items: list })
  })
  .post('/:sessionId', zValidator('json', sendMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const { content, type } = c.req.valid('json')
    const [msg] = await db
      .insert(messages)
      .values({ sessionId, senderId: user.sub, senderType: 'user', type, content })
      .returning()
    // Trigger agent reply asynchronously (do not await to keep response fast)
    if (msg) {
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(sessionId, msg).catch(() => {})
      })
    }
    return c.json(msg)
  })
