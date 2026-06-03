import {
  SessionType,
  SenderType,
  MessageType,
  TaskStatus,
  AgentRoleType,
  AgentRelationType,
  OrchestratorRunStatus,
  ExecutionLogType,
  BlackboardSchemaType,
  SandboxPolicy,
  RuntimeType,
  ContextPolicy,
  CodeAgentType,
  ArtifactFileStatus,
  AppErrorCodes,
  API_BASE_PATH,
  TaskType,
  OrchestratorRunEventType,
  OrchestratorRunEventSeverity,
} from '@agenthub/shared'

const API_BASE = API_BASE_PATH
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RETRIES = 2

interface RequestOptions extends RequestInit {
  timeout?: number
}

export class ApiError extends Error {
  public code?: string
  public requestId?: string

  constructor(
    public status: number,
    message: string,
    code?: string,
    requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.requestId = requestId
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
  if (error instanceof ApiError) {
    // 根据错误码提供比 HTTP 状态码更精准的中文提示
    const codeMap: Record<string, string> = {
      [AppErrorCodes.INTERNAL_ERROR]: '服务端内部错误，请稍后重试',
      [AppErrorCodes.SERVICE_UNAVAILABLE]: '服务暂时不可用，请稍后重试',
      [AppErrorCodes.TIMEOUT]: '请求超时，请稍后重试',
      [AppErrorCodes.VALIDATION_FAILED]: '请求参数错误',
      [AppErrorCodes.MISSING_FIELD]: '缺少必要参数',
      [AppErrorCodes.UNAUTHORIZED]: '未登录或登录已过期',
      [AppErrorCodes.FORBIDDEN]: '没有权限执行此操作',
      [AppErrorCodes.SESSION_NOT_FOUND]: '会话不存在或已被删除',
      [AppErrorCodes.MESSAGE_NOT_FOUND]: '消息不存在或已被删除',
      [AppErrorCodes.WORKSPACE_NOT_FOUND]: '工作区不存在或已被删除',
      [AppErrorCodes.TASK_NOT_FOUND]: '任务不存在或已被删除',
      [AppErrorCodes.AGENT_NOT_FOUND]: 'Agent 不存在或已被删除',
      [AppErrorCodes.FILE_NOT_FOUND]: '文件不存在',
      [AppErrorCodes.ARTIFACT_NOT_FOUND]: '产物不存在',
      [AppErrorCodes.LLM_REQUEST_FAILED]: 'AI 服务请求失败，请检查模型配置',
      [AppErrorCodes.LLM_RATE_LIMITED]: 'AI 服务请求过于频繁，请稍后重试',
      [AppErrorCodes.MODEL_NOT_CONFIGURED]: '模型未配置，请先完成设置',
      [AppErrorCodes.CODE_AGENT_NOT_INSTALLED]: '代码 Agent 未安装，请先安装 CLI 工具',
      [AppErrorCodes.CODE_AGENT_CONFIG_INVALID]: '代码 Agent 配置错误',
      [AppErrorCodes.ORCHESTRATOR_PLAN_FAILED]: '编排计划生成失败，请稍后重试',
      [AppErrorCodes.ORCHESTRATOR_DISPATCH_FAILED]: '任务派发失败，请稍后重试',
      [AppErrorCodes.DIFF_APPLY_FAILED]: '代码补丁应用失败',
      [AppErrorCodes.DIFF_VALIDATION_FAILED]: '代码补丁校验失败',
    }
    if (error.code && codeMap[error.code]) {
      if (
        error.code === AppErrorCodes.DIFF_APPLY_FAILED ||
        error.code === AppErrorCodes.DIFF_VALIDATION_FAILED
      ) {
        return prefix + normalizeErrorMessage(error.message, codeMap[error.code])
      }
      return prefix + codeMap[error.code]
    }
    if (error.status === 500 && error.message === 'Internal Server Error') {
      return prefix + '服务端暂不可用，请确认后端服务已启动后重试'
    }
    return prefix + normalizeErrorMessage(error.message, `HTTP ${error.status}`)
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (msg.includes('failed to fetch')) {
      return prefix + '网络连接中断，请确认服务端已启动后重试'
    }
    if (msg.includes('abort')) {
      return prefix + '请求超时，请稍后重试'
    }
    return prefix + normalizeErrorMessage(error.message)
  }
  return prefix + normalizeUnknownError(error)
}

async function requestWithRetry<T>(path: string, init?: RequestOptions, attempt = 0): Promise<T> {
  const timeoutMs = init?.timeout ?? DEFAULT_TIMEOUT_MS
  const method = (init?.method ?? 'GET').toUpperCase()
  const canRetry = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
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
      const errorPayload = body?.error ?? {}
      const message = extractApiErrorMessage(body, res.status)
      const code = typeof errorPayload === 'object' ? errorPayload.code : undefined
      const requestId = typeof errorPayload === 'object' ? errorPayload.requestId : undefined
      throw new ApiError(res.status, message, code, requestId)
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  } catch (error) {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)

