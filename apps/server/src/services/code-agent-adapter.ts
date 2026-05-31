import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AgentArtifact,
  CodeAgentRunStatus,
  ArtifactFileStatus,
  type CodeAgentRunMetadata,
} from '@agenthub/shared'
import { db, settings } from '@agenthub/db'
import { eq } from 'drizzle-orm'
import type { AgentRunProfile, MessageRow } from './agent-runner'
import { globalSkillRegistry } from './skill-registry'
import {
  getLlmRuntimeStatus,
  resolveLlmRuntimeConfig,
  resolveModelApiKey,
  resolveModelConfig,
} from './llm-client'
import { env } from '../env'
import { getBooleanSetting } from './settings-helper'
import type { AgentExecutionEnvelope } from './execution/agent-execution-envelope'
import {
  DEFAULT_ENV_ALLOWLIST,
  validateEnvelope,
  buildExecutionCwd,
} from './execution/agent-execution-envelope'

type CodeAgentType = NonNullable<AgentRunProfile['codeAgentType']>

interface CodeAgentAdapter {
  command: string
  displayName: string
  envKey: string
  docsHint: string
  promptMode: 'argument' | 'stdin' | 'file'
  buildArgs: (prompt: string, options?: CodeAgentRunOptions) => string[]
}

interface CodeAgentRunOptions {
  cwd?: string
  modelId?: string | null
  modelProvider?: string | null
  agentRoleType?: string
  outputPath?: string
  sandboxPolicy?: AgentRunProfile['sandboxPolicy']
  toolConfig?: Record<string, unknown>
  promptFile?: string
  sessionId?: string
  continueSession?: boolean
}

interface CodeAgentModelTarget {
  catalogId?: string
  provider: string
  providerKey: string
  modelId: string
  apiKey?: string
  apiKeySource?: string
  openaiBaseUrl?: string
  anthropicBaseUrl?: string
}

interface CodeAgentCommandResult {
  code: number
  output: string
  finalMessage?: string
  metadata: CodeAgentRunMetadata
  sessionId?: string
}

interface CodeAgentRuntimeOptions {
  ignoreModelEnv?: boolean
  skipLocalCodexConfig?: boolean
}

export interface CodeAgentMetadataChunk {
  kind: 'code-agent-metadata'
  metadata: CodeAgentRunMetadata
}

export type CodeAgentReplyChunk = string | CodeAgentMetadataChunk

const serviceDir = dirname(fileURLToPath(import.meta.url))
const sourceProjectRoot = resolve(serviceDir, '../../../..')
const projectRoot = sourceProjectRoot
const lastMessageStart = '__AGENTHUB_LAST_MESSAGE_START__'
const lastMessageEnd = '__AGENTHUB_LAST_MESSAGE_END__'
let rootEnvCache: Record<string, string> | null = null

function resolveServerProjectRoot() {
  const candidates = [
    Bun.env.PROJECT_ROOT?.trim(),
    process.env.PROJECT_ROOT?.trim(),
    sourceProjectRoot,
  ].filter(Boolean) as string[]

  for (const candidate of [...new Set(candidates)]) {
    const absolute = isAbsolute(candidate) ? candidate : resolve(sourceProjectRoot, candidate)
    if (!existsSync(absolute) || isRuntimeDataDir(absolute)) continue
    try {
      if (statSync(absolute).isDirectory()) return absolute
    } catch {
      // Ignore invalid project root candidates.
    }
  }

  return sourceProjectRoot
}

