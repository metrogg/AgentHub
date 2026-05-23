import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentRunProfile, MessageRow } from './agent-runner'

type CodeAgentType = NonNullable<AgentRunProfile['codeAgentType']>

interface CodeAgentAdapter {
  command: string
  displayName: string
  envKey: string
  docsHint: string
  promptMode: 'argument' | 'stdin'
  buildArgs: (prompt: string, options?: CodeAgentRunOptions) => string[]
}

interface CodeAgentRunOptions {
  cwd?: string
  modelId?: string | null
  outputPath?: string
  sandboxPolicy?: AgentRunProfile['sandboxPolicy']
}

interface CodeAgentCommandResult {
  code: number
  output: string
  finalMessage?: string
}

const serviceDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(serviceDir, '../../../..')
const lastMessageStart = '__AGENTHUB_LAST_MESSAGE_START__'
const lastMessageEnd = '__AGENTHUB_LAST_MESSAGE_END__'
let rootEnvCache: Record<string, string> | null = null

const adapters: Record<CodeAgentType, CodeAgentAdapter> = {
  codex: {
    command: 'codex',
    displayName: 'Codex CLI',
    envKey: 'OPENAI_API_KEY',
    docsHint: 'Codex 会使用本机安装的 CLI，并在当前项目目录中执行代码任务。',
    promptMode: 'stdin',
    buildArgs: (_prompt, options) => {
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--cd',
        options?.cwd ?? projectRoot,
        '--sandbox',
        toCodexSandbox(options?.sandboxPolicy),
        '-c',
        'approval_policy=never',
        '-c',
        'preferred_auth_method=apikey',
        '-c',
        'model_reasoning_effort=minimal',
      ]
      const model = readEnv('OPENAI_MODEL') || readEnv('LLM_MODEL')
      const baseUrl = readEnv('OPENAI_BASE_URL') || readEnv('LLM_BASE_URL')
      if (model) args.push('--model', model)
      if (baseUrl) {
        args.push(
          '-c',
          'model_provider=agenthub-openai-compatible',
          '-c',
          'model_providers.agenthub-openai-compatible.name=AgentHub',
          '-c',
          `model_providers.agenthub-openai-compatible.base_url=${baseUrl}`,
          '-c',
          'model_providers.agenthub-openai-compatible.env_key=OPENAI_API_KEY',
          '-c',
          `model_providers.agenthub-openai-compatible.wire_api=${codexWireApiForBaseUrl(baseUrl)}`
        )
      }
      if (options?.outputPath) args.push('--output-last-message', options.outputPath)
      args.push('-')
      return args
    },
  },
  'claude-code': {
    command: 'claude',
    displayName: 'Claude Code',
    envKey: 'ANTHROPIC_API_KEY',
    docsHint: 'Claude Code 会使用本机 Anthropic 凭据，并优先读取项目上下文。',
    promptMode: 'argument',
    buildArgs: (prompt) => ['-p', prompt],
  },
  opencode: {
    command: 'opencode',
    displayName: 'OpenCode',
    envKey: 'DEEPSEEK_API_KEY',
    docsHint: 'OpenCode 会使用本机配置；如果 Agent 绑定了 provider/model，会通过 --model 传给 OpenCode。',
    promptMode: 'argument',
    buildArgs: (prompt, options) => ['run', ...(options?.modelId ? ['--model', options.modelId] : []), prompt],
  },
}

export function isCodeAgentProfile(profile?: AgentRunProfile) {
  return profile?.runtimeType === 'code-agent' && Boolean(profile.codeAgentType)
}

