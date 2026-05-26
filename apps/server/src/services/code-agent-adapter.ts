import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentArtifact } from '@agenthub/shared'
import { db, settings } from '@agenthub/db'
import { eq } from 'drizzle-orm'
import type { AgentRunProfile, MessageRow } from './agent-runner'
import { globalSkillRegistry } from './skill-registry'
import { resolveLlmRuntimeConfig } from './llm-client'

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
  toolConfig?: Record<string, unknown>
}

interface CodeAgentCommandResult {
  code: number
  output: string
  finalMessage?: string
  metadata: CodeAgentRunMetadata
}

export interface CodeAgentRunMetadata {
  type: 'code-agent-run'
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out'
  runtime: CodeAgentType
  command: string
  cwd?: string
  durationMs: number
  exitCode: number
  commands: Array<{ id: string; command: string; cwd?: string; output?: string }>
  files: Array<{ path: string; status: 'created' | 'modified' | 'deleted' | 'renamed' | 'untracked'; diff?: string }>
  toolCalls?: Array<{ id: string; name: string; label: string; target?: string; detail?: string }>
  artifacts?: AgentArtifact[]
  logs?: Array<{ id: string; stream: 'stdout' | 'stderr' | 'event'; text: string }>
  diagnostics?: string
}

export interface CodeAgentMetadataChunk {
  kind: 'code-agent-metadata'
  metadata: CodeAgentRunMetadata
}