const adapters: Record<CodeAgentType, CodeAgentAdapter> = {
  codex: {
    command: 'codex',
    displayName: 'Codex CLI',
    envKey: 'OPENAI_API_KEY',
    docsHint: 'Codex 会使用本机安装的 CLI，并在当前项目目录中执行代码任务。',
    promptMode: 'stdin',
    buildArgs: (prompt, options) => {
      const cfg = options?.toolConfig ?? {}
      const sandbox = String(cfg['sandbox'] ?? toCodexSandbox(options?.sandboxPolicy))
      const args: string[] = [
        'exec',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--cd',
        options?.cwd ?? projectRoot,
        '--sandbox',
        sandbox,
      ]
      if (sandbox === 'danger-full-access') {
        args.push('--dangerously-bypass-approvals-and-sandbox')
      } else if (String(cfg['approvalPolicy'] ?? 'never') === 'never') {
        args.push('--full-auto')
      }
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
      const permissionMode = resolveClaudePermissionMode(options?.sandboxPolicy, cfg)
      const outputFormat = String(cfg['outputFormat'] ?? 'stream-json')
      const args: string[] = [
        '-p',
        '--input-format',
        'text',
        '--permission-mode',
        permissionMode,
        '--output-format',
        outputFormat,
      ]
      if (outputFormat === 'stream-json') {
        if (cfg['verbose'] !== false) args.push('--verbose')
        if (cfg['includePartialMessages'] !== false) args.push('--include-partial-messages')
      }
      // 支持会话恢复：如果有 sessionId，使用 --session-id 保持会话连续性
      if (options?.sessionId) {
        args.push('--session-id', options.sessionId)
      }
      // 如果是继续输出，使用 --continue 参数
      if (options?.continueSession) {
        args.push('--continue')
      }
      if (cfg['maxTurns']) {
        args.push('--max-turns', String(cfg['maxTurns']))
      }
      if (options?.modelId) {
        args.push('--model', options.modelId)
      }
      if (typeof cfg['settings'] === 'string' && cfg['settings'].trim()) {
        args.push('--settings', cfg['settings'].trim())
      }
      const addDirs = normalizeStringList(cfg['addDir'] ?? cfg['addDirs'])
      for (const dir of addDirs) args.push('--add-dir', dir)
      if (
        options?.sandboxPolicy !== 'read-only' &&
        permissionMode === 'bypassPermissions' &&
        cfg['skipPermissions'] !== false
      ) {
        args.push('--dangerously-skip-permissions')
      }
      return args
    },
  },
  opencode: {
    command: 'opencode',
    displayName: 'OpenCode',
    envKey: 'DEEPSEEK_API_KEY',
    docsHint:
      'OpenCode 会使用本机配置；如果 Agent 绑定了 provider/model，会通过 --model 传给 OpenCode。',
    promptMode: 'file',
    buildArgs: (prompt, options) => {
      const cfg = options?.toolConfig ?? {}
      const args = ['run']
      if (options?.cwd) args.push('--dir', options.cwd)
      if (options?.modelId) {
        const provider = options.modelProvider || String(cfg['provider'] ?? 'agenthub')
        const modelId = options.modelId.includes('/')
          ? options.modelId
          : `${provider}/${options.modelId}`
        args.push('--model', modelId)
      }
      const agent =
        typeof cfg['agent'] === 'string' && cfg['agent'].trim()
          ? cfg['agent'].trim()
          : options?.sandboxPolicy === 'read-only'
            ? 'plan'
            : 'build'
      args.push('--agent', agent)
      if (options?.sandboxPolicy !== 'read-only' && cfg['skipPermissions'] !== false) {
        args.push('--dangerously-skip-permissions')
      }
      args.push(options?.promptFile ? buildFileBackedPrompt(options.promptFile) : prompt)
      // OpenCode's --file is an array option; keep it after the message so it
      // does not consume the prompt text as another file path.
      if (options?.promptFile) args.push('--file', options.promptFile)
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

export const __codeAgentAdapterTestHooks = {
  buildClaudeArgs: (prompt: string, options?: CodeAgentRunOptions) =>
    adapters['claude-code'].buildArgs(prompt, options),
  buildOpencodeArgs: (prompt: string, options?: CodeAgentRunOptions) =>
    adapters.opencode.buildArgs(prompt, options),
  consumeClaudeStreamJson,
  extractClaudeResultMessage,
  friendlyCodeAgentError: (output: string, displayName = 'Coding Tools') =>
    friendlyCodeAgentError(output, { displayName } as CodeAgentAdapter),
}

export function isCodeAgentProfile(profile?: AgentRunProfile) {
  return profile?.runtimeType === 'code-agent'
}

export async function* streamCodeAgentReply(
  profile: AgentRunProfile,
  userMsg: MessageRow,
  history: Array<{ senderType: string; content: string }>,
  signal?: AbortSignal,
  envelope?: AgentExecutionEnvelope,
  continueSession?: boolean,
): AsyncGenerator<CodeAgentReplyChunk, void, unknown> {
  let type = profile.codeAgentType
  if (!type) {
    yield '这个 Agent 配置为 Coding Tools，但还没有绑定 CLI。'
    return
  }

  let adapter = adapters[type]
  if (!adapter) {
    yield `不支持的 Coding Tools 绑定：${type}。`
    return
  }

  // 如果提供了 envelope，使用 envelope 的执行上下文；否则降级到旧路径（已废弃）
  const legacyProjectPath = profile.projectPath?.trim() || null

  const cwdInfo = envelope
    ? resolveExecutionCwd(envelope)
    : resolveExecutionCwd({
        runId: userMsg.sessionId || 'legacy',
        taskId: userMsg.id || 'legacy',
        agentId: profile.id,
        agentName: profile.name,
        projectPath: legacyProjectPath,
        worktreePath: legacyProjectPath,
        sandboxPolicy: profile.sandboxPolicy ?? 'workspace-write',
        envAllowlist: DEFAULT_ENV_ALLOWLIST,
      })
  if (!cwdInfo.valid) {
    yield `\n\n[错误：执行目录无效 — ${cwdInfo.label}]`
    return
  }

  const skillContext = await globalSkillRegistry.buildSkillContext(
    [profile.systemPrompt, profile.description, userMsg.content].filter(Boolean).join('\n\n'),
    { capabilityTags: profile.capabilityTags, limit: 3 },
  )
  const prompt = buildCodeAgentPrompt(profile, userMsg, history, cwdInfo.label, skillContext)
  const toolConfig = await resolveToolConfig(type)
  const requestedModelId = resolveCodeAgentModelId(profile.modelId, toolConfig)
  let modelTarget = await resolveCodeAgentModelTarget(type, profile.modelId, toolConfig)
  if (
    !modelTarget &&
    requestedModelId &&
    (type === 'opencode' || !isNativeCodeAgentModelIdCompatible(type, requestedModelId))
  ) {
    modelTarget = await resolveRuntimeModelTarget(requestedModelId)
  }
  let runtimeModelTarget = normalizeCodeAgentModelTarget(type, modelTarget)
  let installed = await isCommandInstalled(adapter.command)
  let ignoreModelEnv = false
  let skipLocalCodexConfig = false
  if (shouldRouteModelThroughOpenCode(type, modelTarget, runtimeModelTarget, requestedModelId)) {
    const opencodeTarget = modelTarget ?? (await resolveRuntimeModelTarget(requestedModelId))
    const opencodeAdapter = adapters.opencode
    const opencodeInstalled = await isCommandInstalled(opencodeAdapter.command)
    const opencodeConfigured =
      opencodeInstalled && opencodeTarget
        ? await isRuntimeConfigured(
            'opencode',
            opencodeAdapter,
            opencodeTarget.modelId,
            opencodeTarget,
          )
        : false
    if (opencodeInstalled && opencodeConfigured && opencodeTarget) {
      type = 'opencode'
      adapter = opencodeAdapter
      runtimeModelTarget = opencodeTarget
      modelTarget = opencodeTarget
      installed = opencodeInstalled
    } else {
      yield buildIncompatibleCodeAgentModelMessage({
        requestedModelId,
        selectedRuntime: type,
        selectedRuntimeName: adapter.displayName,
        modelTarget: opencodeTarget ?? modelTarget,
        opencodeInstalled,
        opencodeConfigured,
      })
      return
    }
  }
  const effectiveModelId = runtimeModelTarget?.modelId ?? null
  const configured = await isRuntimeConfigured(type, adapter, effectiveModelId, runtimeModelTarget)
  const executionEnabled = await getBooleanSetting(
    'AGENTHUB_ENABLE_CODE_AGENT_EXECUTION',
    env.AGENTHUB_ENABLE_CODE_AGENT_EXECUTION,
  )
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
      `- 模型档案：${runtimeModelTarget ? `${runtimeModelTarget.provider}/${runtimeModelTarget.modelId}` : '自动模型'}`,
      `- 运行凭据：${configured ? '可由模型管理注入' : '未检测到'}`,
      `- 安装状态：${installed ? '已安装' : '未安装'}`,
      `- 执行开关：${executionEnabled ? '已启用' : '已禁用'}\``,
      `- 高风险确认：${profile.approvalRequired === false ? '关闭' : '开启'}`,
      '',
      codeAgentBlockerText({
        configured,
        cwdValid: cwdInfo.valid,
        executionEnabled,
        installed,
        profile,
      }),
      '',
      '命令预览：',
      '```bash',
      previewCommand(adapter, cwdInfo.cwd, profile.sandboxPolicy, runtimeModelTarget),
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
  const runPromise = runCodeAgentCommand(
    adapter,
    prompt,
    cwdInfo.cwd,
    profile.sandboxPolicy,
    runtimeModelTarget,
    signal,
    toolConfig,
    envelope?.envAllowlist,
    profile.roleType,
    { ignoreModelEnv, skipLocalCodexConfig },
    {
      onMetadata: (metadata) => push({ kind: 'code-agent-metadata', metadata }),
      onText: (text) => push(text),
    },
    continueSession,
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

  // 将 session ID 包含在 metadata 中，用于会话恢复
  const metadataWithSession = finalResult.sessionId
    ? { ...finalResult.metadata, sessionId: finalResult.sessionId }
    : finalResult.metadata

  yield { kind: 'code-agent-metadata', metadata: metadataWithSession }

  const finalMessage = stripReasoningTags(finalResult.finalMessage?.trim() || '')
  if (finalResult.code === 0 && finalMessage && !streamedText) {
    yield finalMessage
    return
  }

  const cleanedOutput = stripReasoningTags(stripToolNoise(finalResult.output))
  if (finalResult.code === 0 && !streamedText) {
    if (adapter.command === 'opencode') {
      yield buildCodeAgentCompletionMessage(finalResult.metadata, cleanedOutput)
      return
    }
    yield limitFinalOutput(cleanedOutput || '(Coding Tools 没有返回正文)')
    return
  }
  if (finalResult.code === 0) return

  yield formatCodeAgentFailure(adapter, finalResult)
}

async function resolveCodeAgentModelTarget(
  type: CodeAgentType,
  agentModelId?: string | null,
  toolConfig?: Record<string, unknown>,
): Promise<CodeAgentModelTarget | null> {
  for (const candidate of resolveCodeAgentModelCandidates(agentModelId, toolConfig)) {
    const selected = await resolveModelConfig(candidate)
    if (!selected?.modelId) continue

    const providerKey = safeProviderKey(selected.provider || selected.id)
    const openaiBaseUrl = selected.apiEndpoint?.replace(/\/$/, '')
    const anthropicBaseUrl =
      selected.anthropicEndpoint?.replace(/\/$/, '') ||
      (isAnthropicLike(selected.provider, selected.apiEndpoint) ? openaiBaseUrl : undefined)

    return {
      catalogId: selected.id,
      provider: selected.provider,
      providerKey,
      modelId: selected.modelId,
      apiKey: selected.apiKey,
      apiKeySource: selected.apiKeySource,
      openaiBaseUrl,
      anthropicBaseUrl,
    }
  }

  return null
}

async function resolveRuntimeModelTarget(
  modelId?: string | null,
): Promise<CodeAgentModelTarget | null> {
  const effectiveModelId = modelId?.trim()
  if (!effectiveModelId) return null

  try {
    const runtime = await resolveLlmRuntimeConfig(effectiveModelId)
    const provider = runtime.provider?.trim() || 'openai'
    const baseUrl = runtime.baseUrl?.trim().replace(/\/$/, '')
    const anthropicBaseUrl = isAnthropicLike(provider, baseUrl) ? baseUrl : undefined
    const openaiBaseUrl = anthropicBaseUrl ? undefined : baseUrl

    return {
      provider,
      providerKey: safeProviderKey(provider),
      modelId: runtime.model?.trim() || effectiveModelId,
      apiKey: runtime.apiKey ?? undefined,
      apiKeySource: runtime.apiKeySource ?? undefined,
      openaiBaseUrl,
      anthropicBaseUrl,
    }
  } catch {
    return null
  }
}

function resolveCodeAgentModelId(
  agentModelId?: string | null,
  toolConfig?: Record<string, unknown>,
) {
  return resolveCodeAgentModelCandidates(agentModelId, toolConfig)[0] ?? null
}

function resolveCodeAgentModelCandidates(
  agentModelId?: string | null,
  toolConfig?: Record<string, unknown>,
) {
  const fromAgent = typeof agentModelId === 'string' ? agentModelId.trim() : ''
  const fromTool = typeof toolConfig?.['modelId'] === 'string' ? toolConfig['modelId'].trim() : ''
  return [...new Set([fromAgent, fromTool].filter(Boolean))]
}

function normalizeCodeAgentModelTarget(
  type: CodeAgentType,
  modelTarget?: CodeAgentModelTarget | null,
) {
  if (!modelTarget) return null
  if (type === 'claude-code') return isClaudeCodeModelTarget(modelTarget) ? modelTarget : null
  if (type === 'codex') return isCodexModelTarget(modelTarget) ? modelTarget : null
  if (type === 'gemini') return isGeminiModelTarget(modelTarget) ? modelTarget : null
  return modelTarget
}

function shouldRouteModelThroughOpenCode(
  type: CodeAgentType,
  modelTarget?: CodeAgentModelTarget | null,
  runtimeModelTarget?: CodeAgentModelTarget | null,
  requestedModelId?: string | null,
) {
  if (type === 'opencode') return false
  if (modelTarget && !runtimeModelTarget) return true
  if (
    !modelTarget &&
    requestedModelId &&
    !isNativeCodeAgentModelIdCompatible(type, requestedModelId)
  ) {
    return true
  }
  return false
}

function isNativeCodeAgentModelIdCompatible(type: CodeAgentType, modelId?: string | null) {
  const normalized = modelId?.trim().toLowerCase()
  if (!normalized || type === 'opencode') return true
  if (type === 'claude-code') return /\b(claude|sonnet|opus|haiku)\b/i.test(normalized)
  if (type === 'gemini') return /\bgemini\b|\bgoogle\b/i.test(normalized)
  if (type === 'codex') {
    return /^(gpt|o[1-9](?:\b|-)|chatgpt|codex|computer-use|openai\/)/i.test(normalized)
  }
  return true
}

function isClaudeCodeModelTarget(modelTarget: CodeAgentModelTarget) {
  const provider = modelTarget.provider.trim().toLowerCase()
  const providerKey = modelTarget.providerKey.trim().toLowerCase()
  const endpoint = (modelTarget.anthropicBaseUrl || modelTarget.openaiBaseUrl || '').toLowerCase()
  if (modelTarget.anthropicBaseUrl) return true
  return (
    provider.includes('anthropic') ||
    provider.includes('claude') ||
    providerKey.includes('anthropic') ||
    providerKey.includes('claude') ||
    endpoint.includes('anthropic.com') ||
    endpoint.includes('/anthropic')
  )
}

function isCodexModelTarget(modelTarget: CodeAgentModelTarget) {
  const provider = modelTarget.provider.trim().toLowerCase()
  const providerKey = modelTarget.providerKey.trim().toLowerCase()
  const endpoint = (modelTarget.openaiBaseUrl || modelTarget.anthropicBaseUrl || '').toLowerCase()
  return provider === 'openai' || providerKey === 'openai' || endpoint.includes('api.openai.com')
}

function isGeminiModelTarget(modelTarget: CodeAgentModelTarget) {
  const provider = modelTarget.provider.trim().toLowerCase()
  const providerKey = modelTarget.providerKey.trim().toLowerCase()
  const modelId = modelTarget.modelId.trim().toLowerCase()
  return (
    provider.includes('gemini') ||
    provider.includes('google') ||
    providerKey.includes('gemini') ||
    providerKey.includes('google') ||
    modelId.includes('gemini')
  )
}

async function isRuntimeConfigured(
  type: CodeAgentType,
  adapter: CodeAgentAdapter,
  modelId?: string | null,
  modelTarget?: CodeAgentModelTarget | null,
) {
  if (modelTarget?.apiKey) return true
  if (readEnv(adapter.envKey)) return true
  if (type === 'opencode' && !env.ENABLE_LOCAL_CLI_PROBES) return false
  if (type === 'codex' && !modelId) return true

  // Check agent's selected model in MODEL_CATALOG first
  if (modelId) {
    try {
      const modelConfig = await resolveModelApiKey(modelId)
      if (modelConfig.apiKey) return true
    } catch {
      // fall through
    }
  }

  try {
    const llmStatus = await getLlmRuntimeStatus()
    if (!llmStatus.apiKeyConfigured) return false
    if (type === 'claude-code') {
      if (llmStatus.provider === 'anthropic' || llmStatus.baseUrl?.includes('anthropic.com'))
        return true
      if (llmStatus.apiKeySource === 'ANTHROPIC_API_KEY') return true
    }
    if (type === 'gemini') {
      if (llmStatus.provider === 'gemini' || llmStatus.provider === 'google') return true
      if (llmStatus.apiKeySource === 'GEMINI_API_KEY') return true
    }
    if (type === 'opencode') return true
  } catch (err: any) {
    console.error(
      `[isRuntimeConfigured] getLlmRuntimeStatus failed for ${type}:`,
      err?.message || String(err),
    )
  }

  return false
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
    !options.configured ? '模型档案缺少 API Key，或未设置对应环境变量' : '',
    !options.executionEnabled ? '执行开关未开启' : '',
    options.profile.approvalRequired === false ? '' : '该 Agent 仍开启了“高风险操作需要确认”',
    !options.cwdValid ? '项目目录不存在或不可访问' : '',
  ].filter(Boolean)
  if (!blockers.length) return '当前配置已满足自动执行条件。'
  return `当前阻塞项：${blockers.join('、')}。`
}

function buildIncompatibleCodeAgentModelMessage(options: {
  requestedModelId?: string | null
  selectedRuntime: CodeAgentType
  selectedRuntimeName: string
  modelTarget?: CodeAgentModelTarget | null
  opencodeInstalled: boolean
  opencodeConfigured: boolean
}) {
  const modelLabel =
    options.modelTarget?.modelId ?? options.requestedModelId?.trim() ?? '当前选中模型'
  const providerLabel = options.modelTarget
    ? `${options.modelTarget.provider}/${options.modelTarget.modelId}`
    : modelLabel
  const runtimeLabel = options.selectedRuntimeName || options.selectedRuntime
  const blockers = [
    !options.opencodeInstalled ? 'OpenCode 未安装或不在 PATH' : '',
    options.opencodeInstalled && !options.opencodeConfigured
      ? 'OpenCode 缺少该模型档案可用的 API Key/Base URL'
      : '',
    !options.modelTarget ? '未找到可注入 OpenCode 的模型档案' : '',
  ].filter(Boolean)

  return [
    `**${runtimeLabel} 未启动**`,
    '',
    `Agent 选择的模型 \`${modelLabel}\` 不是 ${runtimeLabel} 可直接运行的原生模型。为避免再次触发 unsupported_vendor，AgentHub 没有把它交给 ${runtimeLabel}。`,
    '',
    `- 选中模型：${providerLabel}`,
    `- 自动改投 OpenCode：${options.opencodeInstalled && options.opencodeConfigured ? '可用' : '不可用'}`,
    blockers.length ? `- 阻塞项：${blockers.join('、')}` : '',
    '',
    '请把该 Agent 的 Coding Tools 改为 OpenCode，或把 Agent 模型换成当前 CLI 原生支持的模型；OpenCode 安装并配置好后会自动接管这类非原生模型。',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildCodeAgentPrompt(
  profile: AgentRunProfile,
  userMsg: MessageRow,
  history: Array<{ senderType: string; content: string }>,
  workspacePath: string,
  skillContext = '',
) {
  const recent = history
    .slice(-12)
    .map((message) => ({
      senderType: message.senderType,
      content: sanitizeHistoryContent(message.content),
    }))
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
    '请完成任务要求的实际交付物后给出最终总结并正常退出，不要等待用户继续确认。',
    '除非任务明确要求只输出计划，否则不要只创建 plan.md 或 TODO 后就结束。',
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
      trimmed,
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
  try {
    const proc = isWindows
      ? Bun.spawn(['where', command], { stdout: 'ignore', stderr: 'ignore', env: process.env })
      : Bun.spawn(['sh', '-lc', `command -v ${quoteForSh(command)}`], {
          stdout: 'ignore',
          stderr: 'ignore',
          env: process.env,
        })
    const code = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(124), 2000)),
    ])
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
  modelTarget?: CodeAgentModelTarget | null,
  signal?: AbortSignal,
  toolConfig?: Record<string, unknown>,
  envAllowlist?: string[],
  agentRoleType?: string,
  runtimeOptions: CodeAgentRuntimeOptions = {},
  hooks: {
    onMetadata?: (metadata: CodeAgentRunMetadata) => void
    onText?: (text: string) => void
  } = {},
  continueSession?: boolean,
): Promise<CodeAgentCommandResult> {
  cwd = cwd?.trim() || undefined
  const outputPath =
    adapter.command === 'codex'
      ? join(
          tmpdir(),
          `agenthub-code-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
        )
      : undefined
  const promptFile =
    adapter.promptMode === 'file' ? writeCodeAgentPromptFile(adapter.command, prompt) : undefined
  const commandPrompt = promptFile
    ? buildFileBackedPrompt(promptFile)
    : process.platform === 'win32' && (adapter.command === 'codex' || adapter.command === 'claude')
      ? buildAsciiSafePrompt(prompt)
      : prompt
  // 生成或获取 session ID 用于会话恢复
  const sessionId = continueSession ? undefined : crypto.randomUUID()
  const args = adapter.buildArgs(commandPrompt, {
    cwd,
    agentRoleType,
    modelId: modelTarget?.modelId,
    modelProvider: modelTarget?.providerKey,
    outputPath,
    sandboxPolicy,
    toolConfig,
    promptFile,
    sessionId,
    continueSession,
  })

  if (signal?.aborted) {
    cleanupTempFile(outputPath)
    cleanupTempFile(promptFile)
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
  const liveSteps: NonNullable<CodeAgentRunMetadata['steps']> = []
  const seenCommands = new Set<string>()
  const seenFiles = new Set<string>()
  const seenToolCalls = new Set<string>()
  const seenSteps = new Set<string>()
  let stepCounter = 0
  let lastMetadataAt = 0
  let claudeStdoutBuffer = ''
  let claudeFinalMessage = ''
  let claudeHasStreamedText = false
  let claudeAssistantSnapshot = ''
  let claudeSessionId: string | undefined
  const closeRunningSteps = (status: 'completed' | 'failed' = 'completed') => {
    for (const step of liveSteps) {
      if (step.status === 'running') step.status = status
    }
  }
  const addStep = (
    step: Omit<
      NonNullable<CodeAgentRunMetadata['steps']>[number],
      'id' | 'createdAt' | 'status'
    > & {
      status?: 'running' | 'completed' | 'failed'
    },
    key?: string,
  ) => {
    if (key && seenSteps.has(key)) return
    if (key) seenSteps.add(key)
    closeRunningSteps(step.status === 'failed' ? 'failed' : 'completed')
    liveSteps.push({
      ...step,
      id: `step-${++stepCounter}`,
      status: step.status ?? 'running',
      createdAt: Date.now(),
    })
    if (liveSteps.length > 140) liveSteps.splice(0, liveSteps.length - 140)
  }
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
      reviewRequired: requiresCodeAgentOutputReview(adapter),
      logs: liveLogs.slice(-80),
      steps: liveSteps.slice(-120),
    })
  }
  const addLog = (stream: 'stdout' | 'stderr' | 'event', text: string) => {
    const cleaned = cleanRuntimeLog(text)
    if (!cleaned) return
    const normalizedStream =
      adapter.command === 'opencode'
        ? normalizeOpencodeRuntimeLogStream(stream, cleaned)
        : normalizeRuntimeLogStream(stream, cleaned)
    liveLogs.push({
      id: `log-${liveLogs.length + 1}`,
      stream: normalizedStream,
      text: limitOutput(cleaned, 4000),
    })
    if (normalizedStream === 'stderr' || normalizedStream === 'event') {
      const isError = normalizedStream === 'stderr'
      addStep(
        {
          kind: 'log',
          status: isError ? 'failed' : 'completed',
          title: isError ? '错误输出' : '过程输出',
          subtitle: limitOutput(cleaned.split(/\r?\n/)[0] ?? cleaned, 180),
          detail: limitOutput(cleaned, 4000),
          stream: normalizedStream,
        },
        `log:${cleaned.slice(0, 500)}`,
      )
    }
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
    addStep(
      {
        kind: 'command',
        title: '运行命令',
        subtitle: limitOutput(cleaned, 180),
        detail: commandCwd ? `cwd: ${commandCwd}` : undefined,
        command: limitOutput(cleaned, 500),
      },
      `command:${key}`,
    )
    addLog('event', `运行命令：${cleaned}`)
  }
  const addFile = (path: string, status: CodeAgentRunMetadata['files'][number]['status']) => {
    const cleaned = path.trim()
    if (!cleaned) return
    const key = `${status}\n${cleaned}`
    if (seenFiles.has(key)) return
    seenFiles.add(key)
    liveFiles.push({ path: limitOutput(cleaned, 500), status })
    addStep(
      {
        kind: 'file',
        title: fileStatusLabelForLog(status),
        subtitle: limitOutput(cleaned, 180),
        path: limitOutput(cleaned, 500),
        fileStatus: status,
      },
      `file:${key}`,
    )
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
    if (shouldShowToolStep(summary.name)) {
      addStep(
        {
          kind: 'tool',
          title: summary.label,
          subtitle: summary.target ? limitOutput(summary.target, 180) : summary.name,
          detail: summary.detail ? limitOutput(summary.detail, 500) : undefined,
          toolName: summary.name,
        },
        `tool:${key}`,
      )
    }
    emitLiveMetadata()
  }
  const claudeStreamHandlers = {
    addFile,
    addCommand,
    addToolCall,
    addLog,
    onText: (text: string) => {
      claudeHasStreamedText = true
      claudeFinalMessage += text
      hooks.onText?.(text)
    },
    onAssistantText: (text: string) => {
      const previous = claudeAssistantSnapshot
      claudeAssistantSnapshot = text
      claudeFinalMessage = text
      if (claudeHasStreamedText) return
      const delta = previous && text.startsWith(previous) ? text.slice(previous.length) : text
      if (delta) hooks.onText?.(delta)
    },
  }

  addStep(
    {
      kind: 'status',
      title: '启动 Coding Tools',
      subtitle: `${adapter.displayName} · ${adapter.command}`,
      detail: cwd,
    },
    `status:start:${adapter.command}:${cwd ?? ''}`,
  )
  emitLiveMetadata(true)

  if (outputPath && existsSync(outputPath)) {
    try {
      unlinkSync(outputPath)
    } catch {
      // A stale last-message file should not block execution.
    }
  }

  const proc = Bun.spawn(buildHostCommand(adapter.command, args), {
    cwd,
    env: await mergedEnv(adapter, modelTarget, envAllowlist, runtimeOptions),
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

  const heartbeat = setInterval(() => emitLiveMetadata(true), 1000)
  let timedOut = false
  const stopRun = () => killProcessTree(proc)
  const timer = setTimeout(() => {
    timedOut = true
    stopRun()
  }, env.AGENTHUB_CODE_AGENT_TIMEOUT_MS)
  const abortRun = () => {
    stopRun()
  }
  signal?.addEventListener('abort', abortRun, { once: true })
  let stdout = ''
  let stderr = ''
  let code = 1
  try {
    ;[code] = await Promise.all([
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
              claudeHasStreamedText = true
              claudeFinalMessage += text
              hooks.onText?.(text)
            },
            onAssistantText: (text) => {
              claudeFinalMessage ||= text
              if (!claudeHasStreamedText) hooks.onText?.(text)
            },
            onSessionId: (sessionId) => {
              claudeSessionId = sessionId
            },
          })
        } else {
          addLog('stdout', chunk)
          for (const command of parseExecutedCommands(stdout))
            addCommand(command.command, command.cwd)
          for (const file of parseOpencodeFileOperations(stdout)) addFile(file.path, file.status)
        }
      }),
      readProcessStream(proc.stderr, (chunk) => {
        stderr += chunk
        addLog('stderr', chunk)
        if (adapter.command === 'opencode') {
          for (const file of parseOpencodeFileOperations(stderr)) addFile(file.path, file.status)
        }
      }),
    ])
  } finally {
    clearTimeout(timer)
    clearInterval(heartbeat)
    signal?.removeEventListener('abort', abortRun)
  }
  if (adapter.command === 'claude' && claudeStdoutBuffer.trim()) {
    claudeStdoutBuffer = consumeClaudeStreamJson('\n', claudeStdoutBuffer, claudeStreamHandlers)
  }
  const output = [
    stdout.trim(),
    stderr.trim(),
    timedOut
      ? `Coding Tools 超过 ${env.AGENTHUB_CODE_AGENT_TIMEOUT_MS}ms 未返回，已自动停止。`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  const outputFileMessage =
    outputPath && existsSync(outputPath) ? readFileSync(outputPath, 'utf8').trim() : undefined
  if (outputPath && existsSync(outputPath)) {
    try {
      unlinkSync(outputPath)
    } catch {
      // Best-effort cleanup.
    }
  }
  if (promptFile && existsSync(promptFile)) {
    try {
      unlinkSync(promptFile)
    } catch {
      // Best-effort cleanup.
    }
  }
  const parsed = withExtractedLastMessage({ code, output })
  const finalMessage = stripReasoningTags(
    outputFileMessage ||
      claudeFinalMessage.trim() ||
      parsed.finalMessage ||
      extractClaudeResultMessage(parsed.output) ||
      extractCodexAssistantMessage(parsed.output) ||
      '',
  )
  const effectiveCode = code === 0 && !finalMessage && isCodeAgentFailureOutput(output) ? 1 : code
  const metadata = await buildCodeAgentRunMetadata({
    adapter,
    code: effectiveCode,
    durationMs: Date.now() - startedAt,
    output: parsed.output,
    finalMessage: finalMessage || undefined,
    timedOut,
    beforeFiles,
    cwd,
    liveCommands,
    liveFiles,
    liveToolCalls,
    liveLogs,
    liveSteps,
  })
  return {
    ...parsed,
    code: effectiveCode,
    finalMessage: finalMessage || undefined,
    metadata,
    sessionId: claudeSessionId,
  }
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

function buildFileBackedPrompt(promptFile?: string) {
  const fileName = promptFile ? basename(promptFile) : 'task-prompt.md'
  return [
    'Read the attached prompt file and follow it exactly.',
    `The attached file is ${fileName}.`,
    'Use it as the full task specification and conversation context.',
  ].join('\n')
}

function writeCodeAgentPromptFile(command: string, prompt: string) {
  const dir = resolve(tmpdir(), 'AgentHub', 'code-agent-prompts')
  mkdirSync(dir, { recursive: true })
  const path = resolve(
    dir,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${safeFileName(command)}.md`,
  )
  writeFileSync(path, prompt, 'utf8')
  return path
}

function cleanupTempFile(path?: string) {
  if (!path || !existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    // Best-effort cleanup.
  }
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
  liveSteps?: NonNullable<CodeAgentRunMetadata['steps']>
  finalMessage?: string
  output: string
  timedOut: boolean
}): Promise<CodeAgentRunMetadata> {
  const diagnostics = input.code === 0 && !input.timedOut ? '' : cleanDiagnosticOutput(input.output)
  const parsedCommands = parseExecutedCommands(input.output)
  const commands = mergeCommands([...(input.liveCommands ?? []), ...parsedCommands])
  const files = await enrichFileDiffs(
    input.cwd,
    mergeFiles([
      ...(input.liveFiles ?? []),
      ...(await diffWorkspaceFiles(input.cwd, input.beforeFiles)),
    ]),
  )
  const artifacts = buildArtifactsFromMetadata({ cwd: input.cwd, files, output: input.output })
  const status: CodeAgentRunMetadata['status'] = input.timedOut
    ? 'timed-out'
    : input.code === 0
      ? 'completed'
      : input.code === 130
        ? 'cancelled'
        : 'failed'
  const partialSuccess = status === 'failed' && files.length > 0 && !input.timedOut
  return {
    type: 'code-agent-run',
    status,
    runtime: runtimeTypeForAdapter(input.adapter),
    command: input.adapter.command,
    cwd: input.cwd,
    durationMs: input.durationMs,
    exitCode: input.code,
    commands,
    files,
    toolCalls: input.liveToolCalls?.slice(0, 120),
    artifacts,
    finalMessage: input.finalMessage,
    partialSuccess,
    warning: partialSuccess ? friendlyCodeAgentError(input.output, input.adapter) : undefined,
    reviewRequired: requiresCodeAgentOutputReview(input.adapter),
    logs: input.liveLogs?.slice(-80),
    steps: buildFinalRunSteps({
      status,
      durationMs: input.durationMs,
      commands,
      files,
      liveSteps: input.liveSteps ?? [],
      partialSuccess,
    }),
    diagnostics: diagnostics || undefined,
  }
}

function emptyCodeAgentRunMetadata(
  adapter: CodeAgentAdapter,
  status: CodeAgentRunMetadata['status'],
): CodeAgentRunMetadata {
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
    partialSuccess: false,
    reviewRequired: requiresCodeAgentOutputReview(adapter),
    steps: [
      {
        id: 'step-1',
        kind: 'status',
        status: status === 'completed' || status === 'running' ? 'completed' : 'failed',
        title: codeAgentStatusStepTitle(status),
        createdAt: Date.now(),
      },
    ],
  }
}