export async function* streamCodeAgentReply(
  profile: AgentRunProfile,
  userMsg: MessageRow,
  history: Array<{ senderType: string; content: string }>,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const type = profile.codeAgentType
  if (!type) {
    yield '这个 Agent 配置为 Code Agent，但还没有绑定 CLI。'
    return
  }

  const adapter = adapters[type]
  if (!adapter) {
    yield `不支持的 Code Agent 绑定：${type}。`
    return
  }

  const cwdInfo = resolveExecutionCwd(profile.projectPath)
  const prompt = buildCodeAgentPrompt(profile, userMsg, history, cwdInfo.label)
  const installed = await isCommandInstalled(adapter.command)
  const configured = Boolean(readEnv(adapter.envKey)) || type === 'codex'
  const executionEnabled = readEnv('AGENTHUB_ENABLE_CODE_AGENT_EXECUTION') === 'true'
  const canExecute = executionEnabled && installed && configured && profile.approvalRequired === false && cwdInfo.valid

  yield `正在执行 ${profile.name || adapter.displayName}...\n\n`

  if (!canExecute) {
    yield [
      `**${adapter.displayName} 暂未直接执行**`,
      '',
      `- 运行时：${type}`,
      `- 命令：\`${adapter.command}\``,
      `- 沙箱：${profile.sandboxPolicy ?? 'workspace-write'}`,
      `- 项目目录：${cwdInfo.label}`,
      `- 环境变量：\`${adapter.envKey}\` ${configured ? '已配置或可选' : '未检测到'}`,
      `- 安装状态：${installed ? '已安装' : '未安装'}`,
      `- 执行开关：\`AGENTHUB_ENABLE_CODE_AGENT_EXECUTION=${executionEnabled ? 'true' : 'false'}\``,
      `- 高风险确认：${profile.approvalRequired === false ? '关闭' : '开启'}`,
      '',
      '要让这个 Code Agent 自动运行，请确认本机 CLI 已安装、凭据已配置、执行开关已开启，并在该 Agent 配置中关闭“高风险操作需要确认”。',
      '',
      '命令预览：',
      '```bash',
      previewCommand(adapter, cwdInfo.cwd, profile.sandboxPolicy, profile.modelId),
      '```',
      '',
      cwdInfo.valid ? '' : `项目目录不存在或不是文件夹：${cwdInfo.label}`,
      adapter.docsHint,
    ]
      .filter(Boolean)
      .join('\n')
    return
  }

  const result = await runCodeAgentCommand(adapter, prompt, cwdInfo.cwd, profile.sandboxPolicy, profile.modelId, signal)
  if (result.code === 0 && result.finalMessage?.trim()) {
    yield stripReasoningTags(result.finalMessage).trim()
    return
  }

  if (result.code === 0) {
    yield limitOutput(stripReasoningTags(stripToolNoise(result.output)) || '(Code Agent 没有返回正文)', 16_000)
    return
  }

  yield [
    `**${adapter.displayName} 执行失败**`,
    '',
    friendlyCodeAgentError(result.output),
    '',
    '诊断输出：',
    '```text',
    limitOutput(stripLastMessageBlock(result.output) || '(no output)', 16_000),
    '```',
    '',
    `Code Agent 退出码：${result.code}。`,
  ].join('\n')
}

function buildCodeAgentPrompt(
  profile: AgentRunProfile,
  userMsg: MessageRow,
  history: Array<{ senderType: string; content: string }>,
  workspacePath: string
) {
  const recent = history
    .slice(-8)
    .map((message) => `${message.senderType}: ${message.content}`)
    .join('\n\n')
  return [
    `You are ${profile.name}.`,
    profile.role ? `Role: ${profile.role}.` : '',
    profile.description ? `Capabilities: ${profile.description}.` : '',
    profile.systemPrompt ? `System prompt: ${profile.systemPrompt}` : '',
    `Project workspace path: ${workspacePath}. Treat this as the repository root for code work.`,
    `Sandbox policy: ${profile.sandboxPolicy ?? 'workspace-write'}.`,
    `Allowed tool scopes: ${(profile.toolPermissions ?? ['chat']).join(', ')}.`,
    'Follow the project instructions and keep changes focused.',
    '',
    'Recent group context:',
    recent,
    '',
    'Current user request:',
    userMsg.content,
  ]
    .filter(Boolean)
    .join('\n')
}

async function isCommandInstalled(command: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(command)) return false
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd.exe' : 'sh'
  const args = isWindows
    ? ['/d', '/s', '/c', `where ${command} >nul 2>nul`]
    : ['-lc', `command -v ${quoteForSh(command)} >/dev/null 2>&1`]
  try {
    const proc = Bun.spawn([shell, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const code = await Promise.race([proc.exited, new Promise<number>((resolve) => setTimeout(() => resolve(124), 2000))])
    return code === 0
  } catch {
    return false
  }
}

async function runCodeAgentCommand(
  adapter: CodeAgentAdapter,
  prompt: string,
  cwd?: string,
  sandboxPolicy?: AgentRunProfile['sandboxPolicy'],
  modelId?: string | null,
  signal?: AbortSignal
): Promise<CodeAgentCommandResult> {
  const outputPath = adapter.command === 'codex' ? join(tmpdir(), `agenthub-code-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.md`) : undefined
  const args = adapter.buildArgs(prompt, { cwd, modelId, outputPath, sandboxPolicy })

  if (signal?.aborted) return { code: 130, output: 'Code Agent execution cancelled.' }
  if (outputPath && existsSync(outputPath)) {
    try {
      unlinkSync(outputPath)
    } catch {
      // A stale last-message file should not block execution.
    }
  }

  const proc = Bun.spawn(buildHostCommand(adapter.command, args), {
    cwd,
    env: mergedEnv(),
    stdin: adapter.promptMode === 'stdin' ? 'pipe' : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (adapter.promptMode === 'stdin') {
    try {
      proc.stdin?.write(prompt)
      proc.stdin?.end()
    } catch {
      // The process may have exited before stdin was written.
    }
  }

  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // Process may have exited.
    }
  }, Number(readEnv('AGENTHUB_CODE_AGENT_TIMEOUT_MS') ?? 120_000))
  const abortRun = () => {
    try {
      proc.kill()
    } catch {
      // Process may have exited.
    }
  }
  signal?.addEventListener('abort', abortRun, { once: true })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text().catch(() => ''),
    new Response(proc.stderr).text().catch(() => ''),
  ])
  clearTimeout(timer)
  signal?.removeEventListener('abort', abortRun)
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  const finalMessage = outputPath && existsSync(outputPath) ? readFileSync(outputPath, 'utf8').trim() : undefined
  if (outputPath && existsSync(outputPath)) {
    try {
      unlinkSync(outputPath)
    } catch {
      // Best-effort cleanup.
    }
  }
  return { ...withExtractedLastMessage({ code, output }), finalMessage }
}

