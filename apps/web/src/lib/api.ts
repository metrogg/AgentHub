const API_BASE = '/api'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RETRIES = 2

interface RequestOptions extends RequestInit {
  timeout?: number
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('abort') ||
    msg.includes('timeout')
  )
}

export function friendlyErrorMessage(error: unknown, context?: string): string {
  const prefix = context ? `${context}：` : ''
  if (error instanceof ApiError) return prefix + error.message
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (msg.includes('failed to fetch')) {
      return prefix + '网络连接中断，请确认服务端已启动后重试'
    }
    if (msg.includes('abort')) {
      return prefix + '请求超时，请稍后重试'
    }
    return prefix + error.message
  }
  return prefix + '请求失败'
}

async function requestWithRetry<T>(path: string, init?: RequestOptions, attempt = 0): Promise<T> {
  const timeoutMs = init?.timeout ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Merge caller's signal with our timeout controller
  const callerSignal = init?.signal
  const onCallerAbort = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason)
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    }
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new ApiError(res.status, body?.error ?? body?.message ?? `HTTP ${res.status}`)
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  } catch (error) {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)

    // Server errors (5xx) and network errors are retryable
    const shouldRetry =
      attempt < MAX_RETRIES &&
      (isRetryableError(error) || (error instanceof ApiError && error.status >= 500))

    if (shouldRetry) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      return requestWithRetry<T>(path, init, attempt + 1)
    }

    throw error
  }
}

async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  return requestWithRetry<T>(path, init)
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
  isPinned?: boolean
  replyToMessageId?: string | null
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
  | {
      id: string
      type: 'workflow'
      title: string
      description?: string
      source?: string
      createdAt?: string
      nodes: Array<{
        id: string
        label: string
        type: 'agent' | 'tool' | 'input' | 'output'
        agentKey?: string
        agentName?: string
        agentColor?: string
      }>
      edges: Array<{ from: string; to: string; label?: string }>
    }

