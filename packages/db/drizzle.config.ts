import type { Config } from 'drizzle-kit'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../../..')
const rawUrl = process.env.DATABASE_URL ?? './storage/agenthub.db'
const dbPath = isAbsolute(rawUrl) ? rawUrl : resolve(PROJECT_ROOT, rawUrl)

export default {
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: dbPath },
} satisfies Config
