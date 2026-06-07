import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const portFile = resolve(root, '.agenthub-port')
const children = new Set()
let shuttingDown = false

await run('bun', ['--filter', '@agenthub/desktop', 'prepare:sidecar', '--skip-web-build'])

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
    env: { ...process.env, ...envPatch },
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

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === 'win32',
      stdio: 'inherit',
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