function shouldShowToolStep(name: string) {
  return !['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write'].includes(name)
}

function buildFinalRunSteps(input: {
  status: CodeAgentRunMetadata['status']
  durationMs: number
  commands: CodeAgentRunMetadata['commands']
  files: CodeAgentRunMetadata['files']
  liveSteps: NonNullable<CodeAgentRunMetadata['steps']>
  partialSuccess?: boolean
}): NonNullable<CodeAgentRunMetadata['steps']> {
  const finalStepStatus = input.status === 'completed' || input.partialSuccess ? 'completed' : 'failed'
  const steps: NonNullable<CodeAgentRunMetadata['steps']> = input.liveSteps.map((step) => ({
    ...step,
    status: step.status === 'running' ? finalStepStatus : step.status,
  }))
  const commandSet = new Set(steps.map((step) => step.command).filter(Boolean))
  const fileSet = new Set(steps.map((step) => `${step.fileStatus ?? ''}\n${step.path ?? ''}`))

  for (const command of input.commands) {
    if (!command.command || commandSet.has(command.command)) continue
    commandSet.add(command.command)
    steps.push({
      id: `step-final-${steps.length + 1}`,
      kind: 'command',
      status: 'completed',
      title: '运行命令',
      subtitle: limitOutput(command.command, 180),
      detail: command.cwd ? `cwd: ${command.cwd}` : undefined,
      command: command.command,
    })
  }

  for (const file of input.files) {
    const key = `${file.status}\n${file.path}`
    if (!file.path || fileSet.has(key)) continue
    fileSet.add(key)
    steps.push({
      id: `step-final-${steps.length + 1}`,
      kind: 'file',
      status: 'completed',
      title: fileStatusLabelForLog(file.status),
      subtitle: limitOutput(file.path, 180),
      path: file.path,
      fileStatus: file.status,
    })
  }

  steps.push({
    id: `step-final-${steps.length + 1}`,
    kind: 'status',
    status: finalStepStatus,
    title: codeAgentStatusStepTitle(input.status),
    subtitle: `耗时 ${formatMetadataDuration(input.durationMs)}`,
  })

  return steps.slice(-120)
}

