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

export interface ChatAttachment {
  id: string
  type: 'image'
  name: string
  mimeType: string
  size: number
  dataUrl: string
}

export type AgentArtifact =
  | {
      id: string
      type: 'diff'
      title: string
      description?: string
      source?: string
      createdAt?: string
      filePath: string
      status?: 'created' | 'modified' | 'deleted' | 'renamed' | 'untracked'
      language?: string
      diff: string
    }
  | {
      id: string
      type: 'preview'
      title: string
      description?: string
      source?: string
      createdAt?: string
      url: string
      previewKind: 'dev-server' | 'static-html' | 'iframe'
    }
  | {
      id: string
      type: 'file'
      title: string
      description?: string
      source?: string
      createdAt?: string
      path: string
      status?: 'created' | 'modified' | 'deleted' | 'renamed' | 'untracked'
      mimeType?: string
      size?: number
    }
  | {
      id: string
      type: 'deploy'
      title: string
      description?: string
      source?: string
      createdAt?: string
      provider: 'vercel' | 'static' | 'unknown'
      status: 'pending' | 'running' | 'ready' | 'failed'
      url?: string
      logs?: string
    }

export interface CodeAgentRunMetadata {
  type: 'code-agent-run'
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out'
  runtime: 'codex' | 'claude-code' | 'opencode'
  command: string
  durationMs: number
  exitCode: number
  commands: Array<{ id: string; command: string; cwd?: string; output?: string }>
  files: Array<{ path: string; status: 'created' | 'modified' | 'deleted' | 'renamed' | 'untracked'; diff?: string }>
  toolCalls?: Array<{ id: string; name: string; label: string; target?: string; detail?: string }>
  artifacts?: AgentArtifact[]
  logs?: Array<{ id: string; stream: 'stdout' | 'stderr' | 'event'; text: string }>
  diagnostics?: string
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

export interface CodexConfigFile {
  ok: boolean
  exists: boolean
  path: string
  content: string
  message: string
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

export interface SkillSummary {
  id: string
  name: string
  description: string
  rootPath: string
  skillPath: string
  source: string
}

export interface LoadedSkill extends SkillSummary {
  body: string
}

export interface SkillInstallResult {
  ok: boolean
  installed?: SkillSummary | null
  message: string
}

export interface SkillhubSearchItem {
  slug: string
  title: string
  description: string
  version?: string
  source: string
}

export interface SkillhubSearchResult {
  ok: boolean
  items: SkillhubSearchItem[]
  message: string
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

export type TaskStatus = 'pending' | 'running' | 'done'

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

export interface WorkspaceActiveRun {
  agentId: string | null
  sessionId: string
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
  dispatchResult?: OrchestratorDispatchResult
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
  createSession: (data: { title: string; type?: 'direct' | 'group'; workspaceId?: string | null; workspaceAgentId?: string | null }) =>
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
    data: { content: string; modelId?: string; type?: string; skipAgentReply?: boolean; attachments?: ChatAttachment[]; displayContent?: string }
  ) =>
    request<Message>(`/messages/${sessionId}`, {
      method: 'POST',
      body: JSON.stringify({
        content: data.content,
        type: data.type ?? 'text',
        metadata: {
          ...(data.modelId ? { modelId: data.modelId } : {}),
          ...(data.skipAgentReply || mentionsOrchestrator(data.content) ? { skipAgentReply: true } : {}),
          ...(data.attachments?.length ? { attachments: data.attachments } : {}),
          ...(data.displayContent !== undefined ? { displayContent: data.displayContent } : {}),
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
  installAllCliTools: () =>
    request<CliInstallAction>('/coding-tools/cli/install', { method: 'POST' }),
  getOpencodeModels: () =>
    request<OpencodeModelsResponse>('/coding-tools/opencode/models'),
  getCodexConfig: () =>
    request<CodexConfigFile>('/coding-tools/codex/config'),
  saveCodexConfig: (content: string) =>
    request<CodexConfigFile>('/coding-tools/codex/config', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  getCodexAuthFile: () =>
    request<CodexConfigFile>('/coding-tools/codex/auth-file'),
  saveCodexAuthFile: (content: string) =>
    request<CodexConfigFile>('/coding-tools/codex/auth-file', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
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

  // Skills
  listSkills: () => request<{ items: SkillSummary[] }>('/skills'),
  getSkill: (id: string) => request<LoadedSkill>(`/skills/${encodeURIComponent(id)}`),
  installSkill: (data: { sourceUrl: string; id?: string }) =>
    request<SkillInstallResult>('/skills/install', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  searchSkillhub: (q: string) =>
    request<SkillhubSearchResult>(`/skills/skillhub/search?q=${encodeURIComponent(q)}`),
  installSkillhub: (slug: string) =>
    request<SkillInstallResult>('/skills/skillhub/install', {
      method: 'POST',
      body: JSON.stringify({ slug }),
    }),
  // Workspaces (Agent Group)
  listWorkspaces: () => request<{ items: Workspace[] }>('/workspaces'),
  createWorkspace: (data: { name: string; goal?: string; projectPath?: string | null; template?: 'blank' | 'classic' }) =>
    request<WorkspaceFull>('/workspaces', { method: 'POST', body: JSON.stringify(data) }),
  openWorkspaceFolder: () =>
    request<WorkspaceFolderOpenResult>('/workspaces/open-folder', { method: 'POST' }),
  getWorkspace: (id: string) => request<WorkspaceFull>(`/workspaces/${id}`),
  getWorkspaceActiveRuns: (id: string) => request<{ items: WorkspaceActiveRun[] }>(`/workspaces/${id}/active-runs`),
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
}

export function mentionsOrchestrator(content: string) {
  return /(^|\s)@(orchestrator|coordinator|agenthub)\b/i.test(content) || content.includes('@协调器') || content.includes('@调度')
}