function buildHostCommand(command: string, args: string[]) {
  if (process.platform !== 'win32') return [command, ...args]
  return ['cmd.exe', '/d', '/c', [command, ...args.map(windowsShellArg)].join(' ')]
}

function readEnv(key: string) {
  return (rootEnv()[key] ?? Bun.env[key])?.trim()
}

function mergedEnv() {
  return { ...Bun.env, ...rootEnv() }
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

function resolveExecutionCwd(projectPath?: string | null) {
  const fallback = existsSync(projectRoot) ? projectRoot : undefined
  const trimmed = projectPath?.trim()
  if (!trimmed) {
    return {
      cwd: fallback,
      label: fallback ?? '(默认目录)',
      valid: true,
    }
  }

  const absolute = isAbsolute(trimmed) ? trimmed : resolve(projectRoot, trimmed)
  try {
    const stat = statSync(absolute)
    return {
      cwd: stat.isDirectory() ? absolute : fallback,
      label: absolute,
      valid: stat.isDirectory(),
    }
  } catch {
    return {
      cwd: fallback,
      label: absolute,
      valid: false,
    }
  }
}

function previewCommand(adapter: CodeAgentAdapter, cwd?: string, sandboxPolicy?: AgentRunProfile['sandboxPolicy'], modelId?: string | null) {
  return formatCommand(adapter.command, adapter.buildArgs('<task-prompt>', { cwd, modelId, sandboxPolicy }))
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args.map(shellQuote)].join(' ')
}

function shellQuote(value: string) {
  if (/^[a-zA-Z0-9_./:@=\\-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function toCodexSandbox(sandboxPolicy?: AgentRunProfile['sandboxPolicy']) {
  if (sandboxPolicy === 'danger-full-access') return 'danger-full-access'
  if (sandboxPolicy === 'read-only') return 'read-only'
  return 'workspace-write'
}

function codexWireApiForBaseUrl(baseUrl: string) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'responses'
  } catch {
    // Fall through to the broad OpenAI-compatible default.
  }
  return 'chat'
}

function withExtractedLastMessage(result: { code: number; output: string }): CodeAgentCommandResult {
  const finalMessage = extractLastMessage(result.output)
  return {
    ...result,
    output: stripLastMessageBlock(result.output),
    finalMessage,
  }
}

function extractLastMessage(output: string) {
  const pattern = new RegExp(`${lastMessageStart}\\n([\\s\\S]*?)\\n${lastMessageEnd}`)
  return pattern.exec(output)?.[1]?.trim()
}

function stripLastMessageBlock(output: string) {
  const pattern = new RegExp(`\\n?${lastMessageStart}\\n[\\s\\S]*?\\n${lastMessageEnd}\\n?`)
  return output.replace(pattern, '\n').trim()
}

function stripToolNoise(output: string) {
  return stripLastMessageBlock(output)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (trimmed === 'Reading additional input from stdin...') return false
      if (/^OpenAI Codex v/i.test(trimmed)) return false
      if (/^-{4,}$/.test(trimmed)) return false
      if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/.test(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()
}

function stripReasoningTags(output: string) {
  return output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function friendlyCodeAgentError(output: string) {
  if (/401 Unauthorized|Missing bearer|basic authentication/i.test(output)) {
    return 'Codex CLI 已启动，但供应商鉴权失败。请检查本机 API Key、Base URL 和模型是否匹配。'
  }
  if (/model.*not found|does not exist|404|unknown model/i.test(output)) {
    return 'Codex CLI 已启动，但当前模型或 Base URL 不可用。请检查模型名称和供应商地址。'
  }
  if (/No such file or directory|cannot find the path|系统找不到指定的路径/i.test(output)) {
    return 'Code Agent 已启动，但项目目录不存在。请重新打开或选择正确的工作区文件夹。'
  }
  return 'Code Agent 已启动，但 CLI 执行过程返回了错误。'
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

function limitOutput(output: string, max: number) {
  if (output.length <= max) return output
  return `${output.slice(0, max)}\n... output truncated ...`
}
