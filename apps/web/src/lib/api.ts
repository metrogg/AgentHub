const API_BASE = '/api'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, body?.error ?? body?.message ?? `HTTP ${res.status}`)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export interface Session {
  id: string
  ownerId: string
  title: string
  type: 'direct' | 'group'
  workspaceId?: string | null
  workspaceAgentId?: string | null
  createdAt: string
  updatedAt: string
}

export interface Message {
  id: string
  sessionId: string
  senderId: string
  senderType: 'user' | 'agent' | 'system'
  type: string
  content: string
  metadata: Record<string, unknown> | null
  createdAt: string
}

export type AgentArtifact =
  | {
      id: string
      kind: 'web_preview'
      title: string
      description?: string
      url: string
      framework?: string
      status?: 'ready' | 'building' | 'failed'
    }
  | {
      id: string
      kind: 'diff'
      title: string
      description?: string
      files: Array<{
        path: string
        additions: number
        deletions: number
        language?: string
        patch: string
      }>
    }
  | {
      id: string
      kind: 'file'
      title: string
      description?: string
      fileName: string
      mimeType: string
      sizeLabel: string
      url?: string
    }
  | {
      id: string
      kind: 'deploy'
      title: string
      description?: string
      provider: string
      environment: string
      status: 'queued' | 'building' | 'ready' | 'failed'
      previewUrl?: string
      logs?: string[]
    }

export interface ModelCatalogItem {
  id: string
  enabled: boolean
  name: string
  provider: string
  modelId: string
  apiEndpoint: string
  anthropicEndpoint?: string
  apiKeyEnv?: string
  apiKey?: string
}

export interface CodingToolStatus {
  configEnv?: string
  configMessage?: string
  configured?: boolean
  id: string
  command: string
  installed: boolean
  version: string | null
}

export interface CodingToolProbe {
  apiKeyEnv?: string
  id: string
  command: string
}

export interface CodingToolStatusResponse {
  items: CodingToolStatus[]
  localCliProbesEnabled: boolean
  platform: string
  runtime?: 'local' | 'host'
}

export interface AgentAdapterCatalogItem {
  id: 'codex' | 'claude-code' | 'opencode'
  name: string
  command: string
  envKey: string
  docsHint: string
  installed: boolean
  configured: boolean
  version: string | null
  configEnv: string
  configMessage: string
  executionEnabled: boolean
  ready: boolean
  readiness: string
}

export interface AgentAdapterCatalogResponse {
  platform: string
  localCliProbesEnabled: boolean
  executionEnabled: boolean
  items: AgentAdapterCatalogItem[]
}

export interface CliInstallAction {
  code?: number
  items?: CodingToolStatus[]
  ok: boolean
  output?: string
  message: string
  runtime?: 'local' | 'host'
  status: 'completed' | 'failed'
}

export interface OpencodeModelItem {
  id: string
  provider: string
  model: string
}

export interface OpencodeModelsResponse {
  ok: boolean
  defaultModel: string | null
  smallModel: string | null
  configPath: string
  models: OpencodeModelItem[]
  message: string
}

export interface CodexAuthStatus {
  loggedIn: boolean
  authMode: 'none' | 'api-key' | 'chatgpt'
  status: 'logged-in' | 'logged-out'
  message: string
  accountId?: string | null
  deviceAuthEnabled?: boolean
  validationFailed?: boolean
  validationError?: string | null
}

export interface CodexAuthAction {
  ok: boolean
  status?: 'pending' | 'completed' | 'failed'
  message: string
}

export interface CodexLoginStart extends CodexAuthAction {
  status: 'pending' | 'failed'
  loginId?: string
  verificationUrl?: string
  userCode?: string
  interval?: number
  expiresAt?: string
}

export interface CodexLoginPoll extends CodexAuthAction {
  status: 'pending' | 'completed' | 'failed'
  cliAuthMessage?: string
  cliAuthSynced?: boolean
  interval?: number
}

