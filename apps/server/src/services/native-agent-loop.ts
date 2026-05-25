import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../env'
import { logger } from '../lib/logger'
import type { AgentRunProfile, MessageRow } from './agent-runner'
import { resolveLlmRuntimeConfig, redactSensitive, type LLMMessage, type LlmRuntimeConfig } from './llm-client'
import { globalSkillRegistry } from './skill-registry'
import { createToolExecutionContext, readOnlyToolRegistry, type JsonObject, type ToolDefinition } from './tool-registry'

type ChatRole = 'user' | 'assistant' | 'tool'

interface NativeChatMessage {
  role: ChatRole
  content?: string | AnthropicContentBlock[]
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: JsonObject
  content?: string
}

const serviceDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(serviceDir, '../../../..')

export function isNativeAgentProfile(profile?: AgentRunProfile) {
  if (!profile) return false
  const permissions = normalizePermissions(profile.toolPermissions)
  if (profile.runtimeType === 'mcp') return true
  return permissions.some((permission) =>
    ['native', 'tools', 'read-only', 'workspace:read', 'skills:read', 'list_files', 'read_file', 'search_code'].includes(permission)
  )
}

export async function* streamNativeAgentReply(
  profile: AgentRunProfile,
  userMsg: MessageRow,
  history: Array<{ senderType: string; content: string }>,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  const cwdInfo = resolveExecutionCwd(profile.projectPath)
  if (!cwdInfo.valid || !cwdInfo.cwd) {
    yield `原生只读 Agent 无法启动：项目目录无效（${cwdInfo.label}）。`
    return
  }

  const config = await resolveLlmRuntimeConfig(profile.modelId ?? undefined)
  if (!config.apiKey) {
    yield 'API Key 未配置。请在环境变量中设置 LLM_API_KEY 或 OPENAI_API_KEY 等供应商专用 Key，然后重启服务。'
    return
  }

  const permissions = normalizePermissions(profile.toolPermissions)
  const defaultReadOnlyPermissions =
    profile.runtimeType === 'mcp' && (permissions.length === 0 || (permissions.length === 1 && permissions.includes('chat')))
  const allowedTools = readOnlyToolRegistry.allowedTools(
    defaultReadOnlyPermissions ? ['workspace:read', 'skills:read'] : permissions,
    { readOnlyOnly: true }
  )
  const skillContext = await globalSkillRegistry.buildSkillContext(
    [profile.systemPrompt, profile.description, userMsg.content, history.slice(-6).map((item) => item.content).join('\n')].filter(Boolean).join('\n\n'),
    { capabilityTags: profile.capabilityTags, limit: 2 }
  )
  const system = buildNativeSystemPrompt(profile, cwdInfo.cwd, allowedTools, skillContext)
  const messages = history.map((message) => ({
    role: (message.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: message.content,
  }))

  try {
    const output = isAnthropicProvider(config)
      ? await runAnthropicNativeLoop(config, system, messages, allowedTools, cwdInfo.cwd, signal)
      : await runOpenAINativeLoop(config, system, messages, allowedTools, cwdInfo.cwd, signal)
    yield output.trim() || '（原生 Agent 已完成，但没有返回文本内容。）'
  } catch (error: any) {
    const message = redactSensitive(error?.message || '原生 Agent 循环失败', [config.apiKey])
    logger.error({ err: message, provider: config.provider, model: config.model }, 'Native agent loop error')
    yield `\n\n[原生 Agent 错误：${message}]`
  }
}

async function runOpenAINativeLoop(
  config: LlmRuntimeConfig,
  system: string,
  inputMessages: LLMMessage[],
  tools: ToolDefinition[],
  cwd: string,
  signal?: AbortSignal
) {
  const messages: NativeChatMessage[] = inputMessages.map((message) => ({ role: message.role, content: message.content }))
  let finalText = ''

  for (let round = 0; round < env.AGENTHUB_NATIVE_MAX_TOOL_ROUNDS; round += 1) {
    const body: JsonObject = {
      model: config.model,
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
      stream: false,
    }
    if (tools.length) body.tools = tools.map(openAIToolSchema)

    throwIfAborted(signal)
    const parsed = await postJson(`${config.baseUrl}/chat/completions`, body, buildHeaders(config), config.timeoutMs, signal)
    const message = firstChoiceMessage(parsed)
    finalText = typeof message.content === 'string' ? message.content : finalText
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as OpenAIToolCall[] : []

    if (!toolCalls.length) return finalText

    messages.push({
      role: 'assistant',
      content: finalText || '',
      tool_calls: toolCalls,
    })

    for (const call of toolCalls) {
      const result = await executeToolCall(call.function.name, parseToolArguments(call.function.arguments), tools, cwd)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      })
    }
  }

  return `${finalText}\n\n[原生工具循环已在 ${env.AGENTHUB_NATIVE_MAX_TOOL_ROUNDS} 轮后停止。]`
}

