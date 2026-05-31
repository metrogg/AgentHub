import { db, messages, sessions, sessionMembers, settings, eq, and, desc, asc } from '@agenthub/db'
import { logger } from '../lib/logger'
import type { ServerWebSocket } from 'bun'
import { runtimeRegistry } from './runtime'
import type { AgentProfile, AgentOutputChunk } from './runtime'
import { WsEvent, SenderType, MessageType } from '@agenthub/shared'

export interface MessageRow {
  id: string
  sessionId: string
  senderId: string
  senderType: 'user' | 'agent' | 'system'
  type: string
  content: string
  metadata: Record<string, unknown> | null
  isPinned?: boolean
  replyToMessageId?: string | null
  createdAt: Date
}

// 保持向后兼容：AgentRunProfile 是 AgentProfile 的别名
export type AgentRunProfile = AgentProfile

export interface AgentRunResult {
  ok: boolean
  cancelled?: boolean
  messageId?: string
}

export const __agentRunnerTestHooks = {
  looksLikeAgentFailure,
}

const sessionRooms = new Map<string, Set<ServerWebSocket<unknown>>>()
const activeRuns = new Map<string, { cancelled: boolean; controller: AbortController }>()
const runLocks = new Map<string, Promise<void>>()

async function withRunLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  while (runLocks.has(sessionId)) {
    await runLocks.get(sessionId)!
  }
  let release: () => void
  const lock = new Promise<void>((resolve) => {
    release = resolve
  })
  runLocks.set(sessionId, lock)
  try {
    return await fn()
  } finally {
    runLocks.delete(sessionId)
    release!()
  }
}

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
      try {
        ws.send(payload)
      } catch {
        // WebSocket may close between readyState check and send; ignore.
      }
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

import type { AgentExecutionEnvelope } from './execution/agent-execution-envelope'
import { DEFAULT_ENV_ALLOWLIST } from './execution/agent-execution-envelope'
import { gitBranchManager } from './git/branch-manager'
import { isCodeAgentProfile } from './runtime'
import { buildA2AAgentMessage } from './protocols/a2a-internal'

export async function runAgentReply(
  sessionId: string,
  userMsg: MessageRow,
  profile?: AgentProfile,
  envelope?: AgentExecutionEnvelope,
): Promise<AgentRunResult> {
  return withRunLock(sessionId, () => _runAgentReply(sessionId, userMsg, profile, envelope))
}

