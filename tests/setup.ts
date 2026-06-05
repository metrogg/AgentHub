import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const testDataDir = mkdtempSync(join(tmpdir(), 'agenthub-test-'))
const databaseUrl = join(testDataDir, 'agenthub-test.db')

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = databaseUrl
process.env.AGENTHUB_TEST_DATABASE_URL_LOCKED = '1'
process.env.AGENTHUB_TEST_PRELOADED = '1'
process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key'
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
process.env.ENABLE_LOCAL_CLI_PROBES = 'false'
process.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'
process.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'
process.env.AGENTHUB_ROOM_PROVIDER = 'matrix'
process.env.AGENTHUB_TEST_ROOM_ADAPTER = '1'

Bun.env.DATABASE_URL = process.env.DATABASE_URL
Bun.env.NODE_ENV = 'test'
Bun.env.AGENTHUB_TEST_DATABASE_URL_LOCKED = '1'
Bun.env.AGENTHUB_TEST_PRELOADED = '1'
Bun.env.LLM_API_KEY = process.env.LLM_API_KEY
Bun.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY
Bun.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
Bun.env.ENABLE_LOCAL_CLI_PROBES = 'false'
Bun.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'
Bun.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'
Bun.env.AGENTHUB_ROOM_PROVIDER = 'matrix'
Bun.env.AGENTHUB_TEST_ROOM_ADAPTER = '1'

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

export async function waitForCondition<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  options: {
    timeoutMs?: number
    intervalMs?: number
    description?: string
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const intervalMs = options.intervalMs ?? 25
  const startedAt = Date.now()
  let lastValue: T
  let lastError: unknown

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await read()
      if (predicate(lastValue)) return lastValue
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  const detail = lastError
    ? ` Last error: ${(lastError as Error)?.message ?? String(lastError)}`
    : ` Last value: ${JSON.stringify(lastValue!)}`
  throw new Error(`Timed out waiting for condition${options.description ? `: ${options.description}` : ''}.${detail}`)
}