export type CodeAgentReplyChunk = string | CodeAgentMetadataChunk

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
    buildArgs: (prompt, options) => {
      const cfg = options?.toolConfig ?? {}
      const args: string[] = [
        'exec',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--cd',
        options?.cwd ?? projectRoot,
        '--sandbox',
        String(cfg['sandbox'] ?? toCodexSandbox(options?.sandboxPolicy)),
        '--ask-for-approval',
        String(cfg['approvalPolicy'] ?? 'never'),
      ]
      if (cfg['profile']) {
        args.push('--profile', String(cfg['profile']))
      }
      if (cfg['searchEnabled']) {
        args.push('--search')
      }
      if (cfg['jsonOutput']) {
        args.push('--json')
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
    promptMode: 'stdin',
    buildArgs: (prompt, options) => {
      const cfg = options?.toolConfig ?? {}
      const args: string[] = [
        '-p',
        '--no-session-persistence',
        '--permission-mode',
        String(cfg['permissionMode'] ?? 'bypassPermissions'),
        '--output-format',
        String(cfg['outputFormat'] ?? 'stream-json'),
        '--include-partial-messages',
        '--verbose',
      ]
      if (cfg['maxTurns']) {
        args.push('--max-turns', String(cfg['maxTurns']))
      }
      return args
    },
  },
  opencode: {
    command: 'opencode',
    displayName: 'OpenCode',
    envKey: 'DEEPSEEK_API_KEY',
    docsHint: 'OpenCode 会使用本机配置；如果 Agent 绑定了 provider/model，会通过 --model 传给 OpenCode。',
    promptMode: 'argument',
    buildArgs: (prompt, options) => {
      const cfg = options?.toolConfig ?? {}
      const args = ['run']
      if (options?.modelId) args.push('--model', options.modelId)
      if (cfg['agent']) args.push('--agent', String(cfg['agent']))
      args.push(prompt)
      return args
    },
  },
  gemini: {
    command: 'gemini',
    displayName: 'Gemini CLI',
    envKey: 'GEMINI_API_KEY',
    docsHint: 'Gemini CLI 会使用本机 Google Gemini 凭据，并在当前项目目录中执行代码任务。',
    promptMode: 'argument',
    buildArgs: (prompt, options) => {
      const args: string[] = []
      if (options?.modelId) args.push('--model', options.modelId)
      args.push('-p', prompt)
      return args
    },
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
): AsyncGenerator<CodeAgentReplyChunk, void, unknown> {
  const type = profile.codeAgentType
  if (!type) {
    yield '这个 Agent 配置为 Coding Tools，但还没有绑定 CLI。'
    return
  }

  const adapter = adapters[type]
  if (!adapter) {
    yield `不支持的 Coding Tools 绑定：${type}。`
    return
  }

  const cwdInfo = resolveExecutionCwd(profile.projectPath)
  const skillContext = await globalSkillRegistry.buildSkillContext(
    [profile.systemPrompt, profile.description, userMsg.content].filter(Boolean).join('\n\n'),
    { capabilityTags: profile.capabilityTags, limit: 3 }
  )
  const prompt = buildCodeAgentPrompt(profile, userMsg, history, cwdInfo.label, skillContext)
  const installed = await isCommandInstalled(adapter.command)
  const configured = isRuntimeConfigured(type, adapter)
  const executionEnabled = readEnv('AGENTHUB_ENABLE_CODE_AGENT_EXECUTION') !== 'false'
  const canExecute = executionEnabled && installed && configured && cwdInfo.valid

  if (!canExecute) {
    yield [
      `[错误：${adapter.displayName} 无法执行]`,
      '',
      `**${adapter.displayName} 暂未直接执行**`,
      '',
      `- 运行时：${type}`,
      `- 命令：\`${adapter.command}\``,
      `- 沙箱：${profile.sandboxPolicy ?? 'workspace-write'}`,
      `- 项目目录：${cwdInfo.label}`,
      `- 环境变量：\`${adapter.envKey}\` ${configured ? '已配置或可选' : '未检测到'}`,
      `- 安装状态：${installed ? '已安装' : '未安装'}`,
      `- 执行开关：${executionEnabled ? '已启用' : '已禁用'}\``,
      `- 高风险确认：${profile.approvalRequired === false ? '关闭' : '开启'}`,
      '',
      codeAgentBlockerText({ configured, cwdValid: cwdInfo.valid, executionEnabled, installed, profile }),
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

  const queue: CodeAgentReplyChunk[] = []
  let wake: (() => void) | null = null
  let settled = false
  let streamedText = false
  let result: CodeAgentCommandResult | null = null
  const push = (chunk: CodeAgentReplyChunk) => {
    if (typeof chunk === 'string') streamedText = true
    queue.push(chunk)
    wake?.()
    wake = null
  }
  const toolConfig = await resolveToolConfig(type)
  const runPromise = runCodeAgentCommand(
    adapter,
    prompt,
    cwdInfo.cwd,
    profile.sandboxPolicy,
    profile.modelId,
    signal,
    toolConfig,
    {
      onMetadata: (metadata) => push({ kind: 'code-agent-metadata', metadata }),
      onText: (text) => push(text),
    }
  )
    .then((value) => {
      result = value
    })
    .finally(() => {
      settled = true
      wake?.()
      wake = null
    })

  while (!settled || queue.length) {
    const next = queue.shift()
    if (next) {
      yield next
      continue
    }
    await new Promise<void>((resolve) => {
      wake = resolve
    })
  }
  await runPromise
  const finalResult = result as CodeAgentCommandResult | null
  if (!finalResult) return

  yield { kind: 'code-agent-metadata', metadata: finalResult.metadata }

  const finalMessage = stripReasoningTags(finalResult.finalMessage?.trim() || '')
  if (finalResult.code === 0 && finalMessage && !streamedText) {
    yield finalMessage
    return
  }

  const cleanedOutput = stripReasoningTags(stripToolNoise(finalResult.output))
  if (finalResult.code === 0 && !streamedText) {
    yield limitOutput(cleanedOutput || '(Coding Tools 没有返回正文)', 16_000)
    return
  }
  if (finalResult.code === 0) return

  yield formatCodeAgentFailure(adapter, finalResult)
}

function isRuntimeConfigured(type: CodeAgentType, adapter: CodeAgentAdapter) {
  if (readEnv(adapter.envKey)) return true
  return type === 'codex' || type === 'opencode' || type === 'claude-code' || type === 'gemini'
}

function codeAgentBlockerText(options: {
  configured: boolean
  cwdValid: boolean
  executionEnabled: boolean
  installed: boolean
  profile: AgentRunProfile
}) {
  const blockers = [
    !options.installed ? '本机 CLI 未安装或不在 PATH' : '',
    !options.configured ? '凭据未配置' : '',
    !options.executionEnabled ? '执行开关未开启' : '',
    options.profile.approvalRequired === false ? '' : '该 Agent 仍开启了“高风险操作需要确认”',
    !options.cwdValid ? '项目目录不存在或不可访问' : '',
  ].filter(Boolean)
  if (!blockers.length) return '当前配置已满足自动执行条件。'
  return `当前阻塞项：${blockers.join('、')}。`
}

function buildCodeAgentPrompt(
  profile: AgentRunProfile,
  userMsg: MessageRow,
  history: Array<{ senderType: string; content: string }>,
  workspacePath: string,
  skillContext = ''
) {
  const recent = history
    .slice(-12)
    .map((message) => ({ senderType: message.senderType, content: sanitizeHistoryContent(message.content) }))
    .filter((message) => message.content)
    .slice(-6)
    .map((message) => `${senderTypeLabel(message.senderType)}：${message.content}`)
    .join('\n\n')

  return [
    `你是 ${profile.name}。`,
    profile.role ? `角色：${profile.role}。` : '',
    profile.description ? `能力：${profile.description}。` : '',
    profile.systemPrompt ? `系统提示：${profile.systemPrompt}` : '',
    `项目工作区路径：${workspacePath}。请把它当作代码工作的仓库根目录。`,
    `沙箱策略：${profile.sandboxPolicy ?? 'workspace-write'}。`,
    `允许的工具范围：${(profile.toolPermissions ?? ['chat']).join('、')}。`,
    '请遵循项目内已有约定，保持改动聚焦。',
    '请使用上面的真实项目路径，不要编造 /agent-workspace 之类的容器路径。',
    '所有面向用户的计划、状态、总结和错误说明都请使用中文。',
    skillContext,
    '',
    recent ? '最近群聊上下文：' : '',
    recent,
    '',
    '当前用户请求：',
    userMsg.content,
  ]
    .filter(Boolean)
    .join('\n')
}

function senderTypeLabel(senderType: string) {
  if (senderType === 'user') return '用户'
  if (senderType === 'agent') return 'Agent'
  if (senderType === 'system') return '系统'
  return senderType
}

function sanitizeHistoryContent(content: string) {
  const trimmed = content.trim()
  if (!trimmed) return ''
  if (/^\s*正在执行\b/.test(trimmed)) return ''
  if (/\[Stopped by user\]/i.test(trimmed)) return ''
  if (/Coding Tools (执行失败|退出码|已启动)/.test(trimmed)) return ''
  if (
    /OpenAI Codex v\d|stream error|unexpected status|tool_call_id|mcp_connection_manager|new_stdio_client|Warning: no last agent message|\/agent-workspace/i.test(
      trimmed
    )
  ) {
    return ''
  }
  if (/诊断输出：|Error loading config\.toml|No such file or directory/i.test(trimmed)) return ''
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}\n...` : trimmed
}

async function isCommandInstalled(command: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(command)) return false
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd.exe' : 'sh'
  const args = isWindows
    ? ['/d', '/s', '/c', `where ${command} >nul 2>nul`]
    : ['-lc', `command -v ${quoteForSh(command)} >/dev/null 2>&1`]
  try {
    const proc = Bun.spawn([shell, ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env })
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
  signal?: AbortSignal,
  toolConfig?: Record<string, unknown>,
  hooks: {
    onMetadata?: (metadata: CodeAgentRunMetadata) => void
    onText?: (text: string) => void
  } = {}
): Promise<CodeAgentCommandResult> {
  const outputPath = adapter.command === 'codex' ? join(tmpdir(), `agenthub-code-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.md`) : undefined
  const commandPrompt =
    process.platform === 'win32' && (adapter.command === 'codex' || adapter.command === 'claude')
      ? buildAsciiSafePrompt(prompt)
      : prompt
  const args = adapter.buildArgs(commandPrompt, { cwd, modelId, outputPath, sandboxPolicy, toolConfig })

  if (signal?.aborted) {
    return {
      code: 130,
      output: 'Coding Tools 执行已取消。',
      metadata: emptyCodeAgentRunMetadata(adapter, 'cancelled'),
    }
  }
  const startedAt = Date.now()
  const beforeFiles = await snapshotWorkspaceFiles(cwd)
  const liveCommands: CodeAgentRunMetadata['commands'] = []
  const liveFiles: CodeAgentRunMetadata['files'] = []
  const liveToolCalls: NonNullable<CodeAgentRunMetadata['toolCalls']> = []
  const liveLogs: NonNullable<CodeAgentRunMetadata['logs']> = []
  const seenCommands = new Set<string>()
  const seenFiles = new Set<string>()
  const seenToolCalls = new Set<string>()
  let lastMetadataAt = 0
  let claudeStdoutBuffer = ''
  let claudeFinalMessage = ''
  const emitLiveMetadata = (force = false) => {
    const now = Date.now()
    if (!force && now - lastMetadataAt < 250) return
    lastMetadataAt = now
    hooks.onMetadata?.({
      type: 'code-agent-run',
      status: 'running',
      runtime: runtimeTypeForAdapter(adapter),
      command: adapter.command,
      durationMs: now - startedAt,
      exitCode: 0,
      commands: liveCommands.slice(0, 80),
      files: liveFiles.slice(0, 80),
      toolCalls: liveToolCalls.slice(0, 120),
      artifacts: buildArtifactsFromMetadata({
        cwd,
        files: liveFiles.slice(0, 80),
        output: liveLogs.map((log) => log.text).join('\n'),
      }),
      logs: liveLogs.slice(-80),
    })
  }
  const addLog = (stream: 'stdout' | 'stderr' | 'event', text: string) => {
    const cleaned = cleanRuntimeLog(text)
    if (!cleaned) return
    liveLogs.push({ id: `log-${liveLogs.length + 1}`, stream, text: limitOutput(cleaned, 1000) })
    emitLiveMetadata()
  }
  const addCommand = (command: string, commandCwd?: string) => {
    const cleaned = cleanCommandText(command)
    const key = `${cleaned}\n${commandCwd ?? ''}`
    if (!cleaned || seenCommands.has(key)) return
    seenCommands.add(key)
    liveCommands.push({
      id: `cmd-${liveCommands.length + 1}`,
      command: limitOutput(cleaned, 500),
      cwd: commandCwd ? limitOutput(commandCwd, 260) : undefined,
    })
    addLog('event', `运行命令：${cleaned}`)
  }
  const addFile = (path: string, status: CodeAgentRunMetadata['files'][number]['status']) => {
    const cleaned = path.trim()
    if (!cleaned) return
    const key = `${status}\n${cleaned}`
    if (seenFiles.has(key)) return
    seenFiles.add(key)
    liveFiles.push({ path: limitOutput(cleaned, 500), status })
    addLog('event', `${fileStatusLabelForLog(status)}：${cleaned}`)
  }
  const addToolCall = (name: string, input?: Record<string, unknown>) => {
    const summary = summarizeToolCall(name, input)
    if (!summary) return
    const key = `${summary.name}\n${summary.target ?? ''}\n${summary.detail ?? ''}`
    if (seenToolCalls.has(key)) return
    seenToolCalls.add(key)
    liveToolCalls.push({
      id: `tool-${liveToolCalls.length + 1}`,
      name: summary.name,
      label: summary.label,
      target: summary.target ? limitOutput(summary.target, 500) : undefined,
      detail: summary.detail ? limitOutput(summary.detail, 500) : undefined,
    })
    emitLiveMetadata()
  }

  if (outputPath && existsSync(outputPath)) {
    try {
      unlinkSync(outputPath)
    } catch {
      // A stale last-message file should not block execution.
    }
  }

  const proc = Bun.spawn(buildHostCommand(adapter.command, args), {
    cwd,
    env: await mergedEnv(adapter),
    stdin: adapter.promptMode === 'stdin' ? 'pipe' : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (adapter.promptMode === 'stdin') {
    try {
      proc.stdin?.write(commandPrompt)
      proc.stdin?.end()
    } catch {
      // The process may have exited before stdin was written.
    }
  }

  let timedOut = false
  const stopRun = () => killProcessTree(proc)
  const timer = setTimeout(() => {
    timedOut = true
    stopRun()
  }, Number(readEnv('AGENTHUB_CODE_AGENT_TIMEOUT_MS') ?? 120_000))
  const abortRun = () => {
    stopRun()
  }
  signal?.addEventListener('abort', abortRun, { once: true })
  let stdout = ''
  let stderr = ''
  const [code] = await Promise.all([
    proc.exited,
    readProcessStream(proc.stdout, (chunk) => {
      stdout += chunk
      if (adapter.command === 'claude') {
        claudeStdoutBuffer = consumeClaudeStreamJson(chunk, claudeStdoutBuffer, {
          addFile,
          addCommand,
          addToolCall,
          addLog,
          onText: (text) => {
            claudeFinalMessage += text
            hooks.onText?.(text)
          },
        })
      } else {
        addLog('stdout', chunk)
        for (const command of parseExecutedCommands(stdout)) addCommand(command.command, command.cwd)
      }
    }),
    readProcessStream(proc.stderr, (chunk) => {
      stderr += chunk
      addLog('stderr', chunk)
    }),
  ])
  clearTimeout(timer)
  signal?.removeEventListener('abort', abortRun)
  const output = [
    stdout.trim(),
    stderr.trim(),
    timedOut ? `Coding Tools 超过 ${readEnv('AGENTHUB_CODE_AGENT_TIMEOUT_MS') ?? 120_000}ms 未返回，已自动停止。` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const outputFileMessage = outputPath && existsSync(outputPath) ? readFileSync(outputPath, 'utf8').trim() : undefined
  if (outputPath && existsSync(outputPath)) {
    try {
      unlinkSync(outputPath)
    } catch {
      // Best-effort cleanup.
    }
  }
  const parsed = withExtractedLastMessage({ code, output })
  const finalMessage =
    outputFileMessage || claudeFinalMessage.trim() || parsed.finalMessage || extractCodexAssistantMessage(parsed.output)
  const effectiveCode = code === 0 && !finalMessage && isCodeAgentFailureOutput(output) ? 1 : code
  const metadata = await buildCodeAgentRunMetadata({
    adapter,
    code: effectiveCode,
    durationMs: Date.now() - startedAt,
    output: parsed.output,
    timedOut,
    beforeFiles,
    cwd,
    liveCommands,
    liveFiles,
    liveToolCalls,
    liveLogs,
  })
  return { ...parsed, code: effectiveCode, finalMessage, metadata }
}

function buildAsciiSafePrompt(prompt: string) {
  return [
    '下面的任务载荷是 ASCII-only JSON 字符串。由于 Windows 命令行可能损坏非 ASCII 参数，这里使用 JSON Unicode 转义。',
    '请先解码 JSON_STRING，然后把解码后的文本作为完整任务说明和对话上下文执行。',
    '不要向用户解释这个编码包装。',
    '',
    'JSON_STRING:',
    jsonStringifyAscii(prompt),
  ].join('\n')
}

function jsonStringifyAscii(value: string) {
  return JSON.stringify(value).replace(/[^\x00-\x7F]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function killProcessTree(proc: ReturnType<typeof Bun.spawn>) {
  try {
    if (process.platform === 'win32' && proc.pid) {
      Bun.spawn(['taskkill', '/pid', String(proc.pid), '/t', '/f'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      return
    }
    proc.kill()
  } catch {
    try {
      proc.kill()
    } catch {
      // Process may have exited.
    }
  }
}

async function buildCodeAgentRunMetadata(input: {
  adapter: CodeAgentAdapter
  beforeFiles: Map<string, string>
  code: number
  cwd?: string
  durationMs: number
  liveCommands?: CodeAgentRunMetadata['commands']
  liveFiles?: CodeAgentRunMetadata['files']
  liveToolCalls?: NonNullable<CodeAgentRunMetadata['toolCalls']>
  liveLogs?: NonNullable<CodeAgentRunMetadata['logs']>
  output: string
  timedOut: boolean
}): Promise<CodeAgentRunMetadata> {
  const diagnostics = input.code === 0 && !input.timedOut ? '' : cleanDiagnosticOutput(input.output)
  const parsedCommands = parseExecutedCommands(input.output)
  const commands = mergeCommands([...(input.liveCommands ?? []), ...parsedCommands])
  const files = await enrichFileDiffs(input.cwd, mergeFiles([...(input.liveFiles ?? []), ...(await diffWorkspaceFiles(input.cwd, input.beforeFiles))]))
  const artifacts = buildArtifactsFromMetadata({ cwd: input.cwd, files, output: input.output })
  return {
    type: 'code-agent-run',
    status: input.timedOut ? 'timed-out' : input.code === 0 ? 'completed' : input.code === 130 ? 'cancelled' : 'failed',
    runtime: runtimeTypeForAdapter(input.adapter),
    command: input.adapter.command,
    cwd: input.cwd,
    durationMs: input.durationMs,
    exitCode: input.code,
    commands,
    files,
    toolCalls: input.liveToolCalls?.slice(0, 120),
    artifacts,
    logs: input.liveLogs?.slice(-80),
    diagnostics: diagnostics || undefined,
  }
}

function emptyCodeAgentRunMetadata(adapter: CodeAgentAdapter, status: CodeAgentRunMetadata['status']): CodeAgentRunMetadata {
  return {
    type: 'code-agent-run',
    status,
    runtime: runtimeTypeForAdapter(adapter),
    command: adapter.command,
    durationMs: 0,
    exitCode: status === 'completed' || status === 'running' ? 0 : 130,
    commands: [],
    files: [],
    toolCalls: [],
    artifacts: [],
  }
}

function runtimeTypeForAdapter(adapter: CodeAgentAdapter): CodeAgentType {
  const entry = Object.entries(adapters).find(([, item]) => item === adapter)
  return (entry?.[0] as CodeAgentType | undefined) ?? 'codex'
}

async function readProcessStream(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      onChunk(decoder.decode(value, { stream: true }))
    }
    const tail = decoder.decode()
    if (tail) onChunk(tail)
  } catch {
    // The process may have been killed while streams were still open.
  }
}

function consumeClaudeStreamJson(
  chunk: string,
  previousBuffer: string,
  handlers: {
    addFile: (path: string, status: CodeAgentRunMetadata['files'][number]['status']) => void
    addCommand: (command: string, cwd?: string) => void
    addToolCall: (name: string, input?: Record<string, unknown>) => void
    addLog: (stream: 'stdout' | 'stderr' | 'event', text: string) => void
    onText: (text: string) => void
  }
) {
  const combined = previousBuffer + chunk
  const lines = combined.split(/\r?\n/)
  const nextBuffer = lines.pop() ?? ''
  for (const line of lines) parseClaudeJsonLine(line, handlers)
  return nextBuffer
}

function parseClaudeJsonLine(
  line: string,
  handlers: {
    addFile: (path: string, status: CodeAgentRunMetadata['files'][number]['status']) => void
    addCommand: (command: string, cwd?: string) => void
    addToolCall: (name: string, input?: Record<string, unknown>) => void
    addLog: (stream: 'stdout' | 'stderr' | 'event', text: string) => void
    onText: (text: string) => void
  }
) {
  const trimmed = line.trim()
  if (!trimmed) return
  let payload: any
  try {
    payload = JSON.parse(trimmed)
  } catch {
    handlers.addLog('stdout', trimmed)
    return
  }

  if (payload.type === 'system' && payload.subtype === 'init') {
    handlers.addLog('event', `Claude Code 初始化：${payload.cwd || 'workspace'}`)
    return
  }

  if (payload.type === 'stream_event') {
    const event = payload.event
    const block = event?.content_block
    const delta = event?.delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') handlers.onText(delta.text)
    if (block?.type === 'tool_use') recordClaudeToolUse(block, handlers)
    return
  }

  if (payload.type === 'assistant') {
    for (const block of payload.message?.content ?? []) {
      if (block?.type === 'tool_use') recordClaudeToolUse(block, handlers)
    }
    return
  }

  if (payload.type === 'result' && payload.subtype) {
    handlers.addLog(payload.is_error ? 'stderr' : 'event', payload.is_error ? payload.result || 'Claude Code 执行失败' : 'Claude Code 执行完成')
  }
}

function recordClaudeToolUse(
  block: any,
  handlers: {
    addFile: (path: string, status: CodeAgentRunMetadata['files'][number]['status']) => void
    addCommand: (command: string, cwd?: string) => void
    addToolCall: (name: string, input?: Record<string, unknown>) => void
    addLog: (stream: 'stdout' | 'stderr' | 'event', text: string) => void
  }
) {
  const name = String(block.name ?? '')
  const input: Record<string, unknown> = block.input && typeof block.input === 'object' ? block.input : {}
  if (name) handlers.addToolCall(name, input)
  if (name === 'Bash' && typeof input.command === 'string') {
    handlers.addCommand(input.command)
    return
  }
  if ((name === 'Edit' || name === 'MultiEdit') && typeof input.file_path === 'string') {
    handlers.addFile(input.file_path, 'modified')
    return
  }
  if (name === 'Write' && typeof input.file_path === 'string') {
    handlers.addFile(input.file_path, 'created')
    return
  }
  if (name === 'Read' && typeof input.file_path === 'string') {
    handlers.addLog('event', `${name}：${input.file_path}`)
    return
  }
  if (name) handlers.addLog('event', `工具调用：${name}`)
}

function summarizeToolCall(name: string, input?: Record<string, unknown>) {
  const cleanName = name.trim()
  if (!cleanName) return null
  const readString = (key: string) => {
    const value = input?.[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const readNumber = (key: string) => {
    const value = input?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const joinDetails = (...items: Array<string | undefined>) => items.filter(Boolean).join(' · ') || undefined
  const filePath = readString('file_path') ?? readString('notebook_path')
  const path = readString('path')
  const pattern = readString('pattern')
  const command = readString('command')

  if (cleanName === 'Bash') {
    return { name: cleanName, label: '运行命令', target: command, detail: readString('description') }
  }
  if (cleanName === 'Read') {
    const range = joinDetails(
      readNumber('offset') !== undefined ? `从第 ${readNumber('offset')} 行` : undefined,
      readNumber('limit') !== undefined ? `最多 ${readNumber('limit')} 行` : undefined
    )
    return { name: cleanName, label: '读取文件', target: filePath, detail: range }
  }
  if (cleanName === 'Write') {
    return { name: cleanName, label: '写入文件', target: filePath }
  }
  if (cleanName === 'Edit' || cleanName === 'MultiEdit' || cleanName === 'NotebookEdit') {
    return { name: cleanName, label: '编辑文件', target: filePath }
  }
  if (cleanName === 'Grep') {
    return { name: cleanName, label: '搜索内容', target: pattern, detail: joinDetails(path, readString('glob'), readString('output_mode')) }
  }
  if (cleanName === 'Glob') {
    return { name: cleanName, label: '匹配文件', target: pattern, detail: path }
  }
  if (cleanName === 'LS') {
    return { name: cleanName, label: '列出目录', target: path }
  }
  if (cleanName === 'WebFetch') {
    return { name: cleanName, label: '读取网页', target: readString('url'), detail: readString('prompt') }
  }
  if (cleanName === 'WebSearch') {
    return { name: cleanName, label: '网页搜索', target: readString('query') }
  }
  if (cleanName === 'Task' || cleanName === 'Agent') {
    return { name: cleanName, label: '调用子任务', target: readString('description') ?? readString('prompt') }
  }
  if (cleanName === 'TodoWrite') {
    const todos = Array.isArray(input?.todos) ? input.todos.length : undefined
    return { name: cleanName, label: '更新待办', detail: todos ? `${todos} 项` : undefined }
  }
  return { name: cleanName, label: '工具调用', target: filePath ?? path ?? pattern ?? command ?? readString('query') ?? readString('url') }
}

function parseExecutedCommands(output: string): CodeAgentRunMetadata['commands'] {
  const commands: CodeAgentRunMetadata['commands'] = []
  const seen = new Set<string>()
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^\[?[^\]]*\]?\s*exec\s+(.+?)(?:\s+in\s+(.+))?$/i)
    if (!match) continue
    const command = cleanCommandText(match[1] ?? '')
    const cwd = match[2]?.trim()
    const key = `${command}\n${cwd ?? ''}`
    if (!command || seen.has(key)) continue
    seen.add(key)
    commands.push({
      id: `cmd-${commands.length + 1}`,
      command: limitOutput(command, 500),
      cwd: cwd ? limitOutput(cwd, 260) : undefined,
    })
  }
  return commands.slice(0, 60)
}

function mergeCommands(commands: CodeAgentRunMetadata['commands']) {
  const seen = new Set<string>()
  const merged: CodeAgentRunMetadata['commands'] = []
  for (const command of commands) {
    const key = `${command.command}\n${command.cwd ?? ''}`
    if (!command.command || seen.has(key)) continue
    seen.add(key)
    merged.push({ ...command, id: `cmd-${merged.length + 1}` })
  }
  return merged.slice(0, 80)
}

function mergeFiles(files: CodeAgentRunMetadata['files']) {
  const rank: Record<CodeAgentRunMetadata['files'][number]['status'], number> = {
    deleted: 5,
    modified: 4,
    created: 3,
    renamed: 2,
    untracked: 1,
  }
  const byPath = new Map<string, CodeAgentRunMetadata['files'][number]>()
  for (const file of files) {
    if (!file.path) continue
    const previous = byPath.get(file.path)
    if (!previous || rank[file.status] >= rank[previous.status]) byPath.set(file.path, file)
  }
  return Array.from(byPath.values()).slice(0, 80)
}

function fileStatusLabelForLog(status: CodeAgentRunMetadata['files'][number]['status']) {
  if (status === 'created') return '创建文件'
  if (status === 'modified') return '修改文件'
  if (status === 'deleted') return '删除文件'
  if (status === 'renamed') return '重命名文件'
  return '发现文件'
}

function cleanRuntimeLog(value: string) {
  return value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/codex_core::mcp_connection_manager|McpServerConfig|InitializeRequestParams/i.test(line))
    .join('\n')
}

function cleanCommandText(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

async function snapshotWorkspaceFiles(cwd?: string): Promise<Map<string, string>> {
  if (!cwd) return new Map()
  try {
    const proc = Bun.spawn(['git', 'status', '--short', '--untracked-files=all'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.env,
    })
    const [code, stdout] = await Promise.all([
      Promise.race([proc.exited, new Promise<number>((resolve) => setTimeout(() => resolve(124), 3000))]),
      new Response(proc.stdout).text().catch(() => ''),
    ])
    if (code !== 0) return new Map()
    return parseGitStatus(stdout)
  } catch {
    return new Map()
  }
}

function parseGitStatus(output: string) {
  const snapshot = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    const rawPath = line.slice(3).trim()
    if (!rawPath) continue
    const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop()?.trim() || rawPath : rawPath
    snapshot.set(path, status)
  }
  return snapshot
}

async function diffWorkspaceFiles(cwd: string | undefined, before: Map<string, string>): Promise<CodeAgentRunMetadata['files']> {
  const after = await snapshotWorkspaceFiles(cwd)
  const files: CodeAgentRunMetadata['files'] = []
  for (const [path, status] of after) {
    if (before.get(path) === status) continue
    const fileStatus = fileStatusFromGitStatus(status)
    files.push({ path, status: fileStatus, diff: await readGitDiffForFile(cwd, path, fileStatus) })
  }
  return files.slice(0, 80)
}

async function readGitDiffForFile(
  cwd: string | undefined,
  path: string,
  status: CodeAgentRunMetadata['files'][number]['status']
) {
  if (!cwd) return undefined
  const diff = await runGitDiff(cwd, ['diff', '--', path])
  if (diff.trim()) return limitOutput(diff, 24_000)

  const staged = await runGitDiff(cwd, ['diff', '--cached', '--', path])
  if (staged.trim()) return limitOutput(staged, 24_000)

  if (status === 'created' || status === 'untracked') {
    return buildNewFileDiff(cwd, path)
  }
  return undefined
}

async function enrichFileDiffs(cwd: string | undefined, files: CodeAgentRunMetadata['files']) {
  if (!cwd) return files
  const enriched: CodeAgentRunMetadata['files'] = []
  for (const file of files) {
    if (file.diff) {
      enriched.push(file)
      continue
    }
    const gitPath = normalizeGitPath(cwd, file.path)
    enriched.push({ ...file, diff: await readGitDiffForFile(cwd, gitPath, file.status) })
  }
  return enriched
}

function normalizeGitPath(cwd: string, path: string) {
  if (!isAbsolute(path)) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : path
}

async function runGitDiff(cwd: string, args: string[]) {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.env,
    })
    const [code, stdout] = await Promise.all([
      Promise.race([proc.exited, new Promise<number>((resolve) => setTimeout(() => resolve(124), 3000))]),
      new Response(proc.stdout).text().catch(() => ''),
    ])
    return code === 0 || code === 1 ? stdout : ''
  } catch {
    return ''
  }
}

function buildNewFileDiff(cwd: string, path: string) {
  try {
    const absolutePath = resolve(cwd, path)
    if (!existsSync(absolutePath) || statSync(absolutePath).isDirectory()) return undefined
    const content = readFileSync(absolutePath, 'utf8')
    const lines = content.split(/\r?\n/).slice(0, 300)
    const body = lines.map((line) => `+${line}`).join('\n')
    return limitOutput([`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, body].join('\n'), 24_000)
  } catch {
    return undefined
  }
}

