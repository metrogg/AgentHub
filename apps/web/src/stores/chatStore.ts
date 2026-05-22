import { create } from 'zustand'
import { api, mentionsOrchestrator, type Message, type Session, type Workspace, type WorkspaceAgent } from '../lib/api'
import { wsClient, type WSEvent } from '../lib/ws'

interface ChatState {
  sessions: Session[]
  currentSession: Session | null
  currentWorkspace: Workspace | null
  currentWorkspaceAgents: WorkspaceAgent[]
  currentSessionId: string | null
  messages: Message[]
  streamingMessage: { id: string; content: string } | null
  selectedModelId: string | null
  loadingSessions: boolean
  loadingMessages: boolean
  agentTyping: boolean

  fetchSessions: () => Promise<void>
  createSession: (title?: string) => Promise<Session>
  selectSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  sendMessageToSession: (sessionId: string, content: string) => Promise<void>
  setSelectedModelId: (modelId: string | null) => void
  handleWSEvent: (e: WSEvent) => void
  initWebSocket: () => () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSession: null,
  currentWorkspace: null,
  currentWorkspaceAgents: [],
  currentSessionId: null,
  messages: [],
  streamingMessage: null,
  selectedModelId: null,
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
    const session = await api.createSession({ title, type: 'direct' })
    set((s) => ({ sessions: [session, ...s.sessions] }))
    return session
  },

  async selectSession(sessionId) {
    set({
      currentSessionId: sessionId,
      currentSession: null,
      currentWorkspace: null,
      currentWorkspaceAgents: [],
      loadingMessages: true,
      messages: [],
      streamingMessage: null,
    })
    wsClient.joinSession(sessionId)
    try {
      const [session, { items }] = await Promise.all([api.getSession(sessionId), api.listMessages(sessionId)])
      if (session.workspaceId) {
        const full = await api.getWorkspace(session.workspaceId)
        set({
          currentSession: session,
          currentWorkspace: full.workspace,
          currentWorkspaceAgents: full.agents,
          messages: items,
          loadingMessages: false,
        })
      } else {
        set({ currentSession: session, messages: items, loadingMessages: false })
      }
    } catch {
      set({ loadingMessages: false })
    }
  },

  async deleteSession(sessionId) {
    await api.deleteSession(sessionId)
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== sessionId),
      currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      currentSession: s.currentSessionId === sessionId ? null : s.currentSession,
      currentWorkspace: s.currentSessionId === sessionId ? null : s.currentWorkspace,
      currentWorkspaceAgents: s.currentSessionId === sessionId ? [] : s.currentWorkspaceAgents,
      messages: s.currentSessionId === sessionId ? [] : s.messages,
    }))
  },

  async sendMessage(content) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    await get().sendMessageToSession(sessionId, content)
  },

  async sendMessageToSession(sessionId, content) {
    const msg = await api.sendMessageWithModel(sessionId, {
      content,
      modelId: get().selectedModelId ?? undefined,
    })
    set((s) => ({ messages: [...s.messages, msg] }))
    if (mentionsOrchestrator(content)) {
      const card = await api.createOrchestratorPlan(sessionId, content)
      set((s) => ({ messages: [...s.messages, card] }))
    }
  },

  setSelectedModelId(modelId) {
    set({ selectedModelId: modelId })
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
