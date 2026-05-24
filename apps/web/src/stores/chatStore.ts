import { create } from 'zustand'
import { api, mentionsOrchestrator, type CodeAgentRunMetadata, type Message, type Session, type Workspace, type WorkspaceAgent } from '../lib/api'
import { wsClient, type WSEvent } from '../lib/ws'

let pendingStream: { messageId: string; delta: string } | null = null
let pendingStreamTimer: number | null = null
const cancelledSessions = new Set<string>()

interface ChatState {
  sessions: Session[]
  currentSession: Session | null
  currentWorkspace: Workspace | null
  currentWorkspaceAgents: WorkspaceAgent[]
  currentSessionId: string | null
  messages: Message[]
  streamingMessage: { id: string; content: string } | null
  streamingCodeAgentRun: CodeAgentRunMetadata | null
  selectedModelId: string | null
  loadingSessions: boolean
  loadingMessages: boolean
  agentTyping: boolean

  fetchSessions: () => Promise<void>
  createSession: (title?: string, options?: { workspaceId?: string | null; workspaceAgentId?: string | null; type?: 'direct' | 'group' }) => Promise<Session>
  selectSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  sendMessageToSession: (sessionId: string, content: string) => Promise<void>
  cancelRun: () => Promise<void>
  setSelectedModelId: (modelId: string | null) => void
  handleWSEvent: (e: WSEvent) => void
  initWebSocket: () => () => void
}

