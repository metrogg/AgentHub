import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { env } from './env'
import { authRoutes } from './routes/auth'
import { sessionRoutes } from './routes/sessions'
import { messageRoutes } from './routes/messages'
import { agentRoutes } from './routes/agents'
import { mastraCompatRoutes } from './routes/mastra-compat'
import { taskRoutes } from './routes/tasks'
import { settingsRoutes } from './routes/settings'
import { studioRoutes } from './routes/studio'
import { workspaceRoutes } from './routes/workspaces'

const app = new Hono()
  .use('*', honoLogger())
  .use('*', cors({ origin: resolveCorsOrigin, credentials: true }))
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
  .route('/api/mastra', mastraCompatRoutes)
  .route('/api/tasks', taskRoutes)
  .route('/api/settings', settingsRoutes)
  .route('/api/studio', studioRoutes)
  .route('/api/workspaces', workspaceRoutes)

export { app }
export type AppType = typeof routes

function resolveCorsOrigin(origin: string | undefined) {
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((item) => item.trim())
  if (!origin) return allowedOrigins[0] ?? env.CORS_ORIGIN
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1):517\d$/.test(origin)) return origin
  return allowedOrigins[0] ?? env.CORS_ORIGIN
}