function codeAgentStatusStepTitle(status: CodeAgentRunMetadata['status']) {
  if (status === 'running') return '正在执行'
  if (status === 'completed') return '执行完成'
  if (status === 'cancelled') return '已停止'
  if (status === 'timed-out') return '执行超时'
  return '执行失败'
}

function formatMetadataDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

function runtimeTypeForAdapter(adapter: CodeAgentAdapter): CodeAgentType {
  const entry = Object.entries(adapters).find(([, item]) => item === adapter)
  return (entry?.[0] as CodeAgentType | undefined) ?? 'codex'
}

function requiresCodeAgentOutputReview(_adapter: CodeAgentAdapter) {
  return false
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
) {
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
    onAssistantText?: (text: string) => void
    onSessionId?: (sessionId: string) => void
  },
) {
  const combined = previousBuffer + chunk
  const lines = combined.split(/\r?\n/)
  const nextBuffer = lines.pop() ?? ''
  for (const line of lines) parseClaudeJsonLine(line, handlers)
  return nextBuffer
}

function extractClaudeResultMessage(output: string) {
  const resultMessages: string[] = []
  const assistantMessages: string[] = []
  const streamText: string[] = []
  const errorMessages: string[] = []
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let payload: any
    try {
      payload = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (payload?.type === 'result') {
      const text = extractClaudePayloadText(payload)
      if (text) resultMessages.push(text)
    }
    if (payload?.type === 'assistant') {
      const text = extractClaudeContentText(payload.message?.content)
      if (text) assistantMessages.push(text)
    }
    if (payload?.type === 'stream_event') {
      const delta = payload.event?.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string')
        streamText.push(delta.text)
    }
    if (payload?.type === 'error') {
      const text = extractClaudePayloadText(payload)
      if (text) errorMessages.push(text)
    }
  }
  return (
    resultMessages.find(Boolean)?.trim() ||
    assistantMessages.find(Boolean)?.trim() ||
    streamText.join('').trim() ||
    errorMessages.find(Boolean)?.trim()
  )
}

