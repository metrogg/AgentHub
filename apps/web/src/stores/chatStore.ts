import { create } from 'zustand'
import { api, mentionsOrchestrator, type ChatAttachment, type CodeAgentRunMetadata, type Message, type Session, type Workspace, type WorkspaceAgent } from '../lib/api'
import { wsClient, type WSEvent } from '../lib/ws'

let pendingStream: { messageId: string; delta: string; agentId?: string; agentName?: string } | null = null
let pendingStreamTimer: number | null = null
const cancelledSessions = new Set<string>()
const pendingOrchestratorPlans = new Set<string>()
const messageCache = new Map<string, Message[]>()
const workspaceDetailsCache = new Map<string, { workspace: Workspace; agents: WorkspaceAgent[] }>()

function updateCachedMessages(sessionId: string, updater: (messages: Message[]) => Message[]) {
  const cached = messageCache.get(sessionId)
  if (!cached) return
  messageCache.set(sessionId, updater(cached))
}

interface ChatState {
  sessions: Session[]
  currentSession: Session | null
  currentWorkspace: Workspace | null
  currentWorkspaceAgents: WorkspaceAgent[]
  currentSessionId: string | null
  messages: Message[]
  streamingMessage: { id: string; content: string; agentId?: string; agentName?: string } | null
  streamingCodeAgentRun: CodeAgentRunMetadata | null
  pendingAttachments: ChatAttachment[]
  loadingSessions: boolean
  loadingMessages: boolean
  agentTyping: boolean
  replyingToMessageId: string | null
  replyingToMessage: Message | null
  sessionsBootstrapped: boolean

  fetchSessions: () => Promise<void>
  createSession: (title?: string, options?: {
    workspaceId?: string | null
    workspaceAgentId?: string | null
    type?: 'direct' | 'group'
    metadata?: Record<string, unknown> | null
  }) => Promise<Session>
  selectSession: (sessionId: string) => Promise<void>
  setSessionWorkspace: (sessionId: string, workspaceId: string | null) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  clearMessages: (sessionId: string) => Promise<void>
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
  loadingSessions: false,
  loadingMessages: false,
  agentTyping: false,
  replyingToMessageId: null,
  replyingToMessage: null,
  sessionsBootstrapped: false,