function clearPendingStream() {
  pendingStream = null
  if (pendingStreamTimer !== null) {
    window.clearTimeout(pendingStreamTimer)
    pendingStreamTimer = null
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSession: null,
  currentWorkspace: null,
  currentWorkspaceAgents: [],
  currentSessionId: null,
  messages: [],
  streamingMessage: null,
  streamingCodeAgentRun: null,
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

  async createSession(title = '新会话', options = {}) {
    const session = await api.createSession({
      title,
      type: options.type ?? 'direct',
      workspaceId: options.workspaceId ?? null,
      workspaceAgentId: options.workspaceAgentId ?? null,
    })
    set((s) => ({ sessions: [session, ...s.sessions] }))
    return session
  },

  async selectSession(sessionId) {
    clearPendingStream()
    cancelledSessions.delete(sessionId)
    set({
      currentSessionId: sessionId,
      currentSession: null,
      currentWorkspace: null,
      currentWorkspaceAgents: [],
      loadingMessages: true,
      messages: [],
      streamingMessage: null,
      streamingCodeAgentRun: null,
      agentTyping: false,
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
    clearPendingStream()
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== sessionId),
      currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      currentSession: s.currentSessionId === sessionId ? null : s.currentSession,
      currentWorkspace: s.currentSessionId === sessionId ? null : s.currentWorkspace,
      currentWorkspaceAgents: s.currentSessionId === sessionId ? [] : s.currentWorkspaceAgents,
      messages: s.currentSessionId === sessionId ? [] : s.messages,
      streamingMessage: s.currentSessionId === sessionId ? null : s.streamingMessage,
      streamingCodeAgentRun: s.currentSessionId === sessionId ? null : s.streamingCodeAgentRun,
      agentTyping: s.currentSessionId === sessionId ? false : s.agentTyping,
    }))
  },

  async sendMessage(content) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    await get().sendMessageToSession(sessionId, content)
  },

  async sendMessageToSession(sessionId, content) {
    cancelledSessions.delete(sessionId)
    set({ agentTyping: true })
    const shouldCreatePlan = shouldRouteToOrchestratorPlan(
      content,
      get().currentSession,
      get().currentWorkspaceAgents
    )
    try {
      const msg = await api.sendMessageWithModel(sessionId, {
        content,
        modelId: get().selectedModelId ?? undefined,
        skipAgentReply: shouldCreatePlan,
      })
      set((s) => ({ messages: [...s.messages, msg] }))
      if (shouldCreatePlan) {
        const card = await api.createOrchestratorPlan(sessionId, content)
        set((s) => ({ messages: [...s.messages, card] }))
        const result = await api.dispatchOrchestratorPlan(sessionId, card.id)
        set((s) => ({
          messages: s.messages.map((message) =>
            message.id === card.id
              ? {
                  ...message,
                  metadata: {
                    ...(message.metadata ?? {}),
                    dispatchResult: result,
                    plan:
                      message.metadata && typeof message.metadata.plan === 'object'
                        ? { ...(message.metadata.plan as Record<string, unknown>), dispatchResult: result }
                        : message.metadata?.plan,
                  },
                }
              : message
          ),
        }))
        await get().fetchSessions()
        set({ agentTyping: false })
      }
    } catch (error) {
      set({ agentTyping: false, streamingMessage: null, streamingCodeAgentRun: null })
      throw error
    }
  },

  async cancelRun() {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    cancelledSessions.add(sessionId)
    clearPendingStream()
    set({ agentTyping: false, streamingMessage: null, streamingCodeAgentRun: null })
    await api.cancelMessage(sessionId).catch(() => undefined)
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
        if (cancelledSessions.has(sessionId)) break
        set({ agentTyping: true })
        break
      case 'message:stream': {
        if (cancelledSessions.has(sessionId)) break
        const { messageId, delta } = e.payload as { messageId: string; delta: string }
        const commitPendingStream = (pending: { messageId: string; delta: string }) => {
          set((s) => {
            const current = s.streamingMessage
            if (current?.id === pending.messageId) {
              return { streamingMessage: { id: pending.messageId, content: current.content + pending.delta } }
            }
            return { streamingMessage: { id: pending.messageId, content: pending.delta }, agentTyping: false }
          })
        }

        if (pendingStream && pendingStream.messageId !== messageId) {
          const previous = pendingStream
          clearPendingStream()
          commitPendingStream(previous)
        }

        if (pendingStream && pendingStream.messageId === messageId) {
          pendingStream = { messageId, delta: pendingStream.delta + delta }
        } else {
          pendingStream = { messageId, delta }
        }

        if (pendingStreamTimer === null) {
          pendingStreamTimer = window.setTimeout(() => {
            const pending = pendingStream
            pendingStream = null
            pendingStreamTimer = null
            if (!pending) return

            commitPendingStream(pending)
          }, 32)
        }
        break
      }
      case 'message:metadata': {
        if (cancelledSessions.has(sessionId)) break
        const { messageId, codeAgentRun } = e.payload as { messageId: string; codeAgentRun: CodeAgentRunMetadata }
        set((s) => {
          const current = s.streamingMessage
          return {
            streamingMessage: current?.id === messageId ? current : { id: messageId, content: current?.content ?? '' },
            streamingCodeAgentRun: codeAgentRun,
            agentTyping: false,
          }
        })
        break
      }
      case 'message:completed': {
        const { message } = e.payload as { message: Message }
        cancelledSessions.delete(sessionId)
        clearPendingStream()
        set((s) => ({
          messages: [...s.messages, message],
          streamingMessage: null,
          streamingCodeAgentRun: null,
          agentTyping: false,
        }))
        break
      }
      case 'message:cancelled':
        cancelledSessions.add(sessionId)
        clearPendingStream()
        set({ streamingMessage: null, streamingCodeAgentRun: null, agentTyping: false })
        break
    }
  },

  initWebSocket() {
    wsClient.connect()
    return wsClient.on((e) => get().handleWSEvent(e))
  },
}))

function shouldRouteToOrchestratorPlan(content: string, session: Session | null, agents: WorkspaceAgent[]) {
  if (mentionsOrchestrator(content)) return true
  if (session?.type !== 'group' || !session.workspaceId) return false
  return !agents.some((agent) => mentionsAgent(content, agent))
}

function mentionsAgent(content: string, agent: WorkspaceAgent) {
  return [agent.name, agent.role]
    .filter(Boolean)
    .some((alias) => hasMention(content, alias))
}

function hasMention(content: string, alias: string) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[，,。.!！?？:：])`, 'i').test(content)
}
