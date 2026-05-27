import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { ensureStarOfficeRunning, getStarOfficeRuntimeStatus } from '../services/star-office-service'

export const officeRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/status', async (c) => {
    const status = await getStarOfficeRuntimeStatus()
    return c.json(status)
  })
  .post('/start', async (c) => {
    const status = await ensureStarOfficeRunning()
    return c.json(status)
  })
