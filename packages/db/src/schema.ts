import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

const id = () => text('id').primaryKey().$defaultFn(() => randomUUID())
const ts = (name: string) => integer(name, { mode: 'timestamp' })
const now = () => ts('created_at').notNull().$defaultFn(() => new Date())

export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const sessions = sqliteTable('sessions', {
  id: id(),
  title: text('title').notNull(),
  type: text('type', { enum: ['direct', 'group'] }).notNull().default('direct'),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  workspaceAgentId: text('workspace_agent_id').references(() => workspaceAgents.id, { onDelete: 'set null' }),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const workspaces = sqliteTable('workspaces', {
  id: id(),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  goal: text('goal').notNull().default(''),
  projectPath: text('project_path'),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const workspaceStates = sqliteTable('workspace_states', {
  workspaceId: text('workspace_id').notNull().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  state: text('state').notNull(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const workspaceAgents = sqliteTable(
  'workspace_agents',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  role: text('role').notNull(),
  roleType: text('role_type', {
    enum: ['orchestrator', 'clarifier', 'architect', 'researcher', 'coder', 'verifier', 'reviewer', 'integrator', 'custom'],
  }).notNull().default('custom'),
  description: text('description').notNull().default(''),
  avatar: text('avatar'),
  systemPrompt: text('system_prompt').notNull().default(''),
  roleProfile: text('role_profile', { mode: 'json' }).$type<Record<string, unknown>>(),
  color: text('color').notNull().default('#6366f1'),
  modelId: text('model_id'),
  runtimeType: text('runtime_type', { enum: ['code-agent'] }).notNull().default('code-agent'),
  codeAgentType: text('code_agent_type', { enum: ['codex', 'claude-code', 'opencode', 'gemini'] }),
  capabilityTags: text('capability_tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  skillIds: text('skill_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  toolPermissions: text('tool_permissions', { mode: 'json' }).$type<string[]>().notNull().default([]),
  sandboxPolicy: text('sandbox_policy', { enum: ['workspace-write', 'danger-full-access'] })
    .notNull()
    .default('workspace-write'),
  contextPolicy: text('context_policy', { enum: ['recent-only', 'pinned-recent', 'workspace-aware'] })
    .notNull()
    .default('workspace-aware'),
  autoInvoke: integer('auto_invoke', { mode: 'boolean' }).notNull().default(true),
  approvalRequired: integer('approval_required', { mode: 'boolean' }).notNull().default(true),
  orderIdx: integer('order_idx').notNull().default(0),
  createdAt: now(),
},
(table) => ({
  workspaceIdIdx: index('workspace_agents_workspace_id_idx').on(table.workspaceId),
}))

export const workspaceAgentRelations = sqliteTable(
  'workspace_agent_relations',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceAgentId: text('source_agent_id').notNull().references(() => workspaceAgents.id, { onDelete: 'cascade' }),
    targetAgentId: text('target_agent_id').notNull().references(() => workspaceAgents.id, { onDelete: 'cascade' }),
    relationType: text('relation_type', {
      enum: ['handoff_to', 'reviewed_by', 'fallback_to', 'reports_to', 'blocks'],
    }).notNull(),
    note: text('note'),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueRelation: uniqueIndex('workspace_agent_relations_unique').on(
      table.workspaceId,
      table.sourceAgentId,
      table.targetAgentId,
      table.relationType,
    ),
  }),
)

export interface AgentArtifact {
  id: string
  kind: 'diff' | 'file' | 'preview' | 'deploy' | 'log' | 'workflow'
  title: string
  description?: string
  source?: string
  createdAt?: string
  // diff
  filePath?: string
  status?: 'created' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  language?: string
  diff?: string
  // preview
  url?: string
  previewKind?: 'dev-server' | 'static-html' | 'iframe'
  // file
  path?: string
  mimeType?: string
  size?: number
  // deploy
  provider?: 'vercel' | 'static' | 'unknown'
  logs?: string[]
}

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => orchestratorRuns.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => workspaceTasks.id, { onDelete: 'set null' }),
    roomId: text('room_id').references(() => rooms.id, { onDelete: 'set null' }),
    taskThreadId: text('task_thread_id').references(() => taskThreads.id, { onDelete: 'set null' }),
    workspaceAgentId: text('workspace_agent_id').references(() => workspaceAgents.id, { onDelete: 'set null' }),
    workerInstanceId: text('worker_instance_id'),
    kind: text('kind', {
      enum: ['file', 'directory', 'preview', 'report', 'log', 'diff', 'url'],
    }).notNull().default('file'),
    title: text('title').notNull(),
    description: text('description'),
    sourcePath: text('source_path'),
    handoffPath: text('handoff_path'),
    relativePath: text('relative_path'),
    storageProvider: text('storage_provider').notNull().default('local-filesystem'),
    bucket: text('bucket').notNull().default('agenthub-artifacts'),
    objectKey: text('object_key'),
    storagePath: text('storage_path'),
    mimeType: text('mime_type'),
    size: integer('size'),
    checksum: text('checksum'),
    status: text('status', {
      enum: ['discovered', 'registered', 'verified', 'partial', 'failed'],
    }).notNull().default('registered'),
    visibility: text('visibility', {
      enum: ['private', 'team', 'user'],
    }).notNull().default('team'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceIdIdx: index('artifacts_workspace_id_idx').on(table.workspaceId),
    runIdIdx: index('artifacts_run_id_idx').on(table.runId),
    taskIdIdx: index('artifacts_task_id_idx').on(table.taskId),
    roomIdIdx: index('artifacts_room_id_idx').on(table.roomId),
    taskThreadIdIdx: index('artifacts_task_thread_id_idx').on(table.taskThreadId),
    objectKeyIdx: index('artifacts_object_key_idx').on(table.objectKey),
    taskPathUnique: uniqueIndex('artifacts_task_relative_path_unique').on(
      table.taskId,
      table.relativePath,
      table.checksum,
    ),
  }),
)

export const workspaceTasks = sqliteTable(
  'workspace_tasks',
  {
    id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => workspaceAgents.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'cancelled', 'blocked', 'skipped'] }).notNull().default('pending'),
  sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  orderIdx: integer('order_idx').notNull().default(0),

  // === 新增字段：DAG 调度支持 ===
  runId: text('run_id').references(() => orchestratorRuns.id, { onDelete: 'cascade' }),
  phaseId: text('phase_id'), // 所属阶段（粗粒度规划）
  dependencies: text('dependencies', { mode: 'json' }).$type<string[]>().notNull().default([]),
  inputRefs: text('input_refs', { mode: 'json' }).$type<Array<{ namespace: string; key: string; version: number }>>().notNull().default([]),
  outputKey: text('output_key'), // 产出写入黑板的键名
  parallelGroup: text('parallel_group'),
  maxRetries: integer('max_retries').notNull().default(3),
  retryCount: integer('retry_count').notNull().default(0),
  timeout: integer('timeout').notNull().default(300000), // 5分钟
  fallbackAgentId: text('fallback_agent_id').references(() => workspaceAgents.id, { onDelete: 'set null' }),
  artifacts: text('artifacts', { mode: 'json' }).$type<AgentArtifact[]>().notNull().default([]),
  startedAt: ts('started_at'),
  completedAt: ts('completed_at'),
  errorLog: text('error_log'),

  progressPercent: integer('progress_percent').default(0),
  progressStatus: text('progress_status'),
  clarificationCount: integer('clarification_count').default(0),

  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
},
(table) => ({
  workspaceIdIdx: index('workspace_tasks_workspace_id_idx').on(table.workspaceId),
  runIdIdx: index('workspace_tasks_run_id_idx').on(table.runId),
  sessionIdIdx: index('workspace_tasks_session_id_idx').on(table.sessionId),
  agentIdIdx: index('workspace_tasks_agent_id_idx').on(table.agentId),
}))

