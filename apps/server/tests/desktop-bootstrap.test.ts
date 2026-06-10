import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'bun:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

test('server boots on a fresh desktop data dir', async () => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'agenthub-desktop-bootstrap-'))
  const port = 8931 + Math.floor(Math.random() * 200)
  const proc = Bun.spawn(
    [process.execPath, 'apps/server/src/index.ts'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTHUB_APP_DATA_DIR: appDataDir,
        AGENTHUB_AUTO_START_MANAGER: 'false',
        AGENTHUB_PORT_FILE: join(appDataDir, 'agenthub-port.json'),
        AGENTHUB_SKIP_LEGACY_SCHEMA: '0',
        PORT: String(port),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdout = new Response(proc.stdout).text().catch((error) => String(error))
  const stderr = new Response(proc.stderr).text().catch((error) => String(error))

  try {
    const ok = await waitForHealth(port, 80)
    if (!ok) {
      proc.kill()
      await proc.exited.catch(() => undefined)
      throw new Error(`server did not become healthy\nstdout:\n${await stdout}\nstderr:\n${await stderr}`)
    }
    expect(ok).toBe(true)
  } finally {
    proc.kill()
    await proc.exited.catch(() => undefined)
    rmSync(appDataDir, { recursive: true, force: true })
  }
}, 60_000)

async function waitForHealth(port: number, attempts: number) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok) {
        const body = await res.text()
        return body.includes('"status":"ok"')
      }
    } catch {
      // retry
    }
    await delay(200)
  }
  return false
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
