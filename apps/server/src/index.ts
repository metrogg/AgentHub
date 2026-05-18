import { app } from './app'
import { env } from './env'
import { logger } from './lib/logger'

const port = env.PORT

const server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket: {
    open(ws) {
      logger.info({ id: ws.data }, 'ws open')
    },
    message(ws, message) {
      logger.debug({ message }, 'ws message')
    },
    close(ws) {
      logger.info({ id: ws.data }, 'ws close')
    },
  },
})

logger.info(`🚀 AgentHub server listening on http://localhost:${server.port}`)