export const sessionMembers = sqliteTable(
  'session_members',
  {
    id: id(),
    sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull(),
    memberType: text('member_type', { enum: ['user', 'agent'] }).notNull(),
    joinedAt: now(),
  },
  (table) => ({
    sessionIdIdx: index('session_members_session_id_idx').on(table.sessionId),
  }),
)

export const rooms = sqliteTable(
  'rooms',
  {
    id: id(),
    provider: text('provider', { enum: ['matrix'] })
      .notNull()
      .default('matrix'),
    providerRoomId: text('provider_room_id').notNull(),
    kind: text('kind', { enum: ['group', 'manager_dm', 'task', 'direct', 'human_intervention'] })
      .notNull(),
    ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => orchestratorRuns.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => workspaceTasks.id, { onDelete: 'set null' }),
    taskThreadId: text('task_thread_id').references(() => taskThreads.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    topic: text('topic'),
    status: text('status', { enum: ['active', 'archived', 'failed'] }).notNull().default('active'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    providerRoomIdUnique: uniqueIndex('rooms_provider_room_id_unique').on(table.provider, table.providerRoomId),
    ownerIdIdx: index('rooms_owner_id_idx').on(table.ownerId),
    workspaceIdIdx: index('rooms_workspace_id_idx').on(table.workspaceId),
    sessionIdIdx: index('rooms_session_id_idx').on(table.sessionId),
    runIdIdx: index('rooms_run_id_idx').on(table.runId),
    taskThreadIdIdx: index('rooms_task_thread_id_idx').on(table.taskThreadId),
  }),
)