export interface CodeAgentRunMetadata {
  type: 'code-agent-run'
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out'
  runtime: 'codex' | 'claude-code' | 'opencode' | 'gemini'
  command: string
  cwd?: string
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
  diagnostics?: string
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
  id: 'codex' | 'claude-code' | 'opencode' | 'gemini'
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

export interface SettingsGeneralInfo {
  debug: {
    enabled: boolean
    dir: string
    logLevel: string
    exists: boolean
    sizeBytes: number
    sizeLabel: string
  }
  storage: {
    appDataDir: string
    configDir: string
    logDir: string
    activeDataDir: string
    dataPath: string
    databasePath: string
    migrationPending: boolean
    exists: boolean
    sizeBytes: number
    sizeLabel: string
    databaseSizeBytes: number
    databaseSizeLabel: string
    scannedFiles: number
    truncated: boolean
    message: string
  }
  git: { runtime: string; path: string; ok: boolean; message: string }
  python: { runtime: string; path: string; ok: boolean; message: string }
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

export interface MobilePairStartResult {
  version: number
  baseUrl: string
  webUrl: string
  pairingCode: string
  expiresAt: string
  ttlSeconds: number
  qrPayload: string
  localAddresses: string[]
}

export interface SettingsGeneralInfo {
  debug: {
    enabled: boolean
    dir: string
    logLevel: string
    exists: boolean
    sizeBytes: number
    sizeLabel: string
  }
  storage: {
    appDataDir: string
    configDir: string
    logDir: string
    activeDataDir: string
    dataPath: string
    databasePath: string
    migrationPending: boolean
    exists: boolean
    sizeBytes: number
    sizeLabel: string
    databaseSizeBytes: number
    databaseSizeLabel: string
    scannedFiles: number
    truncated: boolean
    message: string
  }
  git: { runtime: string; path: string; ok: boolean; message: string }
  python: { runtime: string; path: string; ok: boolean; message: string }
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
  roleType: AgentRoleType
  description: string
  avatar: string | null
  systemPrompt: string
  roleProfile?: Record<string, unknown> | null
  color: string
  modelId: string | null
  runtimeType: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType: 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  capabilityTags: string[]
  toolPermissions: string[]
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
  contextPolicy: 'recent-only' | 'pinned-recent' | 'workspace-aware'
  autoInvoke: boolean
  approvalRequired: boolean
  orderIdx: number
  createdAt: string
}

export type AgentRoleType =
  | 'clarifier'
  | 'architect'
  | 'researcher'
  | 'coder'
  | 'reviewer'
  | 'integrator'
  | 'custom'

export type AgentRelationType =
  | 'handoff_to'
  | 'reviewed_by'
  | 'fallback_to'
  | 'reports_to'
  | 'blocks'

export interface WorkspaceAgentRelation {
  id: string
  workspaceId: string
  sourceAgentId: string
  targetAgentId: string
  relationType: AgentRelationType
  note: string | null
  createdAt: string
  updatedAt: string
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
  roleType?: AgentRoleType
  description?: string
  avatar?: string | null
  systemPrompt?: string
  roleProfile?: Record<string, unknown> | null
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
  agentRelations?: WorkspaceAgentRelation[]
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
  roleType?: AgentRoleType
  color: string
  systemPrompt: string
}

export interface OrchestratorPlanTask {
  id: string
  phaseId?: string
  title: string
  description: string
  agentKey: string
  taskType?: 'read' | 'research' | 'design' | 'code' | 'test' | 'review' | 'synthesize'
  status?: TaskStatus
  outputContract?: OrchestratorTaskOutputContract
  validation?: OrchestratorTaskValidation
  agentSelection?: {
    selectedAgentKey: string
    score: number
    rationale: string[]
    reviewerAgentKey?: string
    fallbackAgentKey?: string
  }
}

export interface OrchestratorTaskOutputContract {
  requiredBlackboardWrites: Array<{
    key: string
    schemaType: BlackboardSchemaType
  }>
  requiredArtifacts?: string[]
  allowedPaths?: string[]
  acceptanceCriteria?: string[]
}

export interface OrchestratorTaskValidation {
  commands?: string[]
  requiresReview?: boolean
}

export interface OrchestratorPlanPhase {
  id: string
  title: string
  purpose: string
  taskIds: string[]
}

export interface ClarificationQuestion {
  id: string
  question: string
  options?: string[]
  answer?: string
}

export interface OrchestratorPlan {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: OrchestratorPlanAgent[]
  phases?: OrchestratorPlanPhase[]
  tasks: OrchestratorPlanTask[]
  clarificationQuestions?: ClarificationQuestion[]
  messageId?: string
  dispatchResult?: OrchestratorDispatchResult
}

export interface OrchestratorTaskLedger {
  runId: string
  title: string
  goal: string
  phases: OrchestratorPlanPhase[]
  tasks: Array<{
    id: string
    phaseId: string
    title: string
    description: string
    agentId: string
    dependencies: string[]
    taskType: NonNullable<OrchestratorPlanTask['taskType']>
    status: TaskStatus | 'cancelled'
    outputContract?: OrchestratorTaskOutputContract
    validation?: OrchestratorTaskValidation
  }>
}

export interface OrchestratorProgressLedger {
  runId: string
  status: OrchestratorRunStatus
  currentPhaseId?: string
  pendingTaskIds: string[]
  runningTaskIds: string[]
  completedTaskIds: string[]
  failedTaskIds: string[]
  cancelledTaskIds: string[]
  blockedTaskIds: string[]
  blackboardKeys: string[]
  artifactIds: string[]
  replanHistory: Array<{ strategy?: string; reason?: string; changedTaskIds: string[]; at: string }>
  updatedAt: string
}

export type OrchestratorRunStatus = 'planning' | 'running' | 'synthesizing' | 'completed' | 'failed' | 'cancelled'

export interface OrchestratorRunListItem {
  id: string
  workspaceId: string
  groupSessionId: string
  planMessageId: string | null
  status: OrchestratorRunStatus
  plan: unknown | null
  summaryMessageId: string | null
  conflictReport: unknown[] | null
  createdAt: string
  updatedAt: string
  workspaceName: string
  sessionTitle: string
}

export interface ExecutionLog {
  id: string
  runId: string
  sessionId: string
  agentId: string
  taskId: string | null
  type: 'llm_call' | 'tool_call' | 'blackboard_read' | 'blackboard_write' | 'error' | 'task_start' | 'task_end'
  input: unknown | null
  output: unknown | null
  durationMs: number | null
  tokenUsage: unknown | null
  createdAt: string
}

export type OrchestratorRunEventSeverity = 'debug' | 'info' | 'warning' | 'error'

export type OrchestratorRunEventType =
  | 'run.started'
  | 'plan.created'
  | 'plan.validated'
  | 'approval.requested'
  | 'approval.granted'
  | 'phase.started'
  | 'task.queued'
  | 'task.started'
  | 'task.stream'
  | 'blackboard.written'
  | 'artifact.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.retrying'
  | 'task.reassigned'
  | 'run.replanned'
  | 'conflict.detected'
  | 'conflict.resolved'
  | 'run.synthesizing'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.failed'

export interface OrchestratorRunEvent {
  id: string
  runId: string
  workspaceId: string
  groupSessionId: string
  taskId: string | null
  agentId: string | null
  type: OrchestratorRunEventType
  payload: Record<string, unknown>
  severity: OrchestratorRunEventSeverity
  createdAt: string
}

export type BlackboardSchemaType =
  | 'fact'
  | 'decision'
  | 'risk'
  | 'artifact_ref'
  | 'diff_summary'
  | 'test_result'
  | 'task_output'

export interface TypedBlackboardValue {
  schemaType: BlackboardSchemaType
  summary: string
  confidence?: number
  sourceAgentId?: string
  taskId?: string
  [key: string]: unknown
}

export interface TypedBlackboardEntry {
  id: string
  namespace: string
  key: string
  value: TypedBlackboardValue
  schemaVersion: number
  agentId: string | null
  taskId: string | null
  version: number
  tags: string[]
  createdAt: string
}

export interface ConflictReportItem {
  filePath: string
  baseContent: string
  variants: Array<{
    agentId: string
    agentName: string
    diff: string
    fullContent?: string
  }>
  resolution: 'auto-merged' | 'llm-resolved' | 'needs-human' | 'human-approved' | 'human-rejected' | 'human-overridden'
  mergedContent?: string
  notes?: string
}

export interface OrchestratorDispatchResult {
  runId: string
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
  deleteAllSessions: () => request<{ deleted: boolean }>('/sessions/all', { method: 'DELETE' }),

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
    data: { content: string; modelId?: string; type?: string; skipAgentReply?: boolean; attachments?: ChatAttachment[]; displayContent?: string; replyToMessageId?: string | null }
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
          ...(data.replyToMessageId ? { replyToMessageId: data.replyToMessageId } : {}),
        },
      }),
    }),
  cancelMessage: (sessionId: string) =>
    request<{ cancelled: boolean }>(`/messages/${sessionId}/cancel`, {
      method: 'POST',
    }),
  updateMessage: (sessionId: string, messageId: string, data: { content: string }) =>
    request<Message>(`/messages/${sessionId}/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  withdrawMessage: (sessionId: string, messageId: string, data: { rollback?: boolean } = {}) =>
    request<{ removedMessageIds: string[]; rollback: { reverted: number; failed: number } }>(
      `/messages/${sessionId}/${messageId}${data.rollback === false ? '?rollback=false' : ''}`,
      { method: 'DELETE' }
    ),
  regenerateMessage: (sessionId: string, messageId: string) =>
    request<{ removedMessageId: string }>(`/messages/${sessionId}/${messageId}/regenerate`, {
      method: 'POST',
    }),
  pinMessage: (sessionId: string, messageId: string) =>
    request<Message>(`/messages/${sessionId}/${messageId}/pin`, { method: 'PATCH' }),
  unpinMessage: (sessionId: string, messageId: string) =>
    request<Message>(`/messages/${sessionId}/${messageId}/unpin`, { method: 'PATCH' }),
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
  getRuntimeInfo: () =>
    request<{
      git: { runtime: string; path: string; ok: boolean; message: string }
      python: { runtime: string; path: string; ok: boolean; message: string }
    }>('/settings/runtime-info'),
  getSettingsGeneralInfo: () => request<SettingsGeneralInfo>('/settings/general-info'),
  startMobilePairing: () => request<MobilePairStartResult>('/mobile/pair/start', { method: 'POST' }),
  ensureStorageDirectory: (path: string) =>
    request<{ ok: boolean; path: string; sizeBytes: number; sizeLabel: string; message: string }>('/settings/storage/ensure', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  openLocalPath: (path: string) =>
    request<{ ok: boolean; message: string }>('/settings/storage/open-path', {
      method: 'POST',
      body: JSON.stringify({ path }),
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
  // Workspaces (group chats)
  listWorkspaces: () => request<{ items: Workspace[] }>('/workspaces'),
  createWorkspace: (data: { name: string; goal?: string; projectPath?: string | null; template?: 'blank' | 'classic' }) =>
    request<WorkspaceFull>('/workspaces', { method: 'POST', body: JSON.stringify(data) }),
  openWorkspaceFolder: (projectPath?: string | null) =>
    request<WorkspaceFolderOpenResult>('/workspaces/open-folder', {
      method: 'POST',
      timeout: 120_000,
      body: projectPath ? JSON.stringify({ projectPath }) : undefined,
    }),
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
  getWorkspaceAgentRelations: (id: string) =>
    request<{ items: WorkspaceAgentRelation[] }>(`/workspaces/${id}/agent-relations`),
  replaceWorkspaceAgentRelations: (
    id: string,
    relations: Array<Pick<WorkspaceAgentRelation, 'sourceAgentId' | 'targetAgentId' | 'relationType'> & { note?: string | null }>
  ) =>
    request<{ items: WorkspaceAgentRelation[] }>(`/workspaces/${id}/agent-relations`, {
      method: 'PUT',
      body: JSON.stringify({ relations }),
    }),

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

  // Artifacts
  deployStatic: (workspaceId: string) =>
    request<{ deployId: string; url: string; status: 'ready' }>('/artifacts/deploy-static', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }),
  applyDiff: (projectPath: string, diff: string) =>
    request<{ success: boolean; message: string }>('/artifacts/apply-diff', {
      method: 'POST',
      body: JSON.stringify({ projectPath, diff }),
    }),
  downloadZip: async (workspaceId: string) => {
    const res = await fetch(`${API_BASE}/artifacts/zip-download?workspaceId=${encodeURIComponent(workspaceId)}`, {
      credentials: 'include',
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }))
      throw new ApiError(res.status, body?.error ?? body?.message ?? `HTTP ${res.status}`)
    }
    return res.blob()
  },

  // Orchestrator runs
  listOrchestratorRuns: () => request<{ items: OrchestratorRunListItem[] }>('/orchestrator-runs'),
  getOrchestratorRun: (id: string) => request<OrchestratorRunListItem>(`/orchestrator-runs/${id}`),
  cancelOrchestratorRun: (id: string) =>
    request<{ run: { id: string; status: OrchestratorRunStatus }; activeRunCancelled: boolean }>(
      `/orchestrator-runs/${id}/cancel`,
      { method: 'POST' },
    ),
  retryOrchestratorTask: (runId: string, taskId: string) =>
    request<{ ok: boolean; result: unknown }>(`/orchestrator-runs/${runId}/retry-task/${taskId}`, { method: 'POST' }),
  getOrchestratorRunEvents: (id: string) => request<{ items: OrchestratorRunEvent[] }>(`/orchestrator-runs/${id}/events`),
  getOrchestratorRunBlackboard: (id: string, schemaType?: BlackboardSchemaType) =>
    request<{ items: TypedBlackboardEntry[] }>(
      `/orchestrator-runs/${id}/blackboard${schemaType ? `?schemaType=${encodeURIComponent(schemaType)}` : ''}`,
    ),
  getOrchestratorRunLogs: (id: string) => request<{ items: ExecutionLog[] }>(`/orchestrator-runs/${id}/logs`),
  getOrchestratorRunConflicts: (id: string) => request<{ items: ConflictReportItem[] }>(`/orchestrator-runs/${id}/conflicts`),
  resolveOrchestratorConflict: (
    id: string,
    body: { filePath: string; resolution: 'approved' | 'rejected' | 'overridden'; mergedContent?: string; notes?: string },
  ) =>
    request<{ ok: boolean; item: ConflictReportItem }>(`/orchestrator-runs/${id}/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
}

export function mentionsOrchestrator(content: string) {
  return /(^|\s)@(orchestrator|coordinator|agenthub)\b/i.test(content) || content.includes('@协调器') || content.includes('@调度')
}
