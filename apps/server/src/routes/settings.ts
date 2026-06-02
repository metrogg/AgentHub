import { Hono } from 'hono'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  agents,
  blackboardEntries,
  db,
  eq,
  executionLogs,
  messages,
  orchestratorRunControls,
  orchestratorRunEvents,
  orchestratorRuns,
  sessionMembers,
  sessions,
  settings,
  taskClarifications,
  tasks,
  users,
  workspaceAgentRelations,
  workspaceAgents,
  workspaceStates,
  workspaceTasks,
  workspaces,
} from '@agenthub/db'
import { env } from '../env'
import { AppError, AppErrorCodes } from '../lib/error'
import { logger } from '../lib/logger'
import { DEFAULT_USER, authMiddleware, type AuthVariables } from '../middleware/auth'
import { describeSandboxRuntimeStatus } from '../services/execution/sandbox-provider'
import { cleanupLegacyApplicationData } from '../services/legacy-cleanup'
import { testLlmConnection } from '../services/llm-client'
import { resolveWorkspaceStorageRoot } from '../services/workspace/auto-workspace'

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
    const databasePath = resolve(env.DATABASE_URL)
    const activeDataDir = dirname(databasePath)
    const dataPath = appSettings.dataPath?.trim() || activeDataDir
    const workspaceStorageRoot = appSettings.workspaceStorageRoot?.trim() || (await resolveWorkspaceStorageRoot())
    const debugDir = join(appDataDir, 'debug', 'llm')
    const [git, python, dataUsage, workspaceStorageUsage, debugUsage, databaseUsage, sandbox] = await Promise.all([
      detectRuntime('git', ['--version']),
      detectPythonRuntime(),
      describePathUsage(dataPath),
      describePathUsage(workspaceStorageRoot),
      describePathUsage(debugDir),
      describeFileUsage(databasePath),
      describeSandboxRuntimeStatus(),
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
        activeDataDir,
        dataPath,
        workspaceStorageRoot,
        databasePath,
        migrationPending: normalizePath(dataPath) !== normalizePath(activeDataDir),
        exists: dataUsage.exists,
        sizeBytes: dataUsage.sizeBytes,
        sizeLabel: formatBytes(dataUsage.sizeBytes),
        workspaceStorageExists: workspaceStorageUsage.exists,
        workspaceStorageSizeBytes: workspaceStorageUsage.sizeBytes,
        workspaceStorageSizeLabel: formatBytes(workspaceStorageUsage.sizeBytes),
        databaseSizeBytes: databaseUsage.sizeBytes,
        databaseSizeLabel: formatBytes(databaseUsage.sizeBytes),
        scannedFiles: dataUsage.scannedFiles,
        truncated: dataUsage.truncated,
        message: dataUsage.message,
      },
      sandbox,
      git,
      python,
    })
  })
  .post('/sandbox/docker/setup', async (c) => {
    const result = await setupDockerSandbox()
    logger.warn({ result }, 'Docker Sandboxes setup requested from settings')
    return c.json({
      ok: result.ok,
      message: result.message,
      steps: result.steps,
      sandbox: await describeSandboxRuntimeStatus(),
    })
  })
  .post('/sandbox/docker/login', async (c) => {
    const result = await launchDockerSandboxLogin()
    logger.warn({ result }, 'Docker Sandboxes login requested from settings')
    return c.json({
      ok: result.ok,
      message: result.message,
      started: result.started,
      sandbox: await describeSandboxRuntimeStatus(),
    })
  })
  .post('/storage/ensure', async (c) => {
    const input: { path?: string } = await c.req.json<{ path?: string }>().catch(() => ({}))
    const target = input.path?.trim()
    if (!target) return c.json({ ok: false, message: '目录路径不能为空' }, 400)
    await mkdir(target, { recursive: true })
    const usage = await describePathUsage(target)
    return c.json({
      ok: true,
      path: resolve(target),
      sizeBytes: usage.sizeBytes,
      sizeLabel: formatBytes(usage.sizeBytes),
      message: '目录已创建',
    })
  })
  .post('/storage/open-path', async (c) => {
    const input: { path?: string } = await c.req.json<{ path?: string }>().catch(() => ({}))
    const target = input.path?.trim()
    if (!target) return c.json({ ok: false, message: '路径不能为空' }, 400)
    if (!existsSync(target)) return c.json({ ok: false, message: '路径不存在' }, 404)
    const opened = await openSystemPath(target)
    if (!opened.ok) return c.json(opened, 500)
    return c.json({ ok: true, message: '已打开路径' })
  })
  .post('/reset-all-data', async (c) => {
    const input: { confirm?: string } = await c.req.json<{ confirm?: string }>().catch(() => ({}))
    if (input.confirm !== 'RESET_AGENTHUB_DATA') {
      throw AppError.fromCode(
        AppErrorCodes.VALIDATION_FAILED,
        '确认短语不正确，已取消重置',
      )
    }

    await resetAllApplicationData()
    logger.warn({ userId: c.get('user').sub }, 'All AgentHub application data has been reset')
    return c.json({
      success: true,
      message: '已清空应用数据并重新创建默认用户',
      preserved: ['本地项目目录', '数据库迁移记录'],
    })
  })
  .post('/cleanup-legacy-data', async (c) => {
    const result = await cleanupLegacyApplicationData()
    logger.warn({ userId: c.get('user').sub, result }, 'Legacy AgentHub entries have been cleaned')
    return c.json({
      ...result,
      message: '已清理历史入口、旧任务表、旧 Agent 表和无效任务子会话',
    })
  })
  .post('/test-model', async (c) => {
    const input = await c.req.json<{
      provider?: string
      apiEndpoint?: string
      anthropicEndpoint?: string
      apiKey?: string
      apiKeyEnv?: string
      modelId?: string
    }>()

    return c.json(await testLlmConnection(input), 200)
  })
  .get('/ccswitch-models', async (c) => {
    const dbPath = resolve(homedir(), '.cc-switch', 'cc-switch.db')
    if (!existsSync(dbPath)) return c.json({ models: [] })

    try {
      const { Database } = await import('bun:sqlite')
      const sqlite = new Database(dbPath, { readonly: true })
      const rows = sqlite
        .query<{ id: string; name: string; settings_config: string }, []>(
          `SELECT id, name, settings_config FROM providers WHERE app_type = 'claude' ORDER BY sort_index, name`,
        )
        .all()
      sqlite.close()

      const models: Array<{
        name: string
        modelId: string
        apiEndpoint: string
        anthropicEndpoint?: string
        apiKey: string
      }> = []

      for (const row of rows) {
        try {
          const config = JSON.parse(row.settings_config) as { env?: Record<string, string> }
          const env = config.env ?? {}
          const modelId = env.ANTHROPIC_MODEL ?? ''
          const anthropicEndpoint = env.ANTHROPIC_BASE_URL ?? ''
          const apiEndpoint = inferOpenAiEndpointFromAnthropicBaseUrl(anthropicEndpoint) ?? ''
          const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? ''
          if (!modelId && !anthropicEndpoint && !apiEndpoint) continue
          models.push({ name: row.name, modelId, apiEndpoint, anthropicEndpoint, apiKey })
        } catch {
          // skip invalid config
        }
      }

      return c.json({ models })
    } catch {
      return c.json({ models: [] })
    }
  })