function buildArtifactsFromMetadata(input: {
  cwd?: string
  files: CodeAgentRunMetadata['files']
  output: string
}): AgentArtifact[] {
  const artifacts: AgentArtifact[] = []
  const createdAt = new Date().toISOString()
  for (const file of input.files.slice(0, 40)) {
    artifacts.push({
      id: `file:${file.path}`,
      type: 'file',
      title: file.path,
      path: file.path,
      status: file.status,
      source: 'code-agent',
      createdAt,
    })
    if (file.diff) {
      artifacts.push({
        id: `diff:${file.path}`,
        type: 'diff',
        title: `Diff: ${file.path}`,
        filePath: file.path,
        status: file.status,
        language: 'diff',
        diff: file.diff,
        source: 'git',
        createdAt,
      })
    }
    if (isHtmlFile(file.path)) {
      const url = staticPreviewUrl(input.cwd, file.path)
      if (url) {
        artifacts.push({
          id: `preview:${file.path}`,
          type: 'preview',
          title: `预览: ${file.path}`,
          url,
          previewKind: 'static-html',
          source: 'file',
          createdAt,
        })
        artifacts.push({
          id: `deploy:static:${file.path}`,
          type: 'deploy',
          title: `静态发布: ${file.path}`,
          provider: 'static',
          status: 'ready',
          url,
          source: 'file',
          createdAt,
        })
      }
    }
  }

  for (const url of detectPreviewUrls(input.output)) {
    artifacts.push({
      id: `preview:${url}`,
      type: 'preview',
      title: '网页预览',
      url,
      previewKind: 'dev-server',
      source: 'code-agent',
      createdAt,
    })
  }

  for (const url of detectDeployUrls(input.output)) {
    artifacts.push({
      id: `deploy:${url}`,
      type: 'deploy',
      title: '部署结果',
      provider: url.includes('vercel.app') ? 'vercel' : 'unknown',
      status: 'ready',
      url,
      source: 'code-agent',
      createdAt,
    })
  }

  return dedupeArtifacts(artifacts).slice(0, 80)
}