function extractClaudeContentText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : content ? [content] : []
  return blocks
    .map((block) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      const value = block as Record<string, unknown>
      if (value.type === 'text' && typeof value.text === 'string') return value.text
      return ''
    })
    .join('')
    .trim()
}

function extractClaudePayloadText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const value = payload as Record<string, unknown>
  const candidates = [
    value.result,
    value.message,
    value.content,
    value.text,
    value.error,
    value.stderr,
    value.stdout,
  ]
  for (const candidate of candidates) {
    const text = extractClaudeValueText(candidate)
    if (text) return text
  }
  return ''
}

function extractClaudeValueText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return extractClaudeContentText(value)
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (record.type === 'text' && typeof record.text === 'string') return record.text.trim()
  for (const key of ['message', 'text', 'content', 'result']) {
    const nested = extractClaudeValueText(record[key])
    if (nested) return nested
  }
  return ''
}

function isClaudeResultError(payload: unknown) {
  if (!payload || typeof payload !== 'object') return false
  const value = payload as Record<string, unknown>
  if (value.is_error === true || value.error === true) return true
  const subtype = typeof value.subtype === 'string' ? value.subtype : ''
  const status = typeof value.status === 'string' ? value.status : ''
  return /error|failed|failure|cancel|timeout/i.test(`${subtype} ${status}`)
}

function summarizeClaudeSystemEvent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return null
  const value = payload as Record<string, unknown>
  const subtype = typeof value.subtype === 'string' ? value.subtype : ''
  if (!subtype) return null
  if (subtype === 'init') return `Claude Code 初始化：${String(value.cwd || 'workspace')}`
  if (subtype === 'compact') return 'Claude Code 已压缩上下文'
  if (subtype === 'error') return extractClaudePayloadText(value) || 'Claude Code 系统事件：error'
  return `Claude Code 系统事件：${subtype}`
}

function parseClaudeJsonLine(
  line: string,
  handlers: {
    addFile: (path: string, status: CodeAgentRunMetadata['files'][number]['status']) => void
    addCommand: (command: string, cwd?: string) => void
    addToolCall: (name: string, input?: Record<string, unknown>) => void
    addLog: (stream: 'stdout' | 'stderr' | 'event', text: string) => void
    onText: (text: string) => void
    onAssistantText?: (text: string) => void
    onSessionId?: (sessionId: string) => void
  },
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
    // 捕获 session_id 用于会话恢复
    if (payload.session_id && typeof payload.session_id === 'string') {
      handlers.onSessionId?.(payload.session_id)
    }
    return
  }

  if (payload.type === 'system') {
    const summary = summarizeClaudeSystemEvent(payload)
    if (summary) handlers.addLog('event', summary)
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
    const text = extractClaudeContentText(payload.message?.content)
    if (text) (handlers.onAssistantText ?? handlers.onText)(text)
    return
  }

  if (payload.type === 'result' && payload.subtype) {
    const isError = isClaudeResultError(payload)
    const message =
      extractClaudePayloadText(payload) ||
      (isError ? 'Claude Code 执行失败' : 'Claude Code 执行完成')
    handlers.addLog(isError ? 'stderr' : 'event', message)
    return
  }

  if (payload.type === 'error') {
    const message = extractClaudePayloadText(payload) || 'Claude Code 执行失败'
    handlers.addLog('stderr', message)
  }
}

function recordClaudeToolUse(
  block: any,
  handlers: {
    addFile: (path: string, status: CodeAgentRunMetadata['files'][number]['status']) => void
    addCommand: (command: string, cwd?: string) => void
    addToolCall: (name: string, input?: Record<string, unknown>) => void
    addLog: (stream: 'stdout' | 'stderr' | 'event', text: string) => void
  },
) {
  const name = String(block.name ?? '')
  const input: Record<string, unknown> =
    block.input && typeof block.input === 'object'
      ? block.input
      : block.params && typeof block.params === 'object'
        ? block.params
        : {}
  if (name) handlers.addToolCall(name, input)
  if (name === 'Bash' && typeof input.command === 'string') {
    handlers.addCommand(input.command, typeof input.cwd === 'string' ? input.cwd : undefined)
    return
  }
  if (
    (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') &&
    typeof input.file_path === 'string'
  ) {
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
  const joinDetails = (...items: Array<string | undefined>) =>
    items.filter(Boolean).join(' · ') || undefined
  const filePath = readString('file_path') ?? readString('notebook_path')
  const path = readString('path')
  const pattern = readString('pattern')
  const command = readString('command')

  if (cleanName === 'Bash') {
    return {
      name: cleanName,
      label: '运行命令',
      target: command,
      detail: readString('description'),
    }
  }
  if (cleanName === 'Read') {
    const range = joinDetails(
      readNumber('offset') !== undefined ? `从第 ${readNumber('offset')} 行` : undefined,
      readNumber('limit') !== undefined ? `最多 ${readNumber('limit')} 行` : undefined,
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
    return {
      name: cleanName,
      label: '搜索内容',
      target: pattern,
      detail: joinDetails(path, readString('glob'), readString('output_mode')),
    }
  }
  if (cleanName === 'Glob') {
    return { name: cleanName, label: '匹配文件', target: pattern, detail: path }
  }
  if (cleanName === 'LS') {
    return { name: cleanName, label: '列出目录', target: path }
  }
  if (cleanName === 'WebFetch') {
    return {
      name: cleanName,
      label: '读取网页',
      target: readString('url'),
      detail: readString('prompt'),
    }
  }
  if (cleanName === 'WebSearch') {
    return { name: cleanName, label: '网页搜索', target: readString('query') }
  }
  if (cleanName === 'Task' || cleanName === 'Agent') {
    return {
      name: cleanName,
      label: '调用子任务',
      target: readString('description') ?? readString('prompt'),
    }
  }
  if (cleanName === 'TodoWrite') {
    const todos = Array.isArray(input?.todos) ? input.todos.length : undefined
    return { name: cleanName, label: '更新待办', detail: todos ? `${todos} 项` : undefined }
  }
  return {
    name: cleanName,
    label: '工具调用',
    target: filePath ?? path ?? pattern ?? command ?? readString('query') ?? readString('url'),
  }
}

function parseExecutedCommands(output: string): CodeAgentRunMetadata['commands'] {
  const commands: CodeAgentRunMetadata['commands'] = []
  const seen = new Set<string>()
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    // 匹配 Claude/Codex 格式: exec command
    const match = line.match(/^\[?[^\]]*\]?\s*exec\s+(.+?)(?:\s+in\s+(.+))?$/i)
    if (match) {
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
      continue
    }
    // 匹配 OpenCode 格式: $ command
    const opencodeMatch = line.match(/^\$\s+(.+)$/)
    if (opencodeMatch) {
      const command = cleanCommandText(opencodeMatch[1] ?? '')
      const key = command
      if (!command || seen.has(key)) continue
      seen.add(key)
      commands.push({
        id: `cmd-${commands.length + 1}`,
        command: limitOutput(command, 500),
      })
    }
  }
  return commands.slice(0, 60)
}

function parseOpencodeFileOperations(
  output: string,
): Array<{ path: string; status: CodeAgentRunMetadata['files'][number]['status'] }> {
  const files: Array<{ path: string; status: CodeAgentRunMetadata['files'][number]['status'] }> = []
  const seen = new Set<string>()
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^←\s*(Write|Read|Edit|MultiEdit)\s+(.+)$/i)
    if (!match) continue
    const action = match[1]?.toLowerCase() ?? ''
    if (action === 'read') continue
    const path = match[2]?.trim() ?? ''
    if (!path || seen.has(path)) continue
    seen.add(path)
    const status =
      action === 'write' || action === 'multiedit'
        ? 'created'
        : action === 'edit'
          ? 'modified'
          : 'created'
    files.push({ path, status })
  }
  return files
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
  return stripTerminalControls(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/codex_core::mcp_connection_manager|McpServerConfig|InitializeRequestParams/i.test(line),
    )
    .join('\n')
}

function stripTerminalControls(value: string) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')
}

function normalizeRuntimeLogStream(
  stream: 'stdout' | 'stderr' | 'event',
  text: string,
): 'stdout' | 'stderr' | 'event' {
  if (stream === 'event') return stream
  if (isProgressLikeRuntimeLog(text)) return 'event'
  return stream
}

function normalizeOpencodeRuntimeLogStream(
  stream: 'stdout' | 'stderr' | 'event',
  text: string,
): 'stdout' | 'stderr' | 'event' {
  if (stream === 'event') return stream
  if (isProgressLikeRuntimeLog(text)) return 'event'
  if (stream === 'stderr' && !isLikelyRuntimeErrorLog(text)) return 'event'
  return stream
}

function isLikelyRuntimeErrorLog(text: string) {
  return /\b(error|failed|failure|exception|fatal|panic|traceback|timeout|timed out|denied|unauthorized|not found|cannot|can't)\b/i.test(
    text,
  )
}

function isProgressLikeRuntimeLog(text: string) {
  const normalized = text.trim()
  if (!normalized) return true
  if (
    /^(->|→)\s*(Read|Edit|Write|MultiEdit|Grep|Glob|Bash|TodoWrite|Task|WebFetch|WebSearch)\b/i.test(
      normalized,
    )
  )
    return true
  if (/^#\s*Todos\b/i.test(normalized)) return true
  if (/^\[[ xX-]\]\s+/.test(normalized)) return true
  if (/^[✓✔]\s+/.test(normalized)) return true
  if (/^[•·]\s+/.test(normalized)) return true
  if (/^>\s*[\w.-]+\s*·\s*[\w./:+-]+/i.test(normalized)) return true
  if (/\b(Explore|Plan|Analyze|Review|Build|Write|Read)\b.*\bAgent\b/i.test(normalized)) return true
  if (
    /^(Read|Edit|Write|MultiEdit|Grep|Glob|Bash|TodoWrite|Task|WebFetch|WebSearch)[：:]/i.test(
      normalized,
    )
  )
    return true
  if (/^(Warning|Warn|警告)[：:\s]/i.test(normalized)) return true
  // OpenCode 特有模式：命令前缀、文件操作箭头、版本输出、目录列表
  if (/^\$\s+/.test(normalized)) return true
  if (/^←\s*(Write|Read|Edit|MultiEdit|Grep|Glob|Bash)/i.test(normalized)) return true
  if (/^Python \d+\.\d+\.\d+/.test(normalized)) return true
  if (/^node v\d+\.\d+\.\d+/i.test(normalized)) return true
  if (/^Directory:\s/.test(normalized)) return true
  if (/^Mode\s+LastWriteTime/.test(normalized)) return true
  if (/^[-a]{3,}\s+\d{4}\/\d{1,2}\/\d{1,2}/.test(normalized)) return true
  if (normalized === '(no output)') return true
  return false
}

function cleanCommandText(value: string) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

async function snapshotWorkspaceFiles(cwd?: string): Promise<Map<string, string>> {
  if (!cwd) return new Map()
  if (shouldScanWorkspaceFiles(cwd)) return scanWorkspaceFiles(cwd)
  const gitSnapshot = await snapshotGitWorkspaceFiles(cwd)
  if (gitSnapshot) return gitSnapshot
  return scanWorkspaceFiles(cwd)
}

function shouldScanWorkspaceFiles(cwd: string) {
  const normalized = cwd.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.includes('/.agenthub/workdirs/') ||
    normalized.includes('/.agenthub/workspaces/') ||
    normalized.includes('/storage/workspaces/')
  )
}

