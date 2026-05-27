import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema'

export * from './schema'
export { eq, and, or, desc, asc, sql } from 'drizzle-orm'

// 锚定到项目根：packages/db/src -> ../../..
const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..')

const desktopDataDir = process.env.AGENTHUB_APP_DATA_DIR?.trim()
const rawUrl = desktopDataDir
  ? `${desktopDataDir.replace(/[\\/]+$/, '')}\\data\\agenthub.db`
  : (process.env.DATABASE_URL ?? './storage/agenthub.db')
const dbPath = absolutePath(rawUrl)

mkdirSync(pathDirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')
ensureLegacySchema(sqlite)

export const db = drizzle(sqlite, { schema })
export type DB = typeof db
export const migrationsPath = resolve(PROJECT_ROOT, 'packages/db/drizzle')

function ensureLegacySchema(database: Database) {
  ensureColumn(database, 'sessions', 'workspace_id', 'ALTER TABLE sessions ADD COLUMN workspace_id text')
  ensureColumn(database, 'sessions', 'workspace_agent_id', 'ALTER TABLE sessions ADD COLUMN workspace_agent_id text')
  ensureColumn(database, 'sessions', 'metadata', 'ALTER TABLE sessions ADD COLUMN metadata text')

  ensureColumn(database, 'session_members', 'joined_at', 'ALTER TABLE session_members ADD COLUMN joined_at integer')
  if (hasColumn(database, 'session_members', 'created_at') && hasColumn(database, 'session_members', 'joined_at')) {
    database.exec('UPDATE session_members SET joined_at = created_at WHERE joined_at IS NULL AND created_at IS NOT NULL')
  }

  ensureColumn(database, 'messages', 'is_pinned', 'ALTER TABLE messages ADD COLUMN is_pinned integer DEFAULT 0 NOT NULL')
  ensureColumn(database, 'messages', 'reply_to_message_id', 'ALTER TABLE messages ADD COLUMN reply_to_message_id text')

  ensureColumn(database, 'workspace_tasks', 'run_id', 'ALTER TABLE workspace_tasks ADD COLUMN run_id text')
  ensureColumn(database, 'workspace_tasks', 'phase_id', 'ALTER TABLE workspace_tasks ADD COLUMN phase_id text')
  ensureColumn(
    database,
    'workspace_tasks',
    'dependencies',
    "ALTER TABLE workspace_tasks ADD COLUMN dependencies text DEFAULT '[]' NOT NULL",
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'input_refs',
    "ALTER TABLE workspace_tasks ADD COLUMN input_refs text DEFAULT '[]' NOT NULL",
  )
  ensureColumn(database, 'workspace_tasks', 'output_key', 'ALTER TABLE workspace_tasks ADD COLUMN output_key text')
  ensureColumn(database, 'workspace_tasks', 'parallel_group', 'ALTER TABLE workspace_tasks ADD COLUMN parallel_group text')
  ensureColumn(database, 'workspace_tasks', 'max_retries', 'ALTER TABLE workspace_tasks ADD COLUMN max_retries integer DEFAULT 3 NOT NULL')
  ensureColumn(database, 'workspace_tasks', 'retry_count', 'ALTER TABLE workspace_tasks ADD COLUMN retry_count integer DEFAULT 0 NOT NULL')
  ensureColumn(database, 'workspace_tasks', 'timeout', 'ALTER TABLE workspace_tasks ADD COLUMN timeout integer DEFAULT 300000 NOT NULL')
  ensureColumn(database, 'workspace_tasks', 'fallback_agent_id', 'ALTER TABLE workspace_tasks ADD COLUMN fallback_agent_id text')
  ensureColumn(
    database,
    'workspace_tasks',
    'artifacts',
    "ALTER TABLE workspace_tasks ADD COLUMN artifacts text DEFAULT '[]' NOT NULL",
  )
  ensureColumn(database, 'workspace_tasks', 'started_at', 'ALTER TABLE workspace_tasks ADD COLUMN started_at integer')
  ensureColumn(database, 'workspace_tasks', 'completed_at', 'ALTER TABLE workspace_tasks ADD COLUMN completed_at integer')
  ensureColumn(database, 'workspace_tasks', 'error_log', 'ALTER TABLE workspace_tasks ADD COLUMN error_log text')

  ensureTable(
    database,
    'orchestrator_runs',
    `CREATE TABLE orchestrator_runs (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      group_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      plan_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      plan TEXT,
      summary_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      conflict_report TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  ensureTable(
    database,
    'blackboard_entries',
    `CREATE TABLE blackboard_entries (
      id TEXT PRIMARY KEY NOT NULL,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      agent_id TEXT,
      task_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    )`,
  )
  ensureTable(
    database,
    'execution_logs',
    `CREATE TABLE execution_logs (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      task_id TEXT,
      type TEXT NOT NULL,
      input TEXT,
      output TEXT,
      duration_ms INTEGER,
      token_usage TEXT,
      created_at INTEGER NOT NULL
    )`,
  )
}

function ensureColumn(database: Database, table: string, column: string, statement: string) {
  if (!tableExists(database, table)) return
  if (!hasColumn(database, table, column)) {
    database.exec(statement)
  }
}

function hasColumn(database: Database, table: string, column: string) {
  if (!tableExists(database, table)) return false
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some((item) => item.name === column)
}

function ensureTable(database: Database, table: string, statement: string) {
  if (tableExists(database, table)) return
  database.exec(statement)
}

function tableExists(database: Database, table: string) {
  const row = database.query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)
  return Boolean(row)
}

function isWindowsAbsolutePath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)
}

function absolutePath(value: string) {
  if (isWindowsAbsolutePath(value)) return win32.normalize(value)
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value)
}

function pathDirname(value: string) {
  return isWindowsAbsolutePath(value) ? win32.dirname(value) : dirname(value)
}
