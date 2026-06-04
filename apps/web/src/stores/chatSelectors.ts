import { useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import { buildHeaderAgentStatusProjection } from '../lib/runtimeStatusProjection'
import { useChatStore, type ChatState } from './chatStore'

const emptyMessages: ChatState['messages'] = []
const messageByIdCache = new WeakMap<
  ChatState['messages'],
  Map<string, ChatState['messages'][number]>
>()

function getMessageById(messages: ChatState['messages'], messageId?: string | null) {
  if (!messageId) return undefined
  let byId = messageByIdCache.get(messages)
  if (!byId) {
    byId = new Map(messages.map((message) => [message.id, message]))
    messageByIdCache.set(messages, byId)
  }
  return byId.get(messageId)
}

export function useChatStoreShallow<T>(selector: (state: ChatState) => T): T {
  return useChatStore(selector, shallow)
}

export const selectCurrentSessionId = (state: ChatState) => state.currentSessionId
export const selectCurrentWorkspaceId = (state: ChatState) => state.currentSession?.workspaceId
export const selectMessages = (state: ChatState) => state.messages
export const selectMessageCount = (state: ChatState) => state.messages.length

export const selectChatPageState = (state: ChatState) => ({
  currentSessionId: state.currentSessionId,
  sessionsBootstrapped: state.sessionsBootstrapped,
  initWebSocket: state.initWebSocket,
  selectSession: state.selectSession,
})

export const selectRuntimeState = (state: ChatState) => ({
  messages: state.messages,
  streamingMessage: state.streamingMessage,
  streamingCodeAgentRun: state.streamingCodeAgentRun,
  agentTyping: state.agentTyping,
  agentActivity: state.agentActivity,
  currentSessionId: state.currentSessionId,
  sendMessage: state.sendMessage,
  safetyMode: state.safetyMode,
  cancelRun: state.cancelRun,
})

export const selectSessionListState = (state: ChatState) => ({
  sessions: state.sessions,
  currentSession: state.currentSession,
  taskBoard: state.taskBoard,
  sessionsBootstrapped: state.sessionsBootstrapped,
  loadingSessions: state.loadingSessions,
  currentSessionId: state.currentSessionId,
  fetchSessions: state.fetchSessions,
  selectSession: state.selectSession,
  deleteSession: state.deleteSession,
})

export const selectThreadShellState = (state: ChatState) => ({
  currentSession: state.currentSession,
  workspaceAgents: state.currentWorkspaceAgents,
  taskBoard: state.taskBoard,
  agentActivity: state.agentActivity,
  streamingCodeAgentRun: state.streamingCodeAgentRun,
  selectedAgentTab: state.selectedAgentTab,
  agentTabs: state.agentTabs,
  selectAgentTab: state.selectAgentTab,
  selectSession: state.selectSession,
})

export const selectHeaderAgentStatus = (state: ChatState) =>
  buildHeaderAgentStatusProjection({
    sessionId: state.currentSession?.id ?? null,
    taskBoard: state.taskBoard,
    agentTabs: state.agentTabs,
    agentTyping: state.agentTyping,
    agentActivity: state.agentActivity,
    streamingMessage: state.streamingMessage,
    streamingCodeAgentRun: state.streamingCodeAgentRun,
  })

export const selectGroupHeaderState = (state: ChatState) => ({
  session: state.currentSession,
  workspace: state.currentWorkspace,
  agents: state.currentWorkspaceAgents,
  clearMessages: state.clearMessages,
})

export const selectAgentHeaderState = (state: ChatState) => ({
  session: state.currentSession,
  workspace: state.currentWorkspace,
  agents: state.currentWorkspaceAgents,
})

export const selectComposerState = (state: ChatState) => ({
  currentSessionId: state.currentSessionId,
  currentWorkspace: state.currentWorkspace,
  workspaceAgents: state.currentWorkspaceAgents,
  fetchSessions: state.fetchSessions,
  setSessionWorkspace: state.setSessionWorkspace,
  pendingAttachments: state.pendingAttachments,
  addPendingAttachments: state.addPendingAttachments,
  removePendingAttachment: state.removePendingAttachment,
  replyingToMessage: state.replyingToMessage,
  replyingToKind: state.replyingToKind,
  setReplyingTo: state.setReplyingTo,
  sendMessage: state.sendMessage,
  agentTyping: state.agentTyping,
  streamingMessage: state.streamingMessage,
  safetyMode: state.safetyMode,
  setSafetyMode: state.setSafetyMode,
  cancelRun: state.cancelRun,
})

export const selectWorkspaceChatState = (state: ChatState) => ({
  taskBoard: state.taskBoard,
  previewUrl: state.previewUrl,
  previewFileName: state.previewFileName,
  setPreviewUrl: state.setPreviewUrl,
  agentTabs: state.agentTabs,
  selectedAgentTab: state.selectedAgentTab,
  selectAgentTab: state.selectAgentTab,
  agentTyping: state.agentTyping,
  agentActivity: state.agentActivity,
})

export function makeSelectSessionExists(sessionId?: string | null) {
  return (state: ChatState) =>
    sessionId ? state.sessions.some((session) => session.id === sessionId) : false
}

export function makeSelectMessageById(messageId?: string | null) {
  return (state: ChatState) => getMessageById(state.messages, messageId)
}

export function makeSelectMessageWithQuoteSource(messageId?: string | null) {
  return (state: ChatState) => {
    const message = getMessageById(state.messages, messageId)
    const replyToMessageId =
      typeof message?.replyToMessageId === 'string' ? message.replyToMessageId : null
    return {
      message,
      quotedSourceMessage: getMessageById(state.messages, replyToMessageId),
    }
  }
}

export function makeSelectMessageAvatarState(messageId?: string | null) {
  return (state: ChatState) => ({
    sourceMessage: getMessageById(state.messages, messageId),
    streamingMessage:
      messageId && state.streamingMessage?.id === messageId ? state.streamingMessage : null,
    workspaceAgents: state.currentWorkspaceAgents,
  })
}

export function makeSelectDirectRunMessages(enabled: boolean) {
  return (state: ChatState) => (enabled ? state.messages : emptyMessages)
}

export function useChatMessageById(messageId?: string | null) {
  const selector = useMemo(() => makeSelectMessageById(messageId), [messageId])
  return useChatStore(selector)
}
