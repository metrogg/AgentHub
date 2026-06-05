import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const portFile = resolve(root, '.agenthub-port')
const children = new Set()
let shuttingDown = false
const localMatrixDefaults = {
  AGENTHUB_ROOM_PROVIDER: 'matrix',
  AGENTHUB_MATRIX_HOMESERVER_URL: 'http://127.0.0.1:6167',
  AGENTHUB_MATRIX_SERVER_NAME: 'agenthub.local',
  AGENTHUB_MATRIX_REGISTRATION_TOKEN: 'agenthub-dev-registration-token',
  AGENTHUB_MATRIX_AUTO_INVITE_PARTICIPANTS: 'true',
  AGENTHUB_MATRIX_AUTO_JOIN_PARTICIPANTS: 'true',
}

await run('bun', ['--filter', '@agenthub/desktop', 'prepare:sidecar', '--skip-web-build'])
await ensureLocalMatrixReady(desktopDevEnv())

const server = spawnManaged('bun', ['--watch', 'apps/server/src/index.ts'], {
  AGENTHUB_PORT_FILE: portFile,
  CORS_ORIGIN: 'http://127.0.0.1:5173',
  NODE_NO_WARNINGS: '1',
  PORT: '8000',
  PROJECT_ROOT: root,
})

const port = await waitForServer()
console.warn(`[desktop-dev] AgentHub server ready on 127.0.0.1:${port}`)

spawnManaged('bun', ['--filter', '@agenthub/web', 'dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  VITE_PROXY_TARGET: `http://127.0.0.1:${port}`,
  VITE_WS_PROXY_TARGET: `ws://127.0.0.1:${port}`,
})

await new Promise(() => undefined)

function spawnManaged(command, args, envPatch = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: desktopDevEnv(envPatch),
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
  children.add(child)
  child.on('exit', (code) => {
    children.delete(child)
    if (!shuttingDown) shutdown(code && code > 0 ? code : 1)
  })
  child.on('error', (error) => {
    console.error(`[desktop-dev] failed to start ${command} ${args.join(' ')}:`, error)
    shutdown(1)
  })
  return child
}

function desktopDevEnv(envPatch = {}) {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(localMatrixDefaults)) {
    if (!env[key]?.trim()) env[key] = value
  }
  return { ...env, ...envPatch }
}

async function ensureLocalMatrixReady(env) {
  const homeserverUrl = env.AGENTHUB_MATRIX_HOMESERVER_URL
  if (env.AGENTHUB_DESKTOP_SKIP_MATRIX_UP === '1') {
    console.warn('[desktop-dev] Skipping Matrix startup because AGENTHUB_DESKTOP_SKIP_MATRIX_UP=1')
    return
  }
  if (!isDefaultLocalMatrixUrl(homeserverUrl)) {
    console.warn(`[desktop-dev] Using configured Matrix homeserver: ${homeserverUrl}`)
    return
  }
  if (await matrixHealthCheck(homeserverUrl)) {
    console.warn(`[desktop-dev] Matrix homeserver ready at ${homeserverUrl}`)
    return
  }

  console.warn('[desktop-dev] Matrix homeserver is not reachable; starting local Tuwunel...')
  await ensureDockerReady(env)
  await run('docker', ['compose', '-f', 'infra/docker-compose.hiclaw-lite.yml', 'up', '-d', 'tuwunel'], env)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await matrixHealthCheck(homeserverUrl)) {
      console.warn(`[desktop-dev] Matrix homeserver ready at ${homeserverUrl}`)
      return
    }
    await sleep(1_000)
  }
  throw new Error(
    `Tuwunel did not become ready at ${homeserverUrl}. Check Docker Desktop and run: bun run matrix:logs`,
  )
}

async function ensureDockerReady(env) {
  try {
    await run('docker', ['info'], env, { stdio: 'ignore' })
  } catch {
    throw new Error(
      'Local Tuwunel requires Docker Desktop, but the Docker daemon is not reachable. ' +
        'Start Docker Desktop, then rerun bun run dev:desktop. ' +
        'For an external Matrix homeserver, set AGENTHUB_MATRIX_HOMESERVER_URL.',
    )
  }
}

function isDefaultLocalMatrixUrl(value) {
  try {
    const url = new URL(value)
    return url.hostname === '127.0.0.1' && url.port === '6167'
  } catch {
    return false
  }
}

async function matrixHealthCheck(homeserverUrl) {
  try {
    const response = await fetch(`${homeserverUrl.replace(/\/+$/, '')}/_matrix/client/versions`, {
      signal: AbortSignal.timeout(1_000),
    })
    return response.ok
  } catch {
    return false
  }
}

function run(command, args, env = process.env, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      shell: process.platform === 'win32',
      stdio: options.stdio ?? 'inherit',
    })
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    })
    child.on('error', reject)
  })
}

async function waitForServer() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const port = await readPortFile()
    if (port && (await healthCheck(port))) return port
    if (await healthCheck(8000)) return 8000
    await sleep(250)
  }
  shutdown(1)
  throw new Error('AgentHub server did not become healthy on 127.0.0.1:8000')
}

async function readPortFile() {
  try {
    const parsed = JSON.parse(await readFile(portFile, 'utf8'))
    return Number.isInteger(parsed.port) && parsed.port > 0 ? parsed.port : null
  } catch {
    return null
  }
}

async function healthCheck(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) })
    return response.ok
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // Best-effort cleanup.
    }
  }
  setTimeout(() => process.exit(code), 250)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
