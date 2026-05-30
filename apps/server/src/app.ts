import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
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
import { welcomeRoutes } from './routes/welcome'
import { protocolRoutes } from './routes/protocols'
import { requestContextMiddleware } from './middleware/request-context'
import { formatErrorResponse } from './lib/error'
import { APP_VERSION } from '@agenthub/shared'

const app = new Hono()
  .use('*', honoLogger())
  .use('*', cors({ origin: resolveCorsOrigin, credentials: true }))
  .use('*', requestContextMiddleware)
  .onError((err, c) => {
    const isDev = env.NODE_ENV !== 'production'
    const requestContext = c.get('requestContext')
    const requestId = requestContext?.requestId
    requestContext?.logger.error({ err, requestId }, 'Request error')
    const { body, status } = formatErrorResponse(err, requestId, isDev)
    return c.json(body, status as any)
  })
  .get('/health', (c) => c.json({ status: 'ok', version: APP_VERSION }))

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
  .route('/api/welcome', welcomeRoutes)
  .route('/api/protocols', protocolRoutes)

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
  if (isPrivateLanDevOrigin(origin)) return origin
  return allowedOrigins[0] ?? env.CORS_ORIGIN
}

function isPrivateLanDevOrigin(origin: string) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' || !/^517\d$/.test(url.port)) return false
    const host = url.hostname
    return (
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    )
  } catch {
    return false
  }
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
