import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { HTTPException } from 'hono/http-exception'
import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { env } from './env'
import { sessionRoutes } from './routes/sessions'
import { messageRoutes } from './routes/messages'
import { settingsRoutes } from './routes/settings'
import { codingToolsRoutes } from './routes/coding-tools'
import { skillRoutes } from './routes/skills'
import { workspaceRoutes } from './routes/workspaces'
import { artifactRoutes, serveDeployStatic } from './routes/artifacts'
import { orchestratorRunRoutes } from './routes/orchestrator-runs'
import { mobileRoutes } from './routes/mobile'
import { officeRoutes } from './routes/office'

const app = new Hono()
  .use('*', honoLogger())
  .use('*', cors({ origin: resolveCorsOrigin, credentials: true }))
  .onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status)
    }
    const isDev = env.NODE_ENV !== 'production'
    const message = err instanceof Error ? err.message : String(err)
    const stack = isDev && err instanceof Error ? err.stack : undefined
    console.error(err)
    return c.json({ error: isDev ? message : 'Internal Server Error', stack }, 500)
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
  .route('/api/orchestrator-runs', orchestratorRunRoutes)
  .route('/api/mobile', mobileRoutes)
  .route('/api/office', officeRoutes)

app.get('/deploy/:workspaceId/*', async (c) => {
  const workspaceId = c.req.param('workspaceId')
  const subPath = c.req.path.replace(`/deploy/${workspaceId}`, '')
  const response = await serveDeployStatic(workspaceId, subPath)
  if (!response) return c.notFound()
  return response
})

installStaticRoutes(app)

export { app }
export type AppType = typeof routes

function resolveCorsOrigin(origin: string | undefined) {
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((item) => item.trim())
  if (!origin) return allowedOrigins[0] ?? env.CORS_ORIGIN
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1):517\d$/.test(origin)) return origin
  return allowedOrigins[0] ?? env.CORS_ORIGIN
}

function installStaticRoutes(app: Hono) {
  const webDist = env.AGENTHUB_WEB_DIST?.trim()
  if (!webDist) return
  const root = resolve(webDist)
  if (!existsSync(root)) return

  app.get('/assets/*', (c) => serveStaticPath(root, c.req.path))
  app.get('/favicon.svg', () => serveStaticPath(root, '/favicon.svg'))
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ws')) return c.notFound()
    return serveStaticPath(root, c.req.path)
  })
}

function serveStaticPath(root: string, requestPath: string) {
  const relativePath = decodeURIComponent(requestPath.replace(/^\/+/, '')) || 'index.html'
  const candidate = resolve(root, normalize(relativePath))
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`
  const filePath = candidate === root || !candidate.startsWith(rootWithSep) ? join(root, 'index.html') : candidate
  const finalPath = existsSync(filePath) && statSync(filePath).isFile() ? filePath : join(root, 'index.html')
  return new Response(Bun.file(finalPath), {
    headers: {
      'Content-Type': contentType(finalPath),
    },
  })
}

function contentType(filePath: string) {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  if (ext === '.ico') return 'image/x-icon'
  if (ext === '.json') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}
