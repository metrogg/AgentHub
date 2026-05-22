import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { db, settings } from '@agenthub/db'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../env'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import {
  getCodexAuthStatus,
  getCodexModels,
  logoutCodexAuth,
  openCodexDeviceAuthPage,
  pollCodexLogin,
  retryCodexAuth,
  startCodexLogin,
} from '../services/codex-auth'
import { getLlmRuntimeStatus } from '../services/llm-client'

interface ToolProbe {
  apiKeyEnv?: string
  id: string
  command: string
}

const probes: ToolProbe[] = [
  { id: 'codex', command: 'codex' },
  { id: 'claude-code', command: 'claude' },
  { id: 'opencode', command: 'opencode' },
]

const cliPackages = [
  '@openai/codex@0.133.0',
  '@anthropic-ai/claude-code@2.1.146',
  'opencode-ai@1.15.7',
]

const chatGptAuthDisabledMessage =
  'ChatGPT device auth is disabled for runtime use. Configure OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL in the environment instead.'
const routeDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(routeDir, '../../../..')
const envFilePath = resolve(projectRoot, '.env')

export const codingToolsRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/status', async (c) => {
    const items = await probeTools(probes)
    return c.json({ platform: process.platform, localCliProbesEnabled: env.ENABLE_LOCAL_CLI_PROBES, items })
  })
  .post('/status', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { tools?: ToolProbe[] }
    const requestedTools = Array.isArray(body.tools) && body.tools.length ? body.tools : probes
    const customProbes = requestedTools.map((tool: ToolProbe) => ({
      apiKeyEnv: isSafeEnvName(tool.apiKeyEnv) ? tool.apiKeyEnv : defaultApiKeyEnv(tool.id),
      id: tool.id,
      command: isSafeCommand(tool.command) ? tool.command : '',
    }))
    const items = await probeTools(customProbes)
    return c.json({ platform: process.platform, localCliProbesEnabled: env.ENABLE_LOCAL_CLI_PROBES, items })
  })
  .post('/cli/install', async (c) => {
    return c.json(await installAllCliTools(), 200)
  })
  .get('/docker/status', async (c) => {
    return c.json(await getDockerStatus())
  })
  .post('/docker/install', async (c) => {
    const status = await getDockerStatus()
    if (!status.installEnabled) {
      return c.json({
        ok: false,
        status: 'failed',
        message: 'Docker management is disabled. Set ENABLE_DOCKER_MANAGEMENT=true when running the local dev server.',
        statusBefore: status,
      }, 200)
    }
    if (!status.ready) {
      return c.json({
        ok: false,
        status: 'failed',
        message: status.message,
        statusBefore: status,
      }, 200)
    }

    const result = await runFixedCommand(['docker', 'compose', 'build'], {
      cwd: projectRoot,
      timeoutMs: 10 * 60 * 1000,
    })
    return c.json({
      ok: result.code === 0,
      status: result.code === 0 ? 'completed' : 'failed',
      code: result.code,
      message: result.code === 0 ? 'Container images with CLI tools are built.' : 'Container install failed.',
      output: limitOutput(result.output),
      statusBefore: status,
    }, 200)
  })
  .post('/docker/restart', async (c) => {
    const status = await getDockerStatus()
    if (!status.installEnabled) {
      return c.json({
        ok: false,
        status: 'failed',
        message: 'Docker management is disabled. Set ENABLE_DOCKER_MANAGEMENT=true when running the local dev server.',
        statusBefore: status,
      }, 200)
    }
    if (!status.ready) {
      return c.json({
        ok: false,
        status: 'failed',
        message: status.message,
        statusBefore: status,
      }, 200)
    }

    const applied = await applySavedRuntimeConfigToEnv()
    const result = await runFixedCommand(['docker', 'compose', 'up', '-d', '--build', 'server', 'web'], {
      cwd: projectRoot,
      timeoutMs: 10 * 60 * 1000,
    })
    return c.json({
      ok: result.code === 0,
      status: result.code === 0 ? 'completed' : 'failed',
      code: result.code,
      message: result.code === 0
        ? applied.updated
          ? 'Saved runtime config was written to .env, and AgentHub containers were rebuilt and restarted.'
          : 'AgentHub containers were rebuilt and restarted. No saved runtime API key was found to apply.'
        : 'Container restart failed.',
      output: limitOutput([applied.message, result.output].filter(Boolean).join('\n')),
      statusBefore: status,
    }, 200)
  })
  .get('/codex/auth/status', async (c) => {
    if (!env.ENABLE_CODEX_CHATGPT_AUTH) return c.json(await getApiKeyAuthStatus())
    const chatGptStatus = await getCodexAuthStatus()
    if (chatGptStatus.loggedIn) return c.json({ ...chatGptStatus, deviceAuthEnabled: true })
    const apiKeyStatus = await getApiKeyAuthStatus()
    return c.json({
      ...apiKeyStatus,
      deviceAuthEnabled: true,
      message: apiKeyStatus.loggedIn
        ? `${apiKeyStatus.message} 也可以继续登录 ChatGPT 账号。`
        : 'ChatGPT account is not logged in. You can sign in with device authorization.',
    })
  })
  .post('/codex/auth/start', async (c) => {
    if (!env.ENABLE_CODEX_CHATGPT_AUTH) return c.json(disabledAuthAction('failed'), 200)
    try {
      return c.json(await startCodexLogin())
    } catch (error: any) {
      return c.json({ ok: false, status: 'failed', message: sanitizeAuthOutput(error?.message || 'Login failed') }, 200)
    }
  })
  .post('/codex/auth/login', async (c) => {
    if (!env.ENABLE_CODEX_CHATGPT_AUTH) return c.json(disabledAuthAction('failed'), 200)
    try {
      return c.json(await startCodexLogin())
    } catch (error: any) {
      return c.json({ ok: false, status: 'failed', message: sanitizeAuthOutput(error?.message || 'Login failed') }, 200)
    }
  })
  .post('/codex/auth/open-device', async (c) => {
    if (!env.ENABLE_CODEX_CHATGPT_AUTH) return c.json(disabledAuthAction(), 200)
    try {
      return c.json(await openCodexDeviceAuthPage())
    } catch (error: any) {
      return c.json({ ok: false, message: sanitizeAuthOutput(error?.message || 'Failed to open authorization page') }, 200)
    }
  })
  .post('/codex/auth/poll', async (c) => {
    if (!env.ENABLE_CODEX_CHATGPT_AUTH) return c.json(disabledAuthAction('failed'), 200)
    const body = (await c.req.json().catch(() => ({}))) as { loginId?: string }
    if (!body.loginId) {
      return c.json({ ok: false, status: 'failed', message: 'loginId is required' }, 400)
    }
    try {
      return c.json(await pollCodexLogin(body.loginId))
    } catch (error: any) {
      return c.json({ ok: false, status: 'failed', message: sanitizeAuthOutput(error?.message || 'Login polling failed') }, 200)
    }
  })
  .post('/codex/auth/retry', async (c) => {
    if (!env.ENABLE_CODEX_CHATGPT_AUTH) return c.json(disabledAuthAction(), 200)
    return c.json(await retryCodexAuth())
  })
  .post('/codex/auth/logout', async (c) => {
    if (!env.ENABLE_CODEX_CHATGPT_AUTH) return c.json({ ok: true, message: chatGptAuthDisabledMessage })
    return c.json(await logoutCodexAuth())
  })
  .get('/codex/models', async (c) => {
    if (!env.ENABLE_CODEX_CHATGPT_AUTH) {
      return c.json({ ok: false, message: chatGptAuthDisabledMessage }, 200)
    }
    try {
      return c.json({ ok: true, data: await getCodexModels() })
    } catch (error: any) {
      return c.json({ ok: false, message: sanitizeAuthOutput(error?.message || 'Failed to fetch Codex models') }, 200)
    }
  })

