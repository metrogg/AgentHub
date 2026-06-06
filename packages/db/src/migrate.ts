import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'

const { db, migrationsPath, databasePath } = await import('./index')

console.log('Running migrations...')
const sqlite = new Database(databasePath)
reconcileLegacyMigrationState(sqlite, migrationsPath)
reconcileCurrentMigrationState(sqlite, migrationsPath)
sqlite.close()
migrate(db, { migrationsFolder: migrationsPath })
console.log('Migrations complete.')

function reconcileLegacyMigrationState(database: Database, folder: string) {
  if (!tableExists(database, '__drizzle_migrations')) return

  mark0013IfRuntimePatchAlreadyApplied(database, folder)
  mark0014IfRuntimePatchAlreadyApplied(database, folder)
}

function reconcileCurrentMigrationState(database: Database, folder: string) {
  if (!tableExists(database, '__drizzle_migrations')) return

  mark0018IfRuntimePatchAlreadyApplied(database, folder)
  mark0019IfRuntimePatchAlreadyApplied(database, folder)
  mark0020IfRuntimePatchAlreadyApplied(database, folder)
  mark0021IfRuntimePatchAlreadyApplied(database, folder)
  mark0022IfRuntimePatchAlreadyApplied(database, folder)
  mark0023IfRuntimePatchAlreadyApplied(database, folder)
  mark0024IfRuntimePatchAlreadyApplied(database, folder)
  mark0025IfRuntimePatchAlreadyApplied(database, folder)
}

function mark0013IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0013_cleanup_legacy_schema.sql'
  if (migrationApplied(database, folder, file)) return
  if (!hasColumn(database, 'session_members', 'joined_at')) return

  if (hasColumn(database, 'workspace_tasks', 'attempt_count') && hasColumn(database, 'workspace_tasks', 'retry_count')) {
    database.exec(
      'UPDATE workspace_tasks SET retry_count = COALESCE(attempt_count, 0) WHERE attempt_count IS NOT NULL AND retry_count = 0',
    )
  }
  if (hasColumn(database, 'workspace_tasks', 'max_retries')) {
    database.exec('UPDATE workspace_tasks SET max_retries = 3 WHERE max_retries = 2')
  }
  recordMigration(database, folder, file, 1729843200006)
}

function mark0014IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0014_task_clarifications_and_controls.sql'
  if (migrationApplied(database, folder, file)) return
  const columnsExist =
    hasColumn(database, 'workspace_tasks', 'progress_percent') &&
    hasColumn(database, 'workspace_tasks', 'progress_status') &&
    hasColumn(database, 'workspace_tasks', 'clarification_count')
  const tablesExist = tableExists(database, 'task_clarifications') && tableExists(database, 'orchestrator_run_controls')
  if (!columnsExist || !tablesExist) return

  recordMigration(database, folder, file, 1780065211703)
}

function mark0018IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0018_agent_skill_ids.sql'
  if (migrationApplied(database, folder, file)) return
  if (!hasColumn(database, 'workspace_agents', 'skill_ids')) return
  recordMigration(database, folder, file, 1780300000000)
}

function mark0019IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0019_task_threads_and_run_event_replay.sql'
  if (migrationApplied(database, folder, file)) return
  const taskThreadsReady =
    tableExists(database, 'task_threads') &&
    hasColumn(database, 'task_threads', 'workspace_id') &&
    hasColumn(database, 'task_threads', 'run_id') &&
    hasColumn(database, 'task_threads', 'task_id') &&
    hasColumn(database, 'task_threads', 'group_session_id') &&
    hasColumn(database, 'task_threads', 'session_id') &&
    hasColumn(database, 'task_threads', 'status') &&
    hasColumn(database, 'task_threads', 'created_at') &&
    hasColumn(database, 'task_threads', 'updated_at')
  const runEventsReady =
    hasColumn(database, 'orchestrator_run_events', 'thread_id') &&
    hasColumn(database, 'orchestrator_run_events', 'worker_instance_id') &&
    hasColumn(database, 'orchestrator_run_events', 'sequence')
  if (!taskThreadsReady || !runEventsReady) return
  recordMigration(database, folder, file, 1780390000000)
}

function mark0020IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0020_artifact_store.sql'
  if (migrationApplied(database, folder, file)) return
  const artifactsReady =
    tableExists(database, 'artifacts') &&
    hasColumn(database, 'artifacts', 'storage_provider') &&
    hasColumn(database, 'artifacts', 'bucket') &&
    hasColumn(database, 'artifacts', 'object_key') &&
    hasColumn(database, 'artifacts', 'storage_path') &&
    hasColumn(database, 'artifacts', 'room_id')
  if (!artifactsReady) return
  recordMigration(database, folder, file, 1780470000000)
}

function mark0021IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0021_worker_runtime_resources.sql'
  if (migrationApplied(database, folder, file)) return
  const ready = tableExists(database, 'worker_instances') && tableExists(database, 'runtime_leases')
  if (!ready) return
  recordMigration(database, folder, file, 1780550000000)
}

function mark0022IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0022_runtime_leases_backfill.sql'
  if (migrationApplied(database, folder, file)) return
  if (!tableExists(database, 'runtime_leases')) return
  recordMigration(database, folder, file, 1780630000000)
}

function mark0023IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0023_rooms_timeline.sql'
  if (migrationApplied(database, folder, file)) return
  const ready =
    tableExists(database, 'rooms') &&
    tableExists(database, 'room_participants') &&
    tableExists(database, 'timeline_events')
  if (!ready) return
  recordMigration(database, folder, file, 1780710000000)
}

function mark0024IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0024_artifact_object_storage.sql'
  if (migrationApplied(database, folder, file)) return
  const ready =
    tableExists(database, 'artifacts') &&
    hasColumn(database, 'artifacts', 'storage_provider') &&
    hasColumn(database, 'artifacts', 'bucket') &&
    hasColumn(database, 'artifacts', 'object_key') &&
    hasColumn(database, 'artifacts', 'storage_path') &&
    hasColumn(database, 'artifacts', 'room_id')
  if (!ready) return
  recordMigration(database, folder, file, 1780790000000)
}

function mark0025IfRuntimePatchAlreadyApplied(database: Database, folder: string) {
  const file = '0025_matrix_identities.sql'
  if (migrationApplied(database, folder, file)) return
  if (!tableExists(database, 'matrix_identities')) return
  recordMigration(database, folder, file, 1780870000000)
}

function migrationApplied(database: Database, folder: string, file: string) {
  const hash = migrationHash(folder, file)
  const row = database.query('SELECT hash FROM __drizzle_migrations WHERE hash = ?').get(hash)
  return Boolean(row)
}

function recordMigration(database: Database, folder: string, file: string, createdAt: number) {
  const hash = migrationHash(folder, file)
  database
    .query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(hash, createdAt)
  console.log(`Marked legacy-patched migration as applied: ${file}`)
}

function migrationHash(folder: string, file: string) {
  return createHash('sha256').update(readFileSync(join(folder, file), 'utf8')).digest('hex')
}

function hasColumn(database: Database, table: string, column: string) {
  if (!tableExists(database, table)) return false
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return columns.some((item) => item.name === column)
}

function tableExists(database: Database, table: string) {
  return Boolean(
    database
      .query('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', table),
  )
}
