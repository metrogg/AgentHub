import { db, messages, eq, desc } from '@agenthub/db'
import { streamReply } from './llm'
import { isCodeAgentProfile, streamCodeAgentReply, type CodeAgentMetadataChunk } from './code-agent-adapter'
import { isNativeAgentProfile, streamNativeAgentReply } from './native-agent-loop'
import { pushStarOfficeAgentState, starOfficeStateForProfile } from './star-office-bridge'
import { logger } from '../lib/logger'
import type { ServerWebSocket } from 'bun'

export interface MessageRow {
  id: string
  sessionId: string
  senderId: string
  senderType: 'user' | 'agent' | 'system'
  type: string
  content: string
  metadata: Record<string, unknown> | null
  createdAt: Date
}

export interface AgentRunProfile {
  id: string
  name: string
  role?: string
  description?: string
  systemPrompt?: string
  color?: string
  modelId?: string | null
  runtimeType?: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | null
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: 'read-only' | 'workspace-write' | 'danger-full-access'
  contextPolicy?: 'recent-only' | 'pinned-recent' | 'workspace-aware'
  approvalRequired?: boolean
  projectPath?: string | null
}

export interface AgentRunResult {
  ok: boolean
  cancelled?: boolean
  messageId?: string
}

// In-memory map: sessionId -> Set of connected websockets
const sessionRooms = new Map<string, Set<ServerWebSocket<unknown>>>()
const activeRuns = new Map<string, { cancelled: boolean; controller: AbortController }>()

export function joinRoom(sessionId: string, ws: ServerWebSocket<unknown>) {
  const set = sessionRooms.get(sessionId) ?? new Set()
  set.add(ws)
  sessionRooms.set(sessionId, set)
}

export function leaveRoom(sessionId: string, ws: ServerWebSocket<unknown>) {
  const set = sessionRooms.get(sessionId)
  if (set) {
    set.delete(ws)
    if (set.size === 0) sessionRooms.delete(sessionId)
  }
}

export function getRoom(sessionId: string): Set<ServerWebSocket<unknown>> | undefined {
  return sessionRooms.get(sessionId)
}

export function cleanupWebSocket(ws: ServerWebSocket<unknown>) {
  for (const [sessionId, room] of sessionRooms) {
    if (room.has(ws)) {
      room.delete(ws)
      if (room.size === 0) sessionRooms.delete(sessionId)
    }
  }
}

function broadcast(sessionId: string, data: unknown) {
  const room = sessionRooms.get(sessionId)
  if (!room) return
  const payload = JSON.stringify(data)
  for (const ws of room) {
    if (ws.readyState === 1) {
      ws.send(payload)
    }
  }
}

export function broadcastSessionEvent(sessionId: string, data: unknown) {
  broadcast(sessionId, data)
}

export function cancelAgentReply(sessionId: string) {
  const run = activeRuns.get(sessionId)
  if (!run) return false
  run.cancelled = true
  run.controller.abort(new Error('用户已停止 Agent 运行'))
  broadcast(sessionId, {
    type: 'message:cancelled',
    payload: { sessionId },
  })
  logger.info({ sessionId }, 'Agent reply cancelled')
  return true
}

export function getActiveRunSessionIds() {
  return Array.from(activeRuns.keys())
}