function isHtmlFile(path: string) {
  return /\.html?$/i.test(path)
}

function staticPreviewUrl(cwd: string | undefined, path: string) {
  if (!cwd) return null
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path)
  return `/api/artifacts/preview-file?path=${encodeURIComponent(absolutePath)}`
}

function detectPreviewUrls(output: string) {
  const urls = new Set<string>()
  const pattern = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"<>)]*/gi
  for (const match of output.matchAll(pattern)) {
    urls.add(match[0].replace('://0.0.0.0', '://localhost').replace('://[::1]', '://localhost'))
  }
  return [...urls]
}

function detectDeployUrls(output: string) {
  const urls = new Set<string>()
  const pattern = /https?:\/\/[^\s'"<>)]*(?:vercel\.app|netlify\.app|pages\.dev)[^\s'"<>)]*/gi
  for (const match of output.matchAll(pattern)) urls.add(match[0])
  return [...urls]
}

function dedupeArtifacts(artifacts: AgentArtifact[]) {
  const seen = new Set<string>()
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.id)) return false
    seen.add(artifact.id)
    return true
  })
}

function fileStatusFromGitStatus(status: string): CodeAgentRunMetadata['files'][number]['status'] {
  if (status.includes('??') || status.includes('A')) return 'created'
  if (status.includes('D')) return 'deleted'
  if (status.includes('R')) return 'renamed'
  if (status.includes('M')) return 'modified'
  return 'untracked'
}

