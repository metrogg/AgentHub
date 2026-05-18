import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { env } from './env'
import { authRoutes } from './routes/auth'
import { sessionRoutes } from './routes/sessions'
import { messageRoutes } from './routes/messages'
import { agentRoutes } from './routes/agents'
import { taskRoutes } from './routes/tasks'

const app = new Hono()
  .use('*', honoLogger())
  .use('*', cors({ origin: env.CORS_ORIGIN, credentials: true }))
  .onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status)
    }
    console.error(err)
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  .get('/health', (c) => c.json({ status: 'ok', version: '0.1.0' }))

const routes = app
  .route('/api/auth', authRoutes)
  .route('/api/sessions', sessionRoutes)
  .route('/api/messages', messageRoutes)
  .route('/api/agents', agentRoutes)
  .route('/api/tasks', taskRoutes)

export { app }
export type AppType = typeof routes
