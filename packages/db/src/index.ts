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
