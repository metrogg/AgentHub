import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../lib/logger'
import { starOfficeRoot, starOfficeUrl } from './star-office-bridge'

const HEALTH_TIMEOUT_MS = 900
const START_TIMEOUT_MS = 8000
const START_POLL_MS = 300

export interface StarOfficeRuntimeStatus {
  url: string
  root: string
  rootExists: boolean
  running: boolean
  starting: boolean
  started: boolean
  pid?: number
  error?: string
}

let officeProcess: ChildProcess | null = null
let startPromise: Promise<StarOfficeRuntimeStatus> | null = null
let lastError: string | undefined

export async function getStarOfficeRuntimeStatus(): Promise<StarOfficeRuntimeStatus> {
  const running = await probeStarOffice()
  if (running) lastError = undefined
  return baseStatus({
    running,
    starting: Boolean(startPromise),
    started: false,
    error: running ? undefined : lastError,
  })
}

export async function ensureStarOfficeRunning(): Promise<StarOfficeRuntimeStatus> {
  const existing = await getStarOfficeRuntimeStatus()
  if (existing.running) return existing
  if (startPromise) return startPromise

  startPromise = startStarOfficeProcess()
  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}

function baseStatus(
  status: Pick<StarOfficeRuntimeStatus, 'running' | 'starting' | 'started'> & { error?: string },
): StarOfficeRuntimeStatus {
  const root = starOfficeRoot()
  return {
    url: starOfficeUrl(),
    root,
    rootExists: existsSync(join(root, 'backend', 'app.py')),
    pid: officeProcess?.pid,
    ...status,
  }
}

async function startStarOfficeProcess(): Promise<StarOfficeRuntimeStatus> {
  const root = starOfficeRoot()
  const appPath = join(root, 'backend', 'app.py')
  if (!existsSync(appPath)) {
    lastError = `Star Office UI not found at ${root}`
    return baseStatus({ running: false, starting: false, started: false, error: lastError })
  }
  if (!isLocalOfficeUrl(starOfficeUrl())) {
    lastError = `Star Office URL is not local: ${starOfficeUrl()}`
    return baseStatus({ running: false, starting: false, started: false, error: lastError })
  }

  const python = pythonCommand(root)
  const port = officePort(starOfficeUrl())
  const out = createWriteStream(join(root, 'star-office.out.log'), { flags: 'a' })
  const err = createWriteStream(join(root, 'star-office.err.log'), { flags: 'a' })
  out.write(`\n[AgentHub] starting Star Office at ${new Date().toISOString()}\n`)
  err.write(`\n[AgentHub] starting Star Office at ${new Date().toISOString()}\n`)

  mkdirSync(root, { recursive: true })
  lastError = undefined
  officeProcess = spawn(python.command, [...python.args, appPath], {
    cwd: root,
    env: {
      ...process.env,
      STAR_BACKEND_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  officeProcess.stdout?.pipe(out, { end: false })
  officeProcess.stderr?.pipe(err, { end: false })
  officeProcess.on('error', (error) => {
    lastError = error.message
    logger.warn({ err: error.message }, 'Star Office failed to start')
    officeProcess = null
  })
  officeProcess.on('exit', (code, signal) => {
    logger.warn({ code, signal }, 'Star Office process exited')
    if (officeProcess?.exitCode === code) officeProcess = null
    out.end()
    err.end()
  })

  const running = await waitForStarOffice()
  if (running) {
    lastError = undefined
    return baseStatus({ running: true, starting: false, started: true })
  }

  lastError = lastError ?? 'Star Office did not become ready in time'
  return baseStatus({ running: false, starting: false, started: false, error: lastError })
}

async function waitForStarOffice() {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probeStarOffice()) return true
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS))
  }
  return false
}

async function probeStarOffice() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(`${starOfficeUrl()}/health`, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function isLocalOfficeUrl(rawUrl: string) {
  try {
    const { hostname, protocol } = new URL(rawUrl)
    return protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(hostname)
  } catch {
    return false
  }
}

function officePort(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  } catch {
    return 19000
  }
}

function pythonCommand(root: string) {
  const envPython = process.env.AGENTHUB_STAR_OFFICE_PYTHON?.trim()
  if (envPython) return { command: envPython, args: [] as string[] }

  const venvPython =
    process.platform === 'win32'
      ? join(root, '.venv', 'Scripts', 'python.exe')
      : join(root, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return { command: venvPython, args: [] as string[] }

  return { command: process.platform === 'win32' ? 'python' : 'python3', args: [] as string[] }
}