async function probeTools(items: ToolProbe[]) {
  const dockerStatus = await getDockerStatus()
  if (dockerStatus.ready && dockerStatus.installEnabled) {
    return Promise.all(items.map(probeToolInAgentContainer))
  }
  return Promise.all(items.map(probeTool))
}

async function probeTool(probe: ToolProbe) {
  const configEnv = configEnvName(probe)
  if (!env.ENABLE_LOCAL_CLI_PROBES) {
    return {
      id: probe.id,
      command: probe.command,
      installed: false,
      version: null,
      configured: false,
      configEnv,
      configMessage: 'CLI 探测已关闭，无法判断运行配置。',
    }
  }

  return probeToolDirect(probe)
}

async function probeToolDirect(probe: ToolProbe) {
  const version = await runVersionProbe(probe.command)
  const configEnv = configEnvName(probe)
  const configured = await isDirectToolConfigured(probe, configEnv)
  const installed = Boolean(version)
  return {
    id: probe.id,
    command: probe.command,
    installed,
    version,
    configured,
    configEnv,
    configMessage: configMessage({ configEnv, configured, installed, runtime: '当前服务环境', toolId: probe.id }),
  }
}

async function installAllCliTools() {
  const dockerStatus = await getDockerStatus()
  if (dockerStatus.ready && dockerStatus.installEnabled) {
    const build = await runFixedCommand(['docker', 'compose', 'build'], {
      cwd: projectRoot,
      timeoutMs: 10 * 60 * 1000,
    })
    if (build.code !== 0) {
      return {
        ok: false,
        status: 'failed' as const,
        code: build.code,
        message: 'Container image build failed. CLI tools were not installed.',
        output: limitOutput(build.output),
        items: await Promise.all(probes.map(probeToolDirect)),
        runtime: 'container' as const,
      }
    }

    const items = await Promise.all(probes.map(probeToolInAgentContainer))
    const ok = items.every((item) => item.installed)
    const configured = items.every((item) => item.configured)
    return {
      ok,
      status: ok ? 'completed' as const : 'failed' as const,
      code: ok ? 0 : 1,
      message: ok && configured
        ? 'All CLI tools are installed and configured in the AgentHub container image.'
        : ok
          ? 'CLI tools are installed. Some container API keys or ChatGPT login state are still missing.'
          : 'Container image was built, but one or more CLI tools were not detected in cli-agent.',
      output: limitOutput(build.output),
      items,
      runtime: 'container' as const,
    }
  }

  if (!isRunningInContainer()) {
    return {
      ok: false,
      status: 'failed' as const,
      message: 'Docker is not ready from this server process. Start Docker or run AgentHub in the rebuilt container before installing CLI tools.',
      output: dockerStatus.message,
      items: await Promise.all(probes.map(probeToolDirect)),
      runtime: 'container' as const,
    }
  }

  const install = await runFixedCommand(['bun', 'install', '-g', ...cliPackages], {
    timeoutMs: 10 * 60 * 1000,
  })
  const items = await Promise.all(probes.map(probeToolDirect))
  const ok = install.code === 0 && items.every((item) => item.installed)
  const configured = items.every((item) => item.configured)
  return {
    ok,
    status: ok ? 'completed' as const : 'failed' as const,
    code: install.code,
    message: ok && configured
      ? 'All CLI tools are installed and configured in the current AgentHub container.'
      : ok
        ? 'CLI tools are installed. Some API keys or ChatGPT login state are still missing.'
        : 'CLI install finished with errors, or one or more CLI tools were still not detected.',
    output: limitOutput(install.output),
    items,
    runtime: 'container' as const,
  }
}