function buildHostCommand(command: string, args: string[]) {
  if (process.platform !== 'win32') return [command, ...args]
  if (command === 'codex') return [windowsCodexCommand(), ...args]
  return ['cmd.exe', '/d', '/c', [command, ...args.map(windowsShellArg)].join(' ')]
}

function windowsCodexCommand() {
  const npmShim = Bun.env.APPDATA ? resolve(Bun.env.APPDATA, 'npm', 'codex.cmd') : ''
  return npmShim && existsSync(npmShim) ? npmShim : 'codex.cmd'
}

async function resolveToolConfig(toolId: CodeAgentType): Promise<Record<string, unknown>> {
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, 'CODING_TOOLS_CONFIG')).limit(1)
    const raw = rows[0]?.value
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Array<{ id: string; config?: Record<string, unknown> }>
    const tool = parsed.find((t) => t.id === toolId)
    return tool?.config ?? {}
  } catch {
    return {}
  }
}

function readEnv(key: string) {
  return (rootEnv()[key] ?? Bun.env[key])?.trim()
}

async function mergedEnv(adapter?: CodeAgentAdapter) {
  const base = { ...rootEnv(), ...Bun.env, ...codexAuthEnv() }

  // 若 CLI 需要特定 API Key，优先从 Coding Tools 设置、再自动注入模型配置中的 key
  if (adapter?.envKey) {
    const directValue = readEnv(adapter.envKey)
    if (!directValue) {
      // 1) 尝试读取前端保存的 CODE_AGENT_ACTIVE_API_KEY
      try {
        const rows = await db.select().from(settings).where(eq(settings.key, 'CODE_AGENT_ACTIVE_API_KEY')).limit(1)
        const savedKey = rows[0]?.value?.trim()
        if (savedKey) {
          base[adapter.envKey] = savedKey
        }
      } catch {
        // ignore
      }

      // 2) 若仍无，尝试从主模型配置解析对应 provider 的 API Key
      if (!base[adapter.envKey]) {
        try {
          const llmConfig = await resolveLlmRuntimeConfig()
          if (llmConfig.apiKey) {
            base[adapter.envKey] = llmConfig.apiKey
          }
        } catch {
          // ignore
        }
      }
    }
  }

  if (adapter?.command !== 'codex') return base

  const runtimeHome = prepareCodexRuntimeHome()
  return {
    ...base,
    CODEX_HOME: runtimeHome,
  }
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

function codexAuthEnv() {
  const authPath = resolve(codexConfigHome(), 'auth.json')
  const values: Record<string, string> = {}
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>
    for (const [key, value] of Object.entries(parsed)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && value.trim()) {
        values[key] = value.trim()
      }
    }
  } catch {
    // auth.json is optional; Codex may still use environment or ChatGPT auth.
  }
  return values
}