export const roomParticipants = sqliteTable(
  'room_participants',
  {
    id: id(),
    roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    providerUserId: text('provider_user_id'),
    participantType: text('participant_type', { enum: ['human', 'manager', 'worker', 'system'] }).notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    workspaceAgentId: text('workspace_agent_id').references(() => workspaceAgents.id, { onDelete: 'set null' }),
    workerInstanceId: text('worker_instance_id').references(() => workerInstances.id, { onDelete: 'set null' }),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: ['owner', 'manager', 'member', 'observer', 'system'] }).notNull().default('member'),
    status: text('status', { enum: ['joined', 'invited', 'left'] }).notNull().default('joined'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    joinedAt: ts('joined_at').notNull().$defaultFn(() => new Date()),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    roomIdIdx: index('room_participants_room_id_idx').on(table.roomId),
    userIdIdx: index('room_participants_user_id_idx').on(table.userId),
    workspaceAgentIdIdx: index('room_participants_workspace_agent_id_idx').on(table.workspaceAgentId),
    workerInstanceIdIdx: index('room_participants_worker_instance_id_idx').on(table.workerInstanceId),
  }),
)

export const matrixIdentities = sqliteTable(
  'matrix_identities',
  {
    id: id(),
    ownerType: text('owner_type', { enum: ['human', 'manager', 'worker', 'system'] }).notNull(),
    ownerId: text('owner_id').notNull(),
    serverName: text('server_name').notNull(),
    localpart: text('localpart').notNull(),
    userId: text('user_id').notNull(),
    accessToken: text('access_token'),
    password: text('password'),
    displayName: text('display_name').notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    ownerUnique: uniqueIndex('matrix_identities_owner_unique').on(table.ownerType, table.ownerId, table.serverName),
    userIdUnique: uniqueIndex('matrix_identities_user_id_unique').on(table.userId),
    localpartIdx: index('matrix_identities_localpart_idx').on(table.localpart),
  }),
)