async function probeToolInAgentContainer(probe: ToolProbe) {
  if (!isSafeCommand(probe.command)) {
    const configEnv = configEnvName(probe)
    return {
      id: probe.id,
      command: probe.command,
      installed: false,
      version: null,
      configured: false,
      configEnv,
      configMessage: configMessage({ configEnv, configured: false, installed: false, runtime: 'cli-agent 容器', toolId: probe.id }),
    }
  }
  const configEnv = configEnvName(probe)

  const result = await runFixedCommand([
    'docker',
    'compose',
    '--profile',
    'agents',
    'run',
    '--rm',
    '--no-deps',
    'cli-agent',
    'sh',
    '-lc',
    buildContainerProbeCommand(probe, configEnv),
  ], {
    cwd: projectRoot,
    timeoutMs: 60 * 1000,
  })
  const configured = parseConfiguredMarker(result.output)
  const installed = result.code === 0

  return {
    id: probe.id,
    command: probe.command,
    installed,
    version: result.code === 0 ? versionLine(result.output) : null,
    configured,
    configEnv,
    configMessage: configMessage({ configEnv, configured, installed, runtime: 'cli-agent 容器', toolId: probe.id }),
  }
}

async function getApiKeyAuthStatus() {
  const status = await getLlmRuntimeStatus()
  return {
    loggedIn: status.apiKeyConfigured,
    authMode: status.apiKeyConfigured ? 'api-key' as const : 'none' as const,
    status: status.apiKeyConfigured ? 'logged-in' as const : 'logged-out' as const,
    accountId: null,
    validationFailed: false,
    validationError: null,
    deviceAuthEnabled: false,
    message: status.apiKeyConfigured
      ? env.ENABLE_CODEX_CHATGPT_AUTH
        ? `API Key 已从 ${status.apiKeySource || status.source} 配置。`
        : `API Key 已从 ${status.apiKeySource || status.source} 配置；ChatGPT 设备授权已关闭。`
      : env.ENABLE_CODEX_CHATGPT_AUTH
        ? '尚未配置运行时 API Key，可使用 ChatGPT 账号登录，或设置 OPENAI_API_KEY / LLM_API_KEY。'
        : '尚未配置运行时 API Key，请设置 OPENAI_API_KEY 或 LLM_API_KEY。',
  }
}

