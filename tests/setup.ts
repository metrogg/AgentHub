import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'agenthub-test-'))
const databaseUrl = join(tempDir, 'agenthub-test.db')
process.env.DATABASE_URL = databaseUrl
Bun.env.DATABASE_URL = databaseUrl
process.env.AGENTHUB_TEST_DATABASE_URL_LOCKED = '1'
Bun.env.AGENTHUB_TEST_DATABASE_URL_LOCKED = '1'
process.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'
Bun.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'
process.env.LLM_API_KEY = 'test-key'
Bun.env.LLM_API_KEY = 'test-key'
process.env.OPENAI_API_KEY = ''
Bun.env.OPENAI_API_KEY = ''
process.env.ANTHROPIC_API_KEY = ''
Bun.env.ANTHROPIC_API_KEY = ''
process.env.ENABLE_LOCAL_CLI_PROBES = 'false'
Bun.env.ENABLE_LOCAL_CLI_PROBES = 'false'
process.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'
Bun.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'