async function snapshotGitWorkspaceFiles(cwd: string): Promise<Map<string, string> | null> {
  try {
    const proc = Bun.spawn(['git', 'status', '--short', '--untracked-files=all'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.env,
    })
    const [code, stdout] = await Promise.all([
      Promise.race([
        proc.exited,
        new Promise<number>((resolve) => setTimeout(() => resolve(124), 3000)),
      ]),
      new Response(proc.stdout).text().catch(() => ''),
    ])
    if (code !== 0) return null
    return parseGitStatus(stdout)
  } catch {
    return null
  }
}

function scanWorkspaceFiles(root: string): Map<string, string> {
  const snapshot = new Map<string, string>()

  const walk = (dir: string, prefix = '') => {
    let entries: Array<{
      name: string
      isDirectory(): boolean
      isFile(): boolean
      isSymbolicLink(): boolean
    }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as typeof entries
    } catch {
      return
    }

    for (const entry of entries) {
      if (shouldSkipSnapshotEntry(entry.name)) continue
      const absolutePath = resolve(dir, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath)
        continue
      }
      try {
        const stats = statSync(absolutePath)
        if (!stats.isFile() && !stats.isSymbolicLink()) continue
        snapshot.set(
          relativePath.replace(/\\/g, '/'),
          `f:${stats.size}:${Math.round(stats.mtimeMs)}`,
        )
      } catch {
        continue
      }
    }
  }

  walk(root)
  return snapshot
}