async function runAnthropicNativeLoop(
  config: LlmRuntimeConfig,
  system: string,
  inputMessages: LLMMessage[],
  tools: ToolDefinition[],
  cwd: string,
  signal?: AbortSignal
) {
  const messages: NativeChatMessage[] = inputMessages.map((message) => ({ role: message.role, content: message.content }))
  let finalText = ''

  for (let round = 0; round < env.AGENTHUB_NATIVE_MAX_TOOL_ROUNDS; round += 1) {
    const body: JsonObject = {
      model: config.model,
      max_tokens: 4096,
      system,
      messages,
    }
    if (tools.length) body.tools = tools.map(anthropicToolSchema)

    throwIfAborted(signal)
    const parsed = await postJson(`${config.baseUrl}/v1/messages`, body, buildHeaders(config), config.timeoutMs, signal)
    const blocks = Array.isArray(parsed.content) ? parsed.content as AnthropicContentBlock[] : []
    const text = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('')
    if (text) finalText = text

    const toolUses = blocks.filter((block) => block.type === 'tool_use' && block.id && block.name)
    if (!toolUses.length) return finalText

    messages.push({ role: 'assistant', content: blocks })
    const toolResults: AnthropicContentBlock[] = []
    for (const toolUse of toolUses) {
      const result = await executeToolCall(toolUse.name!, toolUse.input ?? {}, tools, cwd)
      toolResults.push({
        type: 'tool_result',
        id: toolUse.id,
        content: result,
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return `${finalText}\n\n[原生工具循环已在 ${env.AGENTHUB_NATIVE_MAX_TOOL_ROUNDS} 轮后停止。]`
}

async function executeToolCall(name: string, input: JsonObject, allowedTools: ToolDefinition[], cwd: string) {
  const allowed = new Set(allowedTools.map((tool) => tool.name))
  if (!allowed.has(name)) return `工具「${name}」不在当前只读执行环境的允许范围内。`
  try {
    const result = await readOnlyToolRegistry.execute(name, input, createToolExecutionContext(cwd))
    return limitText(result.content, 18_000)
  } catch (error: any) {
    return `工具「${name}」执行失败：${error?.message || '未知错误'}`
  }
}

function buildNativeSystemPrompt(profile: AgentRunProfile, cwd: string, tools: ToolDefinition[], skillContext: string) {
  return [
    profile.systemPrompt || `你是 ${profile.name}，AgentHub 中的协作智能体。`,
    profile.role ? `角色：${profile.role}。` : '',
    profile.description ? `能力摘要：${profile.description}。` : '',
    `项目工作区：${cwd}。`,
    '你正在 AgentHub 原生只读执行环境中运行。',
    '你可以通过提供的只读工具检查工作区文件和 Skills。',
    '不要声称已经修改文件、运行 shell 命令、应用补丁、安装包、部署或访问密钥。如果用户要求改动，请说明应如何改，并标注写入工具需要后续审批流程。',
    tools.length ? `可用只读工具：${tools.map((tool) => tool.name).join('、')}。` : '当前没有启用只读工具。',
    skillContext,
    '除非任务明确要求其他语言，否则请使用中文回复。回答要实用，并基于已检查的文件。',
  ].filter(Boolean).join('\n\n')
}

function openAIToolSchema(tool: ToolDefinition) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

function anthropicToolSchema(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function firstChoiceMessage(parsed: JsonObject) {
  const choices = Array.isArray(parsed.choices) ? parsed.choices : []
  const first = choices[0] as { message?: JsonObject } | undefined
  return first?.message ?? {}
}

async function postJson(
  url: string,
  body: JsonObject,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<JsonObject> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('原生 Agent 请求超时')), timeoutMs)
  const abortFromInput = () => controller.abort(signal?.reason ?? new Error('原生 Agent 请求已中止'))
  if (signal?.aborted) abortFromInput()
  else signal?.addEventListener('abort', abortFromInput, { once: true })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`模型请求失败，状态码 ${res.status}：${text.slice(0, 500)}`)
    }
    return JSON.parse(text) as JsonObject
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromInput)
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error('原生 Agent 请求已中止')
}

function buildHeaders(config: LlmRuntimeConfig): Record<string, string> {
  if (isAnthropicProvider(config)) {
    return {
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': config.apiKey ?? '',
    }
  }
  return {
    authorization: `Bearer ${config.apiKey ?? ''}`,
    'content-type': 'application/json',
  }
}

function isAnthropicProvider(config: LlmRuntimeConfig) {
  const provider = config.provider.toLowerCase()
  return provider === 'anthropic' || provider === 'claude' || config.baseUrl.includes('anthropic.com')
}

function parseToolArguments(value: string): JsonObject {
  if (!value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {}
  } catch {
    return {}
  }
}

function normalizePermissions(values?: string[]) {
  return (values ?? ['chat']).map((value) => value.trim().toLowerCase()).filter(Boolean)
}

function resolveExecutionCwd(projectPath?: string | null) {
  const fallback = existsSync(projectRoot) ? projectRoot : undefined
  const trimmed = projectPath?.trim()
  if (!trimmed) {
    return {
      cwd: fallback,
      label: fallback ?? '（默认工作区）',
      valid: Boolean(fallback),
    }
  }

  const absolute = isAbsolute(trimmed) ? trimmed : resolve(projectRoot, trimmed)
  try {
    const info = statSync(absolute)
    return {
      cwd: info.isDirectory() ? absolute : fallback,
      label: absolute,
      valid: info.isDirectory(),
    }
  } catch {
    return {
      cwd: fallback,
      label: absolute,
      valid: false,
    }
  }
}

function limitText(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n... 输出已截断 ...`
}