async function applySavedRuntimeConfigToEnv() {
  const map = await getSettingsMap()
  const catalog = parseModelCatalog(map.MODEL_CATALOG)
  const active = catalog.find((item) => item.id === map.ACTIVE_MODEL_ID && item.enabled !== false)
    ?? catalog.find((item) => item.enabled !== false && cleanValue(item.apiKey))

  if (!active?.modelId || !cleanValue(active.apiEndpoint)) {
    return { updated: false, message: 'No saved model config was found.' }
  }

  const provider = cleanValue(active.provider)?.toLowerCase() || 'openai'
  const apiKeyEnv = cleanValue(active.apiKeyEnv) || providerApiKeyEnv(provider)
  const apiKey = cleanValue(active.apiKey)
  const baseUrl = cleanValue(active.apiEndpoint)
  const model = cleanValue(active.modelId)

  if (!baseUrl || !model) {
    return { updated: false, message: 'Saved model config is missing Base URL or model name.' }
  }
  if (!apiKey) {
    return { updated: false, message: `Saved model config was found, but ${apiKeyEnv} has no saved API key.` }
  }

  const updates: Record<string, string> = {
    LLM_PROVIDER: provider === 'openai-compatible' ? 'openai' : provider,
    LLM_API_KEY: apiKey,
    LLM_BASE_URL: baseUrl,
    LLM_MODEL: model,
    [apiKeyEnv]: apiKey,
  }

  if (provider === 'anthropic') {
    updates.ANTHROPIC_API_KEY = apiKey
    updates.ANTHROPIC_BASE_URL = cleanValue(active.anthropicEndpoint) || baseUrl
    updates.ANTHROPIC_MODEL = model
  } else {
    updates.OPENAI_API_KEY = apiKey
    updates.OPENAI_BASE_URL = baseUrl
    updates.OPENAI_MODEL = model
  }

  await writeEnvFileUpdates(updates)
  return { updated: true, message: `Applied saved model config to .env for ${model}.` }
}

async function getSettingsMap() {
  const rows = await db.select().from(settings)
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

function parseModelCatalog(value?: string) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as Array<{
      anthropicEndpoint?: string
      apiEndpoint?: string
      apiKey?: string
      apiKeyEnv?: string
      enabled?: boolean
      id?: string
      modelId?: string
      provider?: string
    }> : []
  } catch {
    return []
  }
}

