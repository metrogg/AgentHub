import { db, messages, eq, desc } from '@agenthub/db'
import { logger } from '../lib/logger'
import type { ServerWebSocket } from 'bun'
import { runtimeRegistry } from './runtime'
import type { AgentProfile, AgentOutputChunk } from './runtime'

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

// 保持向后兼容：AgentRunProfile 是 AgentProfile 的别名
export type AgentRunProfile = AgentProfile

export interface AgentRunResult {
  ok: boolean
  cancelled?: boolean
  messageId?: string
}

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

export async function runAgentReply(
  sessionId: string,
  userMsg: MessageRow,
  profile?: AgentProfile,
): Promise<AgentRunResult> {
  cancelAgentReply(sessionId)
  const run = { cancelled: false, controller: new AbortController() }
  activeRuns.set(sessionId, run)

  const agentId = profile?.id ?? 'claude'
  const agentName = profile?.name ?? 'Claude'
  logger.info({ sessionId, msgId: userMsg.id, agentId }, 'Agent reply started')

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(20)

  const historyAsc = history.slice().reverse()

  const streamMsgId = crypto.randomUUID()

  broadcast(sessionId, {
    type: 'agent:typing',
    payload: { sessionId, agentId, agentName },
  })

  let fullContent = ''
  let failed = false
  let codeAgentRun: Record<string, unknown> | null = null
  const artifacts: Array<Record<string, unknown>> = []

  try {
    if (profile) {
      const runtime = runtimeRegistry.resolveForProfile(profile)
      const ctx = {
        sessionId,
        prompt: userMsg.content,
        history: historyAsc.map((m) => ({ senderType: m.senderType, content: m.content })),
        profile,
        signal: run.controller.signal,
        workspacePath: profile.projectPath ?? null,
      }

      for await (const chunk of runtime.execute(ctx)) {
        if (run.cancelled) break
        switch (chunk.kind) {
          case 'text':
            fullContent += chunk.text
            broadcast(sessionId, {
              type: 'message:stream',
              payload: { sessionId, messageId: streamMsgId, delta: chunk.text },
            })
            break
          case 'metadata':
            if (chunk.metadata && typeof chunk.metadata === 'object') {
              codeAgentRun = chunk.metadata as Record<string, unknown>
              broadcast(sessionId, {
                type: 'message:metadata',
                payload: { sessionId, messageId: streamMsgId, codeAgentRun: chunk.metadata },
              })
            }
            break
          case 'artifact':
            artifacts.push(chunk.artifact as unknown as Record<string, unknown>)
            break
        }
      }
    } else {
      // 无 profile 时回退到默认 LLM
      const { streamReply } = await import('./llm')
      const llmMessages = historyAsc.map((m) => ({
        role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }))
      for await (const delta of streamReply(llmMessages, undefined, undefined, run.controller.signal)) {
        if (run.cancelled) break
        fullContent += delta
        broadcast(sessionId, {
          type: 'message:stream',
          payload: { sessionId, messageId: streamMsgId, delta },
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
      type: 'message:stream',
      payload: { sessionId, messageId: streamMsgId, delta: fullContent },
    })
  }

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
            artifacts: codeAgentRun?.artifacts ?? artifacts,
          }
        : null,
    })
    .returning()

  broadcast(sessionId, {
    type: 'message:completed',
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
    /API key is not configured/i.test(content) ||
    /API Key 未配置/.test(content) ||
    /Model returned an empty response/i.test(content) ||
    /模型返回了空响应/.test(content)
  )
}