  async fetchSessions() {
    set({ loadingSessions: true })
    try {
      const { items } = await api.listSessions()
      set({ sessions: items, loadingSessions: false, sessionsBootstrapped: true })
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
      metadata: options.metadata ?? null,
    })
    set((s) => ({ sessions: [session, ...s.sessions] }))
    return session
  },

  async selectSession(sessionId) {
    clearPendingStream()
    cancelledSessions.delete(sessionId)
    const state = get()
    const optimisticSession =
      state.sessions.find((session) => session.id === sessionId) ??
      (state.currentSession?.id === sessionId ? state.currentSession : null)
    const cachedWorkspace = optimisticSession?.workspaceId
      ? workspaceDetailsCache.get(optimisticSession.workspaceId)
      : null
    const canReuseWorkspace =
      optimisticSession?.workspaceId &&
      state.currentSession?.workspaceId === optimisticSession.workspaceId
    const cachedMessages = messageCache.get(sessionId)

    set({
      currentSessionId: sessionId,
      currentSession: optimisticSession ?? state.currentSession,
      currentWorkspace: optimisticSession?.workspaceId
        ? cachedWorkspace?.workspace ?? (canReuseWorkspace ? state.currentWorkspace : null)
        : null,
      currentWorkspaceAgents: optimisticSession?.workspaceId
        ? cachedWorkspace?.agents ?? (canReuseWorkspace ? state.currentWorkspaceAgents : [])
        : [],
      loadingMessages: true,
      messages: cachedMessages ?? state.messages,
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
      messageCache.set(sessionId, items)
      if (session.workspaceId) {
        const full = await api.getWorkspace(session.workspaceId)
        workspaceDetailsCache.set(session.workspaceId, {
          workspace: full.workspace,
          agents: full.agents,
        })
        if (get().currentSessionId !== sessionId) return
        set({
          currentSession: session,
          currentWorkspace: full.workspace,
          currentWorkspaceAgents: full.agents,
          messages: items,
          loadingMessages: false,
        })
      } else {
        if (get().currentSessionId !== sessionId) return
        set({
          currentSession: session,
          currentWorkspace: null,
          currentWorkspaceAgents: [],
          messages: items,
          loadingMessages: false,
        })
      }
    } catch (error) {
      if (get().currentSessionId !== sessionId) return
      set({ loadingMessages: false })
      throw error
    }
  },

  async setSessionWorkspace(sessionId, workspaceId) {
    const session = await api.updateSession(sessionId, { workspaceId, workspaceAgentId: null })
    const full = workspaceId ? await api.getWorkspace(workspaceId) : null
    if (workspaceId && full) {
      workspaceDetailsCache.set(workspaceId, {
        workspace: full.workspace,
        agents: full.agents,
      })
    }
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === session.id ? session : item)),
      currentSession: s.currentSessionId === session.id ? session : s.currentSession,
      currentWorkspace: s.currentSessionId === session.id ? full?.workspace ?? null : s.currentWorkspace,
      currentWorkspaceAgents: s.currentSessionId === session.id ? full?.agents ?? [] : s.currentWorkspaceAgents,
    }))
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

  async clearMessages(sessionId) {
    await api.clearMessages(sessionId)
    if (get().currentSessionId === sessionId) {
      set({ messages: [], streamingMessage: null, streamingCodeAgentRun: null, agentTyping: false })
    }
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
        skipAgentReply: shouldCreatePlan,
        attachments,
        displayContent: attachments.length ? content : undefined,
        replyToMessageId,
      })
      set((s) => ({ messages: [...s.messages, msg], pendingAttachments: [], replyingToMessageId: null, replyingToMessage: null }))
      if (shouldCreatePlan && !pendingOrchestratorPlans.has(sessionId)) {
        pendingOrchestratorPlans.add(sessionId)
        try {
          const card = await api.createOrchestratorPlan(sessionId, contentForAgent)
          set((s) => ({ messages: [...s.messages, card] }))
          await get().fetchSessions()
          set({ agentTyping: false })
        } finally {
          pendingOrchestratorPlans.delete(sessionId)
        }
      } else if (!shouldCreatePlan) {
        await get().fetchSessions()
        set({ agentTyping: false })
      }
    } catch (error) {
      set({ agentTyping: false, streamingMessage: null, streamingCodeAgentRun: null })
      throw error
    }
    return undefined
  },

  async editMessage(messageId, content) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const updated = await api.updateMessage(sessionId, messageId, { content })
    updateCachedMessages(sessionId, (messages) =>
      messages.map((message) => (message.id === messageId ? updated : message)),
    )
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
    updateCachedMessages(sessionId, (messages) => messages.filter((message) => !removed.has(message.id)))
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
    updateCachedMessages(sessionId, (messages) => messages.filter((message) => message.id !== result.removedMessageId))
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
        const { messageId, delta, agentId, agentName } = e.payload as {
          messageId: string
          delta: string
          agentId?: string
          agentName?: string
        }
        const commitPendingStream = (pending: { messageId: string; delta: string; agentId?: string; agentName?: string }) => {
          set((s) => {
            const current = s.streamingMessage
            if (current?.id === pending.messageId) {
              return {
                streamingMessage: {
                  id: pending.messageId,
                  content: current.content + pending.delta,
                  agentId: pending.agentId ?? current.agentId,
                  agentName: pending.agentName ?? current.agentName,
                },
              }
            }
            return {
              streamingMessage: {
                id: pending.messageId,
                content: pending.delta,
                agentId: pending.agentId,
                agentName: pending.agentName,
              },
              agentTyping: false,
            }
          })
        }

        if (pendingStream && pendingStream.messageId !== messageId) {
          const previous = pendingStream
          clearPendingStream()
          commitPendingStream(previous)
        }

        if (pendingStream && pendingStream.messageId === messageId) {
          pendingStream = {
            messageId,
            delta: pendingStream.delta + delta,
            agentId: agentId ?? pendingStream.agentId,
            agentName: agentName ?? pendingStream.agentName,
          }
        } else {
          pendingStream = { messageId, delta, agentId, agentName }
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
      case 'run:event': {
        const event = e.payload as {
          id: string
          runId: string
          type: string
          taskId?: string | null
          payload?: Record<string, unknown>
        }
        set((s) => {
          let updated = false
          const newMessages = s.messages.map((msg) => {
            if (msg.type !== 'task_card' || !msg.metadata || typeof msg.metadata !== 'object') return msg
            const dispatchResult = (msg.metadata as Record<string, unknown>).dispatchResult as
              | { runId?: string }
              | undefined
            if (!dispatchResult || dispatchResult.runId !== event.runId) return msg
            const plan = (msg.metadata as Record<string, unknown>).plan as
              | { tasks?: Array<{ id: string; status?: string }>; runStatus?: string }
              | undefined
            if (!plan || !Array.isArray(plan.tasks)) return msg
            updated = true
            const nextPlan = { ...plan }
            if (
              event.type === 'task.started' ||
              event.type === 'task.completed' ||
              event.type === 'task.failed' ||
              event.type === 'task.cancelled' ||
              event.type === 'task.retrying'
            ) {
              const taskId = event.taskId
              if (taskId) {
                nextPlan.tasks = plan.tasks.map((t) => {
                  if (t.id !== taskId) return t
                  const statusMap: Record<string, string> = {
                    'task.started': 'running',
                    'task.completed': 'done',
                    'task.failed': 'failed',
                    'task.cancelled': 'cancelled',
                    'task.retrying': 'pending',
                  }
                  return { ...t, status: statusMap[event.type] ?? t.status }
                })
              }
            }
            if (event.type === 'run.completed') nextPlan.runStatus = 'completed'
            if (event.type === 'run.failed') nextPlan.runStatus = 'failed'
            if (event.type === 'run.cancelled') nextPlan.runStatus = 'cancelled'
            if (event.type === 'run.synthesizing') nextPlan.runStatus = 'synthesizing'
            return {
              ...msg,
              metadata: { ...(msg.metadata as Record<string, unknown>), plan: nextPlan },
            }
          })
          return updated ? { messages: newMessages } : s
        })
        break
      }
    }
  },

  initWebSocket() {
    wsClient.connect()
    return wsClient.on((e) => get().handleWSEvent(e))
  },
}))