function inferOpenAiEndpointFromAnthropicBaseUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    const originalPath = url.pathname
    url.pathname = url.pathname.replace(/\/anthropic\/?$/i, '/v1')
    if (url.pathname === originalPath) return ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

async function resetAllApplicationData() {
  await db.transaction(async (tx) => {
    await tx.delete(executionLogs)
    await tx.delete(orchestratorRunControls)
    await tx.delete(taskClarifications)
    await tx.delete(orchestratorRunEvents)
    await tx.delete(workspaceTasks)
    await tx.delete(blackboardEntries)
    await tx.delete(tasks)
    await tx.delete(messages)
    await tx.delete(sessionMembers)
    await tx.delete(orchestratorRuns)
    await tx.delete(sessions)
    await tx.delete(workspaceAgentRelations)
    await tx.delete(workspaceAgents)
    await tx.delete(workspaceStates)
    await tx.delete(workspaces)
    await tx.delete(agents)
    await tx.delete(settings)
    await tx.delete(users)
    await tx.insert(users).values({
      id: DEFAULT_USER.sub,
      email: DEFAULT_USER.email,
      username: DEFAULT_USER.username,
      passwordHash: '',
    })
  })
}

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

function parseAppSettings(value?: string): { dataPath?: string; workspaceStorageRoot?: string; debugMode?: boolean } {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return {
      dataPath: typeof parsed?.dataPath === 'string' ? parsed.dataPath : undefined,
      workspaceStorageRoot: typeof parsed?.workspaceStorageRoot === 'string' ? parsed.workspaceStorageRoot : undefined,
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

async function describeFileUsage(path: string) {
  try {
    const item = await stat(path)
    return { exists: item.isFile(), sizeBytes: item.isFile() ? item.size : 0 }
  } catch {
    return { exists: false, sizeBytes: 0 }
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

async function openSystemPath(path: string) {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/C', 'start', '', path] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [path] }
        : { file: 'xdg-open', args: [path] }
  try {
    await execFileAsync(command.file, command.args, { timeout: 5000, windowsHide: true })
    return { ok: true, message: '' }
  } catch (error: any) {
    return { ok: false, message: error?.message || String(error) }
  }
}

async function setupDockerSandbox() {
  const steps: Array<{ command: string; ok: boolean; output: string }> = []
  const daemon = await runSbxCommand(['daemon', 'start', '--detach', '--policy', 'balanced'])
  steps.push({ command: 'sbx daemon start --detach --policy balanced', ok: daemon.ok, output: daemon.output })
  const policy = await runSbxCommand(['policy', 'set-default', 'balanced'])
  const policyOutput = /default policy is already set/i.test(policy.output) ? 'default policy already set' : policy.output
  steps.push({ command: 'sbx policy set-default balanced', ok: policy.ok || /default policy is already set/i.test(policy.output), output: policyOutput })

  const ok = steps.every((step) => step.ok)
  return {
    ok,
    message: ok
      ? 'Docker Sandboxes 已启动并配置为 balanced。'
      : steps.find((step) => !step.ok)?.output || 'Docker Sandboxes 初始化失败。',
    steps,
  }
}

async function launchDockerSandboxLogin() {
  try {
    const proc = Bun.spawn(['sbx', 'login'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: process.env,
    })
    const result = await Promise.race([
      proc.exited.then(async (code) => ({
        started: true,
        ok: code === 0,
        message: (await new Response(proc.stderr).text()).trim() || 'Docker Sandboxes login completed.',
      })),
      new Promise<{ started: boolean; ok: boolean; message: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              started: true,
              ok: true,
              message:
                'Docker Sandboxes login flow has been launched. Complete sign-in if a browser window appears, then come back and refresh.',
            }),
          3000,
        ),
      ),
    ])
    return result
  } catch (error: any) {
    return { started: false, ok: false, message: error?.message || 'Docker Sandboxes login failed.' }
  }
}

async function runSbxCommand(args: string[]) {
  try {
    const proc = Bun.spawn(['sbx', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: process.env,
    })
    const code = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(124), 20_000)),
    ])
    const stdout = (await new Response(proc.stdout).text()).trim()
    const stderr = (await new Response(proc.stderr).text()).trim()
    return {
      ok: code === 0 || /default policy is already set/i.test(stderr + stdout),
      code,
      output: [stdout, stderr].filter(Boolean).join('\n').trim(),
    }
  } catch (error: any) {
    return { ok: false, code: -1, output: error?.message || 'sbx command failed.' }
  }
}

async function locateCommand(command: string) {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  return runCommand(locator, [command])
}

function firstLine(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? ''
}

function normalizePath(value: string) {
  return resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}
