import pino from 'pino'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../env'

const logDir = env.AGENTHUB_LOG_DIR?.trim()
const destination = logDir
  ? (() => {
      mkdirSync(logDir, { recursive: true })
      return pino.destination({ dest: join(logDir, 'agenthub-server.log'), sync: false, mkdir: true })
    })()
  : undefined

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    !destination && env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
}, destination)
