import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
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
  workspaceId: text('workspace_id'),
  workspaceAgentId: text('workspace_agent_id'),
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

export const workspaceAgents = sqliteTable('workspace_agents', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  role: text('role').notNull(),
  description: text('description').notNull().default(''),
  avatar: text('avatar'),
  systemPrompt: text('system_prompt').notNull().default(''),
  color: text('color').notNull().default('#6366f1'),
  modelId: text('model_id'),
  runtimeType: text('runtime_type', { enum: ['llm', 'code-agent', 'mcp', 'a2a'] }).notNull().default('llm'),
  codeAgentType: text('code_agent_type', { enum: ['codex', 'claude-code', 'opencode', 'gemini'] }),
  capabilityTags: text('capability_tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  toolPermissions: text('tool_permissions', { mode: 'json' }).$type<string[]>().notNull().default([]),
  sandboxPolicy: text('sandbox_policy', { enum: ['read-only', 'workspace-write', 'danger-full-access'] })
    .notNull()
    .default('workspace-write'),
  contextPolicy: text('context_policy', { enum: ['recent-only', 'pinned-recent', 'workspace-aware'] })
    .notNull()
    .default('workspace-aware'),
  autoInvoke: integer('auto_invoke', { mode: 'boolean' }).notNull().default(true),
  approvalRequired: integer('approval_required', { mode: 'boolean' }).notNull().default(true),
  orderIdx: integer('order_idx').notNull().default(0),
  createdAt: now(),
})

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

export const workspaceTasks = sqliteTable('workspace_tasks', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'cancelled'] }).notNull().default('pending'),
  sessionId: text('session_id'),
  orderIdx: integer('order_idx').notNull().default(0),

  // === 新增字段：DAG 调度支持 ===
  runId: text('run_id'),
  phaseId: text('phase_id'), // 所属阶段（粗粒度规划）
  dependencies: text('dependencies', { mode: 'json' }).$type<string[]>().notNull().default([]),
  inputRefs: text('input_refs', { mode: 'json' }).$type<Array<{ namespace: string; key: string; version: number }>>().notNull().default([]),
  outputKey: text('output_key'), // 产出写入黑板的键名
  parallelGroup: text('parallel_group'),
  maxRetries: integer('max_retries').notNull().default(3),
  retryCount: integer('retry_count').notNull().default(0),
  timeout: integer('timeout').notNull().default(300000), // 5分钟
  fallbackAgentId: text('fallback_agent_id'),
  artifacts: text('artifacts', { mode: 'json' }).$type<AgentArtifact[]>().notNull().default([]),
  startedAt: ts('started_at'),
  completedAt: ts('completed_at'),
  errorLog: text('error_log'),

  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const sessionMembers = sqliteTable('session_members', {
  id: id(),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  memberId: text('member_id').notNull(),
  memberType: text('member_type', { enum: ['user', 'agent'] }).notNull(),
  joinedAt: now(),
})

export const messages = sqliteTable('messages', {
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
})

export interface ConflictReport {
  filePath: string
  baseContent: string
  variants: Array<{
    agentId: string
    agentName: string
    diff: string
    fullContent?: string
  }>
  resolution: 'auto-merged' | 'llm-resolved' | 'needs-human'
  mergedContent?: string
  notes?: string
}

export const orchestratorRuns = sqliteTable('orchestrator_runs', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  groupSessionId: text('group_session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  planMessageId: text('plan_message_id').references(() => messages.id),
  status: text('status', {
    enum: ['planning', 'running', 'synthesizing', 'completed', 'failed', 'cancelled'],
  }).notNull().default('planning'),
  plan: text('plan', { mode: 'json' }),
  summaryMessageId: text('summary_message_id').references(() => messages.id),
  conflictReport: text('conflict_report', { mode: 'json' }).$type<ConflictReport[]>(),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
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
    enum: ['pending', 'running', 'succeeded', 'failed', 'cancelled'],
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
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, { fields: [messages.sessionId], references: [sessions.id] }),
}))

export const blackboardEntries = sqliteTable('blackboard_entries', {
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
})

export const executionLogs = sqliteTable('execution_logs', {
  id: id(),
  runId: text('run_id').notNull(),
  sessionId: text('session_id').notNull(),
  agentId: text('agent_id').notNull(),
  taskId: text('task_id'),
  type: text('type', { enum: ['llm_call', 'tool_call', 'blackboard_read', 'blackboard_write', 'error', 'task_start', 'task_end'] }).notNull(),
  input: text('input', { mode: 'json' }),
  output: text('output', { mode: 'json' }),
  durationMs: integer('duration_ms'),
  tokenUsage: text('token_usage', { mode: 'json' }),
  createdAt: now(),
})

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  session: one(sessions, { fields: [tasks.sessionId], references: [sessions.id] }),
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
  parent: one(tasks, { fields: [tasks.parentId], references: [tasks.id], relationName: 'parent' }),
  children: many(tasks, { relationName: 'parent' }),
}))
