import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cleanupStaleDevProcesses, root } from './dev-processes.mjs'

const portFile = resolve(root, '.agenthub-port')
const children = new Set()
let shuttingDown = false

await cleanupStaleDevProcesses()
await rm(portFile, { force: true }).catch(() => undefined)
await run('bun', ['run', 'db:migrate'])

const server = spawnManaged('bun', ['--watch', 'apps/server/src/index.ts'], 'server', {
  AGENTHUB_PORT_FILE: portFile,
  CORS_ORIGIN: 'http://127.0.0.1:5173,http://localhost:5173',
  NODE_NO_WARNINGS: '1',
  PORT: '8000',
  PROJECT_ROOT: root,
})

const serverPort = await waitForServer()
console.warn(`[dev] AgentHub server ready on http://127.0.0.1:${serverPort}`)

spawnManaged(
  'bun',
  ['--filter', '@agenthub/web', 'dev', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
  'web',
  {
    VITE_PROXY_TARGET: `http://127.0.0.1:${serverPort}`,
    VITE_WS_PROXY_TARGET: `ws://127.0.0.1:${serverPort}`,
  },
)

console.warn('[dev] AgentHub web ready target: http://127.0.0.1:5173/')
await new Promise(() => undefined)

function spawnManaged(command, args, name, envPatch = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...envPatch },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
  children.add(child)
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited unexpectedly`, { code, signal })
      shutdown(code && code > 0 ? code : 1)
    }
  })
  child.on('error', (error) => {
    console.error(`[dev] failed to start ${name}:`, error)
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
    await sleep(250)
  }
  shutdown(1)
  throw new Error('AgentHub server did not become healthy within 30s')
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
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    })
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
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      // Best-effort cleanup.
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('SIGHUP', () => shutdown(0))
