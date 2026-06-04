import { API_BASE, request } from './apiClient'
import type {
  AgentDraft,
  AgentDraftConfirmResult,
  AgUiRunEvent,
  ChatAttachment,
  ConflictReportItem,
  ExecutionLog,
  MemberProposalConfirmResult,
  MemberProposalContinueResult,
  Message,
  OrchestratorRunArtifactSnapshot,
  OrchestratorRunEvent,
  OrchestratorRunListItem,
  OrchestratorRunResourceSnapshot,
  QuotedMessagePreview,
  Session,
  TypedBlackboardEntry,
  WelcomeQuickPromptsResponse,
} from './apiTypes'
import type { BlackboardSchemaType, MessageType, OrchestratorRunStatus, SessionType } from './apiTypes'

export const chatApi = {
  // Sessions
  listSessions: () => request<{ items: Session[] }>('/sessions'),
  getSession: (id: string) => request<Session>(`/sessions/${id}`),
  createSession: (data: {
    title: string
    type?: SessionType
    workspaceId?: string | null
    workspaceAgentId?: string | null
    metadata?: Record<string, unknown> | null
  }) => request<Session>('/sessions', { method: 'POST', body: JSON.stringify(data) }),
  updateSession: (
    id: string,
    data: {
      title?: string
      workspaceId?: string | null
      workspaceAgentId?: string | null
      metadata?: Record<string, unknown> | null
    },
  ) => request<Session>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  deleteAllSessions: () => request<{ deleted: boolean }>('/sessions/all', { method: 'DELETE' }),

  // Messages
  listMessages: (sessionId: string) => request<{ items: Message[] }>(`/messages/${sessionId}`),
  sendMessage: (sessionId: string, data: { content: string; type?: MessageType }) =>
    request<Message>(`/messages/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({ content: data.content, type: data.type ?? 'text' }),
    }),

  sendMessageWithModel: (
    sessionId: string,
    data: {
      content: string
      modelId?: string
      type?: MessageType
      skipAgentReply?: boolean
      attachments?: ChatAttachment[]
      displayContent?: string
      replyToMessageId?: string | null
      quotedMessage?: QuotedMessagePreview | null
      safetyMode?: string
      mentions?: string[]
    },
  ) =>
    request<Message>(`/messages/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({
        content: data.content,
        type: (data.type ?? 'text') as MessageType,
        ...(data.mentions?.length ? { mentions: data.mentions } : {}),
        metadata: {
          ...(data.modelId ? { modelId: data.modelId } : {}),
          ...(data.skipAgentReply ? { skipAgentReply: true } : {}),
          ...(data.attachments?.length ? { attachments: data.attachments } : {}),
          ...(data.displayContent !== undefined ? { displayContent: data.displayContent } : {}),
          ...(data.replyToMessageId ? { replyToMessageId: data.replyToMessageId } : {}),
          ...(data.quotedMessage ? { quotedMessage: data.quotedMessage } : {}),
          ...(data.safetyMode ? { safetyMode: data.safetyMode } : {}),
        },
      }),
    }),
  cancelMessage: (
    sessionId: string,
    data?: { persistTerminatedMessage?: boolean; content?: string },
  ) =>
    request<{ cancelled: boolean; activeRunCancelled?: boolean; message?: Message }>(
      `/messages/${sessionId}/cancel`,
      {
        method: 'POST',
        body: data ? JSON.stringify(data) : undefined,
      },
    ),
  clearMessages: (sessionId: string) =>
    request<{ deleted: boolean }>(`/messages/${sessionId}/all`, {
      method: 'DELETE',
    }),
  updateMessage: (sessionId: string, messageId: string, data: { content: string }) =>
    request<Message>(`/messages/${sessionId}/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  withdrawMessage: (sessionId: string, messageId: string, data: { rollback?: boolean } = {}) =>
    request<{ removedMessageIds: string[]; rollback: { reverted: number; failed: number } }>(
      `/messages/${sessionId}/${messageId}${data.rollback === false ? '?rollback=false' : ''}`,
      { method: 'DELETE' },
    ),
  regenerateMessage: (sessionId: string, messageId: string) =>
    request<{ removedMessageId: string }>(`/messages/${sessionId}/${messageId}/regenerate`, {
      method: 'POST',
    }),
  resendMessage: (sessionId: string, messageId: string) =>
    request<{ removedMessageIds: string[] }>(`/messages/${sessionId}/${messageId}/resend`, {
      method: 'POST',
    }),
  pinMessage: (sessionId: string, messageId: string) =>
    request<Message>(`/messages/${sessionId}/${messageId}/pin`, { method: 'PATCH' }),
  unpinMessage: (sessionId: string, messageId: string) =>
    request<Message>(`/messages/${sessionId}/${messageId}/unpin`, { method: 'PATCH' }),
  createAgentDraft: (sessionId: string, content: string) =>
    request<Message>(`/messages/${sessionId}/agent-draft`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  confirmAgentDraft: (sessionId: string, messageId: string, draft: AgentDraft) =>
    request<AgentDraftConfirmResult>(`/messages/${sessionId}/agent-draft/${messageId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ draft }),
    }),
  confirmMemberProposals: (sessionId: string, messageId: string, profileIds: string[]) =>
    request<MemberProposalConfirmResult>(`/messages/${sessionId}/member-proposals/${messageId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ profileIds }),
    }),
  continueMemberProposals: (sessionId: string, messageId: string) =>
    request<MemberProposalContinueResult>(
      `/messages/${sessionId}/member-proposals/${messageId}/continue`,
      {
        method: 'POST',
      },
    ),
  getWelcomeQuickPrompts: (seed: string, count = 10) =>
    request<WelcomeQuickPromptsResponse>('/welcome/quick-prompts', {
      method: 'POST',
      body: JSON.stringify({ count, seed }),
      timeout: 50_000,
    }),

  // Orchestrator runs
  listOrchestratorRuns: () => request<{ items: OrchestratorRunListItem[] }>('/orchestrator-runs'),
  getOrchestratorRun: (id: string) => request<OrchestratorRunListItem>(`/orchestrator-runs/${id}`),
  cancelOrchestratorRun: (id: string) =>
    request<{ run: { id: string; status: OrchestratorRunStatus }; activeRunCancelled: boolean }>(
      `/orchestrator-runs/${id}/cancel`,
      { method: 'POST' },
    ),
  retryOrchestratorTask: (runId: string, taskId: string) =>
    request<{ ok: boolean; result: unknown }>(`/orchestrator-runs/${runId}/retry-task/${taskId}`, {
      method: 'POST',
    }),
  getOrchestratorRunEvents: (id: string) =>
    request<{ items: OrchestratorRunEvent[] }>(`/orchestrator-runs/${id}/events`),
  getOrchestratorRunArtifacts: (id: string) =>
    request<{ items: OrchestratorRunArtifactSnapshot[] }>(`/orchestrator-runs/${id}/artifacts`),
  getOrchestratorRunResourceSnapshot: (id: string) =>
    request<OrchestratorRunResourceSnapshot>(`/orchestrator-runs/${id}/resource-snapshot`),
  getAgUiRunEvents: (id: string) =>
    request<{ items: AgUiRunEvent[] }>(`/protocols/ag-ui/runs/${id}/events`),
  getOrchestratorRunBlackboard: (id: string, schemaType?: BlackboardSchemaType) =>
    request<{ items: TypedBlackboardEntry[] }>(
      `/orchestrator-runs/${id}/blackboard${schemaType ? `?schemaType=${encodeURIComponent(schemaType)}` : ''}`,
    ),
  getOrchestratorRunLogs: (id: string) =>
    request<{ items: ExecutionLog[] }>(`/orchestrator-runs/${id}/logs`),
  getOrchestratorRunConflicts: (id: string) =>
    request<{ items: ConflictReportItem[] }>(`/orchestrator-runs/${id}/conflicts`),
  resolveOrchestratorConflict: (
    id: string,
    body: {
      filePath: string
      resolution: 'approved' | 'rejected' | 'overridden'
      mergedContent?: string
      notes?: string
    },
  ) =>
    request<{ ok: boolean; item: ConflictReportItem }>(
      `/orchestrator-runs/${id}/resolve-conflict`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),

  // Translate (SSE streaming)
  translate: async function* (text: string, targetLang: 'zh' | 'en' = 'zh'): AsyncGenerator<string> {
    const res = await fetch(`${API_BASE}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text, targetLang }),
    })
    if (!res.ok) throw new Error(`翻译请求失败: ${res.status}`)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('event: done')) return
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (!payload) continue
        yield payload
      }
    }
  },
}
