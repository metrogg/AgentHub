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
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
})

export const workspaceAgents = sqliteTable('workspace_agents', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  role: text('role').notNull(),
  systemPrompt: text('system_prompt').notNull().default(''),
  color: text('color').notNull().default('#6366f1'),
  orderIdx: integer('order_idx').notNull().default(0),
  createdAt: now(),
})

export const workspaceTasks = sqliteTable('workspace_tasks', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: text('agent_id'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['pending', 'running', 'done'] }).notNull().default('pending'),
  sessionId: text('session_id'),
  orderIdx: integer('order_idx').notNull().default(0),
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

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  session: one(sessions, { fields: [tasks.sessionId], references: [sessions.id] }),
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
  parent: one(tasks, { fields: [tasks.parentId], references: [tasks.id], relationName: 'parent' }),
  children: many(tasks, { relationName: 'parent' }),
}))