export interface Workspace {
  id: string
  ownerId: string
  name: string
  goal: string
  projectPath: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkspaceAgent {
  id: string
  workspaceId: string
  name: string
  role: string
  description: string
  avatar: string | null
  systemPrompt: string
  color: string
  modelId: string | null
  runtimeType: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType: 'codex' | 'claude-code' | 'opencode' | null
  capabilityTags: string[]
  toolPermissions: string[]
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
  contextPolicy: 'recent-only' | 'pinned-recent' | 'workspace-aware'
  autoInvoke: boolean
  approvalRequired: boolean
  orderIdx: number
  createdAt: string
}

export interface AgentConfigInput {
  name: string
  role: string
  description?: string
  avatar?: string | null
  systemPrompt?: string
  color?: string
  modelId?: string | null
  runtimeType?: WorkspaceAgent['runtimeType']
  codeAgentType?: WorkspaceAgent['codeAgentType']
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: WorkspaceAgent['sandboxPolicy']
  contextPolicy?: WorkspaceAgent['contextPolicy']
  autoInvoke?: boolean
  approvalRequired?: boolean
}

export type AgentDraft = Required<Omit<AgentConfigInput, 'avatar' | 'modelId' | 'codeAgentType'>> & {
  avatar?: string | null
  modelId?: string | null
  codeAgentType?: WorkspaceAgent['codeAgentType']
}

export interface AgentDraftConfirmResult {
  agent: WorkspaceAgent
  message: Message
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed'

export interface WorkspaceTask {
  id: string
  workspaceId: string
  agentId: string | null
  title: string
  description: string
  status: TaskStatus
  sessionId: string | null
  orderIdx: number
  createdAt: string
  updatedAt: string
}

export interface WorkspaceFull {
  workspace: Workspace
  agents: WorkspaceAgent[]
  tasks: WorkspaceTask[]
}

export type WorkspaceFolderOpenResult =
  | { cancelled: true; projectPath: null; workspace?: null }
  | { cancelled: false; projectPath: string; workspace?: Workspace | null }

export interface OrchestratorPlanAgent {
  key: string
  name: string
  role: string
  color: string
  systemPrompt: string
}

export interface OrchestratorPlanTask {
  id: string
  title: string
  description: string
  agentKey: string
  status?: TaskStatus
}

export interface OrchestratorPlan {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: OrchestratorPlanAgent[]
  tasks: OrchestratorPlanTask[]
  messageId?: string
}

export interface OrchestratorDispatchResult {
  workspaceId: string
  groupSessionId?: string
  tasks: Array<{ taskId: string; sessionId: string; title: string; agentName: string }>
}

export const api = {
  // Sessions
  listSessions: () => request<{ items: Session[] }>('/sessions'),
  getSession: (id: string) => request<Session>(`/sessions/${id}`),
  createSession: (data: { title: string; type?: 'direct' | 'group' }) =>
    request<Session>('/sessions', { method: 'POST', body: JSON.stringify(data) }),
  deleteSession: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),

