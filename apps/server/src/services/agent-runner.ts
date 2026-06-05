import type { ServerWebSocket } from 'bun'

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
export type AgentRunProfile = import('./runtime').AgentProfile

export interface AgentRunResult {
  ok: boolean
  cancelled?: boolean
  messageId?: string
}

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
