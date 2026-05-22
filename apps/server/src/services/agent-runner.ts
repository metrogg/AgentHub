import { db, messages, eq, desc } from '@agenthub/db'
import { streamReply } from './llm'
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
  systemPrompt?: string
  color?: string
}

// In-memory map: sessionId -> Set of connected websockets
const sessionRooms = new Map<string, Set<ServerWebSocket<unknown>>>()

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

function buildAgentSystem(profile?: AgentRunProfile) {
  if (!profile) return undefined
  return [
    profile.systemPrompt || `You are ${profile.name}, a collaborative agent in AgentHub.`,
    profile.role ? `Your role in this group chat is: ${profile.role}.` : '',
    'You are replying inside a multi-agent group chat. Stay focused on your role, answer in the same language as the user, and mention handoff needs explicitly when another agent should continue.',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function runAgentReply(sessionId: string, userMsg: MessageRow, profile?: AgentRunProfile) {
  const agentId = profile?.id ?? 'claude'
  const agentName = profile?.name ?? 'Claude'
  logger.info({ sessionId, msgId: userMsg.id, agentId }, 'Agent reply started')

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
  const selectedModelId =
    typeof userMsg.metadata?.modelId === 'string' ? userMsg.metadata.modelId : undefined

  for await (const delta of streamReply(llmMessages, buildAgentSystem(profile), selectedModelId)) {
    fullContent += delta
    broadcast(sessionId, {
      type: 'message:stream',
      payload: { sessionId, messageId: streamMsgId, delta },
    })
  }

  if (!fullContent.trim()) {
    fullContent = '[Error: Model returned an empty response. Check the selected provider, model ID, base URL, and API key.]'
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
          }
        : null,
    })
    .returning()

  broadcast(sessionId, {
    type: 'message:completed',
    payload: { sessionId, message: agentMsg },
  })

  logger.info({ sessionId, msgId: agentMsg?.id, length: fullContent.length }, 'Agent reply completed')
}