export const controllerAuditEvents = sqliteTable(
  'controller_audit_events',
  {
    id: id(),
    operationId: text('operation_id').notNull(),
    applyOperationId: text('apply_operation_id'),
    danger: text('danger', { enum: ['read', 'write', 'destructive'] }).notNull(),
    approvalLevel: text('approval_level', { enum: ['not_required', 'recommended', 'required'] })
      .notNull()
      .default('not_required'),
    approvalRequired: integer('approval_required', { mode: 'boolean' }).notNull().default(false),
    approvalProvided: integer('approval_provided', { mode: 'boolean' }).notNull().default(false),
    approvedBy: text('approved_by'),
    approvalReason: text('approval_reason'),
    manifestKind: text('manifest_kind').notNull(),
    manifestName: text('manifest_name'),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    resourceId: text('resource_id'),
    resourceKind: text('resource_kind'),
    auditFields: text('audit_fields', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    resultSummary: text('result_summary', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
  },
  (table) => ({
    operationIdIdx: index('controller_audit_events_operation_id_idx').on(table.operationId),
    workspaceIdIdx: index('controller_audit_events_workspace_id_idx').on(table.workspaceId),
    resourceIdx: index('controller_audit_events_resource_idx').on(table.resourceKind, table.resourceId),
    createdAtIdx: index('controller_audit_events_created_at_idx').on(table.createdAt),
  }),
)

export const timelineEvents = sqliteTable(
  'timeline_events',
  {
    id: id(),
    roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
    providerEventId: text('provider_event_id').notNull(),
    senderParticipantId: text('sender_participant_id').references(() => roomParticipants.id, { onDelete: 'set null' }),
    senderType: text('sender_type', { enum: ['human', 'manager', 'worker', 'system'] }).notNull(),
    type: text('type', {
      enum: [
        'human.message',
        'manager.message',
        'worker.message',
        'task.assigned',
        'task.progress',
        'artifact.created',
        'approval.requested',
        'file.shared',
        'system',
      ],
    }).notNull(),
    body: text('body').notNull().default(''),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    sequence: integer('sequence').notNull().default(0),
    createdAt: now(),
  },
  (table) => ({
    roomIdIdx: index('timeline_events_room_id_idx').on(table.roomId),
    roomSequenceIdx: uniqueIndex('timeline_events_room_sequence_unique').on(table.roomId, table.sequence),
    providerEventIdUnique: uniqueIndex('timeline_events_provider_event_id_unique').on(table.roomId, table.providerEventId),
    senderParticipantIdIdx: index('timeline_events_sender_participant_id_idx').on(table.senderParticipantId),
  }),
)

export const messages = sqliteTable(
  'messages',
  {
    id: id(),
    sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').notNull(),
    senderType: text('sender_type', { enum: ['user', 'agent', 'system'] }).notNull(),
    type: text('type').notNull().default('text'),
    content: text('content').notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
    replyToMessageId: text('reply_to_message_id'),
    createdAt: now(),
  },
  (table) => ({
    sessionIdIdx: index('messages_session_id_idx').on(table.sessionId),
    pinnedIdx: index('messages_pinned_idx').on(table.sessionId, table.isPinned),
  }),
)

export interface ConflictReport {
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

export const orchestratorRuns = sqliteTable('orchestrator_runs', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  groupSessionId: text('group_session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  planMessageId: text('plan_message_id').references(() => messages.id, { onDelete: 'set null' }),
  status: text('status', {
    enum: ['planning', 'running', 'synthesizing', 'completed', 'failed', 'cancelled'],
  }).notNull().default('planning'),
  plan: text('plan', { mode: 'json' }),
  summaryMessageId: text('summary_message_id').references(() => messages.id, { onDelete: 'set null' }),
  conflictReport: text('conflict_report', { mode: 'json' }).$type<ConflictReport[]>(),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const workerInstances = sqliteTable(
  'worker_instances',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    workspaceAgentId: text('workspace_agent_id').notNull().references(() => workspaceAgents.id, { onDelete: 'cascade' }),
    runtimeFamily: text('runtime_family', { enum: ['coordinator', 'worker'] })
      .notNull()
      .default('worker'),
    runtimeBase: text('runtime_base', {
      enum: ['openclaw', 'copaw', 'qwenpaw', 'codex', 'claude-code', 'opencode', 'gemini'],
    }).notNull(),
    modelId: text('model_id'),
    skillIds: text('skill_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    mcpServerIds: text('mcp_server_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    sandboxPolicy: text('sandbox_policy', { enum: ['workspace-write', 'danger-full-access'] })
      .notNull()
      .default('workspace-write'),
    desiredState: text('desired_state', { enum: ['running', 'sleeping', 'stopped'] })
      .notNull()
      .default('running'),
    observedState: text('observed_state', { enum: ['provisioning', 'ready', 'listening', 'assigned', 'busy', 'waiting_for_human', 'resuming', 'idle', 'sleeping', 'stopped', 'failed'] })
      .notNull()
      .default('provisioning'),
    health: text('health', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    runtimeHome: text('runtime_home'),
    runtimeConfigPath: text('runtime_config_path'),
    lastHeartbeatAt: ts('last_heartbeat_at'),
    message: text('message'),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceIdIdx: index('worker_instances_workspace_id_idx').on(table.workspaceId),
    workspaceAgentIdIdx: index('worker_instances_workspace_agent_id_idx').on(table.workspaceAgentId),
    uniqueWorkspaceAgent: uniqueIndex('worker_instances_workspace_agent_unique').on(
      table.workspaceId,
      table.workspaceAgentId,
    ),
  }),
)

export const runtimeLeases = sqliteTable(
  'runtime_leases',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => orchestratorRuns.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => workspaceTasks.id, { onDelete: 'set null' }),
    workerInstanceId: text('worker_instance_id').references(() => workerInstances.id, { onDelete: 'set null' }),
    provider: text('provider', { enum: ['local-workdir', 'docker-sandbox', 'remote-container'] })
      .notNull()
      .default('local-workdir'),
    status: text('status', { enum: ['creating', 'ready', 'running', 'waiting_for_human', 'cleaning', 'released', 'failed', 'stale'] })
      .notNull()
      .default('creating'),
    cwd: text('cwd'),
    homeDir: text('home_dir'),
    configDir: text('config_dir'),
    cacheDir: text('cache_dir'),
    tmpDir: text('tmp_dir'),
    dataDir: text('data_dir'),
    containerId: text('container_id'),
    sandboxId: text('sandbox_id'),
    pid: integer('pid'),
    startedAt: ts('started_at'),
    releasedAt: ts('released_at'),
    error: text('error'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    workspaceIdIdx: index('runtime_leases_workspace_id_idx').on(table.workspaceId),
    runIdIdx: index('runtime_leases_run_id_idx').on(table.runId),
    taskIdIdx: index('runtime_leases_task_id_idx').on(table.taskId),
    workerInstanceIdIdx: index('runtime_leases_worker_instance_id_idx').on(table.workerInstanceId),
  }),
)

export const taskThreads = sqliteTable(
  'task_threads',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => orchestratorRuns.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull().references(() => workspaceTasks.id, { onDelete: 'cascade' }),
    groupSessionId: text('group_session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    workspaceAgentId: text('workspace_agent_id').references(() => workspaceAgents.id, { onDelete: 'set null' }),
    workerInstanceId: text('worker_instance_id'),
    sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['prepared', 'assigned', 'active', 'waiting_for_human', 'completed', 'failed', 'cancelled'],
    }).notNull().default('prepared'),
    lastEventId: text('last_event_id'),
    createdAt: now(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    runTaskUnique: uniqueIndex('task_threads_run_task_unique').on(table.runId, table.taskId),
    runIdIdx: index('task_threads_run_id_idx').on(table.runId),
    sessionIdIdx: index('task_threads_session_id_idx').on(table.sessionId),
    workspaceIdIdx: index('task_threads_workspace_id_idx').on(table.workspaceId),
  }),
)

export const orchestratorRunEvents = sqliteTable(
  'orchestrator_run_events',
  {
    id: id(),
    runId: text('run_id').notNull().references(() => orchestratorRuns.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    groupSessionId: text('group_session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id'),
    threadId: text('thread_id').references(() => taskThreads.id, { onDelete: 'set null' }),
    workerInstanceId: text('worker_instance_id'),
    agentId: text('agent_id'),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    severity: text('severity', { enum: ['debug', 'info', 'warning', 'error'] }).notNull().default('info'),
    sequence: integer('sequence').notNull().default(0),
    createdAt: now(),
  },
  (table) => ({
    runIdIdx: index('orchestrator_run_events_run_id_idx').on(table.runId),
    threadIdIdx: index('orchestrator_run_events_thread_id_idx').on(table.threadId),
  }),
)

export const taskClarifications = sqliteTable('task_clarifications', {
  id: id(),
  runId: text('run_id').notNull().references(() => orchestratorRuns.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull(),
  agentId: text('agent_id').notNull(),
  question: text('question').notNull(),
  options: text('options', { mode: 'json' }).$type<string[]>(),
  answer: text('answer'),
  status: text('status', { enum: ['pending', 'answered', 'timeout'] }).notNull().default('pending'),
  createdAt: now(),
  answeredAt: ts('answered_at'),
})

export const orchestratorRunControls = sqliteTable('orchestrator_run_controls', {
  id: id(),
  runId: text('run_id').notNull().references(() => orchestratorRuns.id, { onDelete: 'cascade' }),
  action: text('action', { enum: ['pause', 'resume', 'cancel', 'retry_all_failed', 'skip_task'] }).notNull(),
  targetTaskId: text('target_task_id'),
  reason: text('reason'),
  createdAt: now(),
})

export const agents = sqliteTable('agents', {
  id: id(),
  name: text('name').notNull(),
  provider: text('provider', { enum: ['claude', 'openai', 'gemini', 'mcp', 'custom'] }).notNull(),
  model: text('model').notNull(),
  description: text('description'),
  avatar: text('avatar'),
  capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().default([]),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: now(),
})

export const settings = sqliteTable('settings', {
  id: id(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const tasks = sqliteTable('tasks', {
  id: id(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  agentId: text('agent_id').references(() => agents.id),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', {
    enum: ['pending', 'running', 'done', 'failed', 'cancelled'],
  }).notNull().default('pending'),
  result: text('result', { mode: 'json' }),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  owner: one(users, { fields: [sessions.ownerId], references: [users.id] }),
  messages: many(messages),
  tasks: many(tasks),
  members: many(sessionMembers),
  rooms: many(rooms),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, { fields: [messages.sessionId], references: [sessions.id] }),
}))

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  owner: one(users, { fields: [rooms.ownerId], references: [users.id] }),
  workspace: one(workspaces, { fields: [rooms.workspaceId], references: [workspaces.id] }),
  session: one(sessions, { fields: [rooms.sessionId], references: [sessions.id] }),
  participants: many(roomParticipants),
  timelineEvents: many(timelineEvents),
}))

