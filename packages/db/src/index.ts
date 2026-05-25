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
ensureSchema(sqlite)

export const db = drizzle(sqlite, { schema })
export type DB = typeof db

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

function ensureSchema(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY NOT NULL,
      email text NOT NULL,
      username text NOT NULL,
      password_hash text NOT NULL,
      avatar_url text,
      role text DEFAULT 'user' NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      description text,
      avatar text,
      capabilities text DEFAULT '[]',
      config text,
      enabled integer DEFAULT 1 NOT NULL,
      created_at integer NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id text PRIMARY KEY NOT NULL,
      title text NOT NULL,
      type text DEFAULT 'direct' NOT NULL,
      owner_id text NOT NULL,
      workspace_id text,
      workspace_agent_id text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE cascade
    );

    CREATE TABLE IF NOT EXISTS messages (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      sender_id text NOT NULL,
      sender_type text NOT NULL,
      type text DEFAULT 'text' NOT NULL,
      content text NOT NULL,
      metadata text,
      created_at integer NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE cascade
    );

    CREATE TABLE IF NOT EXISTS session_members (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      member_id text NOT NULL,
      member_type text NOT NULL,
      created_at integer NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE cascade
    );

    CREATE TABLE IF NOT EXISTS settings (
      id text PRIMARY KEY NOT NULL,
      key text NOT NULL,
      value text NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS settings_key_unique ON settings (key);

    CREATE TABLE IF NOT EXISTS tasks (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      parent_id text,
      agent_id text,
      title text NOT NULL,
      description text,
      status text DEFAULT 'pending' NOT NULL,
      result text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE cascade,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id text PRIMARY KEY NOT NULL,
      owner_id text NOT NULL,
      name text NOT NULL,
      goal text DEFAULT '' NOT NULL,
      project_path text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE cascade
    );

    CREATE TABLE IF NOT EXISTS workspace_agents (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      name text NOT NULL,
      role text NOT NULL,
      description text DEFAULT '' NOT NULL,
      avatar text,
      system_prompt text DEFAULT '' NOT NULL,
      color text DEFAULT '#6366f1' NOT NULL,
      model_id text,
      runtime_type text DEFAULT 'llm' NOT NULL,
      code_agent_type text,
      capability_tags text DEFAULT '[]' NOT NULL,
      tool_permissions text DEFAULT '[]' NOT NULL,
      sandbox_policy text DEFAULT 'workspace-write' NOT NULL,
      context_policy text DEFAULT 'workspace-aware' NOT NULL,
      auto_invoke integer DEFAULT 1 NOT NULL,
      approval_required integer DEFAULT 1 NOT NULL,
      order_idx integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE cascade
    );

    CREATE TABLE IF NOT EXISTS workspace_tasks (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      agent_id text,
      title text NOT NULL,
      description text DEFAULT '' NOT NULL,
      status text DEFAULT 'pending' NOT NULL,
      session_id text,
      order_idx integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE cascade
    );
  `)

  ensureColumn(database, 'sessions', 'workspace_id', 'text')
  ensureColumn(database, 'sessions', 'workspace_agent_id', 'text')
  ensureColumn(database, 'workspaces', 'project_path', 'text')
  ensureColumn(database, 'workspace_agents', 'description', "text DEFAULT '' NOT NULL")
  ensureColumn(database, 'workspace_agents', 'avatar', 'text')
  ensureColumn(database, 'workspace_agents', 'model_id', 'text')
  ensureColumn(database, 'workspace_agents', 'runtime_type', "text DEFAULT 'llm' NOT NULL")
  ensureColumn(database, 'workspace_agents', 'code_agent_type', 'text')
  ensureColumn(database, 'workspace_agents', 'capability_tags', "text DEFAULT '[]' NOT NULL")
  ensureColumn(database, 'workspace_agents', 'tool_permissions', "text DEFAULT '[]' NOT NULL")
  ensureColumn(database, 'workspace_agents', 'sandbox_policy', "text DEFAULT 'workspace-write' NOT NULL")
  ensureColumn(database, 'workspace_agents', 'context_policy', "text DEFAULT 'workspace-aware' NOT NULL")
  ensureColumn(database, 'workspace_agents', 'auto_invoke', 'integer DEFAULT 1 NOT NULL')
  ensureColumn(database, 'workspace_agents', 'approval_required', 'integer DEFAULT 1 NOT NULL')
}

function ensureColumn(database: Database, table: string, column: string, definition: string) {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (columns.some((item) => item.name === column)) return
  database.exec(`ALTER TABLE ${table} ADD ${column} ${definition}`)
}
