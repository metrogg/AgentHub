import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { env } from './env'
import { sessionRoutes } from './routes/sessions'
import { messageRoutes } from './routes/messages'
import { settingsRoutes } from './routes/settings'
import { codingToolsRoutes } from './routes/coding-tools'
import { skillRoutes } from './routes/skills'
import { workspaceRoutes } from './routes/workspaces'
import { artifactRoutes } from './routes/artifacts'

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
  .route('/api/sessions', sessionRoutes)
  .route('/api/messages', messageRoutes)
  .route('/api/settings', settingsRoutes)
  .route('/api/coding-tools', codingToolsRoutes)
  .route('/api/skills', skillRoutes)
  .route('/api/workspaces', workspaceRoutes)
  .route('/api/artifacts', artifactRoutes)

export { app }
export type AppType = typeof routes

function resolveCorsOrigin(origin: string | undefined) {
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((item) => item.trim())
  if (!origin) return allowedOrigins[0] ?? env.CORS_ORIGIN
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1):517\d$/.test(origin)) return origin
  return allowedOrigins[0] ?? env.CORS_ORIGIN
}
