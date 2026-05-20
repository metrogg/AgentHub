import { create } from 'zustand'
import { api, type Message, type Session } from '../lib/api'
import { wsClient, type WSEvent } from '../lib/ws'

interface ChatState {
  sessions: Session[]
  currentSessionId: string | null
  messages: Message[]
  streamingMessage: { id: string; content: string } | null
  loadingSessions: boolean
  loadingMessages: boolean
  agentTyping: boolean

  fetchSessions: () => Promise<void>
  createSession: (title?: string) => Promise<Session>
  selectSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  handleWSEvent: (e: WSEvent) => void
  initWebSocket: () => () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  streamingMessage: null,
  loadingSessions: false,
  loadingMessages: false,
  agentTyping: false,

  async fetchSessions() {
    set({ loadingSessions: true })
    try {
      const { items } = await api.listSessions()
      set({ sessions: items, loadingSessions: false })
    } catch {
      set({ loadingSessions: false })
    }
  },

  async createSession(title = '新会话') {
    const session = await api.createSession({ title, type: 'single' })
    set((s) => ({ sessions: [session, ...s.sessions] }))
    return session
  },

  async selectSession(sessionId) {
    set({ currentSessionId: sessionId, loadingMessages: true, messages: [], streamingMessage: null })
    wsClient.joinSession(sessionId)
    try {
      const { items } = await api.listMessages(sessionId)
      set({ messages: items, loadingMessages: false })
    } catch {
      set({ loadingMessages: false })
    }
  },

  async deleteSession(sessionId) {
    await api.deleteSession(sessionId)
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== sessionId),
      currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      messages: s.currentSessionId === sessionId ? [] : s.messages,
    }))
  },

  async sendMessage(content) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const msg = await api.sendMessage(sessionId, { content })
    set((s) => ({ messages: [...s.messages, msg] }))
  },

  handleWSEvent(e) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    if (e.payload?.sessionId && e.payload.sessionId !== sessionId) return

    switch (e.type) {
      case 'agent:typing':
        set({ agentTyping: true })
        break
      case 'message:stream': {
        const { messageId, delta } = e.payload as { messageId: string; delta: string }
        set((s) => {
          const current = s.streamingMessage
          if (current?.id === messageId) {
            return { streamingMessage: { id: messageId, content: current.content + delta } }
          }
          return { streamingMessage: { id: messageId, content: delta }, agentTyping: false }
        })
        break
      }
      case 'message:completed': {
        const { message } = e.payload as { message: Message }
        set((s) => ({
          messages: [...s.messages, message],
          streamingMessage: null,
          agentTyping: false,
        }))
        break
      }
    }
  },

  initWebSocket() {
    wsClient.connect()
    return wsClient.on((e) => get().handleWSEvent(e))
  },
}))
