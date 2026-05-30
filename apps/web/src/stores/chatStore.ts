import { create } from 'zustand'
import {
  api,
  type AgentConfigInput,
  type ChatAttachment,

  type Message,
  type Session,
  type Workspace,
  type WorkspaceAgent,
  type WorkspaceFull,
} from '../lib/api'
import { wsClient, type WSEvent } from '../lib/ws'
import type { CodeAgentRunMetadata } from '@agenthub/shared'
import { WsEvent, TaskStatus, MessageType, SessionType, SenderType } from '@agenthub/shared'

let pendingStream: {
  messageId: string
  delta: string
  agentId?: string
  agentName?: string
} | null = null
let pendingStreamTimer: number | null = null
const cancelledSessions = new Set<string>()
const messageCache = new Map<string, Message[]>()
const workspaceDetailsCache = new Map<string, { workspace: Workspace; agents: WorkspaceAgent[] }>()

function updateCachedMessages(sessionId: string, updater: (messages: Message[]) => Message[]) {
  const cached = messageCache.get(sessionId)
  if (!cached) return
  messageCache.set(sessionId, sortMessages(updater(cached)))
}

function messageTime(message: Message): number {
  const time = Date.parse(message.createdAt)
  return Number.isFinite(time) ? time : 0
}

function messageSortPriority(message: Message): number {
  if (message.senderType === SenderType.User) return 0
  if (message.senderType === SenderType.System) return 1
  return 2
}

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const byTime = messageTime(a) - messageTime(b)
    if (byTime !== 0) return byTime
    const byPriority = messageSortPriority(a) - messageSortPriority(b)
    return byPriority !== 0 ? byPriority : a.id.localeCompare(b.id)
  })
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const exists = messages.some((item) => item.id === message.id)
  return sortMessages(
    exists ? messages.map((item) => (item.id === message.id ? message : item)) : [...messages, message],
  )
}

function sessionWorkspaceAgents(session: Session | null | undefined, agents: WorkspaceAgent[]) {
  if (session?.type !== SessionType.Group) return agents
  const agentIds = readSessionAgentIds(session)
  if (!agentIds.length) return agents
  const allowed = new Set(agentIds)
  return agents.filter((agent) => allowed.has(agent.id))
}