async function writeEnvFileUpdates(updates: Record<string, string>) {
  const current = await readFile(envFilePath, 'utf8').catch(() => '')
  const lines = current ? current.split(/\r?\n/) : []
  const remaining = new Set(Object.keys(updates))
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
    const key = match?.[1]
    if (!key || !(key in updates)) return line
    remaining.delete(key)
    return `${key}=${formatEnvValue(updates[key] ?? '')}`
  })

  if (remaining.size) {
    if (next.length && next[next.length - 1] !== '') next.push('')
    next.push('# Applied from AgentHub saved model config')
    for (const key of remaining) next.push(`${key}=${formatEnvValue(updates[key] ?? '')}`)
  }

  await writeFile(envFilePath, `${next.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
}

function providerApiKeyEnv(provider: string) {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY'
  if (provider === 'deepseek') return 'DEEPSEEK_API_KEY'
  return 'OPENAI_API_KEY'
}

function cleanValue(value?: string | null) {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function formatEnvValue(value: string) {
  if (/^[^\s"'`#]+$/.test(value)) return value
  return JSON.stringify(value)
}

async function getDockerStatus() {
  const [docker, compose, daemon, composePs] = await Promise.all([
    runFixedCommand(['docker', '--version'], { timeoutMs: 2500 }),
    runFixedCommand(['docker', 'compose', 'version'], { timeoutMs: 2500 }),
    runFixedCommand(['docker', 'info', '--format', '{{.ServerVersion}}'], { timeoutMs: 3500 }),
    runFixedCommand(['docker', 'compose', 'ps', '--format', 'json'], { cwd: projectRoot, timeoutMs: 3500 }),
  ])
  const composeFilePresent =
    existsSync(resolve(projectRoot, 'docker-compose.yml')) ||
    existsSync(resolve(projectRoot, 'compose.yml'))
  const dockerInstalled = docker.code === 0
  const composeInstalled = compose.code === 0
  const daemonRunning = daemon.code === 0
  const installEnabled = env.ENABLE_DOCKER_MANAGEMENT ?? env.NODE_ENV !== 'production'
  const ready = dockerInstalled && composeInstalled && daemonRunning && composeFilePresent

  return {
    dockerInstalled,
    composeInstalled,
    daemonRunning,
    composeFilePresent,
    installEnabled,
    ready,
    dockerVersion: docker.code === 0 ? firstLine(docker.output) : null,
    composeVersion: compose.code === 0 ? firstLine(compose.output) : null,
    serverVersion: daemon.code === 0 ? firstLine(daemon.output) : null,
    projectRoot,
    containers: composePs.code === 0 ? limitOutput(composePs.output, 5000) : null,
    message: dockerStatusMessage({ dockerInstalled, composeInstalled, daemonRunning, composeFilePresent, installEnabled }),
  }
}

function dockerStatusMessage(status: {
  composeFilePresent: boolean
  composeInstalled: boolean
  daemonRunning: boolean
  dockerInstalled: boolean
  installEnabled: boolean
}) {
  if (!status.dockerInstalled) return 'Docker CLI was not found in the server PATH.'
  if (!status.composeInstalled) return 'Docker Compose plugin was not found. Install Docker Desktop or docker compose.'
  if (!status.daemonRunning) return 'Docker is installed, but the daemon is not reachable.'
  if (!status.composeFilePresent) return 'No docker-compose.yml or compose.yml was found at the project root.'
  if (!status.installEnabled) return 'Docker is ready. Container install is disabled for this server process.'
  return 'Docker is ready. You can build AgentHub container images with CLI tools.'
}

async function runVersionProbe(command: string): Promise<string | null> {
  if (!isSafeCommand(command)) return null

  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd.exe' : 'sh'
  const args = isWindows
    ? ['/d', '/s', '/c', `where ${command} >nul 2>nul && ${command} --version`]
    : ['-lc', `command -v ${command} >/dev/null 2>&1 && ${command} --version`]

  try {
    const proc = Bun.spawn([shell, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timed = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(124), 2500)),
    ])
    if (timed !== 0) return null

    const output = await new Response(proc.stdout).text()
    return versionLine(output) ?? 'installed'
  } catch {
    return null
  }
}

