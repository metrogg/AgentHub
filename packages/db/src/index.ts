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
export const databasePath = dbPath

mkdirSync(pathDirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')
if (process.env.AGENTHUB_SKIP_LEGACY_SCHEMA !== '1') {
  ensureLegacySchema(sqlite)
}

export const db = drizzle(sqlite, { schema })
export type DB = typeof db
export const migrationsPath = resolve(PROJECT_ROOT, 'packages/db/drizzle')

function ensureLegacySchema(database: Database) {
  ensureColumn(
    database,
    'sessions',
    'workspace_id',
    'ALTER TABLE sessions ADD COLUMN workspace_id text',
  )
  ensureColumn(
    database,
    'sessions',
    'workspace_agent_id',
    'ALTER TABLE sessions ADD COLUMN workspace_agent_id text',
  )
  ensureColumn(database, 'sessions', 'metadata', 'ALTER TABLE sessions ADD COLUMN metadata text')

  ensureColumn(
    database,
    'session_members',
    'joined_at',
    'ALTER TABLE session_members ADD COLUMN joined_at integer',
  )
  if (
    hasColumn(database, 'session_members', 'created_at') &&
    hasColumn(database, 'session_members', 'joined_at')
  ) {
    database.exec(
      'UPDATE session_members SET joined_at = created_at WHERE joined_at IS NULL AND created_at IS NOT NULL',
    )
  }

  ensureColumn(
    database,
    'messages',
    'is_pinned',
    'ALTER TABLE messages ADD COLUMN is_pinned integer DEFAULT 0 NOT NULL',
  )
  ensureColumn(
    database,
    'messages',
    'reply_to_message_id',
    'ALTER TABLE messages ADD COLUMN reply_to_message_id text',
  )

  ensureColumn(
    database,
    'workspace_tasks',
    'run_id',
    'ALTER TABLE workspace_tasks ADD COLUMN run_id text',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'phase_id',
    'ALTER TABLE workspace_tasks ADD COLUMN phase_id text',
  )
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
  ensureColumn(
    database,
    'workspace_tasks',
    'output_key',
    'ALTER TABLE workspace_tasks ADD COLUMN output_key text',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'parallel_group',
    'ALTER TABLE workspace_tasks ADD COLUMN parallel_group text',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'max_retries',
    'ALTER TABLE workspace_tasks ADD COLUMN max_retries integer DEFAULT 3 NOT NULL',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'retry_count',
    'ALTER TABLE workspace_tasks ADD COLUMN retry_count integer DEFAULT 0 NOT NULL',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'timeout',
    'ALTER TABLE workspace_tasks ADD COLUMN timeout integer DEFAULT 300000 NOT NULL',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'fallback_agent_id',
    'ALTER TABLE workspace_tasks ADD COLUMN fallback_agent_id text',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'artifacts',
    "ALTER TABLE workspace_tasks ADD COLUMN artifacts text DEFAULT '[]' NOT NULL",
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'started_at',
    'ALTER TABLE workspace_tasks ADD COLUMN started_at integer',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'completed_at',
    'ALTER TABLE workspace_tasks ADD COLUMN completed_at integer',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'error_log',
    'ALTER TABLE workspace_tasks ADD COLUMN error_log text',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'progress_percent',
    'ALTER TABLE workspace_tasks ADD COLUMN progress_percent integer DEFAULT 0',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'progress_status',
    'ALTER TABLE workspace_tasks ADD COLUMN progress_status text',
  )
  ensureColumn(
    database,
    'workspace_tasks',
    'clarification_count',
    'ALTER TABLE workspace_tasks ADD COLUMN clarification_count integer DEFAULT 0',
  )

  ensureColumn(
    database,
    'workspace_agents',
    'role_type',
    "ALTER TABLE workspace_agents ADD COLUMN role_type text DEFAULT 'custom' NOT NULL",
  )
  ensureColumn(
    database,
    'workspace_agents',
    'role_profile',
    'ALTER TABLE workspace_agents ADD COLUMN role_profile text',
  )
  ensureColumn(
    database,
    'workspace_agents',
    'skill_ids',
    "ALTER TABLE workspace_agents ADD COLUMN skill_ids text DEFAULT '[]' NOT NULL",
  )
  ensureColumn(
    database,
    'workspace_agents',
    'capability_tags',
    "ALTER TABLE workspace_agents ADD COLUMN capability_tags text DEFAULT '[]' NOT NULL",
  )
  ensureColumn(
    database,
    'workspace_agents',
    'tool_permissions',
    "ALTER TABLE workspace_agents ADD COLUMN tool_permissions text DEFAULT '[]' NOT NULL",
  )
  ensureColumn(
    database,
    'workspace_agents',
    'sandbox_policy',
    "ALTER TABLE workspace_agents ADD COLUMN sandbox_policy text DEFAULT 'workspace-write' NOT NULL",
  )
  ensureColumn(
    database,
    'workspace_agents',
    'context_policy',
    "ALTER TABLE workspace_agents ADD COLUMN context_policy text DEFAULT 'workspace-aware' NOT NULL",
  )
  ensureColumn(
    database,
    'workspace_agents',
    'auto_invoke',
    'ALTER TABLE workspace_agents ADD COLUMN auto_invoke integer DEFAULT true NOT NULL',
  )
  ensureColumn(
    database,
    'workspace_agents',
    'approval_required',
    'ALTER TABLE workspace_agents ADD COLUMN approval_required integer DEFAULT true NOT NULL',
  )
  if (hasColumn(database, 'workspace_agents', 'sandbox_policy')) {
    database.exec(
      "UPDATE workspace_agents SET sandbox_policy = 'workspace-write' WHERE sandbox_policy = 'read-only'",
    )
  }

  ensureTable(
    database,
    'worker_instances',
    `CREATE TABLE worker_instances (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workspace_agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
      runtime_family TEXT NOT NULL DEFAULT 'worker',
      runtime_base TEXT NOT NULL,
      model_id TEXT,
      skill_ids TEXT NOT NULL DEFAULT '[]',
      mcp_server_ids TEXT NOT NULL DEFAULT '[]',
      sandbox_policy TEXT NOT NULL DEFAULT 'workspace-write',
      desired_state TEXT NOT NULL DEFAULT 'running',
      observed_state TEXT NOT NULL DEFAULT 'provisioning',
      health TEXT NOT NULL DEFAULT '{}',
      runtime_home TEXT,
      runtime_config_path TEXT,
      last_heartbeat_at INTEGER,
      message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'worker_instances_workspace_id_idx',
    'CREATE INDEX worker_instances_workspace_id_idx ON worker_instances(workspace_id)',
  )
  ensureIndex(
    database,
    'worker_instances_workspace_agent_id_idx',
    'CREATE INDEX worker_instances_workspace_agent_id_idx ON worker_instances(workspace_agent_id)',
  )
  ensureIndex(
    database,
    'worker_instances_workspace_agent_unique',
    'CREATE UNIQUE INDEX worker_instances_workspace_agent_unique ON worker_instances(workspace_id, workspace_agent_id)',
  )

  ensureTable(
    database,
    'runtime_leases',
    `CREATE TABLE runtime_leases (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES workspace_tasks(id) ON DELETE SET NULL,
      worker_instance_id TEXT REFERENCES worker_instances(id) ON DELETE SET NULL,
      provider TEXT NOT NULL DEFAULT 'local-workdir',
      status TEXT NOT NULL DEFAULT 'creating',
      cwd TEXT,
      home_dir TEXT,
      config_dir TEXT,
      cache_dir TEXT,
      tmp_dir TEXT,
      data_dir TEXT,
      container_id TEXT,
      sandbox_id TEXT,
      pid INTEGER,
      started_at INTEGER,
      released_at INTEGER,
      error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'runtime_leases_workspace_id_idx',
    'CREATE INDEX runtime_leases_workspace_id_idx ON runtime_leases(workspace_id)',
  )
  ensureIndex(
    database,
    'runtime_leases_run_id_idx',
    'CREATE INDEX runtime_leases_run_id_idx ON runtime_leases(run_id)',
  )
  ensureIndex(
    database,
    'runtime_leases_task_id_idx',
    'CREATE INDEX runtime_leases_task_id_idx ON runtime_leases(task_id)',
  )
  ensureIndex(
    database,
    'runtime_leases_worker_instance_id_idx',
    'CREATE INDEX runtime_leases_worker_instance_id_idx ON runtime_leases(worker_instance_id)',
  )

  ensureTable(
    database,
    'workspace_states',
    `CREATE TABLE workspace_states (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )

  ensureTable(
    database,
    'task_clarifications',
    `CREATE TABLE task_clarifications (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT,
      answer TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    )`,
  )

  ensureTable(
    database,
    'orchestrator_run_controls',
    `CREATE TABLE orchestrator_run_controls (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      target_task_id TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL
    )`,
  )

  ensureTable(
    database,
    'task_threads',
    `CREATE TABLE task_threads (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES workspace_tasks(id) ON DELETE CASCADE,
      group_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      workspace_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
      worker_instance_id TEXT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'prepared',
      last_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'task_threads_run_task_unique',
    'CREATE UNIQUE INDEX task_threads_run_task_unique ON task_threads(run_id, task_id)',
  )
  ensureIndex(
    database,
    'task_threads_run_id_idx',
    'CREATE INDEX task_threads_run_id_idx ON task_threads(run_id)',
  )
  ensureIndex(
    database,
    'task_threads_session_id_idx',
    'CREATE INDEX task_threads_session_id_idx ON task_threads(session_id)',
  )
  ensureIndex(
    database,
    'task_threads_workspace_id_idx',
    'CREATE INDEX task_threads_workspace_id_idx ON task_threads(workspace_id)',
  )

  ensureColumn(
    database,
    'orchestrator_run_events',
    'thread_id',
    'ALTER TABLE orchestrator_run_events ADD COLUMN thread_id text',
  )
  ensureColumn(
    database,
    'orchestrator_run_events',
    'worker_instance_id',
    'ALTER TABLE orchestrator_run_events ADD COLUMN worker_instance_id text',
  )
  ensureColumn(
    database,
    'orchestrator_run_events',
    'sequence',
    'ALTER TABLE orchestrator_run_events ADD COLUMN sequence integer DEFAULT 0 NOT NULL',
  )
  ensureIndex(
    database,
    'orchestrator_run_events_run_id_idx',
    'CREATE INDEX orchestrator_run_events_run_id_idx ON orchestrator_run_events(run_id)',
  )
  ensureIndex(
    database,
    'orchestrator_run_events_thread_id_idx',
    'CREATE INDEX orchestrator_run_events_thread_id_idx ON orchestrator_run_events(thread_id)',
  )

  ensureTable(
    database,
    'artifacts',
    `CREATE TABLE artifacts (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES orchestrator_runs(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES workspace_tasks(id) ON DELETE SET NULL,
      room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
      task_thread_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
      workspace_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
      worker_instance_id TEXT,
      kind TEXT NOT NULL DEFAULT 'file',
      title TEXT NOT NULL,
      description TEXT,
      source_path TEXT,
      handoff_path TEXT,
      relative_path TEXT,
      storage_provider TEXT NOT NULL DEFAULT 'local-filesystem',
      bucket TEXT NOT NULL DEFAULT 'agenthub-artifacts',
      object_key TEXT,
      storage_path TEXT,
      mime_type TEXT,
      size INTEGER,
      checksum TEXT,
      status TEXT NOT NULL DEFAULT 'registered',
      visibility TEXT NOT NULL DEFAULT 'team',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'artifacts_workspace_id_idx',
    'CREATE INDEX artifacts_workspace_id_idx ON artifacts(workspace_id)',
  )
  ensureIndex(
    database,
    'artifacts_run_id_idx',
    'CREATE INDEX artifacts_run_id_idx ON artifacts(run_id)',
  )
  ensureIndex(
    database,
    'artifacts_task_id_idx',
    'CREATE INDEX artifacts_task_id_idx ON artifacts(task_id)',
  )
  ensureIndex(
    database,
    'artifacts_task_thread_id_idx',
    'CREATE INDEX artifacts_task_thread_id_idx ON artifacts(task_thread_id)',
  )
  ensureColumn(
    database,
    'artifacts',
    'storage_provider',
    "ALTER TABLE artifacts ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local-filesystem'",
  )
  ensureColumn(
    database,
    'artifacts',
    'bucket',
    "ALTER TABLE artifacts ADD COLUMN bucket TEXT NOT NULL DEFAULT 'agenthub-artifacts'",
  )
  ensureColumn(database, 'artifacts', 'object_key', 'ALTER TABLE artifacts ADD COLUMN object_key TEXT')
  ensureColumn(database, 'artifacts', 'storage_path', 'ALTER TABLE artifacts ADD COLUMN storage_path TEXT')
  ensureColumn(
    database,
    'artifacts',
    'room_id',
    'ALTER TABLE artifacts ADD COLUMN room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL',
  )
  ensureIndex(
    database,
    'artifacts_object_key_idx',
    'CREATE INDEX artifacts_object_key_idx ON artifacts(object_key)',
  )
  ensureIndex(
    database,
    'artifacts_room_id_idx',
    'CREATE INDEX artifacts_room_id_idx ON artifacts(room_id)',
  )
  ensureIndex(
    database,
    'artifacts_task_relative_path_unique',
    'CREATE UNIQUE INDEX artifacts_task_relative_path_unique ON artifacts(task_id, relative_path, checksum)',
  )

  ensureTable(
    database,
    'rooms',
    `CREATE TABLE rooms (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL DEFAULT 'matrix',
      provider_room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      run_id TEXT REFERENCES orchestrator_runs(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES workspace_tasks(id) ON DELETE SET NULL,
      task_thread_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      topic TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'rooms_provider_room_id_unique',
    'CREATE UNIQUE INDEX rooms_provider_room_id_unique ON rooms(provider, provider_room_id)',
  )
  ensureIndex(database, 'rooms_owner_id_idx', 'CREATE INDEX rooms_owner_id_idx ON rooms(owner_id)')
  ensureIndex(database, 'rooms_workspace_id_idx', 'CREATE INDEX rooms_workspace_id_idx ON rooms(workspace_id)')
  ensureIndex(database, 'rooms_session_id_idx', 'CREATE INDEX rooms_session_id_idx ON rooms(session_id)')
  ensureIndex(database, 'rooms_run_id_idx', 'CREATE INDEX rooms_run_id_idx ON rooms(run_id)')
  ensureIndex(database, 'rooms_task_thread_id_idx', 'CREATE INDEX rooms_task_thread_id_idx ON rooms(task_thread_id)')
  if (tableExists(database, 'rooms') && hasColumn(database, 'rooms', 'provider')) {
    database.exec("UPDATE rooms SET provider = 'matrix' WHERE provider = 'local-matrix-compatible'")
  }

  ensureTable(
    database,
    'room_participants',
    `CREATE TABLE room_participants (
      id TEXT PRIMARY KEY NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      provider_user_id TEXT,
      participant_type TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      workspace_agent_id TEXT REFERENCES workspace_agents(id) ON DELETE SET NULL,
      worker_instance_id TEXT REFERENCES worker_instances(id) ON DELETE SET NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'joined',
      metadata TEXT NOT NULL DEFAULT '{}',
      joined_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'room_participants_room_id_idx',
    'CREATE INDEX room_participants_room_id_idx ON room_participants(room_id)',
  )
  ensureIndex(
    database,
    'room_participants_user_id_idx',
    'CREATE INDEX room_participants_user_id_idx ON room_participants(user_id)',
  )
  ensureIndex(
    database,
    'room_participants_workspace_agent_id_idx',
    'CREATE INDEX room_participants_workspace_agent_id_idx ON room_participants(workspace_agent_id)',
  )
  ensureIndex(
    database,
    'room_participants_worker_instance_id_idx',
    'CREATE INDEX room_participants_worker_instance_id_idx ON room_participants(worker_instance_id)',
  )

  ensureTable(
    database,
    'timeline_events',
    `CREATE TABLE timeline_events (
      id TEXT PRIMARY KEY NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      provider_event_id TEXT NOT NULL,
      sender_participant_id TEXT REFERENCES room_participants(id) ON DELETE SET NULL,
      sender_type TEXT NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      sequence INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'timeline_events_room_id_idx',
    'CREATE INDEX timeline_events_room_id_idx ON timeline_events(room_id)',
  )
  ensureIndex(
    database,
    'timeline_events_room_sequence_unique',
    'CREATE UNIQUE INDEX timeline_events_room_sequence_unique ON timeline_events(room_id, sequence)',
  )
  ensureIndex(
    database,
    'timeline_events_provider_event_id_unique',
    'CREATE UNIQUE INDEX timeline_events_provider_event_id_unique ON timeline_events(room_id, provider_event_id)',
  )
  ensureIndex(
    database,
    'timeline_events_sender_participant_id_idx',
    'CREATE INDEX timeline_events_sender_participant_id_idx ON timeline_events(sender_participant_id)',
  )

  ensureTable(
    database,
    'matrix_identities',
    `CREATE TABLE matrix_identities (
      id TEXT PRIMARY KEY NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      server_name TEXT NOT NULL,
      localpart TEXT NOT NULL,
      user_id TEXT NOT NULL,
      access_token TEXT,
      password TEXT,
      display_name TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'matrix_identities_owner_unique',
    'CREATE UNIQUE INDEX matrix_identities_owner_unique ON matrix_identities(owner_type, owner_id, server_name)',
  )
  ensureIndex(
    database,
    'matrix_identities_user_id_unique',
    'CREATE UNIQUE INDEX matrix_identities_user_id_unique ON matrix_identities(user_id)',
  )
  ensureIndex(
    database,
    'matrix_identities_localpart_idx',
    'CREATE INDEX matrix_identities_localpart_idx ON matrix_identities(localpart)',
  )

  ensureTable(
    database,
    'controller_audit_events',
    `CREATE TABLE controller_audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      operation_id TEXT NOT NULL,
      apply_operation_id TEXT,
      danger TEXT NOT NULL,
      approval_level TEXT NOT NULL DEFAULT 'not_required',
      approval_required INTEGER NOT NULL DEFAULT 0,
      approval_provided INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT,
      approval_reason TEXT,
      manifest_kind TEXT NOT NULL,
      manifest_name TEXT,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      resource_id TEXT,
      resource_kind TEXT,
      audit_fields TEXT NOT NULL DEFAULT '{}',
      result_summary TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    )`,
  )
  ensureIndex(
    database,
    'controller_audit_events_operation_id_idx',
    'CREATE INDEX controller_audit_events_operation_id_idx ON controller_audit_events(operation_id)',
  )
  ensureIndex(
    database,
    'controller_audit_events_workspace_id_idx',
    'CREATE INDEX controller_audit_events_workspace_id_idx ON controller_audit_events(workspace_id)',
  )
  ensureIndex(
    database,
    'controller_audit_events_resource_idx',
    'CREATE INDEX controller_audit_events_resource_idx ON controller_audit_events(resource_kind, resource_id)',
  )
  ensureIndex(
    database,
    'controller_audit_events_created_at_idx',
    'CREATE INDEX controller_audit_events_created_at_idx ON controller_audit_events(created_at)',
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

function ensureIndex(database: Database, indexName: string, statement: string) {
  const row = database
    .query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('index', indexName)
  if (row) return
  database.exec(statement)
}

function tableExists(database: Database, table: string) {
  const row = database
    .query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', table)
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