/**
 * Intent Router: 判断用户消息是否应路由到编排器
 * 除显式 @orchestrator 外，还通过启发式复杂度检测自动路由
 */
function shouldRouteToOrchestratorPlan(content: string, session: Session | null, agents: WorkspaceAgent[]) {
  // 1. 显式 @orchestrator 始终路由
  if (mentionsOrchestrator(content)) return true

  // 2. 非群聊会话不自动路由（直接对话走正常 Agent 回复）
  if (!session || session.type !== 'group' || agents.length < 2) return false

  // 3. 启发式复杂度检测
  return assessIntentComplexity(content)
}

/**
 * 启发式评估消息复杂度，判断是否需要多 Agent 协作
 * 信号：多文件/模块引用、阶段关键词、架构/系统级意图、消息长度
 */
function assessIntentComplexity(content: string): boolean {
  const lower = content.toLowerCase()
  let signals = 0

  // 多文件/模块引用 (≥2 个文件路径或模块名)
  const fileRefs = content.match(/[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|vue|css|scss|html|sql|json|yaml|yml|toml|md)\b/gi)
  if (fileRefs && new Set(fileRefs.map(f => f.toLowerCase())).size >= 2) signals += 2

  // 多阶段/步骤关键词
  const phasePatterns = [
    /先.{2,20}然后/, /先.{2,20}再/, /第[一二三四五六七八九十\d]步/,
    /step\s*\d/i, /phase\s*\d/i, /first.{5,30}then/i, /首先.{2,20}接着/,
    /\d+\.\s+\S.{3,}/m, // 有序列表
  ]
  if (phasePatterns.some(p => p.test(content))) signals += 2

  // 架构/系统级意图
  const archKeywords = [
    '架构', '重构', '系统设计', '整体', '全流程', '端到端', '从零开始',
    'architecture', 'refactor', 'system design', 'end-to-end', 'e2e',
    'full stack', 'fullstack', '全栈', '迁移', 'migration', 'migrate',
  ]
  if (archKeywords.some(k => lower.includes(k))) signals += 2

  // 多 Agent 协作暗示
  const collabKeywords = [
    '同时', '并行', '一起', '分别', '各自', '协作',
    'simultaneously', 'in parallel', 'together', 'respectively',
  ]
  if (collabKeywords.some(k => lower.includes(k))) signals += 1

  // 复杂任务动词 + 技术对象
  const complexVerbs = ['实现', '创建', '搭建', '开发', '构建', '设计', 'implement', 'create', 'build', 'develop', 'design']
  const techObjects = ['api', 'ui', '数据库', 'database', '认证', 'auth', '组件', 'component', '服务', 'service', '模块', 'module', '页面', 'page']
  const hasComplexVerb = complexVerbs.some(v => lower.includes(v))
  const hasTechObj = techObjects.some(t => lower.includes(t))
  if (hasComplexVerb && hasTechObj) signals += 1

  // 长消息 + 技术内容
  if (content.length > 200 && hasTechObj) signals += 1

  // 需要 ≥3 个信号才自动路由到编排器
  return signals >= 3
}

function appendAttachmentNote(content: string, attachments: ChatAttachment[]) {
  const note = attachments.map((attachment) => `- ${attachment.name} (${attachment.mimeType})`).join('\n')
  return `${content.trim()}\n\n[已附加图片]\n${note}`.trim()
}


