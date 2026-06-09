import pino from 'pino'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { env } from '../env'

export const serverLogDir = resolve(env.AGENTHUB_LOG_DIR?.trim() || join(resolve(env.AGENTHUB_APP_DATA_DIR?.trim() || process.cwd()), 'logs'))
export const serverLogPath = join(serverLogDir, 'agenthub-server.log')

const fileDestination = createFileDestination()
export const serverFileLoggingEnabled = Boolean(fileDestination)

const prettyDestination = createPrettyDestination()

const destinations = [
  prettyDestination ? { stream: prettyDestination } : undefined,
  fileDestination ? { stream: fileDestination } : undefined,
].filter((item): item is { stream: pino.DestinationStream } => Boolean(item))

export const logger = pino({
  level: env.LOG_LEVEL,
}, destinations.length > 1
  ? pino.multistream(destinations)
  : destinations[0]?.stream)

function createFileDestination() {
  try {
    mkdirSync(serverLogDir, { recursive: true })
    return pino.destination({ dest: serverLogPath, sync: false, mkdir: true })
  } catch {
    return undefined
  }
}

function createPrettyDestination() {
  if (env.NODE_ENV !== 'development') return undefined
  try {
    return pino.transport({ target: 'pino-pretty', options: { colorize: true } })
  } catch {
    return undefined
  }
}
