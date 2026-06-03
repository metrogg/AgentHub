import { writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { app } from './app'
import { env } from './env'
import { logger } from './lib/logger'
import { setRuntimeServerPort } from './lib/runtime-server'
import { joinRoom, cleanupWebSocket, cancelAllAgentReplies } from './services/agent-runner'
import { db, users, eq, orchestratorRuns } from '@agenthub/db'
import { DEFAULT_USER } from './middleware/auth'
import { WsEvent } from '@agenthub/shared'
import { OrchestratorEngine } from './services/orchestrator/orchestrator-engine'
import { markInterruptedRuntimeLeasesStale } from './services/orchestrator/worker-runtime-resources'
import { runController } from './services/orchestrator/run-controller'

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

function resolvePortFile() {
  const configured = Bun.env.AGENTHUB_PORT_FILE?.trim()
  if (configured) return resolve(configured)
  const root = Bun.env.PROJECT_ROOT?.trim() || process.cwd()
  return resolve(root, '.agenthub-port')
}

let currentPort = env.PORT
const maxTries = 10

let server: ReturnType<typeof Bun.serve>
for (let i = 0; i < maxTries; i++) {
  try {
    server = Bun.serve({
      hostname: '0.0.0.0',
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

            if (data.type === WsEvent.SessionJoin && data.payload?.sessionId) {
              joinRoom(data.payload.sessionId, ws)
              ws.send(JSON.stringify({ type: WsEvent.SessionJoined, payload: { sessionId: data.payload.sessionId } }))
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

const runtimePort = server.port ?? currentPort
logger.info(`🚀 AgentHub server listening on http://0.0.0.0:${runtimePort}`)
setRuntimeServerPort(runtimePort)

// Write actual port to file so Vite dev proxy can read it
const portFile = resolvePortFile()
try {
  writeFileSync(
    portFile,
    JSON.stringify({ port: runtimePort, pid: process.pid, updatedAt: new Date().toISOString() }),
    'utf8',
  )
  logger.info({ portFile, port: runtimePort }, 'Wrote AgentHub dev port file')
} catch (err) {
  logger.warn({ err, portFile }, 'Failed to write AgentHub dev port file')
  // Best-effort; non-critical
}

let shuttingDown = false

// Ensure clean shutdown on Ctrl+C / SIGTERM / parent process exit.
async function shutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ reason }, 'AgentHub server shutting down')

  const activeRunIds = OrchestratorEngine.cancelAllActiveRuns()
  const activeSessionIds = cancelAllAgentReplies()

  if (activeRunIds.length > 0 || activeSessionIds.length > 0) {
    logger.warn(
      { activeRunIds, activeSessionIds },
      'Cancelled active Agent work before process exit',
    )
  }

  await Promise.allSettled(
    activeRunIds.map(async (runId) => {
      const [run] = await db
        .select({
          id: orchestratorRuns.id,
          workspaceId: orchestratorRuns.workspaceId,
          groupSessionId: orchestratorRuns.groupSessionId,
        })
        .from(orchestratorRuns)
        .where(eq(orchestratorRuns.id, runId))
        .limit(1)
      if (!run) return
      await runController.cancel(
        {
          runId: run.id,
          workspaceId: run.workspaceId,
          groupSessionId: run.groupSessionId,
        },
        {
          reason: 'server_shutdown',
          summary: `Run cancelled because the server is shutting down (${reason}).`,
          taskErrorLog: `Server shutdown: ${reason}`,
          activeRunCancelled: true,
          payload: {
            shutdownReason: reason,
          },
        },
      )
    }),
  )

  const staleLeases = await markInterruptedRuntimeLeasesStale({
    reason: `Server shutdown: ${reason}`,
  })
  if (staleLeases.staleLeaseCount > 0) {
    logger.warn(
      {
        staleLeaseCount: staleLeases.staleLeaseCount,
        affectedWorkerInstanceIds: staleLeases.affectedWorkerInstanceIds,
      },
      'Marked active runtime leases as stale before process exit',
    )
  }

  // Let AbortSignal handlers taskkill spawned Code Agent process trees.
  await new Promise((resolve) => setTimeout(resolve, 500))

  try { unlinkSync(portFile) } catch {}
  try { server.stop() } catch {}
  process.exit(0)
}
process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))
// On Windows, detect parent process death via stdin close
if (process.stdin) {
  process.stdin.once('end', () => void shutdown('stdin-end'))
}

const runningRuns = await db.query.orchestratorRuns.findMany({
  where: eq(orchestratorRuns.status, 'running'),
})
const staleLeases = await markInterruptedRuntimeLeasesStale({
  reason: 'Server startup recovery: previous process ended before runtime lease cleanup.',
})
if (staleLeases.staleLeaseCount > 0) {
  logger.warn(
    {
      staleLeaseCount: staleLeases.staleLeaseCount,
      affectedWorkerInstanceIds: staleLeases.affectedWorkerInstanceIds,
    },
    '[Recovery] Marked interrupted runtime leases as stale',
  )
}
for (const run of runningRuns) {
  OrchestratorEngine.resumeRun(run.id).catch((err) => {
    logger.error({ err, runId: run.id }, '[Recovery] Failed to resume run')
  })
}
if (runningRuns.length > 0) {
  logger.info({ count: runningRuns.length }, '[Recovery] Resuming unfinished orchestrator runs')
}
