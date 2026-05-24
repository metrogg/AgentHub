import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
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
import { globalSkillRegistry } from '../services/skill-registry'
import { readOnlyToolRegistry } from '../services/tool-registry'

interface ToolProbe {
  apiKeyEnv?: string
  id: string
  command: string
}

interface OpencodeModelItem {
  id: string
  provider: string
  model: string
}

const probes: ToolProbe[] = [
  { id: 'codex', command: 'codex' },
  { id: 'claude-code', command: 'claude' },
  { id: 'opencode', command: 'opencode' },
]

const cliPackages = [
  '@openai/codex@0.42.0',
  '@anthropic-ai/claude-code@2.1.146',
  'opencode-ai@1.15.7',
]

const chatGptAuthDisabledMessage =
  'ChatGPT device auth is disabled for runtime use. Configure OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL in the environment instead.'
const routeDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(routeDir, '../../../..')
let rootEnvCache: Record<string, string> | null = null

export const codingToolsRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/status', async (c) => {
    const items = await probeTools(probes)
    return c.json({ platform: process.platform, localCliProbesEnabled: env.ENABLE_LOCAL_CLI_PROBES, items })
  })
  .get('/native/status', async (c) => {
    const skills = await globalSkillRegistry.listSkills()
    const tools = readOnlyToolRegistry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly,
      scopes: tool.scopes,
      inputSchema: tool.inputSchema,
    }))
    return c.json({
      mode: 'read-only',
      maxToolRounds: env.AGENTHUB_NATIVE_MAX_TOOL_ROUNDS,
      skills,
      tools,
    })
  })
  .post('/status', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { tools?: ToolProbe[] }
    const requestedTools = Array.isArray(body.tools) && body.tools.length ? body.tools : probes
    const customProbes = requestedTools.map((tool) => ({
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
  .get('/opencode/models', async (c) => {
    return c.json(await getOpencodeModels(), 200)
  })
  .get('/codex/config', async (c) => {
    return c.json(readCodexConfig(), 200)
  })
  .post('/codex/config', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { content?: unknown }
    if (typeof body.content !== 'string') {
      return c.json({ ok: false, message: 'content is required' }, 400)
    }
    if (body.content.length > 200_000) {
      return c.json({ ok: false, message: 'config.toml is too large' }, 400)
    }
    return c.json(writeCodexConfig(body.content), 200)
  })
  .get('/codex/auth-file', async (c) => {
    return c.json(readCodexAuthFile(), 200)
  })
  .post('/codex/auth-file', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { content?: unknown }
    if (typeof body.content !== 'string') {
      return c.json({ ok: false, message: 'content is required' }, 400)
    }
    if (body.content.length > 200_000) {
      return c.json({ ok: false, message: 'auth.json is too large' }, 400)
    }
    return c.json(writeCodexAuthFile(body.content), 200)
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
        : 'ChatGPT account is not logged in. You can sign in with device authorization or configure OPENAI_API_KEY.',
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

async function getOpencodeModels() {
  const config = readOpencodeConfig()
  const command = await runHostCliCommand('opencode', ['models'], { timeoutMs: 30_000 })
  const cliModels = command.code === 0 ? parseOpencodeModels(command.output) : []
  const configModels = extractOpencodeConfigModels(config.value)
  const models = uniqueOpencodeModels([...configModels, ...cliModels])

  return {
    ok: command.code === 0 || models.length > 0,
    defaultModel: typeof config.value?.model === 'string' ? config.value.model : null,
    smallModel: typeof config.value?.small_model === 'string' ? config.value.small_model : null,
    configPath: config.path,
    models,
    message:
      command.code === 0
        ? `Loaded ${models.length} model${models.length === 1 ? '' : 's'} from local OpenCode.`
        : models.length
          ? `Loaded ${models.length} model${models.length === 1 ? '' : 's'} from OpenCode config.`
          : limitOutput(command.output || 'OpenCode model list is empty.', 800),
  }
}

function codexConfigPath() {
  return resolve(Bun.env.CODEX_HOME?.trim() || resolve(homedir(), '.codex'), 'config.toml')
}

function codexAuthFilePath() {
  return resolve(Bun.env.CODEX_HOME?.trim() || resolve(homedir(), '.codex'), 'auth.json')
}

function readCodexConfig() {
  const path = codexConfigPath()
  try {
    const content = readFileSync(path, 'utf8')
    return {
      ok: true,
      exists: true,
      path,
      content,
      message: '已读取 Codex config.toml。',
    }
  } catch {
    return {
      ok: true,
      exists: false,
      path,
      content: defaultCodexConfig(),
      message: '未找到 config.toml，已生成默认模板。',
    }
  }
}

function readCodexAuthFile() {
  const path = codexAuthFilePath()
  try {
    const content = readFileSync(path, 'utf8')
    return {
      ok: true,
      exists: true,
      path,
      content,
      message: '已读取 Codex auth.json。',
    }
  } catch {
    return {
      ok: true,
      exists: false,
      path,
      content: defaultCodexAuthFile(),
      message: '未找到 auth.json，已生成默认模板。',
    }
  }
}

function writeCodexConfig(content: string) {
  const validationError = validateCodexConfig(content)
  if (validationError) {
    return {
      ok: false,
      exists: existsSync(codexConfigPath()),
      path: codexConfigPath(),
      content,
      message: validationError,
    }
  }
  const path = codexConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return {
    ok: true,
    exists: true,
    path,
    content,
    message: 'Codex config.toml 已保存。',
  }
}

function writeCodexAuthFile(content: string) {
  const validationError = validateCodexAuthFile(content)
  if (validationError) {
    return {
      ok: false,
      exists: existsSync(codexAuthFilePath()),
      path: codexAuthFilePath(),
      content,
      message: validationError,
    }
  }
  const path = codexAuthFilePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return {
    ok: true,
    exists: true,
    path,
    content,
    message: 'Codex auth.json 已保存。',
  }
}

function validateCodexConfig(content: string) {
  if (/^\s*model_reasoning_effort\s*=/m.test(content)) {
    return '当前 Codex CLI 不支持 model_reasoning_effort，请删除这一行后保存。'
  }
  const provider = content.match(/^\s*model_provider\s*=\s*"([^"]*)"/m)?.[1]?.trim()
  if (provider === '') return 'model_provider 不能为空。'
  if (!provider) return null
  if (provider === 'openai') return null
  const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tablePattern = new RegExp(`^\\s*\\[model_providers\\.${escaped}\\]\\s*$`, 'm')
  if (!tablePattern.test(content)) {
    return `model_provider "${provider}" 没有对应的 [model_providers.${provider}] 配置。`
  }
  return null
}

function validateCodexAuthFile(content: string) {
  if (!content.trim()) return null
  try {
    JSON.parse(content)
    return null
  } catch (error: any) {
    return `auth.json 不是有效 JSON：${error?.message || 'parse failed'}`
  }
}

function defaultCodexAuthFile() {
  return JSON.stringify({ OPENAI_API_KEY: '' }, null, 2)
}

function defaultCodexConfig() {
  return [
    'model_provider = "openai"',
    'model = "gpt-5.5"',
    '',
    '# Example custom provider:',
    '# model_provider = "agenthub-openai-compatible"',
    '# [model_providers.agenthub-openai-compatible]',
    '# name = "AgentHub"',
    '# base_url = "https://api.openai.com/v1"',
    '# env_key = "OPENAI_API_KEY"',
    '# wire_api = "responses"',
    '',
  ].join('\n')
}

function readOpencodeConfig() {
  const configPath = resolve(homedir(), '.config', 'opencode', 'opencode.json')
  try {
    return {
      path: configPath,
      value: JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>,
    }
  } catch {
    return { path: configPath, value: null as Record<string, any> | null }
  }
}

function parseOpencodeModels(output: string): OpencodeModelItem[] {
  return output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:+-]+$/.test(line))
    .map((id) => {
      const [provider, ...rest] = id.split('/')
      return { id, provider: provider ?? '', model: rest.join('/') }
    })
}

function extractOpencodeConfigModels(config: Record<string, any> | null): OpencodeModelItem[] {
  if (!config) return []
  const fromDefaults = [config.model, config.small_model]
    .filter((value): value is string => typeof value === 'string' && value.includes('/'))
    .map((id) => {
      const [provider, ...rest] = id.split('/')
      return { id, provider: provider ?? '', model: rest.join('/') }
    })

  const providerConfig = config.provider && typeof config.provider === 'object' ? config.provider : {}
  const fromProviders = Object.entries(providerConfig).flatMap(([provider, value]) => {
    const models = value && typeof value === 'object' && 'models' in value ? (value as any).models : null
    if (!models || typeof models !== 'object') return []
    return Object.keys(models).map((model) => ({ id: `${provider}/${model}`, provider, model }))
  })

  return [...fromDefaults, ...fromProviders]
}

function uniqueOpencodeModels(models: OpencodeModelItem[]) {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

async function probeTools(items: ToolProbe[]) {
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
      configMessage: 'CLI 探测已关闭，无法判断本机运行配置。',
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
    configMessage: configMessage({ configEnv, configured, installed, runtime: '本机环境', toolId: probe.id }),
  }
}

async function installAllCliTools() {
  const install = await runFixedCommand(['bun', 'install', '-g', ...cliPackages], {
    timeoutMs: 10 * 60 * 1000,
  })
  const items = await Promise.all(probes.map(probeToolDirect))
  const ok = install.code === 0 && items.every((item) => item.installed)
  const configured = items.every((item) => item.configured)
  return {
    ok,
    status: ok ? ('completed' as const) : ('failed' as const),
    code: install.code,
    message:
      ok && configured
        ? 'CLI 工具已在本机安装并完成运行配置。'
        : ok
          ? 'CLI 工具已安装，仍有 API Key 或 ChatGPT 登录状态需要补齐。'
          : 'CLI 安装过程返回错误，或至少一个工具仍未被检测到。',
    output: limitOutput(install.output),
    items,
    runtime: 'host' as const,
  }
}

async function getApiKeyAuthStatus() {
  const status = await getLlmRuntimeStatus()
  return {
    loggedIn: status.apiKeyConfigured,
    authMode: status.apiKeyConfigured ? ('api-key' as const) : ('none' as const),
    status: status.apiKeyConfigured ? ('logged-in' as const) : ('logged-out' as const),
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

async function runVersionProbe(command: string): Promise<string | null> {
  if (!isSafeCommand(command)) return null

  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd.exe' : 'sh'
  const commandLine = isWindows
    ? `where ${command} >nul 2>nul && ${command} --version`
    : `command -v ${quoteForSh(command)} >/dev/null 2>&1 && ${quoteForSh(command)} --version`
  const args = isWindows ? ['/d', '/s', '/c', commandLine] : ['-lc', commandLine]

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
    const isWindows = process.platform === 'win32'
    const proc = Bun.spawn(isWindows ? ['cmd.exe', '/d', '/s', '/c', command.map(quoteForCmd).join(' ')] : command, {
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

async function runHostCliCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ code: number; output: string }> {
  try {
    const isWindows = process.platform === 'win32'
    const proc = Bun.spawn(isWindows ? ['cmd.exe', '/d', '/c', [command, ...args.map(windowsShellArg)].join(' ')] : [command, ...args], {
      cwd: options.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // Process may have already exited.
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
  if (cleanEnvValue(readEnv(configEnv))) return true
  if (probe.id === 'codex' && readCodexConfig().exists) return true
  if (probe.id === 'opencode') {
    const opencode = await getOpencodeModels()
    return Boolean(opencode.defaultModel || opencode.models.length > 0)
  }
  if (probe.id !== 'codex' || !env.ENABLE_CODEX_CHATGPT_AUTH) return false

  try {
    return (await getCodexAuthStatus()).loggedIn
  } catch {
    return false
  }
}

function readEnv(key: string) {
  return rootEnv()[key] ?? Bun.env[key]
}

function rootEnv() {
  if (rootEnvCache) return rootEnvCache
  const envPath = resolve(projectRoot, '.env')
  const values: Record<string, string> = {}
  if (!existsSync(envPath)) {
    rootEnvCache = values
    return values
  }
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  rootEnvCache = values
  return values
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
  if (options.toolId === 'codex') return `${options.runtime}缺少 ${options.configEnv} 或 ChatGPT 登录状态。`
  return `${options.runtime}缺少 ${options.configEnv}。`
}

function quoteForCmd(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function windowsShellArg(value: string) {
  if (/^[a-zA-Z0-9_./:@=\\-]+$/.test(value)) return value
  return quoteForCmd(value)
}

function quoteForSh(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function sanitizeAuthOutput(output: string) {
  return output
    .replace(/sk-[A-Za-z0-9_*.:-]{6,}/g, 'sk-***')
    .replace(/sess-[A-Za-z0-9_*.:-]{6,}/g, 'sess-***')
    .replace(/Bearer\s+[A-Za-z0-9_*.:-]{6,}/gi, 'Bearer ***')
}