export const roomParticipantsRelations = relations(roomParticipants, ({ one, many }) => ({
  room: one(rooms, { fields: [roomParticipants.roomId], references: [rooms.id] }),
  user: one(users, { fields: [roomParticipants.userId], references: [users.id] }),
  workspaceAgent: one(workspaceAgents, {
    fields: [roomParticipants.workspaceAgentId],
    references: [workspaceAgents.id],
  }),
  workerInstance: one(workerInstances, {
    fields: [roomParticipants.workerInstanceId],
    references: [workerInstances.id],
  }),
  timelineEvents: many(timelineEvents),
}))

export const timelineEventsRelations = relations(timelineEvents, ({ one }) => ({
  room: one(rooms, { fields: [timelineEvents.roomId], references: [rooms.id] }),
  senderParticipant: one(roomParticipants, {
    fields: [timelineEvents.senderParticipantId],
    references: [roomParticipants.id],
  }),
}))

export const blackboardEntries = sqliteTable(
  'blackboard_entries',
  {
    id: id(),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    agentId: text('agent_id'),
    taskId: text('task_id'),
    version: integer('version').notNull().default(1),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: now(),
  },
  (table) => ({
    namespaceKeyIdx: index('blackboard_entries_namespace_key_idx').on(table.namespace, table.key),
  }),
)

export const executionLogs = sqliteTable(
  'execution_logs',
  {
    id: id(),
    runId: text('run_id').notNull().references(() => orchestratorRuns.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    taskId: text('task_id'),
    type: text('type', { enum: ['llm_call', 'tool_call', 'blackboard_read', 'blackboard_write', 'error', 'task_start', 'task_end'] }).notNull(),
    input: text('input', { mode: 'json' }),
    output: text('output', { mode: 'json' }),
    durationMs: integer('duration_ms'),
    tokenUsage: text('token_usage', { mode: 'json' }),
    createdAt: now(),
  },
  (table) => ({
    runIdIdx: index('execution_logs_run_id_idx').on(table.runId),
  }),
)

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  session: one(sessions, { fields: [tasks.sessionId], references: [sessions.id] }),
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
  parent: one(tasks, { fields: [tasks.parentId], references: [tasks.id], relationName: 'parent' }),
  children: many(tasks, { relationName: 'parent' }),
}))
