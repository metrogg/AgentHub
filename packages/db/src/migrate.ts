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
sqlite.close()
migrate(db, { migrationsFolder: migrationsPath })
console.log('Migrations complete.')

function reconcileLegacyMigrationState(database: Database, folder: string) {
  if (!tableExists(database, '__drizzle_migrations')) return

  mark0013IfRuntimePatchAlreadyApplied(database, folder)
  mark0014IfRuntimePatchAlreadyApplied(database, folder)
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