function shouldSkipSnapshotEntry(name: string) {
  const lower = name.toLowerCase()
  return [
    '.agenthub',
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    '.vite',
    'coverage',
    '.turbo',
    '.cache',
    '.idea',
    '.vscode',
  ].includes(lower)
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

async function diffWorkspaceFiles(
  cwd: string | undefined,
  before: Map<string, string>,
): Promise<CodeAgentRunMetadata['files']> {
  const after = await snapshotWorkspaceFiles(cwd)
  const files: CodeAgentRunMetadata['files'] = []
  for (const [path, status] of after) {
    if (before.get(path) === status) continue
    const fileStatus = status.startsWith('f:')
      ? before.has(path)
        ? 'modified'
        : 'created'
      : fileStatusFromGitStatus(status)
    files.push({
      path,
      status: fileStatus,
      diff: await readWorkspaceDiffForFile(cwd, path, fileStatus),
    })
  }
  for (const [path, status] of before) {
    if (after.has(path)) continue
    if (!status.startsWith('f:')) continue
    files.push({ path, status: 'deleted', diff: undefined })
  }
  return files.slice(0, 80)
}

async function readWorkspaceDiffForFile(
  cwd: string | undefined,
  path: string,
  status: CodeAgentRunMetadata['files'][number]['status'],
) {
  if (!cwd) return undefined
  const diff = await runGitDiff(cwd, ['diff', '--', path])
  if (diff.trim()) return limitOutput(diff, 24_000)

  const staged = await runGitDiff(cwd, ['diff', '--cached', '--', path])
  if (staged.trim()) return limitOutput(staged, 24_000)

  if (status === 'created' || status === 'untracked') {
    return buildNewFileDiff(cwd, path)
  }
  if (status === 'modified') {
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
    enriched.push({ ...file, diff: await readWorkspaceDiffForFile(cwd, gitPath, file.status) })
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
      Promise.race([
        proc.exited,
        new Promise<number>((resolve) => setTimeout(() => resolve(124), 3000)),
      ]),
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
    return limitOutput(
      [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${path}`,
        body,
      ].join('\n'),
      24_000,
    )
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
  if (command === 'opencode') {
    const direct = windowsOpencodeNodeDirect(args)
    if (direct) return direct
  }
  // Windows 上直接传数组参数，避免 cmd.exe /c 的 8192 字符命令行长度限制
  return [windowsCliCommand(command), ...args]
}

function windowsOpencodeNodeDirect(args: string[]): string[] | null {
  const nodeExe = process.execPath
  // Strategy 1: npm global install
  const npmShim = windowsNpmShim('opencode')
  if (npmShim && existsSync(npmShim)) {
    const npmDir = dirname(npmShim)
    const binPath = resolve(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode')
    if (existsSync(binPath)) return [nodeExe, binPath, ...args]
  }
  // Strategy 2: find opencode.cmd in PATH and infer node_modules location
  for (const candidate of windowsPathCommandCandidates('opencode')) {
    if (existsSync(candidate) && candidate.endsWith('.cmd')) {
      const binPath = resolve(dirname(candidate), 'node_modules', 'opencode-ai', 'bin', 'opencode')
      if (existsSync(binPath)) return [nodeExe, binPath, ...args]
    }
  }
  return null
}

function windowsCodexCommand() {
  const npmShim = windowsNpmShim('codex')
  return npmShim && existsSync(npmShim) ? npmShim : 'codex.cmd'
}

function windowsCliCommand(command: string) {
  const candidates = [
    ...windowsPathCommandCandidates(command),
    windowsNpmShim(command),
    windowsBunShim(command),
  ].filter(Boolean) as string[]

  for (const candidate of [...new Set(candidates)]) {
    if (existsSync(candidate)) return candidate
  }

  return `${command}.cmd`
}

function windowsPathCommandCandidates(command: string) {
  const pathValue = Bun.env.PATH ?? Bun.env.Path ?? process.env.PATH ?? process.env.Path ?? ''
  const extensions = command.includes('.') ? [''] : ['.cmd', '.exe', '.bat', '']
  return pathValue
    .split(';')
    .filter(Boolean)
    .flatMap((dir) => extensions.map((extension) => resolve(dir, `${command}${extension}`)))
}

function windowsNpmShim(command: string) {
  const appData = Bun.env.APPDATA ?? process.env.APPDATA
  return appData ? resolve(appData, 'npm', `${command}.cmd`) : ''
}

function windowsBunShim(command: string) {
  return resolve(homedir(), '.bun', 'bin', `${command}.exe`)
}

async function resolveToolConfig(toolId: CodeAgentType): Promise<Record<string, unknown>> {
  try {
    const rows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'CODING_TOOLS_CONFIG'))
      .limit(1)
    const raw = rows[0]?.value
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Array<{
      id: string
      config?: Record<string, unknown>
      provider?: string
      agent?: string
      modelId?: string
      baseUrl?: string
      apiKeyEnv?: string
      protocol?: string
    }>
    const tool = parsed.find((t) => t.id === toolId)
    const config = { ...(tool?.config ?? {}) }
    // 兼容前端直接保存的扁平字段
    if (tool?.provider) config.provider = tool.provider
    if (tool?.agent) config.agent = tool.agent
    if (tool?.modelId) config.modelId = tool.modelId
    if (tool?.baseUrl) config.baseUrl = tool.baseUrl
    if (tool?.apiKeyEnv) config.apiKeyEnv = tool.apiKeyEnv
    if (tool?.protocol) config.protocol = tool.protocol
    return config
  } catch {
    return {}
  }
}

function readEnv(key: string) {
  return (rootEnv()[key] ?? Bun.env[key])?.trim()
}

async function mergedEnv(
  adapter?: CodeAgentAdapter,
  modelTarget?: CodeAgentModelTarget | null,
  allowlist?: string[],
  runtimeOptions: CodeAgentRuntimeOptions = {},
): Promise<Record<string, string>> {
  const allowedKeys = new Set(allowlist?.length ? allowlist : DEFAULT_ENV_ALLOWLIST)
  const base: Record<string, string> = {}

  // 1. 白名单过滤 Bun.env
  for (const [key, value] of Object.entries(Bun.env)) {
    if (allowedKeys.has(key) && value !== undefined) {
      base[key] = value
    }
  }

  // 2. 白名单过滤 .env 文件中的值（rootEnv）
  const rootEnvValues = rootEnv()
  for (const [key, value] of Object.entries(rootEnvValues)) {
    if (allowedKeys.has(key)) {
      base[key] = value
    }
  }

  // 3. 白名单过滤 codex auth env
  const codexEnv = codexAuthEnv()
  for (const [key, value] of Object.entries(codexEnv)) {
    if (allowedKeys.has(key) && value !== undefined) {
      base[key] = value
    }
  }

  normalizeWindowsProcessEnv(base, allowedKeys)
  applyModelTargetEnv(base, adapter, modelTarget)
  if (runtimeOptions.ignoreModelEnv) removeModelEnv(base, adapter)

  if (adapter?.command === 'opencode' && modelTarget) {
    base.OPENCODE_CONFIG = prepareOpencodeRuntimeConfig(modelTarget)
  }
  if (adapter?.command !== 'codex') return base

  const runtimeHome = prepareCodexRuntimeHome(modelTarget, runtimeOptions.skipLocalCodexConfig)
  base.CODEX_HOME = runtimeHome
  return base
}

function removeModelEnv(base: Record<string, string>, adapter?: CodeAgentAdapter) {
  if (!adapter) return
  if (adapter.command === 'claude') {
    delete base.ANTHROPIC_MODEL
    delete base.CLAUDE_CODE_MODEL
    return
  }
  if (adapter.command === 'codex') {
    delete base.OPENAI_MODEL
    return
  }
  if (adapter.command === 'gemini') {
    delete base.GEMINI_MODEL
  }
}

function normalizeWindowsProcessEnv(base: Record<string, string>, allowedKeys: Set<string>) {
  if (process.platform !== 'win32') return

  const pathValue =
    base.Path || base.PATH || Bun.env.Path || Bun.env.PATH || process.env.Path || process.env.PATH
  if (pathValue && (allowedKeys.has('Path') || allowedKeys.has('PATH'))) {
    base.Path = pathValue
    base.PATH = pathValue
  }

  const passthrough = ['PATHEXT', 'ComSpec', 'SystemRoot', 'LOCALAPPDATA'] as const
  for (const key of passthrough) {
    const value = base[key] || Bun.env[key] || process.env[key]
    if (value && allowedKeys.has(key)) base[key] = value
  }
}

function applyModelTargetEnv(
  base: NodeJS.ProcessEnv,
  adapter?: CodeAgentAdapter,
  modelTarget?: CodeAgentModelTarget | null,
) {
  if (!adapter) return

  const key = modelTarget?.apiKey?.trim()
  if (key) {
    base.AGENTHUB_MODEL_API_KEY = key
    base[adapter.envKey] = key
  }

  if (!modelTarget) return

  if (adapter.command === 'claude') {
    if (key) base.ANTHROPIC_API_KEY = key
    if (modelTarget.anthropicBaseUrl) base.ANTHROPIC_BASE_URL = modelTarget.anthropicBaseUrl
    if (modelTarget.modelId) base.ANTHROPIC_MODEL = modelTarget.modelId
  } else if (adapter.command === 'codex') {
    if (key) base.OPENAI_API_KEY = key
    if (modelTarget.openaiBaseUrl) base.OPENAI_BASE_URL = modelTarget.openaiBaseUrl
    if (modelTarget.modelId) base.OPENAI_MODEL = modelTarget.modelId
  } else if (adapter.command === 'opencode') {
    const providerEnv = `${modelTarget.providerKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    if (key) base[providerEnv] = key
  } else if (adapter.command === 'gemini') {
    if (key) base.GEMINI_API_KEY = key
    if (modelTarget.modelId) base.GEMINI_MODEL = modelTarget.modelId
  }
}

function prepareOpencodeRuntimeConfig(modelTarget: CodeAgentModelTarget) {
  const dir = resolve(tmpdir(), 'AgentHub', 'opencode-runtime')
  mkdirSync(dir, { recursive: true })
  const path = resolve(
    dir,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${modelTarget.providerKey}-${safeFileName(modelTarget.modelId)}.json`,
  )
  const useAnthropicSdk = isAnthropicLike(modelTarget.provider, modelTarget.anthropicBaseUrl)
  const rawBaseUrl = useAnthropicSdk
    ? (modelTarget.anthropicBaseUrl ?? modelTarget.openaiBaseUrl)
    : (modelTarget.openaiBaseUrl ?? modelTarget.anthropicBaseUrl)
  const baseUrl = useAnthropicSdk ? normalizeAnthropicOpencodeBaseUrl(rawBaseUrl) : rawBaseUrl
  const modelRef = `${modelTarget.providerKey}/${modelTarget.modelId}`
  const apiKey = modelTarget.apiKey?.trim() || readEnv('AGENTHUB_MODEL_API_KEY') || ''
  writeFileSync(
    path,
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: modelRef,
        small_model: modelRef,
        provider: {
          [modelTarget.providerKey]: {
            name: modelTarget.provider,
            options: {
              baseURL: baseUrl,
              apiKey,
            },
            models: {
              [modelTarget.modelId]: {},
            },
            ...(useAnthropicSdk
              ? { npm: '@ai-sdk/anthropic' }
              : { npm: '@ai-sdk/openai-compatible' }),
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  return path
}

function normalizeAnthropicOpencodeBaseUrl(baseUrl?: string) {
  const normalized = baseUrl?.trim().replace(/\/+$/, '')
  if (!normalized) return normalized
  if (/\/v\d+(?:\/)?$/i.test(normalized)) return normalized
  if (/\/v\d+\/messages$/i.test(normalized)) return normalized.replace(/\/messages$/i, '')
  return `${normalized}/v1`
}

function isProviderMatching(envKey: string, provider?: string, baseUrl?: string) {
  if (envKey === 'ANTHROPIC_API_KEY') {
    return provider === 'anthropic' || baseUrl?.includes('anthropic.com')
  }
  if (envKey === 'OPENAI_API_KEY') {
    return provider === 'openai' || baseUrl?.includes('openai.com')
  }
  if (envKey === 'GEMINI_API_KEY') {
    return provider === 'gemini' || provider === 'google'
  }
  // OpenCode / others: any provider is fine
  return true
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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
  return (
    Bun.env.AGENTHUB_CODEX_CONFIG_HOME?.trim() ||
    Bun.env.CODEX_HOME?.trim() ||
    resolve(homedir(), '.codex')
  )
}

function codexRuntimeHome() {
  return (
    Bun.env.AGENTHUB_CODEX_RUNTIME_HOME?.trim() ||
    resolve(Bun.env.LOCALAPPDATA?.trim() || tmpdir(), 'AgentHub', 'codex-runtime')
  )
}

function prepareCodexRuntimeHome(
  modelTarget?: CodeAgentModelTarget | null,
  skipLocalConfig = false,
) {
  const sourceHome = codexConfigHome()
  const runtimeHome = resolve(
    codexRuntimeHome(),
    `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(runtimeHome, { recursive: true })
  if (modelTarget) {
    writeFileSync(resolve(runtimeHome, 'config.toml'), buildCodexRuntimeConfig(modelTarget), 'utf8')
  } else if (!skipLocalConfig) {
    syncCodexRuntimeFile(sourceHome, runtimeHome, 'config.toml')
  }
  syncCodexRuntimeFile(sourceHome, runtimeHome, 'auth.json')
  return runtimeHome
}

function buildCodexRuntimeConfig(modelTarget: CodeAgentModelTarget) {
  const providerName =
    modelTarget.providerKey === 'openai' ? 'openai' : `agenthub-${modelTarget.providerKey}`
  const lines = [
    `model_provider = "${escapeToml(providerName)}"`,
    `model = "${escapeToml(modelTarget.modelId)}"`,
  ]
  if (providerName !== 'openai') {
    lines.push(
      '',
      `[model_providers.${providerName}]`,
      `name = "${escapeToml(modelTarget.provider)}"`,
      `base_url = "${escapeToml(modelTarget.openaiBaseUrl ?? modelTarget.anthropicBaseUrl ?? '')}"`,
      'env_key = "AGENTHUB_MODEL_API_KEY"',
      'wire_api = "responses"',
    )
  }
  return `${lines.join('\n')}\n`
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

function resolveExecutionCwd(envelope?: AgentExecutionEnvelope) {
  if (!envelope) {
    return { cwd: undefined, label: '(无执行信封)', valid: false }
  }

  try {
    validateEnvelope(envelope)
  } catch (err: any) {
    return { cwd: undefined, label: err?.message ?? '信封校验失败', valid: false }
  }

  return buildExecutionCwd(envelope)
}

function resolveProjectFallbackCwd() {
  const candidates = [
    Bun.env.PROJECT_ROOT?.trim(),
    process.env.PROJECT_ROOT?.trim(),
    projectRoot,
    sourceProjectRoot,
  ].filter(Boolean) as string[]

  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate) || isRuntimeDataDir(candidate)) continue
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // Ignore invalid candidates.
    }
  }

  return undefined
}

function isRuntimeDataDir(candidate: string) {
  const appDataDir =
    Bun.env.AGENTHUB_APP_DATA_DIR?.trim() || process.env.AGENTHUB_APP_DATA_DIR?.trim()
  if (!appDataDir) return false
  const normalizedCandidate = candidate
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase()
  const normalizedAppData = appDataDir
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase()
  return (
    normalizedCandidate === normalizedAppData ||
    normalizedCandidate.startsWith(`${normalizedAppData}\\`)
  )
}

function previewCommand(
  adapter: CodeAgentAdapter,
  cwd?: string,
  sandboxPolicy?: AgentRunProfile['sandboxPolicy'],
  modelTarget?: CodeAgentModelTarget | null,
) {
  return formatCommand(
    adapter.command,
    adapter.buildArgs('<task-prompt>', {
      cwd,
      modelId: modelTarget?.modelId,
      modelProvider: modelTarget?.providerKey,
      sandboxPolicy,
    }),
  )
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args.map(shellQuote)].join(' ')
}

function shellQuote(value: string) {
  if (/^[a-zA-Z0-9_./:@=\\-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function safeProviderKey(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'agenthub'
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'model'
}

function isAnthropicLike(provider?: string, baseUrl?: string) {
  const normalized = provider?.toLowerCase()
  return (
    normalized === 'anthropic' ||
    normalized === 'claude' ||
    Boolean(baseUrl?.includes('anthropic.com') || baseUrl?.includes('/anthropic'))
  )
}

function escapeToml(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function toCodexSandbox(sandboxPolicy?: AgentRunProfile['sandboxPolicy']) {
  if (sandboxPolicy === 'danger-full-access') return 'danger-full-access'
  if (sandboxPolicy === 'read-only') return 'read-only'
  return 'workspace-write'
}

type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'

function resolveClaudePermissionMode(
  sandboxPolicy?: AgentRunProfile['sandboxPolicy'],
  cfg: Record<string, unknown> = {},
): ClaudePermissionMode {
  if (sandboxPolicy === 'read-only') return 'plan'

  const configured =
    readStringConfig(cfg, 'permissionMode') ??
    readStringConfig(cfg, 'permission-mode') ??
    readStringConfig(cfg, 'permissions')
  if (configured) {
    const normalized = normalizeClaudePermissionMode(configured)
    if (normalized) return normalized
  }

  if (cfg['skipPermissions'] === true || cfg['dangerouslySkipPermissions'] === true) {
    return 'bypassPermissions'
  }

  return 'acceptEdits'
}

function normalizeClaudePermissionMode(value: string): ClaudePermissionMode | null {
  const normalized = value
    .trim()
    .replace(/[\s_-]+/g, '')
    .toLowerCase()
  if (!normalized) return null
  if (normalized === 'default') return 'default'
  if (normalized === 'acceptedits' || normalized === 'accept') return 'acceptEdits'
  if (normalized === 'plan' || normalized === 'readonly' || normalized === 'read') return 'plan'
  if (normalized === 'auto') return 'auto'
  if (normalized === 'dontask' || normalized === 'dontprompt') return 'dontAsk'
  if (
    normalized === 'bypasspermissions' ||
    normalized === 'bypass' ||
    normalized === 'danger' ||
    normalized === 'dangerfullaccess' ||
    normalized === 'skippermissions'
  ) {
    return 'bypassPermissions'
  }
  return null
}

function normalizeStringList(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\n;]/)
      : []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of rawItems) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function readStringConfig(cfg: Record<string, unknown>, key: string) {
  const value = cfg[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function withExtractedLastMessage(result: { code: number; output: string }): {
  code: number
  output: string
  finalMessage?: string
} {
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
  const matches = [
    ...output.matchAll(
      /(?:^|\n)\[[^\]]+\]\s*codex\s*\n\n([\s\S]*?)(?=\n\[[^\]]+\]\s*(?:user|codex|exec)\b|\n\d{4}-\d{2}-\d{2}T|\nERROR:|\nWARN |\nWarning:|$)/gi,
    ),
  ]
  const message = matches
    .map((match) => stripToolNoise(match[1] ?? '').trim())
    .filter(Boolean)
    .pop()
  return message || undefined
}

function isCodeAgentFailureOutput(output: string) {
  return /ERROR:|stream error|exceeded retry limit|unexpected status|Unauthorized|Missing bearer|invalid function arguments|Error loading config\.toml|No such file or directory|CommandNotFoundException|ObjectNotFound: \(node:String\)|not recognized as an internal or external command|无法将.*识别为|找不到.*命令/i.test(
    output,
  )
}

function stripToolNoise(output: string) {
  const withoutBlocks = stripCodexPromptEcho(stripLastMessageBlock(output))
  return stripTerminalControls(withoutBlocks)
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
      if (/^\{"type":"(?:system|assistant|result|stream_event|error)"/.test(trimmed)) return false
      if (
        /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id|Project workspace path|Allowed tool scopes|Capabilities|Sandbox policy):/i.test(
          trimmed,
        )
      ) {
        return false
      }
      if (/^(Follow the project instructions|Use the actual project path)/i.test(trimmed))
        return false
      if (/^(stream error|ERROR:|WARN |Warning: no last agent message)/i.test(trimmed)) return false
      if (/^(exec |mcp_connection_manager|new_stdio_client)/i.test(trimmed)) return false
      if (/^(use_rmcp_client|startup_timeout|params: InitializeRequestParams)/i.test(trimmed))
        return false
      if (
        /codex_core::mcp_connection_manager|McpServerConfig|node_repl|InitializeRequestParams/i.test(
          trimmed,
        )
      )
        return false
      if (/^-{4,}$/.test(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()
}

function stripCodexPromptEcho(output: string) {
  return output
    .replace(
      /User instructions:[\s\S]*?(?=\n(?:\[\d{4}-\d{2}-\d{2}T|OpenAI Codex v|ERROR:|WARN |Warning:|codex\n|$))/gi,
      '\n',
    )
    .replace(
      /Recent group context:[\s\S]*?(?=\nCurrent user request:|\n\[|\nERROR:|\nWARN |$)/gi,
      '\n',
    )
    .replace(
      /Current user request:[\s\S]*?(?=\n(?:\[\d{4}-\d{2}-\d{2}T|ERROR:|WARN |Warning:|codex\n|$))/gi,
      '\n',
    )
}

function stripReasoningTags(output: string) {
  return output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function formatCodeAgentFailure(adapter: CodeAgentAdapter, result: CodeAgentCommandResult) {
  const friendly = friendlyCodeAgentError(result.output, adapter)
  const hasProducedFiles = (result.metadata.files ?? []).length > 0
  const heading = hasProducedFiles
    ? `**${adapter.displayName} 已结束，但带有警告**`
    : `**${adapter.displayName} 执行失败**`
  const lines = [heading, '', friendly]
  if (hasProducedFiles) {
    lines.push('', `已产出 ${result.metadata.files.length} 个文件/变更，退出码：${result.code}`)
  } else {
    lines.push('', `退出码：${result.code}`)
  }
  return lines.join('\n')
}

function buildCodeAgentCompletionMessage(metadata: CodeAgentRunMetadata, fallback: string) {
  const files = metadata.files ?? []
  const commands = metadata.commands ?? []
  const visibleFallback = sanitizeCodeAgentFallbackText(fallback)
  if (!files.length && visibleFallback) return limitFinalOutput(visibleFallback)

  const lines = ['Coding Tools 已执行完成。']
  if (metadata.runtime) lines.push(`运行时：${metadata.runtime}`)
  if (files.length > 0) {
    lines.push('')
    lines.push('变更文件：')
    for (const file of files.slice(0, 12)) {
      lines.push(`- ${file.status}：${file.path}`)
    }
  }
  if (commands.length > 0) {
    lines.push('')
    lines.push('执行过的命令：')
    for (const command of commands.slice(0, 8)) {
      lines.push(`- ${command.command}`)
    }
  }
  if (!files.length && !commands.length) {
    lines.push('')
    lines.push('没有检测到文件变更或可展示的最终正文。详细过程可展开运行卡片查看。')
  }
  return lines.join('\n')
}

function sanitizeCodeAgentFallbackText(value: string) {
  const cleaned = stripTerminalControls(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(Read|Write|Edit|Bash|TodoWrite|Task|Grep|Glob)\b/i.test(line))
    .filter((line) => !/^(node|npm|bun|git|powershell|cmd)(\.exe)?\s/i.test(line))
    .filter(
      (line) =>
        !/CommandNotFoundException|ObjectNotFound|CategoryInfo|FullyQualifiedErrorId/i.test(line),
    )
    .join('\n')
    .trim()
  if (!cleaned) return ''
  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
  return paragraphs.at(-1) ?? cleaned
}

function cleanDiagnosticOutput(output: string) {
  const claudeMessage = extractClaudeResultMessage(output)
  const cleanedLines = stripToolNoise(stripLastMessageBlock(output))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^You are |^Role: |^System prompt: |^Project workspace path: |^Allowed tool scopes:|^Capabilities:|^Sandbox policy:|^Recent group context:|^Current user request:/i.test(
          line,
        ),
    )
    .filter((line) => !/^(user|agent|assistant|system)\s*:/i.test(line))
    .filter((line) => !/^(Follow the project instructions|Use the actual project path)/i.test(line))
    .filter(
      (line) =>
        !/codex_core::mcp_connection_manager|McpServerConfig|node_repl|InitializeRequestParams/i.test(
          line,
        ),
    )
  const diagnosticLines = cleanedLines.filter((line) =>
    /error|failed|unexpected|unauthorized|not found|timed out|wire_api|missing bearer|invalid|No such file|status \d{3}|exited/i.test(
      line,
    ),
  )
  const cleaned = [claudeMessage, ...(diagnosticLines.length ? diagnosticLines : cleanedLines)]
    .filter(Boolean)
    .join('\n')
  return limitOutput(cleaned, 2000)
}

function friendlyCodeAgentError(output: string, adapter?: CodeAgentAdapter) {
  const cliName = adapter?.displayName ?? 'Coding Tools'
  if (
    /issue with the selected model|may not exist|Run --model to pick a different model/i.test(
      output,
    )
  ) {
    return [
      '当前 Coding Tools 使用的模型名称不被该 CLI 端点接受。',
      'AgentHub 会在执行前拦截非原生模型并尝试改用 OpenCode；如果仍看到这个错误，通常是本机 CLI 配置里残留了不兼容模型。请清理该 CLI 的本机 model 配置，或把这个 Agent 的 Coding Tools 改为 OpenCode。',
    ].join('\n')
  }
  if (/unsupported_vendor|specified model is not supported at this endpoint/i.test(output)) {
    return [
      'Claude Code 使用的端点拒绝了当前模型名。Claude Code 只能稳定运行 Claude/Anthropic 原生模型，非原生模型应交给 OpenCode。',
      '请把这个 Agent 的 Coding Tools 改为 OpenCode，或把 Agent 模型换成 Claude Code 原生支持的 Claude/Sonnet/Opus/Haiku 模型。',
    ].join('\n')
  }
  if (/Coding Tools timed out after/i.test(output)) {
    return `${cliName} 已启动，但 CLI 在限定时间内没有返回结果，已自动停止。可以稍后重试，或把该 Agent 切到 OpenCode / Claude Code。`
  }
  if (
    /CommandNotFoundException|ObjectNotFound: \(node:String\)|node.*not recognized|无法将.*node|找不到.*node/i.test(
      output,
    )
  ) {
    return `${cliName} 已启动，但执行环境里找不到 node 命令。已补充 Windows Path/ComSpec/SystemRoot 等环境变量透传；请重启 dev server 后再试。如果仍失败，请确认本机 Node.js 已安装并在系统 Path 中。`
  }
  if (/invalid function arguments json|string, tool_call_id/i.test(output)) {
    return [
      `${cliName} 已启动，但当前模型生成了无效的工具调用参数，供应商接口拒绝了这次请求。`,
      '这通常不是工作区路径问题。建议切换到更兼容 Codex 工具调用的模型，或把这个 Agent 临时改为 OpenCode / Claude Code 执行。',
    ].join('\n')
  }
  if (/401 Unauthorized|Missing bearer|basic authentication/i.test(output)) {
    return `${cliName} 已启动，但供应商鉴权失败。请检查本机 API Key、Base URL 和模型是否匹配。`
  }
  if (/wire_api = "chat" is no longer supported/i.test(output)) {
    return `当前 ${cliName} 不支持这个 provider 配置里的 wire_api=chat。请使用已降级的 Codex CLI，或切换到支持 Responses 的 OpenAI 端点。`
  }
  if (/webfetch failed|web fetch failed|fetch failed|status code 404|http 404|GET .*404/i.test(output)) {
    return `${cliName} 已启动，但网页抓取失败。请检查目标网址是否可访问；如果已经生成了文件，产物会保留在工作目录中。`
  }
  if (
    /(?:model|模型|base url|endpoint).*?(?:not found|does not exist|unknown model|404)/i.test(
      output,
    ) ||
    /issue with the selected model|may not exist|Run --model to pick a different model/i.test(
      output,
    )
  ) {
    return `${cliName} 已启动，但当前模型或 Base URL 不可用。请检查模型名称和供应商地址。`
  }
  if (/No such file or directory|cannot find the path|系统找不到指定的路径/i.test(output)) {
    return `${cliName} 已启动，但项目目录不存在。请重新打开或选择正确的工作区文件夹。`
  }
  return `${cliName} 已启动，但 CLI 执行过程返回了错误。`
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
  if (max <= 0 || output.length <= max) return output
  return `${output.slice(0, max)}\n... 输出已截断 ...`
}

function limitFinalOutput(output: string) {
  return limitOutput(output, env.AGENTHUB_CODE_AGENT_OUTPUT_LIMIT)
}