async function _runAgentReply(
  sessionId: string,
  userMsg: MessageRow,
  profile?: AgentProfile,
  envelope?: AgentExecutionEnvelope,
): Promise<AgentRunResult> {
  cancelAgentReply(sessionId)
  const run = { cancelled: false, controller: new AbortController() }
  activeRuns.set(sessionId, run)

  const agentId = profile?.id ?? 'claude'
  const agentName = profile?.name ?? 'Claude'
  logger.info({ sessionId, msgId: userMsg.id, agentId }, 'Agent reply started')

  const pinned = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.isPinned, true)))
    .orderBy(asc(messages.createdAt))

  // 修复 Bug 19: 增加历史消息限制到 50 条，减少上下文丢失
  const recent = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(50)

  const seen = new Set<string>()
  const historyAsc: typeof pinned = []
  for (const m of pinned) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      historyAsc.push(m)
    }
  }
  for (const m of recent.slice().reverse()) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      historyAsc.push(m)
    }
  }

  // Task #38: Handoff 上下文裁剪 — 群聊多 Agent 场景下只传摘要+refs
  const isGroupSession = await checkIsGroupSession(sessionId)
  const trimmedHistory = isGroupSession ? trimHistoryForHandoff(historyAsc) : historyAsc

  // 检测是否是继续输出：如果用户回复了一条 agent 消息，且该消息包含 codeAgentRun.sessionId，则为继续输出
  let isContinueSession = false
  if (userMsg.replyToMessageId && profile?.runtimeType === 'code-agent') {
    const repliedTo = historyAsc.find((m) => m.id === userMsg.replyToMessageId)
    if (repliedTo?.metadata && typeof repliedTo.metadata === 'object') {
      const metadata = repliedTo.metadata as Record<string, unknown>
      const codeAgentRun = metadata.codeAgentRun as Record<string, unknown> | undefined
      if (codeAgentRun?.sessionId && typeof codeAgentRun.sessionId === 'string') {
        isContinueSession = true
        logger.info({ sessionId, replyToMessageId: userMsg.replyToMessageId, claudeSessionId: codeAgentRun.sessionId }, 'Continuing Claude Code session')
      }
    }
  }

  const streamMsgId = crypto.randomUUID()

  broadcast(sessionId, {
    type: WsEvent.AgentTyping,
    payload: { sessionId, agentId, agentName },
  })

  let fullContent = ''
  let failed = false
  let codeAgentRun: Record<string, unknown> | null = null
  const artifacts: Array<Record<string, unknown>> = []

  try {
    if (profile) {
      const profileWithUserMemory = await withUserProfileContext(profile)
      const runtime = runtimeRegistry.resolveForProfile(profileWithUserMemory)
      const promptWithReply = (() => {
        if (!userMsg.replyToMessageId) return userMsg.content
        const repliedTo = historyAsc.find((m) => m.id === userMsg.replyToMessageId)
        if (!repliedTo) return userMsg.content
        const preview = repliedTo.content.slice(0, 200)
        return `[回复 ${repliedTo.senderType === 'user' ? '用户' : 'Agent'}: ${preview}${repliedTo.content.length > 200 ? '...' : ''}]\n${userMsg.content}`
      })()
      const historyWithReply = trimmedHistory
        .filter((m) => m.id !== userMsg.id)
        .map((m) => {
          if (!m.replyToMessageId) return { senderType: m.senderType, content: m.content }
          const repliedTo = trimmedHistory.find((x) => x.id === m.replyToMessageId)
          if (!repliedTo) return { senderType: m.senderType, content: m.content }
          const preview = repliedTo.content.slice(0, 200)
          return {
            senderType: m.senderType,
            content: `[回复 ${repliedTo.senderType === 'user' ? '用户' : 'Agent'}: ${preview}${repliedTo.content.length > 200 ? '...' : ''}]\n${m.content}`,
          }
        })
      const ctx = {
        sessionId,
        prompt: promptWithReply,
        history: historyWithReply,
        profile: profileWithUserMemory,
        signal: run.controller.signal,
        workspacePath: profileWithUserMemory.projectPath ?? null,
        envelope,
        continueSession: isContinueSession,
      }

      for await (const chunk of runtime.execute(ctx)) {
        if (run.cancelled) break
        switch (chunk.kind) {
          case 'text':
            fullContent += chunk.text
            broadcast(sessionId, {
              type: WsEvent.MessageStream,
              payload: { sessionId, messageId: streamMsgId, delta: chunk.text, agentId, agentName },
            })
            break
          case 'metadata':
            if (chunk.metadata && typeof chunk.metadata === 'object') {
              codeAgentRun = chunk.metadata as Record<string, unknown>
              broadcast(sessionId, {
                type: 'message:metadata',
                payload: { sessionId, messageId: streamMsgId, agentId, agentName, codeAgentRun: chunk.metadata },
              })
            }
            break
          case 'artifact':
            artifacts.push(chunk.artifact as unknown as Record<string, unknown>)
            // 修复 Bug 16: 实时广播 artifact 更新
            broadcast(sessionId, {
              type: 'message:metadata',
              payload: { sessionId, messageId: streamMsgId, agentId, agentName, codeAgentRun: { artifacts } },
            })
            break
        }
      }
    } else {
      // 无 profile 时回退到默认 LLM
      const { streamReply } = await import('./llm')
      const { DEFAULT_AGENT_INSTRUCTIONS } = await import('./llm-client')
      const llmMessages = historyAsc.map((m) => {
        let content = m.content
        if (m.replyToMessageId) {
          const repliedTo = historyAsc.find((x) => x.id === m.replyToMessageId)
          if (repliedTo) {
            const preview = repliedTo.content.slice(0, 200)
            content = `[回复 ${repliedTo.senderType === 'user' ? '用户' : 'Agent'}: ${preview}${repliedTo.content.length > 200 ? '...' : ''}]\n${m.content}`
          }
        }
        return {
          role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content,
        }
      })
      const userContext = await userProfileSystemContext()
      const systemContext = userContext ? `${DEFAULT_AGENT_INSTRUCTIONS}\n\n${userContext}` : undefined
      for await (const delta of streamReply(llmMessages, systemContext, undefined, run.controller.signal)) {
        if (run.cancelled) break
        fullContent += delta
        broadcast(sessionId, {
          type: WsEvent.MessageStream,
          payload: { sessionId, messageId: streamMsgId, delta, agentId, agentName },
        })
      }
    }
  } catch (error: any) {
    if (run.cancelled || isAbortError(error)) {
      run.cancelled = true
    } else {
      const message = error?.message || 'Agent 回复失败'
      logger.error({ err: message, sessionId, agentId }, 'Agent reply failed')
      fullContent = `\n\n[错误：${message}]`
    }
  }

  if (activeRuns.get(sessionId) === run) activeRuns.delete(sessionId)
  if (looksLikeAgentFailure(fullContent)) failed = true

  if (run.cancelled) {
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
      type: WsEvent.MessageStream,
      payload: { sessionId, messageId: streamMsgId, delta: fullContent, agentId, agentName },
    })
  }

  const persistedArtifacts = Array.isArray(codeAgentRun?.artifacts)
    ? (codeAgentRun.artifacts as Array<Record<string, unknown>>)
    : artifacts

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
            artifacts: persistedArtifacts,
            a2a: envelope?.a2a
              ? {
                  request: envelope.a2a.params,
                  responseMessage: buildA2AAgentMessage({
                    envelope: envelope.a2a,
                    content: fullContent,
                    messageId: streamMsgId,
                    artifacts: persistedArtifacts,
                  }),
                }
              : undefined,
          }
        : null,
    })
    .returning()

  broadcast(sessionId, {
    type: WsEvent.MessageCompleted,
    payload: { sessionId, message: agentMsg },
  })

  logger.info({ sessionId, msgId: agentMsg?.id, length: fullContent.length }, 'Agent reply completed')
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
    /^\s*\*\*.*执行失败\*\*/i.test(content) ||
    /API key is not configured/i.test(content) ||
    /API Key 未配置/.test(content) ||
    /Model returned an empty response/i.test(content) ||
    /模型返回了空响应/.test(content)
  )
}

