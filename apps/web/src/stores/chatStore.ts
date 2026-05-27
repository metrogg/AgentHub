import { create } from 'zustand'
import { api, mentionsOrchestrator, type ChatAttachment, type CodeAgentRunMetadata, type Message, type Session, type Workspace, type WorkspaceAgent } from '../lib/api'
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
  pendingAttachments: ChatAttachment[]
  selectedModelId: string | null
  loadingSessions: boolean
  loadingMessages: boolean
  agentTyping: boolean
  replyingToMessageId: string | null
  replyingToMessage: Message | null

  fetchSessions: () => Promise<void>
  createSession: (title?: string, options?: { workspaceId?: string | null; workspaceAgentId?: string | null; type?: 'direct' | 'group' }) => Promise<Session>
  selectSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  sendMessage: (content: string) => Promise<{ groupSessionId?: string } | undefined>
  sendMessageToSession: (sessionId: string, content: string) => Promise<{ groupSessionId?: string } | undefined>
  editMessage: (messageId: string, content: string) => Promise<void>
  withdrawMessage: (messageId: string) => Promise<{ reverted: number; failed: number } | null>
  regenerateMessage: (messageId: string) => Promise<void>
  pinMessage: (messageId: string) => Promise<void>
  unpinMessage: (messageId: string) => Promise<void>
  addPendingAttachments: (attachments: ChatAttachment[]) => void
  removePendingAttachment: (id: string) => void
  clearPendingAttachments: () => void
  cancelRun: () => Promise<void>
  setSelectedModelId: (modelId: string | null) => void
  setReplyingTo: (messageId: string | null) => void
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
  pendingAttachments: [],
  selectedModelId: null,
  loadingSessions: false,
  loadingMessages: false,
  agentTyping: false,
  replyingToMessageId: null,
  replyingToMessage: null,

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
      pendingAttachments: [],
      agentTyping: false,
      replyingToMessageId: null,
      replyingToMessage: null,
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
    if (!sessionId) return undefined
    return get().sendMessageToSession(sessionId, content)
  },

  async sendMessageToSession(sessionId, content) {
    cancelledSessions.delete(sessionId)
    set({ agentTyping: true })
    const attachments = get().pendingAttachments
    const contentForAgent = attachments.length ? appendAttachmentNote(content, attachments) : content
    const shouldCreatePlan = shouldRouteToOrchestratorPlan(
      contentForAgent,
      get().currentSession,
      get().currentWorkspaceAgents
    )
    try {
      const replyToMessageId = get().replyingToMessageId
      const msg = await api.sendMessageWithModel(sessionId, {
        content: contentForAgent,
        modelId: get().selectedModelId ?? undefined,
        skipAgentReply: shouldCreatePlan,
        attachments,
        displayContent: attachments.length ? content : undefined,
        replyToMessageId,
      })
      set((s) => ({ messages: [...s.messages, msg], pendingAttachments: [], replyingToMessageId: null, replyingToMessage: null }))
      let dispatchResult: { groupSessionId?: string } | undefined
      if (shouldCreatePlan) {
        const card = await api.createOrchestratorPlan(sessionId, contentForAgent)
        set((s) => ({ messages: [...s.messages, card] }))
        const result = await api.dispatchOrchestratorPlan(sessionId, card.id)
        dispatchResult = { groupSessionId: result.groupSessionId }
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
      } else {
        await get().fetchSessions()
      }
      return dispatchResult
    } catch (error) {
      set({ agentTyping: false, streamingMessage: null, streamingCodeAgentRun: null })
      throw error
    }
  },

  async editMessage(messageId, content) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const updated = await api.updateMessage(sessionId, messageId, { content })
    set((s) => ({
      messages: s.messages.map((message) => (message.id === messageId ? updated : message)),
    }))
  },

  async withdrawMessage(messageId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return null
    cancelledSessions.add(sessionId)
    clearPendingStream()
    set({ agentTyping: false, streamingMessage: null, streamingCodeAgentRun: null })
    await api.cancelMessage(sessionId).catch(() => undefined)
    const result = await api.withdrawMessage(sessionId, messageId, { rollback: true })
    const removed = new Set(result.removedMessageIds)
    set((s) => ({ messages: s.messages.filter((message) => !removed.has(message.id)) }))
    return result.rollback
  },

  async regenerateMessage(messageId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    cancelledSessions.delete(sessionId)
    clearPendingStream()
    set({ agentTyping: true, streamingMessage: null, streamingCodeAgentRun: null })
    const result = await api.regenerateMessage(sessionId, messageId)
    set((s) => ({ messages: s.messages.filter((message) => message.id !== result.removedMessageId) }))
  },

  async pinMessage(messageId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const updated = await api.pinMessage(sessionId, messageId)
    set((s) => ({
      messages: s.messages.map((message) => (message.id === messageId ? updated : message)),
    }))
  },

  async unpinMessage(messageId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const updated = await api.unpinMessage(sessionId, messageId)
    set((s) => ({
      messages: s.messages.map((message) => (message.id === messageId ? updated : message)),
    }))
  },

  addPendingAttachments(attachments) {
    if (!attachments.length) return
    set((s) => ({ pendingAttachments: [...s.pendingAttachments, ...attachments].slice(0, 6) }))
  },

  removePendingAttachment(id) {
    set((s) => ({ pendingAttachments: s.pendingAttachments.filter((attachment) => attachment.id !== id) }))
  },

  clearPendingAttachments() {
    set({ pendingAttachments: [] })
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

  setReplyingTo(messageId) {
    if (!messageId) {
      set({ replyingToMessageId: null, replyingToMessage: null })
      return
    }
    const msg = get().messages.find((m) => m.id === messageId) ?? null
    set({ replyingToMessageId: messageId, replyingToMessage: msg })
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
      case 'task:update': {
        const { taskId, status, strategy, agentId } = e.payload as {
          taskId: string
          status: string
          strategy?: string
          agentId?: string
          agentName?: string
        }
        set((s) => {
          let updated = false
          const newMessages = s.messages.map((msg) => {
            if (msg.type !== 'task_card' || !msg.metadata || typeof msg.metadata !== 'object') return msg
            const plan = (msg.metadata as Record<string, unknown>).plan as
              | { tasks?: Array<{ id: string; status?: string; agentKey?: string }>; agents?: Array<{ key: string; id?: string }> }
              | undefined
            if (!plan || !Array.isArray(plan.tasks)) return msg
            const task = plan.tasks.find((t) => t.id === taskId)
            if (!task) return msg
            updated = true
            const nextTasks = plan.tasks.map((t) => {
              if (t.id !== taskId) return t
              const next: typeof t = { ...t, status: status as 'pending' | 'running' | 'done' | 'failed' }
              if (strategy) (next as Record<string, unknown>).strategy = strategy
              if (agentId) {
                const matchedAgent = plan.agents?.find((a) => a.id === agentId || a.key === agentId)
                if (matchedAgent) next.agentKey = matchedAgent.key
              }
              return next
            })
            return {
              ...msg,
              metadata: { ...msg.metadata, plan: { ...plan, tasks: nextTasks } },
            }
          })
          return updated ? { messages: newMessages } : s
        })
        break
      }
      case 'blackboard:update': {
        const { taskId, summary, agentName, taskTitle } = e.payload as {
          taskId: string
          summary?: string
          agentName?: string
          taskTitle?: string
        }
        set((s) => {
          let updated = false
          const newMessages = s.messages.map((msg) => {
            if (msg.type !== 'task_card' || !msg.metadata || typeof msg.metadata !== 'object') return msg
            const plan = (msg.metadata as Record<string, unknown>).plan as
              | { tasks?: Array<{ id: string; status?: string; summary?: string; agentName?: string; taskTitle?: string }> }
              | undefined
            if (!plan || !Array.isArray(plan.tasks)) return msg
            const task = plan.tasks.find((t) => t.id === taskId)
            if (!task) return msg
            updated = true
            const nextTasks = plan.tasks.map((t) => {
              if (t.id !== taskId) return t
              return {
                ...t,
                status: (t.status === 'running' ? 'done' : t.status) as typeof t.status,
                summary: summary ?? t.summary,
                agentName: agentName ?? t.agentName,
                taskTitle: taskTitle ?? t.taskTitle,
              }
            })
            return {
              ...msg,
              metadata: { ...msg.metadata, plan: { ...plan, tasks: nextTasks } },
            }
          })
          return updated ? { messages: newMessages } : s
        })
        break
      }
      case 'run:event':
        // Timeline events are persisted and rendered on the Orchestrator Runs page.
        // Task cards continue to use task:update/blackboard:update in this phase.
        break
    }
  },

  initWebSocket() {
    wsClient.connect()
    return wsClient.on((e) => get().handleWSEvent(e))
  },
}))

function shouldRouteToOrchestratorPlan(content: string, _session: Session | null, _agents: WorkspaceAgent[]) {
  // 只有用户明确 @orchestrator 时才创建编排计划
  // 群聊中的普通消息应走正常的 runGroupReplies，由后端决定哪个 Agent 回复
  return mentionsOrchestrator(content)
}

function appendAttachmentNote(content: string, attachments: ChatAttachment[]) {
  const note = attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType})`).join('\n')
  return `${content.trim()}\n\n[已附加图片]\n${note}`.trim()
}


