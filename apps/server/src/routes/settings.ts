import { Hono } from 'hono'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { db, eq, settings } from '@agenthub/db'
import { env } from '../env'
import { logger } from '../lib/logger'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { testLlmConnection } from '../services/llm-client'

const execFileAsync = promisify(execFile)

export const settingsRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const rows = await db.select().from(settings)
    const map: Record<string, string> = {}
    for (const row of rows) map[row.key] = row.value
    return c.json(map)
  })
  .post('/', async (c) => {
    const body = await c.req.json<Record<string, string>>()
    for (const [key, value] of Object.entries(body)) {
      const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
      if (existing.length > 0) {
        await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key))
      } else {
        await db.insert(settings).values({ key, value })
      }
    }
    applyRuntimeSettings(body)
    return c.json({ success: true })
  })
  .get('/runtime-info', async (c) => {
    const [git, python] = await Promise.all([detectRuntime('git', ['--version']), detectPythonRuntime()])
    return c.json({ git, python })
  })
  .get('/general-info', async (c) => {
    const rows = await db.select().from(settings)
    const map = Object.fromEntries(rows.map((row) => [row.key, row.value]))
    const appSettings = parseAppSettings(map.APP_SETTINGS)
    const appDataDir = resolve(env.AGENTHUB_APP_DATA_DIR?.trim() || process.cwd())
    const configDir = env.AGENTHUB_CONFIG_DIR?.trim() || appDataDir
    const logDir = env.AGENTHUB_LOG_DIR?.trim() || join(appDataDir, 'logs')
    const dataPath = appSettings.dataPath?.trim() || appDataDir
    const debugDir = join(appDataDir, 'debug', 'llm')
    const [git, python, dataUsage, debugUsage] = await Promise.all([
      detectRuntime('git', ['--version']),
      detectPythonRuntime(),
      describePathUsage(dataPath),
      describePathUsage(debugDir),
    ])

    return c.json({
      debug: {
        enabled: Boolean(appSettings.debugMode),
        dir: debugDir,
        logLevel: logger.level,
        exists: existsSync(debugDir),
        sizeBytes: debugUsage.sizeBytes,
        sizeLabel: formatBytes(debugUsage.sizeBytes),
      },
      storage: {
        appDataDir,
        configDir,
        logDir,
        dataPath,
        databasePath: resolve(env.DATABASE_URL),
        exists: dataUsage.exists,
        sizeBytes: dataUsage.sizeBytes,
        sizeLabel: formatBytes(dataUsage.sizeBytes),
        scannedFiles: dataUsage.scannedFiles,
        truncated: dataUsage.truncated,
        message: dataUsage.message,
      },
      git,
      python,
    })
  })
  .post('/test-model', async (c) => {
    const input = await c.req.json<{
      provider?: string
      apiEndpoint?: string
      anthropicEndpoint?: string
      apiKey?: string
      apiKeyEnv?: string
    }>()

    return c.json(await testLlmConnection(input), 200)
  })

async function detectRuntime(command: string, args: string[]) {
  const version = await runCommand(command, args)
  const path = await locateCommand(command)
  return {
    runtime: version.ok ? `PATH ${command} ${version.stdout}` : `未检测到 ${command}`,
    path: path.ok ? firstLine(path.stdout) : '',
    ok: version.ok,
    message: version.ok ? '' : version.message,
  }
}

function applyRuntimeSettings(map: Record<string, string>) {
  if (!map.APP_SETTINGS) return
  const appSettings = parseAppSettings(map.APP_SETTINGS)
  logger.level = appSettings.debugMode ? 'debug' : env.LOG_LEVEL
}

function parseAppSettings(value?: string): { dataPath?: string; debugMode?: boolean } {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return {
      dataPath: typeof parsed?.dataPath === 'string' ? parsed.dataPath : undefined,
      debugMode: Boolean(parsed?.debugMode),
    }
  } catch {
    return {}
  }
}

async function describePathUsage(path: string) {
  if (!existsSync(path)) {
    return { exists: false, sizeBytes: 0, scannedFiles: 0, truncated: false, message: '目录不存在' }
  }
  try {
    const usage = await calculateDirectorySize(path)
    return { exists: true, message: '', ...usage }
  } catch (error: any) {
    return {
      exists: true,
      sizeBytes: 0,
      scannedFiles: 0,
      truncated: false,
      message: error?.message || String(error),
    }
  }
}

async function calculateDirectorySize(root: string, maxFiles = 20_000) {
  let sizeBytes = 0
  let scannedFiles = 0
  let truncated = false
  const pending = [root]

  while (pending.length > 0) {
    const current = pending.pop()!
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (scannedFiles >= maxFiles) {
        truncated = true
        return { sizeBytes, scannedFiles, truncated }
      }
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(fullPath)
      } else if (entry.isFile()) {
        const item = await stat(fullPath).catch(() => null)
        if (item) {
          sizeBytes += item.size
          scannedFiles += 1
        }
      }
    }
  }

  return { sizeBytes, scannedFiles, truncated }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

async function detectPythonRuntime() {
  const candidates = ['python', 'python3', 'py']
  for (const command of candidates) {
    const version = await runCommand(command, ['--version'])
    if (!version.ok) continue
    const path = await locateCommand(command)
    return {
      runtime: `PATH ${firstLine(version.stdout)}`,
      path: path.ok ? firstLine(path.stdout) : command,
      ok: true,
      message: '',
    }
  }
  return {
    runtime: '未检测到 Python',
    path: '',
    ok: false,
    message: '未在 PATH 中找到 python、python3 或 py',
  }
}

async function runCommand(command: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000, windowsHide: true })
    return { ok: true, stdout: firstLine(stdout || stderr), message: '' }
  } catch (error: any) {
    return { ok: false, stdout: '', message: error?.message || String(error) }
  }
}

async function locateCommand(command: string) {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  return runCommand(locator, [command])
}

function firstLine(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? ''
}