async function withUserProfileContext(profile: AgentRunProfile): Promise<AgentRunProfile> {
  const userContext = await userProfileSystemContext()
  if (!userContext) return profile
  return {
    ...profile,
    systemPrompt: [profile.systemPrompt, userContext].filter(Boolean).join('\n\n'),
  }
}

async function userProfileSystemContext() {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'APP_SETTINGS')).limit(1)
  if (!row?.value) return undefined
  try {
    const parsed = JSON.parse(row.value) as { accountName?: unknown; accountMemory?: unknown }
    const name = typeof parsed.accountName === 'string' ? parsed.accountName.trim() : ''
    const memory = typeof parsed.accountMemory === 'string' ? parsed.accountMemory.trim() : ''
    if (!name && !memory) return undefined
    return [
      'USER.md',
      name ? `昵称：${name}` : '',
      memory ? `希望你长期记住的用户偏好：\n${memory}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return undefined
  }
}

/** 检查 session 是否为群聊（多 Agent）会话 */
async function checkIsGroupSession(sessionId: string): Promise<boolean> {
  const [session] = await db
    .select({ type: sessions.type })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  return session?.type === 'group'
}

/**
 * Handoff 上下文裁剪：群聊场景下只传 pinned + 最近 3 条 + 中间消息的摘要
 * 减少 token 消耗，避免下游 Agent 被无关历史淹没
 */
function trimHistoryForHandoff(history: MessageRow[]): MessageRow[] {
  if (history.length <= 6) return history

  const pinned = history.filter((m) => m.isPinned)
  const nonPinned = history.filter((m) => !m.isPinned)
  const recent3 = nonPinned.slice(-3)
  const skipped = nonPinned.slice(0, -3)

  if (skipped.length === 0) return history

  // 从跳过的消息中提取关键信息
  const skippedSummary = skipped
    .map((m) => {
      const sender = m.senderType === 'user' ? '用户' : m.senderType === 'agent' ? 'Agent' : '系统'
      const meta = m.metadata as Record<string, unknown> | null
      const agentName = meta?.agentName ? `(${meta.agentName})` : ''
      // 只保留前 100 字符作为摘要
      const preview = m.content.slice(0, 100).replace(/\n/g, ' ')
      return `- ${sender}${agentName}: ${preview}${m.content.length > 100 ? '...' : ''}`
    })
    .join('\n')

  // 创建摘要消息
  const summaryMsg: MessageRow = {
    id: 'context-summary',
    sessionId: history[0]?.sessionId ?? '',
    senderId: 'system',
    senderType: 'system',
    type: 'text',
    content: `[上下文摘要] 以下是之前 ${skipped.length} 条消息的摘要（已裁剪以节省上下文）：\n${skippedSummary}`,
    metadata: { contextTrimmed: true, originalCount: skipped.length },
    createdAt: new Date(),
  }

  return [...pinned, summaryMsg, ...recent3]
}