function buildAgentSystem(profile?: AgentRunProfile) {
  if (!profile) return undefined
  return [
    profile.systemPrompt || `你是 ${profile.name}，AgentHub 中的协作智能体。`,
    profile.role ? `你在群聊中的角色：${profile.role}。` : '',
    profile.description ? `能力摘要：${profile.description}。` : '',
    profile.runtimeType ? `运行时绑定：${profile.runtimeType}${profile.codeAgentType ? `（${profile.codeAgentType}）` : ''}。` : '',
    profile.capabilityTags?.length ? `能力标签：${profile.capabilityTags.join('、')}。` : '',
    profile.toolPermissions?.length ? `允许的工具范围：${profile.toolPermissions.join('、')}。` : '允许的工具范围：仅聊天。',
    profile.sandboxPolicy ? `沙箱策略：${profile.sandboxPolicy}。` : '',
    profile.contextPolicy ? `上下文策略：${profile.contextPolicy}。` : '',
    profile.projectPath ? `项目工作区路径：${profile.projectPath}。` : '',
    profile.approvalRequired
      ? '如果用户请求可能修改文件、运行命令、访问网络、部署或接触密钥，请先请求用户明确确认，再执行或给出执行指令。'
      : '',
    '你正在多 Agent 群聊中回复。请聚焦自己的角色，用中文给出清晰、可执行的回答；如需要其他 Agent 接续，请明确写出交接需求。',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runAgentReply(sessionId: string, userMsg: MessageRow, profile?: AgentRunProfile): Promise<AgentRunResult> {
  cancelAgentReply(sessionId)
  const run = { cancelled: false, controller: new AbortController() }
  activeRuns.set(sessionId, run)

  const agentId = profile?.id ?? 'claude'
  const agentName = profile?.name ?? 'Claude'
  logger.info({ sessionId, msgId: userMsg.id, agentId }, 'Agent reply started')
  void pushStarOfficeAgentState(profile, starOfficeStateForProfile(profile), `${agentName} 正在处理任务`)

  // Fetch recent message history as context
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(20)

  const historyAsc = history.slice().reverse()

  const llmMessages = historyAsc.map((m) => ({
    role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.content,
  }))

  // Generate a temporary streaming message ID
  const streamMsgId = crypto.randomUUID()

  // Notify frontend that agent is typing
  broadcast(sessionId, {
    type: 'agent:typing',
    payload: { sessionId, agentId, agentName },
  })

  let fullContent = ''
  let failed = false
  let codeAgentRun: CodeAgentMetadataChunk['metadata'] | null = null
  const selectedModelId =
    profile?.modelId ?? (typeof userMsg.metadata?.modelId === 'string' ? userMsg.metadata.modelId : undefined)
  const replyStream =
    profile && isCodeAgentProfile(profile)
      ? streamCodeAgentReply(profile, userMsg, historyAsc, run.controller.signal)
      : profile && isNativeAgentProfile(profile)
      ? streamNativeAgentReply(profile, userMsg, historyAsc, run.controller.signal)
      : streamReply(llmMessages, buildAgentSystem(profile), selectedModelId, run.controller.signal)

  try {
    for await (const delta of replyStream) {
      if (run.cancelled) break
      if (typeof delta !== 'string') {
        if (delta.kind === 'code-agent-metadata') {
          codeAgentRun = delta.metadata
          broadcast(sessionId, {
            type: 'message:metadata',
            payload: { sessionId, messageId: streamMsgId, codeAgentRun },
          })
        }
        continue
      }
      fullContent += delta
      broadcast(sessionId, {
        type: 'message:stream',
        payload: { sessionId, messageId: streamMsgId, delta },
      })
    }
  } catch (error: any) {
    if (run.cancelled || isAbortError(error)) {
      run.cancelled = true
    } else {
      const message = error?.message || 'Agent 回复失败'
      logger.error({ err: message, sessionId, agentId }, 'Agent reply failed')
      void pushStarOfficeAgentState(profile, 'error', `${agentName} 执行失败：${message}`)
      fullContent = `\n\n[错误：${message}]`
    }
  }

  if (activeRuns.get(sessionId) === run) activeRuns.delete(sessionId)
  if (looksLikeAgentFailure(fullContent)) failed = true

  if (run.cancelled) {
    void pushStarOfficeAgentState(profile, 'idle', `${agentName} 已停止`)
    if (!fullContent.trim()) {
      broadcast(sessionId, {
        type: 'message:cancelled',
        payload: { sessionId },
      })
      return { ok: false, cancelled: true }
    }
    fullContent = `${fullContent.trimEnd()}\n\n[用户已停止]`
  }

  if (!fullContent.trim()) {
    fullContent = '[错误：模型返回了空响应。请检查当前供应商、模型 ID、Base URL 和 API Key。]'
    broadcast(sessionId, {
      type: 'message:stream',
      payload: { sessionId, messageId: streamMsgId, delta: fullContent },
    })
  }

  // Save the final agent message to DB
  const [agentMsg] = await db
    .insert(messages)
    .values({
      sessionId,
      senderId: agentId,
      senderType: 'agent',
      type: 'text',
      content: fullContent,
      metadata: profile
        ? {
            agentName,
            role: profile.role ?? null,
            color: profile.color ?? null,
            runtimeType: profile.runtimeType ?? 'llm',
            codeAgentType: profile.codeAgentType ?? null,
            modelId: profile.modelId ?? null,
            sandboxPolicy: profile.sandboxPolicy ?? null,
            projectPath: profile.projectPath ?? null,
            codeAgentRun,
            artifacts: codeAgentRun?.artifacts ?? [],
          }
        : null,
    })
    .returning()

  broadcast(sessionId, {
    type: 'message:completed',
    payload: { sessionId, message: agentMsg },
  })

  logger.info({ sessionId, msgId: agentMsg?.id, length: fullContent.length }, 'Agent reply completed')
  void pushStarOfficeAgentState(profile, 'idle', `${agentName} 已完成任务`)
  return { ok: !failed, cancelled: false, messageId: agentMsg?.id }
}

function isAbortError(error: any) {
  return error?.name === 'AbortError' || /abort|cancel/i.test(error?.message || '')
}

function looksLikeAgentFailure(content: string) {
  return (
    /^\s*\[Error:/i.test(content) ||
    /\n\s*\[Error:/i.test(content) ||
    /^\s*\[错误[：:]/i.test(content) ||
    /\n\s*\[错误[：:]/i.test(content) ||
    /API key is not configured/i.test(content) ||
    /API Key 未配置/.test(content) ||
    /Model returned an empty response/i.test(content) ||
    /模型返回了空响应/.test(content)
  )
}
