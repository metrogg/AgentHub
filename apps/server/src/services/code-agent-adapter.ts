import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentRunProfile, MessageRow } from './agent-runner'

type CodeAgentType = NonNullable<AgentRunProfile['codeAgentType']>

interface CodeAgentAdapter {
  command: string
  displayName: string
  envKey: string
  docsHint: string
  buildArgs: (prompt: string) => string[]
}

const serviceDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(serviceDir, '../../../..')

const adapters: Record<CodeAgentType, CodeAgentAdapter> = {
  codex: {
    command: 'codex',
    displayName: 'Codex CLI',
    envKey: 'OPENAI_API_KEY',
    docsHint: 'Codex 通常使用 OpenAI 兼容凭据，并结合项目沙箱执行代码任务。',
    buildArgs: (prompt) => ['exec', prompt],
  },
  'claude-code': {
    command: 'claude',
    displayName: 'Claude Code',
    envKey: 'ANTHROPIC_API_KEY',
    docsHint: 'Claude Code 通常使用 Anthropic Messages 凭据，并优先读取项目上下文。',
    buildArgs: (prompt) => ['-p', prompt],
  },
  opencode: {
    command: 'opencode',
    displayName: 'OpenCode',
    envKey: 'DEEPSEEK_API_KEY',
    docsHint: 'OpenCode 通常使用 OpenAI-compatible 供应商配置，需要重点检查 Base URL 与模型名。',
    buildArgs: (prompt) => ['run', prompt],
  },
}

export function isCodeAgentProfile(profile?: AgentRunProfile) {
  return profile?.runtimeType === 'code-agent' && Boolean(profile.codeAgentType)
}

export async function* streamCodeAgentReply(
  profile: AgentRunProfile,
  userMsg: MessageRow,
  history: Array<{ senderType: string; content: string }>
): AsyncGenerator<string, void, unknown> {
  const type = profile.codeAgentType
  if (!type) {
    yield 'This Agent is configured as a Code Agent, but no CLI binding was selected.'
    return
  }

  const adapter = adapters[type]
  if (!adapter) {
    yield `Unsupported Code Agent binding: ${type}.`
    return
  }

  const prompt = buildCodeAgentPrompt(profile, userMsg, history)
  const cwdInfo = resolveExecutionCwd(profile.projectPath)
  const installed = await isCommandInstalled(adapter.command)
  const configured = Boolean(readEnv(adapter.envKey)) || type === 'codex'
  const executionEnabled = Bun.env.AGENTHUB_ENABLE_CODE_AGENT_EXECUTION === 'true'
  const canExecute = executionEnabled && installed && configured && profile.approvalRequired === false && cwdInfo.valid

  yield [
    `**${adapter.displayName} 交接**`,
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
  ].join('\n')

  if (!canExecute) {
    yield [
      '当前没有直接执行 CLI。要让这个 Code Agent 自动运行，需要确认 CLI 已安装、凭据已配置、设置 `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION=true`，并在该 Agent 配置中关闭“高风险操作需要确认”。',
      '',
      '命令预览：',
      '```bash',
      previewCommand(adapter),
      '```',
      '',
      cwdInfo.valid ? '' : `项目目录不存在或不是文件夹：${cwdInfo.label}`,
      adapter.docsHint,
    ].filter(Boolean).join('\n')
    return
  }

  yield '\n正在执行 Code Agent...\n\n'
  const result = await runCodeAgentCommand(adapter, prompt, cwdInfo.cwd)
  yield [
    '```text',
    limitOutput(result.output || '(no output)', 16_000),
    '```',
    '',
    result.code === 0 ? 'Code Agent 执行完成。' : `Code Agent 退出码：${result.code}。`,
  ].join('\n')
}

function buildCodeAgentPrompt(
  profile: AgentRunProfile,
  userMsg: MessageRow,
  history: Array<{ senderType: string; content: string }>
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
    profile.projectPath ? `Project workspace path: ${profile.projectPath}. Treat this as the repository root for code work.` : '',
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
    : ['-lc', `command -v ${command} >/dev/null 2>&1`]
  try {
    const proc = Bun.spawn([shell, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const code = await Promise.race([proc.exited, new Promise<number>((resolve) => setTimeout(() => resolve(124), 2000))])
    return code === 0
  } catch {
    return false
  }
}

async function runCodeAgentCommand(adapter: CodeAgentAdapter, prompt: string, cwd?: string) {
  const args = adapter.buildArgs(prompt)
  const proc = Bun.spawn([adapter.command, ...args], {
    cwd,
    env: { ...Bun.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // Process may have exited.
    }
  }, Number(Bun.env.AGENTHUB_CODE_AGENT_TIMEOUT_MS ?? 120_000))
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text().catch(() => ''),
    new Response(proc.stderr).text().catch(() => ''),
  ])
  clearTimeout(timer)
  return { code, output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') }
}

function readEnv(key: string) {
  return Bun.env[key]?.trim()
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

function formatCommand(command: string, args: string[]) {
  return [command, ...args.map(shellQuote)].join(' ')
}

function previewCommand(adapter: CodeAgentAdapter) {
  return formatCommand(adapter.command, adapter.buildArgs('<task-prompt>'))
}

function shellQuote(value: string) {
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function limitOutput(output: string, max: number) {
  if (output.length <= max) return output
  return `${output.slice(0, max)}\n... output truncated ...`
}
