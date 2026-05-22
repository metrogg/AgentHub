import { Hono } from 'hono'
import { db, eq, settings } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { testLlmConnection } from '../services/llm-client'

export const settingsRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const rows = await db.select().from(settings)
    const map: Record<string, string> = {}
    for (const row of rows) map[row.key] = row.value
    return c.json(map)
  })
  .post('/', async (c) => {
    const body = await c.req.json<Record<string, string>>()
    for (const [key, value] of Object.entries(body)) {
      const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
      if (existing.length > 0) {
        await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key))
      } else {
        await db.insert(settings).values({ key, value })
      }
    }
    return c.json({ success: true })
  })
  .post('/test-model', async (c) => {
    const input = await c.req.json<{
      provider?: string
      apiEndpoint?: string
      anthropicEndpoint?: string
      apiKey?: string
      apiKeyEnv?: string
    }>()

    return c.json(await testLlmConnection(input), 200)
  })