async function runFixedCommand(
  command: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ code: number; output: string }> {
  try {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // The process may have already exited.
      }
    }, options.timeoutMs ?? 5000)
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ''),
      new Response(proc.stderr).text().catch(() => ''),
    ])
    clearTimeout(timer)
    return { code, output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') }
  } catch (error: any) {
    return { code: 127, output: error?.message || 'Command failed to start.' }
  }
}

function firstLine(output: string) {
  return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
}

function versionLine(output: string) {
  const ignored = [
    /^#\d+/,
    /^=>/,
    /^CACHED\b/,
    /^DONE\b/,
    /^WARNING:/,
    /^View build details/i,
    /^------$/,
    /^target\s/i,
  ]
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !ignored.some((pattern) => pattern.test(line)))

  return (
    lines.find((line) => /\bcodex(?:-cli)?\b/i.test(line)) ??
    lines.find((line) => /Claude Code/i.test(line)) ??
    lines.find((line) => /^\d+\.\d+\.\d+/.test(line)) ??
    lines.find((line) => /\b\d+\.\d+\.\d+\b/.test(line)) ??
    lines[0] ??
    null
  )
}

function limitOutput(output: string, max = 12_000) {
  if (output.length <= max) return output
  return `${output.slice(0, max)}\n... output truncated ...`
}

function isRunningInContainer() {
  return Bun.env.AGENTHUB_CONTAINER === 'true' || existsSync('/.dockerenv')
}

function disabledAuthAction(status?: 'pending' | 'completed' | 'failed') {
  return {
    ok: false,
    ...(status ? { status } : {}),
    message: chatGptAuthDisabledMessage,
  }
}

function isSafeCommand(command: string) {
  return /^[a-zA-Z0-9._-]+$/.test(command)
}

function isSafeEnvName(name?: string) {
  return Boolean(name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
}

function defaultApiKeyEnv(id: string) {
  if (id === 'claude-code') return 'ANTHROPIC_API_KEY'
  if (id === 'opencode') return 'DEEPSEEK_API_KEY'
  return 'OPENAI_API_KEY'
}

function configEnvName(probe: ToolProbe) {
  return isSafeEnvName(probe.apiKeyEnv) ? probe.apiKeyEnv! : defaultApiKeyEnv(probe.id)
}

function cleanEnvValue(value?: string) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

async function isDirectToolConfigured(probe: ToolProbe, configEnv: string) {
  if (cleanEnvValue(Bun.env[configEnv])) return true
  if (probe.id !== 'codex' || !env.ENABLE_CODEX_CHATGPT_AUTH) return false

  try {
    return (await getCodexAuthStatus()).loggedIn
  } catch {
    return false
  }
}

function buildContainerProbeCommand(probe: ToolProbe, configEnv: string) {
  const loginStatusCheck = probe.id === 'codex'
    ? ` || ${probe.command} login status >/dev/null 2>&1`
    : ''
  return [
    'configured=0',
    `[ -n "\${${configEnv}:-}" ] && configured=1`,
    `[ "$configured" = "1" ]${loginStatusCheck} && configured=1`,
    'echo "__AGENTHUB_CONFIGURED__=$configured"',
    `command -v ${probe.command} >/dev/null 2>&1 && ${probe.command} --version`,
  ].join('; ')
}

function parseConfiguredMarker(output: string) {
  return /__AGENTHUB_CONFIGURED__=1/.test(output)
}

function configMessage(options: {
  configEnv: string
  configured: boolean
  installed: boolean
  runtime: string
  toolId?: string
}) {
  if (!options.installed) return `${options.runtime}未检测到 CLI。`
  if (options.configured) return `${options.runtime}已检测到运行配置。`
  if (options.toolId === 'codex') return `${options.runtime}缺少 ${options.configEnv} 或 ChatGPT 登录态。`
  return `${options.runtime}缺少 ${options.configEnv}。`
}

function sanitizeAuthOutput(output: string) {
  return output
    .replace(/sk-[A-Za-z0-9_*.:-]{6,}/g, 'sk-***')
    .replace(/sess-[A-Za-z0-9_*.:-]{6,}/g, 'sess-***')
    .replace(/Bearer\s+[A-Za-z0-9_*.:-]{6,}/gi, 'Bearer ***')
}