  // Messages
  listMessages: (sessionId: string) =>
    request<{ items: Message[] }>(`/messages/${sessionId}`),
  sendMessage: (sessionId: string, data: { content: string; type?: string }) =>
    request<Message>(`/messages/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({ content: data.content, type: data.type ?? 'text' }),
    }),

  sendMessageWithModel: (
    sessionId: string,
    data: { content: string; modelId?: string; type?: string; skipAgentReply?: boolean }
  ) =>
    request<Message>(`/messages/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({
        content: data.content,
        type: data.type ?? 'text',
        metadata: {
          ...(data.modelId ? { modelId: data.modelId } : {}),
          ...(data.skipAgentReply || mentionsOrchestrator(data.content) ? { skipAgentReply: true } : {}),
        },
      }),
    }),
  cancelMessage: (sessionId: string) =>
    request<{ cancelled: boolean }>(`/messages/${sessionId}/cancel`, {
      method: 'POST',
    }),
  createOrchestratorPlan: (sessionId: string, content: string) =>
    request<Message>(`/messages/${sessionId}/orchestrator-plan`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  updateOrchestratorPlan: (
    sessionId: string,
    messageId: string,
    data: { tasks: Array<{ id: string; agentKey?: string; status?: TaskStatus }> }
  ) =>
    request<Message>(`/messages/${sessionId}/orchestrator-plan/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  dispatchOrchestratorPlan: (sessionId: string, messageId: string) =>
    request<OrchestratorDispatchResult>(
      `/messages/${sessionId}/orchestrator-plan/${messageId}/dispatch`,
      { method: 'POST' }
    ),
  createArtifactDemo: (sessionId: string, content: string) =>
    request<Message>(`/messages/${sessionId}/artifact-demo`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
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

  // Settings (map-based)
  getSettings: () => request<Record<string, string>>('/settings'),
  saveSettings: (data: Record<string, string>) =>
    request<{ success: boolean }>('/settings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  testModel: (data: {
    provider: string
    apiEndpoint: string
    anthropicEndpoint?: string
    apiKey?: string
    apiKeyEnv?: string
    modelId?: string
  }) =>
    request<{ ok: boolean; status?: number; message: string }>('/settings/test-model', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Coding tools
  getCodingToolStatus: (tools?: CodingToolProbe[]) =>
    tools?.length
      ? request<CodingToolStatusResponse>('/coding-tools/status', {
          method: 'POST',
          body: JSON.stringify({ tools }),
        })
      : request<CodingToolStatusResponse>('/coding-tools/status'),
  getAgentAdapters: () =>
    request<AgentAdapterCatalogResponse>('/coding-tools/agent-adapters'),
  installAllCliTools: () =>
    request<CliInstallAction>('/coding-tools/cli/install', { method: 'POST' }),
  getOpencodeModels: () =>
    request<OpencodeModelsResponse>('/coding-tools/opencode/models'),
  getCodexAuthStatus: () => request<CodexAuthStatus>('/coding-tools/codex/auth/status'),
  startCodexChatGptLogin: () =>
    request<CodexLoginStart>('/coding-tools/codex/auth/start', { method: 'POST' }),
  openCodexChatGptDevicePage: () =>
    request<CodexAuthAction>('/coding-tools/codex/auth/open-device', { method: 'POST' }),
  pollCodexChatGptLogin: (loginId: string) =>
    request<CodexLoginPoll>('/coding-tools/codex/auth/poll', {
      method: 'POST',
      body: JSON.stringify({ loginId }),
    }),
  retryCodexChatGptAuth: () =>
    request<CodexAuthAction>('/coding-tools/codex/auth/retry', { method: 'POST' }),
  logoutCodexChatGpt: () =>
    request<CodexAuthAction>('/coding-tools/codex/auth/logout', { method: 'POST' }),
  // Workspaces (Agent Group)
  listWorkspaces: () => request<{ items: Workspace[] }>('/workspaces'),
  createWorkspace: (data: { name: string; goal?: string; projectPath?: string | null; template?: 'blank' | 'classic' }) =>
    request<WorkspaceFull>('/workspaces', { method: 'POST', body: JSON.stringify(data) }),
  openWorkspaceFolder: () =>
    request<WorkspaceFolderOpenResult>('/workspaces/open-folder', { method: 'POST' }),
  getWorkspace: (id: string) => request<WorkspaceFull>(`/workspaces/${id}`),
  updateWorkspace: (id: string, data: { name?: string; goal?: string; projectPath?: string | null }) =>
    request<WorkspaceFull>(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkspace: (id: string) => request<void>(`/workspaces/${id}`, { method: 'DELETE' }),

  addWorkspaceAgent: (
    id: string,
    data: AgentConfigInput
  ) =>
    request<WorkspaceAgent>(`/workspaces/${id}/agents`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkspaceAgent: (
    id: string,
    agentId: string,
    data: Partial<AgentConfigInput>
  ) =>
    request<WorkspaceAgent>(`/workspaces/${id}/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteWorkspaceAgent: (id: string, agentId: string) =>
    request<void>(`/workspaces/${id}/agents/${agentId}`, { method: 'DELETE' }),

  addWorkspaceTask: (
    id: string,
    data: { title: string; description?: string; agentId?: string | null }
  ) =>
    request<WorkspaceTask>(`/workspaces/${id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkspaceTask: (
    id: string,
    taskId: string,
    data: Partial<{ title: string; description: string; agentId: string | null; status: TaskStatus }>
  ) =>
    request<WorkspaceTask>(`/workspaces/${id}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteWorkspaceTask: (id: string, taskId: string) =>
    request<void>(`/workspaces/${id}/tasks/${taskId}`, { method: 'DELETE' }),
  dispatchWorkspaceTask: (id: string, taskId: string) =>
    request<{ task: WorkspaceTask; sessionId: string }>(
      `/workspaces/${id}/tasks/${taskId}/dispatch`,
      { method: 'POST' }
    ),
  workspaceSummary: (id: string) =>
    request<{ sessionId: string }>(`/workspaces/${id}/summary`, { method: 'POST' }),
  openWorkspaceGroupSession: (id: string) =>
    request<{ session: Session }>(`/workspaces/${id}/group-session`, { method: 'POST' }),
  openWorkspaceAgentSession: (id: string, agentId: string) =>
    request<{ session: Session }>(`/workspaces/${id}/agents/${agentId}/session`, { method: 'POST' }),
}

export function mentionsOrchestrator(content: string) {
  return /(^|\s)@(orchestrator|coordinator|agenthub)\b/i.test(content) || content.includes('@协调器') || content.includes('@调度')
}
