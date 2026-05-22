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
  history: Array<{ senderType: string; content: string }>
): AsyncGenerator<string, void, unknown> {
  const cwdInfo = resolveExecutionCwd(profile.projectPath)
  if (!cwdInfo.valid || !cwdInfo.cwd) {
    yield `Native read-only agent cannot start because the project directory is invalid: ${cwdInfo.label}`
    return
  }

  const config = await resolveLlmRuntimeConfig(profile.modelId ?? undefined)
  if (!config.apiKey) {
    yield 'API key is not configured. Set LLM_API_KEY or a provider-specific key such as OPENAI_API_KEY in the environment, then restart the server.'
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
      ? await runAnthropicNativeLoop(config, system, messages, allowedTools, cwdInfo.cwd)
      : await runOpenAINativeLoop(config, system, messages, allowedTools, cwdInfo.cwd)
    yield output.trim() || '(Native agent finished without a text response.)'
  } catch (error: any) {
    const message = redactSensitive(error?.message || 'Native agent loop failed', [config.apiKey])
    logger.error({ err: message, provider: config.provider, model: config.model }, 'Native agent loop error')
    yield `\n\n[Native agent error: ${message}]`
  }
}

async function runOpenAINativeLoop(
  config: LlmRuntimeConfig,
  system: string,
  inputMessages: LLMMessage[],
  tools: ToolDefinition[],
  cwd: string
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

    const parsed = await postJson(`${config.baseUrl}/chat/completions`, body, buildHeaders(config), config.timeoutMs)
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

  return `${finalText}\n\n[Native harness stopped after ${env.AGENTHUB_NATIVE_MAX_TOOL_ROUNDS} tool rounds.]`
}

async function runAnthropicNativeLoop(
  config: LlmRuntimeConfig,
  system: string,
  inputMessages: LLMMessage[],
  tools: ToolDefinition[],
  cwd: string
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

    const parsed = await postJson(`${config.baseUrl}/v1/messages`, body, buildHeaders(config), config.timeoutMs)
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

  return `${finalText}\n\n[Native harness stopped after ${env.AGENTHUB_NATIVE_MAX_TOOL_ROUNDS} tool rounds.]`
}

async function executeToolCall(name: string, input: JsonObject, allowedTools: ToolDefinition[], cwd: string) {
  const allowed = new Set(allowedTools.map((tool) => tool.name))
  if (!allowed.has(name)) return `Tool "${name}" is not allowed in this read-only harness.`
  try {
    const result = await readOnlyToolRegistry.execute(name, input, createToolExecutionContext(cwd))
    return limitText(result.content, 18_000)
  } catch (error: any) {
    return `Tool "${name}" failed: ${error?.message || 'unknown error'}`
  }
}

function buildNativeSystemPrompt(profile: AgentRunProfile, cwd: string, tools: ToolDefinition[], skillContext: string) {
  return [
    profile.systemPrompt || `You are ${profile.name}, a collaborative agent in AgentHub.`,
    profile.role ? `Role: ${profile.role}.` : '',
    profile.description ? `Capability summary: ${profile.description}.` : '',
    `Project workspace: ${cwd}.`,
    'You are running inside AgentHub native read-only harness.',
    'You may inspect workspace files and skills through the provided read-only tools.',
    'Do not claim to have modified files, run shell commands, applied patches, installed packages, deployed, or accessed secrets. If the user asks for changes, explain what should be changed and note that write tools require the future approval flow.',
    tools.length ? `Available read-only tools: ${tools.map((tool) => tool.name).join(', ')}.` : 'No read-only tools are currently enabled.',
    skillContext,
    'Reply in the same language as the user unless the task requires otherwise. Keep answers practical and grounded in inspected files.',
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

async function postJson(url: string, body: JsonObject, headers: Record<string, string>, timeoutMs: number): Promise<JsonObject> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('native agent request timed out')), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`model request failed with status ${res.status}: ${text.slice(0, 500)}`)
    }
    return JSON.parse(text) as JsonObject
  } finally {
    clearTimeout(timer)
  }
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
      label: fallback ?? '(default workspace)',
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
  return `${value.slice(0, max)}\n... output truncated ...`
}