    // Don't retry if the caller explicitly aborted (e.g. component unmount or user cancel)
    if (callerSignal?.aborted) {
      throw error
    }

    // Server errors (5xx) and network errors are retryable
    const shouldRetry =
      attempt < MAX_RETRIES &&
      canRetry &&
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

function extractApiErrorMessage(body: any, status: number): string {
  const candidates = [
    body?.error?.message,
    body?.error,
    body?.message,
    body?.details,
    body,
  ]
  for (const candidate of candidates) {
    const normalized = normalizeUnknownError(candidate)
    if (normalized && normalized !== '请求失败' && normalized !== '[object Object]') return normalized
  }
  return `HTTP ${status}`
}

function normalizeErrorMessage(message: string, fallback = '请求失败'): string {
  const trimmed = message.trim()
  if (!trimmed || trimmed === '[object Object]') return fallback
  return trimmed
}

function normalizeUnknownError(error: unknown): string {
  if (typeof error === 'string') return normalizeErrorMessage(error)
  if (error instanceof Error) return normalizeErrorMessage(error.message)
  if (!error || typeof error !== 'object') return '请求失败'

  const record = error as Record<string, unknown>
  const nestedCandidates = [record.message, record.error, record.details, record.reason]
  for (const candidate of nestedCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (candidate && typeof candidate === 'object') {
      const nested = normalizeUnknownError(candidate)
      if (nested && nested !== '请求失败') return nested
    }
  }

  try {
    const serialized = JSON.stringify(error)
    return serialized && serialized !== '{}' ? serialized : '请求失败'
  } catch {
    return '请求失败'
  }
}

export interface Session {
  id: string
  ownerId: string
  title: string
  type: SessionType
  workspaceId?: string | null
  workspaceAgentId?: string | null
  metadata?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  lastMessage?: { content: string; senderType: string } | null
}

export interface StarOfficeStatus {
  url: string
  root: string
  rootExists: boolean
  running: boolean
  starting: boolean
  started: boolean
  pid?: number
  error?: string
}

export interface Message {
  id: string
  sessionId: string
  senderId: string
  senderType: SenderType
  type: MessageType
  content: string
  metadata: Record<string, unknown> | null
  isPinned?: boolean
  replyToMessageId?: string | null
  createdAt: string
}

export interface QuotedMessagePreview {
  messageId: string
  senderName: string
  senderType?: string
  kind?: 'reply' | 'quote'
  content: string
}

export interface ChatAttachment {
  id: string
  type: 'image' | 'file'
  name: string
  mimeType: string
  size: number
  dataUrl: string
  extension?: string
  previewKind?: 'image' | 'text' | 'document' | 'binary'
  text?: string
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
      status?: ArtifactFileStatus
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

export interface CcswitchModel {
  name: string
  modelId: string
  apiEndpoint: string
  anthropicEndpoint?: string
  apiKey: string
}

export interface WelcomeQuickPrompt {
  id: string
  label: string
  prompt: string
}

export interface WelcomeQuickPromptsResponse {
  generatedAt: string
  items: WelcomeQuickPrompt[]
  seed: string
  source: 'llm' | 'unavailable'
  error?: string
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
  id: CodeAgentType
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

export type LocalAgentRuntimeFamily = 'coordinator' | 'worker'
export type LocalAgentRuntimeAdapterStatus = 'candidate' | 'available' | 'blocked'

export interface LocalAgentRuntimeCatalogItem {
  adapterMessage: string
  adapterStatus: LocalAgentRuntimeAdapterStatus
  addedAt: string | null
  command: string
  configMessage: string
  diagnostics?: string
  docsHint: string
  docsUrl: string
  enabled: boolean
  id: string
  installCommand: string
  installed: boolean
  missingAdapterSteps: string[]
  name: string
  packageName: string
  permissions: string[]
  ready: boolean
  recommendedUse: string
  registered: boolean
  runtimeBase: 'openclaw' | 'copaw'
  runtimeFamily: LocalAgentRuntimeFamily
  version: string | null
}

export interface LocalAgentRuntimeBinding {
  adapterStatus: LocalAgentRuntimeAdapterStatus
  addedAt: string
  command: string
  enabled: boolean
  id: string
  packageName: string
  runtimeBase: 'openclaw' | 'copaw'
  runtimeFamily: LocalAgentRuntimeFamily
  version: string | null
}

export interface LocalAgentRuntimeCatalogResponse {
  platform: string
  localCliProbesEnabled: boolean
  items: LocalAgentRuntimeCatalogItem[]
}

export interface LocalAgentRuntimeAddResponse {
  ok: boolean
  binding: LocalAgentRuntimeBinding
  catalog: LocalAgentRuntimeCatalogResponse
  message: string
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

export interface CodingToolsStartupLifecycleResult {
  items: CodingToolStatus[]
  message: string
  ok: boolean
  repairedAgents: number
  settingsChanged: boolean
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
    workspaceStorageRoot: string
    workspaceStorageExists: boolean
    workspaceStorageSizeBytes: number
    workspaceStorageSizeLabel: string
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
  sandbox: {
    defaultProvider: string
    configuredProvider: string
    providerConfigured: boolean
    sbxInstalled: boolean
    daemonReady: boolean
    dockerLoggedIn: boolean
    policyConfigured: boolean
    sandboxRunnable: boolean
    supportsPerAgentIsolation: boolean
    cleanupMode: string
    sandboxRoot: string
    dockerSandbox: {
      agent: string
      available: boolean
      probe: {
        version?: string
        exitCode: number
        installed?: boolean
        daemonReady?: boolean
        message?: string
      }
      policy?: {
        configured: boolean
        authenticated: boolean
        message: string
        recommendedCommand?: string
      } | null
    }
  }
}

export interface SettingsConsoleLog {
  id: string
  time: string
  createdAt: string
  level: 'Trace' | 'Debug' | 'Info' | 'Warn' | 'Error'
  source: '后端' | '前端' | 'Agent' | '桌面端'
  module: string
  content: string
}

export interface SettingsConsoleLogsResponse {
  items: SettingsConsoleLog[]
  sources: {
    serverLogPath: string
    serverLogExists: boolean
    serverLogEnabled: boolean
    executionTraceCount: number
    runEventCount: number
  }
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
  baseUrls?: string[]
  webUrl: string
  webUrls?: string[]
  pairingCode: string
  expiresAt: string
  ttlSeconds: number
  qrPayload: string
  localAddresses: string[]
}

export interface MobileConnectivityStatus {
  port: number
  localAddresses: string[]
  baseUrls: string[]
  networkProfiles: Array<{
    name: string
    interfaceAlias: string
    networkCategory: string
    ipv4Connectivity: string
  }>
  firewall: {
    ruleName: string
    allowed: boolean
    supported: boolean
    message: string
    rules: Array<{
      displayName: string
      enabled: boolean
      direction: string
      action: string
      profile: string
    }>
  }
  activePairings: Array<{
    baseUrl: string
    baseUrls: string[]
    expiresAt: string
  }>
  recentEvents: Array<{
    type: string
    message: string
    at: string
  }>
  message: string
}

export interface MobileFirewallAction {
  ok: boolean
  message: string
  diagnostics: MobileConnectivityStatus
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
    workspaceStorageRoot: string
    workspaceStorageExists: boolean
    workspaceStorageSizeBytes: number
    workspaceStorageSizeLabel: string
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
  sandbox: {
    defaultProvider: string
    configuredProvider: string
    providerConfigured: boolean
    sbxInstalled: boolean
    daemonReady: boolean
    dockerLoggedIn: boolean
    policyConfigured: boolean
    sandboxRunnable: boolean
    supportsPerAgentIsolation: boolean
    cleanupMode: string
    sandboxRoot: string
    dockerSandbox: {
      agent: string
      available: boolean
      probe: {
        version?: string
        exitCode: number
        installed?: boolean
        daemonReady?: boolean
        message?: string
      }
      policy?: {
        configured: boolean
        authenticated: boolean
        message: string
        recommendedCommand?: string
      } | null
    }
  }
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
  runtimeType: RuntimeType
  codeAgentType: CodeAgentType | null
  capabilityTags: string[]
  skillIds: string[]
  toolPermissions: string[]
  sandboxPolicy: SandboxPolicy
  contextPolicy: ContextPolicy
  autoInvoke: boolean
  approvalRequired: boolean
  orderIdx: number
  createdAt: string
}

// AgentRoleType and AgentRelationType imported from @agenthub/shared

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
  remoteSource?: string
  category?: string
  tags?: string[]
  ownerName?: string
  downloads?: number
  installs?: number
  stars?: number
  updatedAt?: number
}

export interface SkillhubSearchResult {
  ok: boolean
  items: SkillhubSearchItem[]
  message: string
  indexedCount?: number
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
  skillIds?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: WorkspaceAgent['sandboxPolicy']
  contextPolicy?: WorkspaceAgent['contextPolicy']
  autoInvoke?: boolean
  approvalRequired?: boolean
}

export interface AgentConfigEditResult {
  summary: string
  patch: Partial<AgentConfigInput>
}

export type AgentConfigEditStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'result'; result: AgentConfigEditResult }

export type AgentDraft = Required<
  Omit<AgentConfigInput, 'avatar' | 'modelId' | 'codeAgentType'>
> & {
  avatar?: string | null
  modelId?: string | null
  codeAgentType?: WorkspaceAgent['codeAgentType']
}

export interface AgentDraftConfirmResult {
  agent: WorkspaceAgent
  message: Message
}

export interface MemberProposal {
  expertProfileId: string
  name: string
  role: string
  category: string
  runtimeType: WorkspaceAgent['runtimeType']
  codeAgentType?: WorkspaceAgent['codeAgentType']
  color?: string
  capabilityTags?: string[]
  reason?: string
  expectedContribution?: string
}

export interface MemberProposalConfirmResult {
  agents: WorkspaceAgent[]
  message: Message
  session: Session
}

export interface MemberProposalContinueResult {
  message: Message
  started: boolean
}

// TaskStatus imported from @agenthub/shared

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

export interface ClarificationQuestion {
  id: string
  question: string
  options?: string[]
  answer?: string
}

export interface OrchestratorTaskLedger {
  runId: string
  title: string
  goal: string
  phases: Array<{ id: string; title: string; purpose: string; taskIds: string[] }>
  tasks: Array<{
    id: string
    phaseId: string
    title: string
    description: string
    agentId: string
    dependencies: string[]
    taskType: TaskType
    status: TaskStatus | 'cancelled'
    outputContract?: {
      requiredBlackboardWrites: Array<{ key: string; schemaType: BlackboardSchemaType }>
      requiredArtifacts?: string[]
      allowedPaths?: string[]
      acceptanceCriteria?: string[]
    }
    validation?: { commands?: string[]; requiresReview?: boolean }
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

// OrchestratorRunStatus imported from @agenthub/shared

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
  tasks?: OrchestratorRunTaskSnapshot[]
  resourceSnapshot?: OrchestratorRunResourceSnapshot
  agUiEvents?: AgUiRunEvent[]
  runtimeActivitySnapshot?: OrchestratorRunRuntimeActivitySnapshot
  taskBoardSnapshot?: OrchestratorRunTaskBoardSnapshot
}

export interface OrchestratorRunRuntimeActivitySnapshot {
  agentTyping: boolean
  agentActivity: {
    sessionId: string
    agentId: string | null
    agentName: string | null
    phase: string | null
    startedAt: string | null
  } | null
  source: 'task-board' | 'ag-ui' | 'none'
}

export interface OrchestratorRunTaskBoardSnapshot {
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
    agentId: string
    agentName: string
    taskType?: string
    status: 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled'
    progress?: number
    progressStatus?: string
    dependencies: string[]
    childSessionId?: string | null
    taskThreadId?: string | null
    taskThreadStatus?: 'prepared' | 'assigned' | 'active' | 'completed' | 'failed' | 'cancelled' | null
    workerInstanceId?: string | null
    runtimeLeaseId?: string | null
    sharedTaskRelativeRoot?: string | null
    sharedTaskSpecPath?: string | null
    artifactCount?: number
    artifacts?: Array<Record<string, unknown>>
    outputSummary?: string
    validationStatus?: 'passed' | 'failed' | 'skipped' | 'not_run'
    contractStatus?: 'passed' | 'failed'
    executionConfig?: Record<string, unknown>
  }>
  status: 'planning' | 'running' | 'synthesizing' | 'completed' | 'failed' | 'cancelled'
  sessionId: string
}

export interface OrchestratorRunTaskSnapshot {
  id: string
  workspaceId: string
  agentId: string | null
  title: string
  description: string
  status: TaskStatus
  sessionId: string | null
  childSessionId: string | null
  taskThreadId?: string | null
  taskThreadSessionId?: string | null
  taskThreadStatus?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  runtimeLease?: OrchestratorRunRuntimeLeaseSnapshot | null
  orderIdx: number
  runId: string | null
  phaseId: string | null
  dependencies: string[]
  artifacts: OrchestratorRunArtifactSnapshot[]
  progressPercent: number | null
  progressStatus: string | null
  startedAt: string | null
  completedAt: string | null
  errorLog: string | null
}

export interface OrchestratorRunRuntimeLeaseSnapshot {
  id: string
  runtimeLeaseId: string
  workerInstanceId: string | null
  provider: 'local-workdir' | 'docker-sandbox' | 'remote-container'
  status: 'creating' | 'ready' | 'running' | 'cleaning' | 'released' | 'failed' | 'stale'
  cwd: string | null
  homeDir: string | null
  configDir: string | null
  cacheDir: string | null
  tmpDir: string | null
  dataDir: string | null
  containerId: string | null
  sandboxId: string | null
  pid: number | null
  startedAt: string | null
  releasedAt: string | null
  error: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface OrchestratorRunArtifactSnapshot {
  artifactId: string
  id: string
  kind: 'file' | 'directory' | 'preview' | 'report' | 'log' | 'diff' | 'url'
  artifactKind: 'file' | 'directory' | 'preview' | 'report' | 'log' | 'diff' | 'url'
  title: string
  description?: string
  filePath?: string
  path?: string
  sourcePath?: string
  handoffPath?: string
  handoffRelativePath?: string
  mimeType?: string
  size?: number
  checksum?: string
  status: 'discovered' | 'registered' | 'verified' | 'partial' | 'failed'
  visibility: 'private' | 'team' | 'user'
  source: 'artifact-store'
  taskId: string | null
  taskThreadId: string | null
  workspaceAgentId: string | null
  workerInstanceId?: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface OrchestratorRunResourceSnapshot {
  run: {
    id: string
    workspaceId: string
    groupSessionId: string
    status: OrchestratorRunStatus
    planMessageId: string | null
    summaryMessageId: string | null
    createdAt: string
    updatedAt: string
  } | null
  counts: {
    tasksByStatus: Record<string, number>
    taskThreadsByStatus: Record<string, number>
    artifactsByStatus: Record<string, number>
    runtimeLeasesByStatus: Record<string, number>
    workerInstancesByState: Record<string, number>
    totalTasks: number
    totalTaskThreads: number
    totalArtifacts: number
    totalRuntimeLeases: number
    totalWorkerInstances: number
  }
  tasks: Array<{
    id: string
    workspaceId: string
    agentId: string | null
    title: string
    description: string
    status: TaskStatus
    sessionId: string | null
    orderIdx: number
    runId: string | null
    phaseId: string | null
    dependencies: string[]
    progressPercent: number | null
    progressStatus: string | null
    startedAt: string | null
    completedAt: string | null
    errorLog: string | null
  }>
  taskThreads: Array<{
    id: string
    workspaceId: string
    runId: string
    taskId: string
    groupSessionId: string
    workspaceAgentId: string | null
    workerInstanceId: string | null
    sessionId: string
    status: 'prepared' | 'assigned' | 'active' | 'completed' | 'failed' | 'cancelled'
    lastEventId: string | null
    sharedTaskRelativeRoot?: string | null
    sharedTaskSpecPath?: string | null
    createdAt: string
    updatedAt: string
  }>
  artifacts: OrchestratorRunArtifactSnapshot[]
  runtimeLeases: OrchestratorRunRuntimeLeaseSnapshot[]
  workerInstances: Array<{
    id: string
    workspaceId: string
    workspaceAgentId: string
    runtimeFamily: 'coordinator' | 'worker' | 'fallback'
    runtimeBase: 'openclaw' | 'copaw' | 'codex' | 'claude-code' | 'opencode' | 'gemini' | 'llm-fallback'
    modelId: string | null
    skillIds: string[]
    mcpServerIds: string[]
    sandboxPolicy: 'workspace-write' | 'danger-full-access'
    desiredState: 'running' | 'sleeping' | 'stopped'
    observedState: 'provisioning' | 'ready' | 'busy' | 'idle' | 'sleeping' | 'stopped' | 'failed'
    health: Record<string, unknown>
    runtimeHome: string | null
    runtimeConfigPath: string | null
    lastHeartbeatAt: string | null
    message: string | null
    createdAt: string
    updatedAt: string
  }>
}

export interface ExecutionLog {
  id: string
  runId: string
  sessionId: string
  agentId: string
  taskId: string | null
  type: ExecutionLogType
  input: unknown | null
  output: unknown | null
  durationMs: number | null
  tokenUsage: unknown | null
  createdAt: string
}

// OrchestratorRunEventSeverity imported from @agenthub/shared

// OrchestratorRunEventType imported from @agenthub/shared

export interface OrchestratorRunEvent {
  id: string
  runId: string
  workspaceId: string
  groupSessionId: string
  taskId: string | null
  threadId?: string | null
  workerInstanceId?: string | null
  agentId: string | null
  type: OrchestratorRunEventType
  payload: Record<string, unknown>
  severity: OrchestratorRunEventSeverity
  createdAt: string
}

export interface AgUiRunEvent {
  type: string
  name?: string
  value?: Record<string, unknown>
  runId?: string
  threadId?: string
  parentRunId?: string
  stepName?: string
  message?: string
  code?: string
  result?: Record<string, unknown>
  outcome?: Record<string, unknown>
  timestamp?: number
}

// BlackboardSchemaType imported from @agenthub/shared

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
  resolution:
    | 'auto-merged'
    | 'llm-resolved'
    | 'needs-human'
    | 'human-approved'
    | 'human-rejected'
    | 'human-overridden'
  mergedContent?: string
  notes?: string
}

export {
  SessionType,
  SenderType,
  MessageType,
  TaskStatus,
  OrchestratorRunStatus,
  ExecutionLogType,
  BlackboardSchemaType,
  SandboxPolicy,
  RuntimeType,
  ContextPolicy,
  CodeAgentType,
  CodeAgentRunStatus,
  ArtifactFileStatus,
  AppErrorCodes,
} from '@agenthub/shared'

export type { AgentRoleType, AgentRelationType } from '@agenthub/shared'

export const api = {
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

  // Settings (map-based)
  getSettings: () => request<Record<string, string>>('/settings'),
  saveSettings: (data: Record<string, string>) =>
    request<{ success: boolean }>('/settings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  resetAllApplicationData: (confirm = 'RESET_AGENTHUB_DATA') =>
    request<{ success: boolean; message: string; preserved: string[] }>(
      '/settings/reset-all-data',
      {
        method: 'POST',
        body: JSON.stringify({ confirm }),
      },
    ),
  cleanupLegacyData: () =>
    request<{
      success: boolean
      message: string
      deletedSessions: number
      deletedMessages: number
      deletedSessionMembers: number
      deletedWorkspaceTasks: number
      deletedLegacyTasks: number
      deletedLegacyAgents: number
      deletedEmptyWorkspaces: number
      cleanedSettings: number
    }>('/settings/cleanup-legacy-data', {
      method: 'POST',
    }),
  getRuntimeInfo: () =>
    request<{
      git: { runtime: string; path: string; ok: boolean; message: string }
      python: { runtime: string; path: string; ok: boolean; message: string }
    }>('/settings/runtime-info'),
  getSettingsGeneralInfo: () => request<SettingsGeneralInfo>('/settings/general-info'),
  getSettingsConsoleLogs: (limit = 160) =>
    request<SettingsConsoleLogsResponse>(`/settings/console-logs?limit=${encodeURIComponent(String(limit))}`),
  setupDockerSandbox: () =>
    request<{ ok: boolean; message: string; steps: Array<{ command: string; ok: boolean; output: string }>; sandbox: SettingsGeneralInfo['sandbox'] }>(
      '/settings/sandbox/docker/setup',
      {
        method: 'POST',
      },
    ),
  loginDockerSandbox: () =>
    request<{ ok: boolean; started: boolean; message: string; sandbox: SettingsGeneralInfo['sandbox'] }>(
      '/settings/sandbox/docker/login',
      {
        method: 'POST',
      },
    ),
  startMobilePairing: () =>
    request<MobilePairStartResult>('/mobile/pair/start', { method: 'POST' }),
  getMobileConnectivity: () => request<MobileConnectivityStatus>('/mobile/connectivity'),
  openMobileFirewall: () =>
    request<MobileFirewallAction>('/mobile/firewall/open', { method: 'POST', timeout: 12_000 }),
  getStarOfficeStatus: () => request<StarOfficeStatus>('/office/status'),
  startStarOffice: () =>
    request<StarOfficeStatus>('/office/start', { method: 'POST', timeout: 15_000 }),
  joinOfficeAgents: (sessionId: string) =>
    request<{ ok: boolean; joined: string[]; total: number }>('/office/join-agents', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  ensureStorageDirectory: (path: string) =>
    request<{ ok: boolean; path: string; sizeBytes: number; sizeLabel: string; message: string }>(
      '/settings/storage/ensure',
      {
        method: 'POST',
        body: JSON.stringify({ path }),
      },
    ),
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
  getCcswitchModels: () =>
    request<{ models: CcswitchModel[] }>('/settings/ccswitch-models'),
  // Coding tools
  getCodingToolStatus: (tools?: CodingToolProbe[]) =>
    tools?.length
      ? request<CodingToolStatusResponse>('/coding-tools/status', {
          method: 'POST',
          body: JSON.stringify({ tools }),
        })
      : request<CodingToolStatusResponse>('/coding-tools/status'),
  getAgentAdapters: () => request<AgentAdapterCatalogResponse>('/coding-tools/agent-adapters'),
  getLocalAgentRuntimes: () =>
    request<LocalAgentRuntimeCatalogResponse>('/coding-tools/local-agent-runtimes'),
  addLocalAgentRuntime: (id: string, data?: { command?: string }) =>
    request<LocalAgentRuntimeAddResponse>(
      `/coding-tools/local-agent-runtimes/${encodeURIComponent(id)}/add`,
      {
        method: 'POST',
        body: data ? JSON.stringify(data) : undefined,
      },
    ),
  installAllCliTools: () =>
    request<CliInstallAction>('/coding-tools/cli/install', { method: 'POST' }),
  ensureCodingToolsStartupLifecycle: () =>
    request<CodingToolsStartupLifecycleResult>('/coding-tools/lifecycle/startup', {
      method: 'POST',
    }),
  getOpencodeModels: () => request<OpencodeModelsResponse>('/coding-tools/opencode/models'),
  getCodexConfig: () => request<CodexConfigFile>('/coding-tools/codex/config'),
  saveCodexConfig: (content: string) =>
    request<CodexConfigFile>('/coding-tools/codex/config', {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  getCodexAuthFile: () => request<CodexConfigFile>('/coding-tools/codex/auth-file'),
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
  createWorkspace: (data: {
    name: string
    goal?: string
    projectPath?: string | null
  }) => request<WorkspaceFull>('/workspaces', { method: 'POST', body: JSON.stringify(data) }),
  createAutoWorkspace: (data: { name?: string; goal?: string }) =>
    request<WorkspaceFull>('/workspaces/auto', { method: 'POST', body: JSON.stringify(data) }),
  cloneGithubWorkspace: (data: { repoUrl: string; name?: string; goal?: string }) =>
    request<WorkspaceFull>('/workspaces/clone-github', {
      method: 'POST',
      timeout: 240_000,
      body: JSON.stringify(data),
    }),
  openWorkspaceFolder: (projectPath?: string | null) =>
    request<WorkspaceFolderOpenResult>('/workspaces/open-folder', {
      method: 'POST',
      timeout: 120_000,
      body: projectPath ? JSON.stringify({ projectPath }) : undefined,
    }),
  getWorkspace: (id: string) => request<WorkspaceFull>(`/workspaces/${id}`),
  getWorkspaceSessions: (id: string) => request<{ items: Session[] }>(`/workspaces/${id}/sessions`),
  getWorkspaceActiveRuns: (id: string) =>
    request<{ items: WorkspaceActiveRun[] }>(`/workspaces/${id}/active-runs`),
  updateWorkspace: (
    id: string,
    data: { name?: string; goal?: string; projectPath?: string | null },
  ) => request<WorkspaceFull>(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteWorkspace: (id: string) => request<void>(`/workspaces/${id}`, { method: 'DELETE' }),

  addWorkspaceAgent: (id: string, data: AgentConfigInput) =>
    request<WorkspaceAgent>(`/workspaces/${id}/agents`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkspaceAgent: (id: string, agentId: string, data: Partial<AgentConfigInput>) =>
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
    relations: Array<
      Pick<WorkspaceAgentRelation, 'sourceAgentId' | 'targetAgentId' | 'relationType'> & {
        note?: string | null
      }
    >,
  ) =>
    request<{ items: WorkspaceAgentRelation[] }>(`/workspaces/${id}/agent-relations`, {
      method: 'PUT',
      body: JSON.stringify({ relations }),
    }),

  addWorkspaceTask: (
    id: string,
    data: { title: string; description?: string; agentId?: string | null },
  ) =>
    request<WorkspaceTask>(`/workspaces/${id}/tasks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateWorkspaceTask: (
    id: string,
    taskId: string,
    data: Partial<{
      title: string
      description: string
      agentId: string | null
      status: TaskStatus
    }>,
  ) =>
    request<WorkspaceTask>(`/workspaces/${id}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteWorkspaceTask: (id: string, taskId: string) =>
    request<void>(`/workspaces/${id}/tasks/${taskId}`, { method: 'DELETE' }),
  openWorkspaceGroupSession: (id: string, agentIds?: string[]) =>
    request<{ session: Session }>(`/workspaces/${id}/group-session`, {
      method: 'POST',
      body: agentIds ? JSON.stringify({ agentIds }) : undefined,
    }),

  // Artifacts
  deployStatic: (workspaceId: string) =>
    request<{ deployId: string; url: string; status: 'ready' }>('/artifacts/deploy-static', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    }),
  applyDiff: (workspaceId: string, diff: string) =>
    request<{ success: boolean; message: string; stagedFiles?: string[] }>('/artifacts/apply-diff', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, diff }),
    }),
  downloadZip: async (workspaceId: string) => {
    const res = await fetch(
      `${API_BASE}/artifacts/zip-download?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        credentials: 'include',
      },
    )
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
  editAgentConfig: async function* (
    draft: AgentConfigInput,
    instruction: string,
  ): AsyncGenerator<AgentConfigEditStreamEvent> {
    const res = await fetch(`${API_BASE}/agent-config/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ draft, instruction }),
    })
    if (!res.ok) throw new Error(`Agent 配置修改失败: ${res.status}`)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = 'message'
    let dataLines: string[] = []

    const flushEvent = (): AgentConfigEditStreamEvent | null => {
      const data = dataLines.join('\n')
      eventName = eventName || 'message'
      dataLines = []
      if (eventName === 'done') return null
      if (eventName === 'error') throw new Error(data || 'Agent 配置修改失败')
      if (!data) return null
      if (eventName === 'result') {
        return { type: 'result', result: JSON.parse(data) as AgentConfigEditResult }
      }
      return { type: 'chunk', text: data }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (!line) {
          const event = flushEvent()
          eventName = 'message'
          if (event) yield event
          continue
        }
        if (line.startsWith('event: ')) {
          eventName = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6))
        }
      }
    }
    if (buffer || dataLines.length) {
      const event = flushEvent()
      if (event) yield event
    }
  },

  // Files
  writeFile: (data: {
    workspaceId: string
    filePath: string
    content: string
    startLine?: number
    endLine?: number
  }) =>
    request<{ ok: boolean; lines?: number }>('/files', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
}
