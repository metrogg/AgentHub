import { spawnSync } from 'node:child_process'
import { db, eq, and, workerInstances, matrixIdentities } from '@agenthub/db'
import { logger } from '../../lib/logger'

/**
 * Wait for the OpenClaw worker process to become healthy, then report readiness.
 * This runs as a background task after launching the worker process.
 *
 * Aligns with HiClaw's `hiclaw worker report-ready` pattern:
 * Worker starts → gateway becomes healthy → reports ready to controller.
 */
export async function waitForWorkerReadiness(input: {
  workerInstanceId: string
  gatewayPort: number
  maxWaitMs?: number
  pollIntervalMs?: number
}): Promise<{ ready: boolean; error?: string }> {
  const maxWait = input.maxWaitMs ?? 60_000
  const pollInterval = input.pollIntervalMs ?? 2_000
  const start = Date.now()

  while (Date.now() - start < maxWait) {
    try {
      const resp = await fetch(`http://127.0.0.1:${input.gatewayPort}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (resp.ok) {
        logger.info(
          { workerInstanceId: input.workerInstanceId, gatewayPort: input.gatewayPort, elapsedMs: Date.now() - start },
          'Worker OpenClaw gateway is healthy',
        )
        return { ready: true }
      }
    } catch {
      // Gateway not ready yet, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  const error = `Worker gateway did not become healthy within ${maxWait}ms`
  logger.warn({ workerInstanceId: input.workerInstanceId, gatewayPort: input.gatewayPort }, error)
  return { ready: false, error }
}

/**
 * Find the OpenClaw binary path. Reused from launcher logic.
 */
export function findOpenClawBinary(): string | null {
  const candidates = [
    'openclaw',
    'openclaw.exe',
  ]
  for (const name of candidates) {
    try {
      const { status } = spawnSync(name, ['--version'], { stdio: 'ignore' })
      if (status === 0) return name
    } catch { /* not found */ }
  }

  // Try which/where
  try {
    const { execSync } = require('node:child_process')
    const result = execSync('which openclaw 2>/dev/null || where openclaw 2>nul', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
    if (result) return result.split('\n')[0]!.trim()
  } catch { /* not found */ }

  return null
}
