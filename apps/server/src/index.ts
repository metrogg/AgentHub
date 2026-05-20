import { app } from './app'
import { env } from './env'
import { logger } from './lib/logger'
import { joinRoom, cleanupWebSocket } from './services/agent-runner'
import { db, users, eq } from '@agenthub/db'
import { DEFAULT_USER } from './middleware/auth'

// Seed the local default user (single-user mode, no auth)
async function seedDefaultUser() {
  const existing = await db.select().from(users).where(eq(users.id, DEFAULT_USER.sub)).limit(1)
  if (existing.length === 0) {
    await db.insert(users).values({
      id: DEFAULT_USER.sub,
      email: DEFAULT_USER.email,
      username: DEFAULT_USER.username,
      passwordHash: '',
    })
    logger.info('Seeded default user')
  }
}

await seedDefaultUser()

let currentPort = env.PORT
const maxTries = 10

let server: ReturnType<typeof Bun.serve>
for (let i = 0; i < maxTries; i++) {
  try {
    server = Bun.serve({
      port: currentPort,
      fetch(req, srv) {
        if (req.headers.get('upgrade') === 'websocket') {
          srv.upgrade(req, { data: {} })
          return undefined as any
        }
        return app.fetch(req, srv)
      },
      websocket: {
        open(ws) {
          logger.info({ id: ws.data }, 'ws open')
        },
        message(ws, message) {
          try {
            const text = typeof message === 'string' ? message : message.toString()
            const data = JSON.parse(text)
            logger.debug({ type: data.type }, 'ws message')

            if (data.type === 'session:join' && data.payload?.sessionId) {
              joinRoom(data.payload.sessionId, ws)
              ws.send(JSON.stringify({ type: 'session:joined', payload: { sessionId: data.payload.sessionId } }))
            }
          } catch {
            // ignore malformed messages
          }
        },
        close(ws) {
          logger.info({ id: ws.data }, 'ws close')
          cleanupWebSocket(ws)
        },
      },
    })
    break
  } catch (e: any) {
    if (e?.code === 'EADDRINUSE') {
      logger.warn(`Port ${currentPort} in use, trying ${currentPort + 1}`)
      currentPort++
      continue
    }
    throw e
  }
}

if (!server!) {
  logger.error(`Could not bind to any port from ${env.PORT} to ${env.PORT + maxTries - 1}`)
  process.exit(1)
}

logger.info(`🚀 AgentHub server listening on http://localhost:${server.port}`)
