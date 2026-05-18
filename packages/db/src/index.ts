import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema'

export * from './schema'
export { eq, and, or, desc, asc, sql } from 'drizzle-orm'

const dbUrl = process.env.DATABASE_URL ?? './storage/agenthub.db'

mkdirSync(dirname(dbUrl), { recursive: true })

const sqlite = new Database(dbUrl, { create: true })
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA foreign_keys = ON;')

export const db = drizzle(sqlite, { schema })
export type DB = typeof db