function codexConfigHome() {
  return Bun.env.AGENTHUB_CODEX_CONFIG_HOME?.trim() || Bun.env.CODEX_HOME?.trim() || resolve(homedir(), '.codex')
}

function codexRuntimeHome() {
  return (
    Bun.env.AGENTHUB_CODEX_RUNTIME_HOME?.trim() ||
    resolve(Bun.env.LOCALAPPDATA?.trim() || tmpdir(), 'AgentHub', 'codex-runtime')
  )
}

function prepareCodexRuntimeHome() {
  const sourceHome = codexConfigHome()
  const runtimeHome = codexRuntimeHome()
  mkdirSync(runtimeHome, { recursive: true })
  syncCodexRuntimeFile(sourceHome, runtimeHome, 'config.toml')
  syncCodexRuntimeFile(sourceHome, runtimeHome, 'auth.json')
  return runtimeHome
}

function syncCodexRuntimeFile(sourceHome: string, runtimeHome: string, filename: string) {
  const source = resolve(sourceHome, filename)
  if (!existsSync(source)) return
  try {
    copyFileSync(source, resolve(runtimeHome, filename))
  } catch {
    // A missing or locked optional config file should not block Coding Tools startup.
  }
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

function previewCommand(
  adapter: CodeAgentAdapter,
  cwd?: string,
  sandboxPolicy?: AgentRunProfile['sandboxPolicy'],
  modelId?: string | null
) {
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

function withExtractedLastMessage(result: { code: number; output: string }): { code: number; output: string; finalMessage?: string } {
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

function extractCodexAssistantMessage(output: string) {
  const matches = [...output.matchAll(/(?:^|\n)\[[^\]]+\]\s*codex\s*\n\n([\s\S]*?)(?=\n\[[^\]]+\]\s*(?:user|codex|exec)\b|\n\d{4}-\d{2}-\d{2}T|\nERROR:|\nWARN |\nWarning:|$)/gi)]
  const message = matches
    .map((match) => stripToolNoise(match[1] ?? '').trim())
    .filter(Boolean)
    .pop()
  return message || undefined
}

function isCodeAgentFailureOutput(output: string) {
  return /ERROR:|stream error|exceeded retry limit|unexpected status|Unauthorized|Missing bearer|invalid function arguments|Error loading config\.toml|No such file or directory/i.test(
    output
  )
}

function stripToolNoise(output: string) {
  const withoutBlocks = stripCodexPromptEcho(stripLastMessageBlock(output))
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) return false
      if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return false
      if (/^OpenAI Codex v/i.test(trimmed)) return false
      if (/^User instructions:/i.test(trimmed)) return false
      if (/^Current user request:/i.test(trimmed)) return false
      if (/^Recent group context:/i.test(trimmed)) return false
      if (/^(user|agent|assistant|system)\s*:/i.test(trimmed)) return false
      if (/^Reading additional input from stdin\.\.\./i.test(trimmed)) return false
      if (
        /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id|Project workspace path|Allowed tool scopes|Capabilities|Sandbox policy):/i.test(
          trimmed
        )
      ) {
        return false
      }
      if (/^(Follow the project instructions|Use the actual project path)/i.test(trimmed)) return false
      if (/^(stream error|ERROR:|WARN |Warning: no last agent message)/i.test(trimmed)) return false
      if (/^(exec |mcp_connection_manager|new_stdio_client)/i.test(trimmed)) return false
      if (/^(use_rmcp_client|startup_timeout|params: InitializeRequestParams)/i.test(trimmed)) return false
      if (/codex_core::mcp_connection_manager|McpServerConfig|node_repl|InitializeRequestParams/i.test(trimmed)) return false
      if (/^-{4,}$/.test(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()
}

function stripCodexPromptEcho(output: string) {
  return output
    .replace(/User instructions:[\s\S]*?(?=\n(?:\[\d{4}-\d{2}-\d{2}T|OpenAI Codex v|ERROR:|WARN |Warning:|codex\n|$))/gi, '\n')
    .replace(/Recent group context:[\s\S]*?(?=\nCurrent user request:|\n\[|\nERROR:|\nWARN |$)/gi, '\n')
    .replace(/Current user request:[\s\S]*?(?=\n(?:\[\d{4}-\d{2}-\d{2}T|ERROR:|WARN |Warning:|codex\n|$))/gi, '\n')
}

function stripReasoningTags(output: string) {
  return output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function formatCodeAgentFailure(adapter: CodeAgentAdapter, result: CodeAgentCommandResult) {
  const friendly = friendlyCodeAgentError(result.output)
  return [`**${adapter.displayName} 执行失败**`, '', friendly, '', `退出码：${result.code}`].join('\n')
}

function cleanDiagnosticOutput(output: string) {
  const cleanedLines = stripToolNoise(stripLastMessageBlock(output))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^You are |^Role: |^System prompt: |^Project workspace path: |^Allowed tool scopes:|^Capabilities:|^Sandbox policy:|^Recent group context:|^Current user request:/i.test(line))
    .filter((line) => !/^(user|agent|assistant|system)\s*:/i.test(line))
    .filter((line) => !/^(Follow the project instructions|Use the actual project path)/i.test(line))
    .filter((line) => !/codex_core::mcp_connection_manager|McpServerConfig|node_repl|InitializeRequestParams/i.test(line))
  const diagnosticLines = cleanedLines.filter((line) =>
    /error|failed|unexpected|unauthorized|not found|timed out|wire_api|missing bearer|invalid|No such file|status \d{3}|exited/i.test(line)
  )
  const cleaned = (diagnosticLines.length ? diagnosticLines : cleanedLines).join('\n')
  return limitOutput(cleaned, 2000)
}

function friendlyCodeAgentError(output: string) {
  if (/Coding Tools timed out after/i.test(output)) {
    return 'Coding Tools 已启动，但 CLI 在限定时间内没有返回结果，已自动停止。可以稍后重试，或把该 Agent 切到 OpenCode / Claude Code。'
  }
  if (/invalid function arguments json|string, tool_call_id/i.test(output)) {
    return [
      'Codex CLI 已启动，但当前模型生成了无效的工具调用参数，供应商接口拒绝了这次请求。',
      '这通常不是工作区路径问题。建议切换到更兼容 Codex 工具调用的模型，或把这个 Agent 临时改为 OpenCode / Claude Code 执行。',
    ].join('\n')
  }
  if (/401 Unauthorized|Missing bearer|basic authentication/i.test(output)) {
    return 'Codex CLI 已启动，但供应商鉴权失败。请检查本机 API Key、Base URL 和模型是否匹配。'
  }
  if (/wire_api = "chat" is no longer supported/i.test(output)) {
    return '当前 Codex CLI 不支持这个 provider 配置里的 wire_api=chat。请使用已降级的 Codex CLI，或切换到支持 Responses 的 OpenAI 端点。'
  }
  if (/model.*not found|does not exist|404|unknown model/i.test(output)) {
    return 'Codex CLI 已启动，但当前模型或 Base URL 不可用。请检查模型名称和供应商地址。'
  }
  if (/No such file or directory|cannot find the path|系统找不到指定的路径/i.test(output)) {
    return 'Coding Tools 已启动，但项目目录不存在。请重新打开或选择正确的工作区文件夹。'
  }
  return 'Coding Tools 已启动，但 CLI 执行过程返回了错误。'
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
  return `${output.slice(0, max)}\n... 输出已截断 ...`
}
