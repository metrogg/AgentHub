import { create } from 'zustand'
import {
  api,
  type ChatAttachment,

  type Message,
  type Session,
  type Workspace,
  type WorkspaceAgent,
} from '../lib/api'
import { wsClient, type WSEvent } from '../lib/ws'
import type { CodeAgentRunMetadata } from '@agenthub/shared'
import { WsEvent, TaskStatus, MessageType, SessionType } from '@agenthub/shared'

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
  messageCache.set(sessionId, updater(cached))
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
  sendMessage: (content: string) => Promise<{ groupSessionId?: string } | undefined>
  sendMessageToSession: (
    sessionId: string,
    content: string,
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
      messages: cachedMessages ?? [],
      streamingMessage: null,
      streamingCodeAgentRun: null,
      pendingAttachments: [],
      agentTyping: false,
      replyingToMessageId: null,
      replyingToMessage: null,
    })
    wsClient.joinSession(sessionId)
    try {
      const [session, { items }] = await Promise.all([
        api.getSession(sessionId),
        api.listMessages(sessionId),
      ])
      messageCache.set(sessionId, items)
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

  async sendMessage(content) {
    const sessionId = get().currentSessionId
    if (!sessionId) return undefined
    return get().sendMessageToSession(sessionId, content)
  },

  async sendMessageToSession(sessionId, content) {
    cancelledSessions.delete(sessionId)
    set({ agentTyping: true })
    const attachments = get().pendingAttachments
    const contentForAgent = attachments.length
      ? appendAttachmentNote(content, attachments)
      : content
    try {
      const replyToMessageId = get().replyingToMessageId
      const msg = await api.sendMessageWithModel(sessionId, {
        content: contentForAgent,
        attachments,
        displayContent: attachments.length ? content : undefined,
        replyToMessageId,
      })
      set((s) => ({
        messages: [...s.messages, msg],
        pendingAttachments: [],
        replyingToMessageId: null,
        replyingToMessage: null,
      }))
      await get().fetchSessions()
      set({ agentTyping: false })
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

  handleWSEvent(e) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    if (e.payload?.sessionId && e.payload.sessionId !== sessionId) return

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
          codeAgentRun: CodeAgentRunMetadata
        }
        set((s) => {
          const current = s.streamingMessage
          return {
            streamingMessage:
              current?.id === messageId
                ? current
                : { id: messageId, content: current?.content ?? '' },
            streamingCodeAgentRun: codeAgentRun,
            agentTyping: false,
          }
        })
        break
      }
      case WsEvent.MessageCompleted: {
        const { message } = e.payload as { message: Message }
        cancelledSessions.delete(sessionId)
        clearPendingStream()
        set((s) => {
          const exists = s.messages.some((msg) => msg.id === message.id)
          return {
            messages: exists
              ? s.messages.map((msg) => (msg.id === message.id ? message : msg))
              : [...s.messages, message],
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
          let updated = false
          const newMessages = s.messages.map((msg) => {
            if (
              msg.type !== MessageType.TaskCard ||
              !msg.metadata ||
              typeof msg.metadata !== 'object'
            )
              return msg
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
                    'task.completed': TaskStatus.Done,
                    'task.failed': TaskStatus.Failed,
                    'task.cancelled': TaskStatus.Cancelled,
                    'task.retrying': TaskStatus.Pending,
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

          if (updated || nextTaskBoard !== s.taskBoard) {
            return { messages: newMessages, taskBoard: nextTaskBoard }
          }
          return { messages: newMessages }
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
        set((state) => ({
          ...state,
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
            tasks: tasks.map((t: any) => ({
              id: t.id,
              phaseId: t.phaseId || '',
              title: t.title || '',
              description: t.description || '',
              agentName: t.agentKey || t.agentId || '',
              status: 'pending' as const,
              dependencies: t.dependencies || [],
            })),
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
          return {
            ...state,
            taskBoard: {
              ...state.taskBoard,
              tasks: state.taskBoard.tasks.map((t) =>
                t.id === taskId ? { ...t, progress: percent, progressStatus: status } : t
              ),
            },
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

function appendAttachmentNote(content: string, attachments: ChatAttachment[]) {
  const note = attachments
    .map((attachment) => `- ${attachment.name} (${attachment.mimeType})`)
    .join('\n')
  return `${content.trim()}\n\n[已附加图片]\n${note}`.trim()
}
