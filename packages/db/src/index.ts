import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema'

export * from './schema'
export { eq, and, or, desc, asc, sql } from 'drizzle-orm'

// 锚定到项目根：packages/db/src -> ../../..
const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..')

const rawUrl = process.env.DATABASE_URL ?? './storage/agenthub.db'
const dbPath = isAbsolute(rawUrl) ? rawUrl : resolve(PROJECT_ROOT, rawUrl)

mkdirSync(dirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')

export const db = drizzle(sqlite, { schema })
export type DB = typeof db
