import { writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { app } from './app'
import { env } from './env'
import { logger } from './lib/logger'
import { setRuntimeServerPort } from './lib/runtime-server'
import { joinRoom, cleanupWebSocket, cancelAllAgentReplies } from './services/agent-runner'
import { db, users, eq, orchestratorRuns, sql } from '@agenthub/db'
import { DEFAULT_USER } from './middleware/auth'
import { WsEvent } from '@agenthub/shared'
import { runController } from './services/orchestrator/run-controller'
import { runtimeLeaseController } from './services/orchestrator/runtime-lease-controller'
import { getActiveManagerProvider } from './services/manager-runtime'
import { controllerReconcileQueue } from './services/controller-plane'

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
controllerReconcileQueue.start()
logger.info({ queue: controllerReconcileQueue.describe() }, 'Started AgentHub Controller Plane reconcile queue')

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

// ─── Start resident Manager (OpenClaw / QwenPaw) ─────────────────────
// Resident Managers observe rooms via Matrix /sync autonomously.
// AgentHub does not invoke their step() directly.
//
// HiClaw design: Manager is the brain. If it cannot start, the system
// is degraded. We log at fatal level so operators cannot miss it.
void (async () => {
  try {
    const provider = getActiveManagerProvider()
    if (provider.runtimeType === 'openclaw' || provider.runtimeType === 'qwenpaw') {
      const status = await provider.status()
      if (!status.running && !status.endpoint) {
        logger.info({ runtimeType: provider.runtimeType }, 'Starting resident Manager process...')
        if (!provider.ensureStarted) {
          logger.fatal('Provider does not support ensureStarted; Manager is unavailable.')
          return
        }
        const result = await provider.ensureStarted()
        if (result.error) {
          logger.fatal(
            { error: result.error, runtimeType: provider.runtimeType },
            'FATAL: Resident Manager failed to start. AgentHub cannot coordinate without a Manager. ' +
              'Install OpenClaw (bash infra/setup-openclaw.sh) or set AGENTHUB_MANAGER_RUNTIME correctly.',
          )
        } else {
          logger.info({ pid: result.pid, runtimeType: result.runtimeType }, 'Resident Manager started')
        }
      } else {
        logger.info({ runtimeType: provider.runtimeType, running: status.running, endpoint: status.endpoint }, 'Resident Manager already active')
      }
    }
  } catch (err) {
    logger.fatal({ err }, 'FATAL: Resident Manager startup threw an exception. AgentHub is in degraded mode.')
  }
})()

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

  const activeSessionIds = cancelAllAgentReplies()
  const activeRuns = await db
    .select({
      id: orchestratorRuns.id,
      workspaceId: orchestratorRuns.workspaceId,
      groupSessionId: orchestratorRuns.groupSessionId,
    })
    .from(orchestratorRuns)
    .where(sql`${orchestratorRuns.status} in ('planning', 'running', 'synthesizing')`)
  const activeRunIds = activeRuns.map((run) => run.id)

  if (activeRunIds.length > 0 || activeSessionIds.length > 0) {
    logger.warn(
      { activeRunIds, activeSessionIds },
      'Cancelled active Agent work before process exit',
    )
  }

  await Promise.allSettled(
    activeRuns.map(async (run) => {
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
          activeRunCancelled: false,
          payload: {
            shutdownReason: reason,
            coordinationSource: 'run-controller',
          },
        },
      )
    }),
  )

  const staleLeases = await runtimeLeaseController.recoverInterruptedLeases({
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
const staleLeases = await runtimeLeaseController.recoverInterruptedLeases({
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

// Also recover any busy worker instances whose leases are now stale
const { workerController } = await import('./services/orchestrator/worker-controller')
const { recoveredLeaseCount, affectedWorkerIds } = await workerController.recoverStaleOnStartup()
if (recoveredLeaseCount > 0) {
  logger.warn(
    { recoveredLeaseCount, affectedWorkerIds },
    '[Recovery] WorkerController recovered stale worker instances on startup',
  )
}
const { matrixRuntimeSupervisor } = await import('./services/rooms/matrix-runtime-supervisor')
const matrixListeners = await matrixRuntimeSupervisor.startActiveParticipantListeners({
  reason: 'server-startup-recovery',
}).catch((err) => {
  logger.warn({ err }, '[Recovery] Matrix runtime listener recovery failed')
  return null
})
if (matrixListeners && (matrixListeners.startedCount > 0 || matrixListeners.skippedCount > 0)) {
  logger.info(
    {
      startedCount: matrixListeners.startedCount,
      skippedCount: matrixListeners.skippedCount,
    },
    '[Recovery] Matrix runtime listeners reconciled',
  )
}
if (runningRuns.length > 0) {
  logger.info({ count: runningRuns.length }, '[Recovery] Reconciling unfinished runs through RunController')
  for (const run of runningRuns) {
    const runContext = {
      runId: run.id,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
    }
    runController
      .requeueRunningTasksForResume(runContext, {
        reason: '服务重启后恢复运行，任务已重新排队。',
        progressStatus: '服务重启后恢复运行，等待 Manager 重新分发。',
      })
      .then(() => runController.reconcile(runContext))
      .catch((err) => {
        logger.error({ err, runId: run.id }, '[Recovery] Failed to reconcile run')
      })
  }
}

// HiClaw-style Manager patrol: periodically check active runs, worker health,
// and task timeouts. The patrol makes the Manager's supervision visible rather
// than waiting passively for the next user message.
const PATROL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes (HiClaw default: configurable)
const patrolTimer = setInterval(() => {
  import('./services/orchestrator/manager-patrol').then(({ patrolAndLog }) => {
    patrolAndLog().catch(() => {})
  })
}, PATROL_INTERVAL_MS)
if (process.env.AGENTHUB_ENABLE_MANAGER_PATROL !== '0') {
  logger.info({ intervalMs: PATROL_INTERVAL_MS }, '[Patrol] Manager patrol timer started')
  // Run an initial patrol after a short delay to catch any issues from startup
  setTimeout(() => {
    import('./services/orchestrator/manager-patrol').then(({ patrolAndLog }) => {
      patrolAndLog().catch(() => {})
    })
  }, 30_000)
}
// Clean up on shutdown
process.once('beforeExit', () => clearInterval(patrolTimer))
