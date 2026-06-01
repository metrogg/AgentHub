import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const testDataDir = mkdtempSync(join(tmpdir(), 'agenthub-test-'))
const databaseUrl = process.env.DATABASE_URL?.trim() || join(testDataDir, 'agenthub-test.db')

process.env.DATABASE_URL = databaseUrl
process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key'
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
process.env.ENABLE_LOCAL_CLI_PROBES = 'false'
process.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'
process.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'
process.env.AGENTHUB_TEST_PRELOADED = '1'

Bun.env.DATABASE_URL = process.env.DATABASE_URL
Bun.env.LLM_API_KEY = process.env.LLM_API_KEY
Bun.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY
Bun.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
Bun.env.ENABLE_LOCAL_CLI_PROBES = 'false'
Bun.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'
Bun.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'
Bun.env.AGENTHUB_TEST_PRELOADED = '1'

const dbApi = await import('../packages/db/src/index')
migrate(dbApi.db, { migrationsFolder: resolve('packages/db/drizzle') })
await dbApi.db
  .insert(dbApi.users)
  .values({
    id: 'default-user',
    email: 'local@agenthub.local',
    username: 'You',
    passwordHash: 'test-only',
  })
  .onConflictDoNothing()
