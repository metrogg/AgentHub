import {
  AgentRelationType,
  AgentRoleType,
  ArtifactFileStatus,
  BlackboardSchemaType,
  CodeAgentType,
  ContextPolicy,
  ExecutionLogType,
  MessageType,
  OrchestratorRunEventSeverity,
  OrchestratorRunEventType,
  OrchestratorRunStatus,
  RuntimeType,
  SandboxPolicy,
  SenderType,
  SessionType,
  TaskStatus,
  TaskType,
} from '@agenthub/shared'

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

export interface OpenClawAgentSummary {
  id: string
  name: string
  role: string
  workspace: string | null
  agentDir: string | null
  bindings: number
  isDefault: boolean
  routes: string[]
  agentHubDraft: AgentConfigInput & {
    runtimeType: 'code-agent'
    codeAgentType: 'openclaw'
  }
}

export interface OpenClawAgentsCatalogResponse {
  ok: boolean
  command: string
  installed: boolean
  items: OpenClawAgentSummary[]
  diagnostics?: string
  message: string
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

export interface WorkspaceFileEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  size: number
  sizeLabel: string
  modifiedAt: string
  extension?: string
  hidden: boolean
}

export interface WorkspaceFileListResponse {
  workspaceId: string
  rootName: string
  path: string
  parentPath: string | null
  items: WorkspaceFileEntry[]
  total: number
  truncated: boolean
}

export interface WorkspaceFileContentResponse {
  workspaceId: string
  name: string
  path: string
  mimeType: string
  size: number
  sizeLabel: string
  binary: boolean
  content: string
  truncated: boolean
}

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