function readSessionAgentIds(session: Session | null | undefined) {
  const value = session?.metadata?.agentIds
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function getRoleIcon(agentName: string, taskTitle: string): string {
  const lower = `${agentName} ${taskTitle}`.toLowerCase()
  if (lower.includes('架构') || lower.includes('architect')) return '🏗️'
  if (lower.includes('码') || lower.includes('码农') || lower.includes('coder') || lower.includes('dev') || lower.includes('工程') || lower.includes('engineer') || lower.includes('前端') || lower.includes('后端')) return '💻'
  if (lower.includes('审查') || lower.includes('review') || lower.includes('qa') || lower.includes('测试') || lower.includes('test')) return '🔍'
  if (lower.includes('产品') || lower.includes('pm') || lower.includes('经理')) return '📋'
  if (lower.includes('设计') || lower.includes('ui') || lower.includes('ux')) return '🎨'
  if (lower.includes('研究') || lower.includes('调研') || lower.includes('research')) return '🔬'
  if (lower.includes('文档') || lower.includes('写') || lower.includes('writer')) return '📝'
  if (lower.includes('部署') || lower.includes('deploy') || lower.includes('ops')) return '🚀'
  return '🤖'
}

function updateAgentTabsFromTaskBoard(
  currentTabs: AgentTab[],
  taskBoard: ChatState['taskBoard'],
  event: { type: string; taskId?: string | null; payload?: Record<string, unknown> },
): AgentTab[] {
  if (!taskBoard) return currentTabs
  const taskId = event.taskId
  if (!taskId) return currentTabs

  const task = taskBoard.tasks.find((t) => t.id === taskId)
  if (!task) return currentTabs

  const tabIndex = currentTabs.findIndex((t) => t.agentName === task.agentName)
  if (tabIndex === -1) {
    const newTab: AgentTab = {
      agentId: task.id,
      agentName: task.agentName,
      roleIcon: getRoleIcon(task.agentName, task.title),
      status: task.status === 'running' ? 'running' : task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : 'pending',
      childSessionId: (event.payload?.sessionId as string) ?? null,
    }
    return [...currentTabs, newTab]
  }

  return currentTabs.map((tab, i) => {
    if (i !== tabIndex) return tab
    const sessionId = (event.payload?.sessionId as string) ?? tab.childSessionId
    const status: AgentTab['status'] =
      task.status === 'running' ? 'running'
      : task.status === 'done' ? 'done'
      : task.status === 'failed' ? 'failed'
      : 'pending'
    return { ...tab, status, childSessionId: sessionId }
  })
}

interface AgentTab {
  agentId: string
  agentName: string
  roleIcon: string
  status: 'pending' | 'running' | 'done' | 'failed'
  childSessionId: string | null
  progress?: number
  progressStatus?: string
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
  taskBoard: {
    runId: string
    title: string
    goal: string
    collaborationMode: string
    phases: Array<{
      id: string
      title: string
      purpose: string
      taskIds: string[]
      status: 'pending' | 'active' | 'completed'
    }>
    tasks: Array<{
      id: string
      phaseId: string
      title: string
      description: string
      agentName: string
      status: 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled'
      progress?: number
      progressStatus?: string
      dependencies: string[]
    }>
    status: 'planning' | 'running' | 'synthesizing' | 'completed' | 'failed' | 'cancelled'
    sessionId: string
  } | null
  previewUrl: string | null
  previewFileType: 'html' | 'markdown' | 'image' | null
  previewFileName: string | null
  selectedAgentTab: string | null
  agentTabs: AgentTab[]

  fetchSessions: () => Promise<void>
  createSession: (
    title?: string,
    options?: {
      workspaceId?: string | null
      workspaceAgentId?: string | null
      type?: 'direct' | 'group'
      metadata?: Record<string, unknown> | null
    },
  ) => Promise<Session>
  selectSession: (sessionId: string) => Promise<void>
  setSessionWorkspace: (sessionId: string, workspaceId: string | null) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  clearMessages: (sessionId: string) => Promise<void>
  sendMessage: (
    content: string,
    options?: {
      displayContent?: string
      replyToMessageId?: string | null
    },
  ) => Promise<{ groupSessionId?: string } | undefined>
  sendMessageToSession: (
    sessionId: string,
    content: string,
    options?: {
      displayContent?: string
      replyToMessageId?: string | null
    },
  ) => Promise<{ groupSessionId?: string } | undefined>
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
  setPreviewUrl: (url: string | null, fileType?: 'html' | 'markdown' | 'image' | null, fileName?: string | null) => void
  selectAgentTab: (agentId: string | null) => void
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
  taskBoard: null,
  previewUrl: null,
  previewFileType: null,
  previewFileName: null,
  selectedAgentTab: null,
  agentTabs: [],

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
      type: options.type ?? SessionType.Direct,
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
        ? (cachedWorkspace?.workspace ?? (canReuseWorkspace ? state.currentWorkspace : null))
        : null,
      currentWorkspaceAgents: optimisticSession?.workspaceId
        ? sessionWorkspaceAgents(
            optimisticSession,
            cachedWorkspace?.agents ?? (canReuseWorkspace ? state.currentWorkspaceAgents : []),
          )
        : [],
      loadingMessages: true,
      messages: cachedMessages ? sortMessages(cachedMessages) : [],
      streamingMessage: null,
      streamingCodeAgentRun: null,
      pendingAttachments: [],
      agentTyping: false,
      replyingToMessageId: null,
      replyingToMessage: null,
      taskBoard: state.taskBoard?.sessionId === sessionId ? state.taskBoard : null,
      agentTabs: state.taskBoard?.sessionId === sessionId ? state.agentTabs : [],
      selectedAgentTab: state.taskBoard?.sessionId === sessionId ? state.selectedAgentTab : null,
    })
    wsClient.joinSession(sessionId)
    try {
      const [session, { items }] = await Promise.all([
        api.getSession(sessionId),
        api.listMessages(sessionId),
      ])
      messageCache.set(sessionId, sortMessages(items))
      if (session.workspaceId) {
        const full = await api.getWorkspace(session.workspaceId)
        workspaceDetailsCache.set(session.workspaceId, {
          workspace: full.workspace,
          agents: full.agents,
        })
        if (get().currentSessionId !== sessionId) return
        const currentAgents = sessionWorkspaceAgents(session, full.agents)
        set({
          currentSession: session,
          currentWorkspace: full.workspace,
          currentWorkspaceAgents: currentAgents,
          messages: sortMessages(items),
          loadingMessages: false,
        })
      } else {
        if (get().currentSessionId !== sessionId) return
        set({
          currentSession: session,
          currentWorkspace: null,
          currentWorkspaceAgents: [],
          messages: sortMessages(items),
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
    const state = get()
    const currentSession =
      state.currentSession?.id === sessionId
        ? state.currentSession
        : state.sessions.find((item) => item.id === sessionId) ?? null

    let workspaceAgentId: string | null = null
    let full: WorkspaceFull | null = null
    if (workspaceId) {
      full = await api.getWorkspace(workspaceId)
      if (currentSession?.type === SessionType.Direct && currentSession.workspaceAgentId) {
        const currentAgent =
          state.currentWorkspaceAgents.find((item) => item.id === currentSession.workspaceAgentId) ??
          null
        workspaceAgentId =
          full.agents.find((item) => item.id === currentSession.workspaceAgentId)?.id ??
          full.agents.find((item) => sameAgentIdentity(item, currentAgent))?.id ??
          null

        if (!workspaceAgentId && currentAgent) {
          const created = await api.addWorkspaceAgent(workspaceId, workspaceAgentToConfigInput(currentAgent))
          full = { ...full, agents: [...full.agents, created] }
          workspaceAgentId = created.id
        } else if (!workspaceAgentId && full.agents.length === 1) {
          workspaceAgentId = full.agents[0]!.id
        }
      } else if (full.agents.length === 1) {
        workspaceAgentId = full.agents[0]!.id
      }
    }

    const session = await api.updateSession(sessionId, { workspaceId, workspaceAgentId })
    if (workspaceId && full) {
      workspaceDetailsCache.set(workspaceId, {
        workspace: full.workspace,
        agents: full.agents,
      })
    }
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === session.id ? session : item)),
      currentSession: s.currentSessionId === session.id ? session : s.currentSession,
      currentWorkspace:
        s.currentSessionId === session.id ? (full?.workspace ?? null) : s.currentWorkspace,
      currentWorkspaceAgents:
        s.currentSessionId === session.id ? (full?.agents ?? []) : s.currentWorkspaceAgents,
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

  async sendMessage(content, options) {
    const sessionId = get().currentSessionId
    if (!sessionId) return undefined
    return get().sendMessageToSession(sessionId, content, options)
  },

  async sendMessageToSession(sessionId, content, options) {
    cancelledSessions.delete(sessionId)
    set({ agentTyping: true })
    const attachments = get().pendingAttachments
    const contentForAgent = attachments.length
      ? appendAttachmentNote(content, attachments)
      : content
    const displayContent = options?.displayContent ?? (attachments.length ? content : contentForAgent)
    const optimisticId = `local-${crypto.randomUUID()}`
    const optimisticMessage: Message = {
      id: optimisticId,
      sessionId,
      senderId: 'default-user',
      senderType: SenderType.User,
      type: MessageType.Text,
      content: displayContent,
      metadata: null,
      replyToMessageId: options?.replyToMessageId ?? get().replyingToMessageId,
      createdAt: new Date().toISOString(),
    }
    set((s) => ({
      messages: upsertMessage(s.messages, optimisticMessage),
      pendingAttachments: [],
      replyingToMessageId: null,
      replyingToMessage: null,
    }))
    try {
      const replyToMessageId = optimisticMessage.replyToMessageId ?? undefined
      const msg = await api.sendMessageWithModel(sessionId, {
        content: contentForAgent,
        attachments,
        displayContent: options?.displayContent ?? (attachments.length ? content : undefined),
        replyToMessageId,
      })
      updateCachedMessages(sessionId, (messages) => upsertMessage(messages, msg))
      set((s) => ({
        messages: upsertMessage(
          s.messages.filter((message) => message.id !== optimisticId),
          msg,
        ),
      }))
      await get().fetchSessions()
      set({ agentTyping: false })
    } catch (error) {
      set((s) => ({
        messages: s.messages.filter((message) => message.id !== optimisticId),
        agentTyping: false,
        streamingMessage: null,
        streamingCodeAgentRun: null,
      }))
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
    updateCachedMessages(sessionId, (messages) =>
      messages.filter((message) => !removed.has(message.id)),
    )
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
    updateCachedMessages(sessionId, (messages) =>
      messages.filter((message) => message.id !== result.removedMessageId),
    )
    set((s) => ({
      messages: s.messages.filter((message) => message.id !== result.removedMessageId),
    }))
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
    set((s) => ({
      pendingAttachments: s.pendingAttachments.filter((attachment) => attachment.id !== id),
    }))
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

  setPreviewUrl(url, fileType = null, fileName = null) {
    set({ previewUrl: url, previewFileType: fileType, previewFileName: fileName })
  },

  selectAgentTab(agentId: string | null) {
    const { agentTabs, currentSessionId: groupSessionId } = get()
    if (agentId === null) {
      set({ selectedAgentTab: null })
      if (groupSessionId) {
        get().selectSession(groupSessionId)
      }
      return
    }
    const tab = agentTabs.find((t) => t.agentId === agentId)
    if (!tab || !tab.childSessionId) return
    set({ selectedAgentTab: agentId })
    get().selectSession(tab.childSessionId)
  },

  handleWSEvent(e) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    if (e.payload?.sessionId && e.payload.sessionId !== sessionId) {
      const isTaskBoardEvent = e.type?.startsWith('task_board:') || e.type === 'run:event'
      if (!isTaskBoardEvent) return
    }

    switch (e.type) {
      case WsEvent.AgentTyping:
        if (cancelledSessions.has(sessionId)) break
        set({ agentTyping: true })
        break
      case WsEvent.MessageStream: {
        if (cancelledSessions.has(sessionId)) break
        const { messageId, delta, agentId, agentName } = e.payload as {
          messageId: string
          delta: string
          agentId?: string
          agentName?: string
        }
        const commitPendingStream = (pending: {
          messageId: string
          delta: string
          agentId?: string
          agentName?: string
        }) => {
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
      case WsEvent.MessageMetadata: {
        if (cancelledSessions.has(sessionId)) break
        const { messageId, codeAgentRun } = e.payload as {
          messageId: string
          codeAgentRun: Partial<CodeAgentRunMetadata>
        }
        set((s) => {
          const current = s.streamingMessage
          const nextCodeAgentRun =
            s.streamingCodeAgentRun && codeAgentRun
              ? ({ ...s.streamingCodeAgentRun, ...codeAgentRun } as CodeAgentRunMetadata)
              : (codeAgentRun as CodeAgentRunMetadata)
          return {
            streamingMessage:
              current?.id === messageId
                ? current
                : { id: messageId, content: current?.content ?? '' },
            streamingCodeAgentRun: nextCodeAgentRun,
            agentTyping: false,
          }
        })
        break
      }
      case WsEvent.MessageCompleted: {
        const { message } = e.payload as { message: Message }
        cancelledSessions.delete(sessionId)
        clearPendingStream()
        updateCachedMessages(sessionId, (messages) => upsertMessage(messages, message))
        set((s) => {
          return {
            messages: upsertMessage(s.messages, message),
            streamingMessage: null,
            streamingCodeAgentRun: null,
            agentTyping: false,
          }
        })
        break
      }
      case WsEvent.MessageCancelled:
        cancelledSessions.add(sessionId)
        clearPendingStream()
        set({ streamingMessage: null, streamingCodeAgentRun: null, agentTyping: false })
        break
      case WsEvent.TaskUpdate: {
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
            if (
              msg.type !== MessageType.TaskCard ||
              !msg.metadata ||
              typeof msg.metadata !== 'object'
            )
              return msg
            const plan = (msg.metadata as Record<string, unknown>).plan as
              | {
                  tasks?: Array<{ id: string; status?: string; agentKey?: string }>
                  agents?: Array<{ key: string; id?: string }>
                }
              | undefined
            if (!plan || !Array.isArray(plan.tasks)) return msg
            const task = plan.tasks.find((t) => t.id === taskId)
            if (!task) return msg
            updated = true
            const nextTasks = plan.tasks.map((t) => {
              if (t.id !== taskId) return t
              const next: typeof t = {
                ...t,
                status: status as 'pending' | 'running' | 'done' | 'failed',
              }
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
      case WsEvent.BlackboardUpdate: {
        const { taskId, summary, agentName, taskTitle } = e.payload as {
          taskId: string
          summary?: string
          agentName?: string
          taskTitle?: string
        }
        set((s) => {
          let updated = false
          const newMessages = s.messages.map((msg) => {
            if (
              msg.type !== MessageType.TaskCard ||
              !msg.metadata ||
              typeof msg.metadata !== 'object'
            )
              return msg
            const plan = (msg.metadata as Record<string, unknown>).plan as
              | {
                  tasks?: Array<{
                    id: string
                    status?: string
                    summary?: string
                    agentName?: string
                    taskTitle?: string
                  }>
                }
              | undefined
            if (!plan || !Array.isArray(plan.tasks)) return msg
            const task = plan.tasks.find((t) => t.id === taskId)
            if (!task) return msg
            updated = true
            const nextTasks = plan.tasks.map((t) => {
              if (t.id !== taskId) return t
              return {
                ...t,
                status: (t.status === TaskStatus.Running
                  ? TaskStatus.Done
                  : t.status) as typeof t.status,
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
      case WsEvent.RunEvent: {
        const event = e.payload as {
          id: string
          runId: string
          type: string
          taskId?: string | null
          payload?: Record<string, unknown>
        }
        set((s) => {
          let nextTaskBoard = s.taskBoard
          if (nextTaskBoard && nextTaskBoard.runId === event.runId) {
            if (
              event.type === 'task.started' ||
              event.type === 'task.completed' ||
              event.type === 'task.failed' ||
              event.type === 'task.cancelled' ||
              event.type === 'task.retrying'
            ) {
              const taskId = event.taskId
              if (taskId) {
                const statusMap: Record<string, string> = {
                  'task.started': 'running',
                  'task.completed': 'done',
                  'task.failed': 'failed',
                  'task.cancelled': 'cancelled',
                  'task.retrying': 'pending',
                }
                const nextStatus = statusMap[event.type]
                if (nextStatus) {
                  nextTaskBoard = {
                    ...nextTaskBoard,
                    tasks: nextTaskBoard.tasks.map((t) =>
                      t.id === taskId ? { ...t, status: nextStatus as any } : t
                    ),
                    phases: nextTaskBoard.phases.map((p) =>
                      p.taskIds.includes(taskId) && nextStatus === 'running'
                        ? { ...p, status: 'active' as const }
                        : p.taskIds.includes(taskId) && (nextStatus === 'done' || nextStatus === 'failed' || nextStatus === 'cancelled')
                          ? {
                              ...p,
                              status: p.taskIds.every((tid) => {
                                const t = nextTaskBoard!.tasks.find((x) => x.id === tid)
                                return t && (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled')
                              })
                                ? ('completed' as const)
                                : p.status,
                            }
                          : p
                    ),
                  }
                }
              }
            }
            if (event.type === 'run.completed') nextTaskBoard = { ...nextTaskBoard, status: 'completed' }
            if (event.type === 'run.failed') nextTaskBoard = { ...nextTaskBoard, status: 'failed' }
            if (event.type === 'run.cancelled') nextTaskBoard = { ...nextTaskBoard, status: 'cancelled' }
            if (event.type === 'run.synthesizing') nextTaskBoard = { ...nextTaskBoard, status: 'synthesizing' }
          }

          if (nextTaskBoard !== s.taskBoard) {
            const nextAgentTabs = updateAgentTabsFromTaskBoard(s.agentTabs, nextTaskBoard, event)
            return { taskBoard: nextTaskBoard, agentTabs: nextAgentTabs }
          }
          return s
        })
        break
      }
      case WsEvent.TaskBoardPlanReady: {
        const { runId, plan, sessionId } = e.payload as {
          runId: string
          plan: Record<string, unknown>
          sessionId: string
        }
        const phases = (plan.phases as any[]) || []
        const tasks = (plan.tasks as any[]) || []
        const taskBoardTasks = tasks.map((t: any) => ({
          id: t.id,
          phaseId: t.phaseId || '',
          title: t.title || '',
          description: t.description || '',
          agentName: t.agentName || t.agentKey || t.agentId || '',
          status: 'pending' as const,
          dependencies: t.dependencies || [],
          childSessionId: t.childSessionId ?? null,
        }))
        const seenAgents = new Map<string, AgentTab>()
        for (const t of taskBoardTasks) {
          if (!t.agentName || seenAgents.has(t.agentName)) continue
          seenAgents.set(t.agentName, {
            agentId: t.id,
            agentName: t.agentName,
            roleIcon: getRoleIcon(t.agentName, t.title),
            status: 'pending',
            childSessionId: t.childSessionId ?? null,
          })
        }
        set((state) => ({
          ...state,
          agentTabs: Array.from(seenAgents.values()),
          selectedAgentTab: state.taskBoard?.runId !== runId ? null : state.selectedAgentTab,
          taskBoard: {
            runId,
            title: (plan.title as string) || '',
            goal: (plan.goal as string) || '',
            collaborationMode: (plan.collaborationMode as string) || 'mapreduce',
            phases: phases.map((p: any) => ({
              id: p.id,
              title: p.title || '',
              purpose: p.purpose || '',
              taskIds: p.taskIds || [],
              status: 'pending' as const,
            })),
            tasks: taskBoardTasks,
            status: 'planning' as const,
            sessionId,
          },
        }))
        break
      }
      case WsEvent.TaskBoardTaskProgress: {
        const { taskId, percent, status } = e.payload as {
          taskId: string
          percent: number
          status: string
        }
        set((state) => {
          if (!state.taskBoard) return state
          const nextTasks = state.taskBoard.tasks.map((t) =>
            t.id === taskId ? { ...t, progress: percent, progressStatus: status } : t
          )
          const nextAgentTabs = state.agentTabs.map((tab) => {
            const task = nextTasks.find((t) => t.id === tab.agentId)
            if (task) {
              return { ...tab, progress: percent, progressStatus: status }
            }
            return tab
          })
          return {
            ...state,
            taskBoard: { ...state.taskBoard, tasks: nextTasks },
            agentTabs: nextAgentTabs,
          }
        })
        break
      }
      case WsEvent.TaskBoardRunCompleted: {
        const { runId, status } = e.payload as { runId: string; status: string }
        set((state) => {
          if (!state.taskBoard || state.taskBoard.runId !== runId) return state
          return {
            ...state,
            taskBoard: {
              ...state.taskBoard,
              status: status as any,
            },
          }
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

function sameAgentIdentity(agent: WorkspaceAgent, current: WorkspaceAgent | null) {
  if (!current) return false
  return [
    normalizeMatchText(agent.name),
    normalizeMatchText(agent.role),
    normalizeMatchText(agent.runtimeType ?? ''),
    normalizeMatchText(agent.runtimeType === 'code-agent' ? agent.codeAgentType ?? '' : ''),
  ].join('|') === [
    normalizeMatchText(current.name),
    normalizeMatchText(current.role),
    normalizeMatchText(current.runtimeType ?? ''),
    normalizeMatchText(current.runtimeType === 'code-agent' ? current.codeAgentType ?? '' : ''),
  ].join('|')
}

function workspaceAgentToConfigInput(agent: WorkspaceAgent): AgentConfigInput {
  return {
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType ?? 'custom',
    description: agent.description ?? '',
    avatar: agent.avatar ?? null,
    systemPrompt: agent.systemPrompt ?? '',
    roleProfile: agent.roleProfile ?? null,
    color: agent.color ?? '#111827',
    modelId: agent.modelId ?? null,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: [...agent.capabilityTags],
    toolPermissions: [...agent.toolPermissions],
    sandboxPolicy: agent.sandboxPolicy,
    contextPolicy: agent.contextPolicy,
    autoInvoke: agent.autoInvoke,
    approvalRequired: agent.approvalRequired,
  }
}

function normalizeMatchText(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase()
}

function appendAttachmentNote(content: string, attachments: ChatAttachment[]) {
  const note = attachments
    .map((attachment) => `- ${attachment.name} (${attachment.mimeType})`)
    .join('\n')
  return `${content.trim()}\n\n[已附加图片]\n${note}`.trim()
}
