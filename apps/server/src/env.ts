import { z } from 'zod'

const envBoolean = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  return value
}, z.boolean())

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8000),
  DATABASE_URL: z.string().default('./storage/agenthub.db'),
  AGENTHUB_APP_DATA_DIR: z.string().optional(),
  AGENTHUB_CONFIG_DIR: z.string().optional(),
  AGENTHUB_LOG_DIR: z.string().optional(),
  AGENTHUB_WEB_DIST: z.string().optional(),
  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-in-production-please'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(['debug', 'info', 'warn', 'error']))
    .default('info'),
  LLM_PROVIDER: z.string().default('openai'),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  ENABLE_LOCAL_CLI_PROBES: envBoolean.default(true),
  ENABLE_CODEX_CHATGPT_AUTH: envBoolean.default(true),
  SYNC_CODEX_CLI_AUTH: envBoolean.default(true),
  CODEX_HOME: z.string().optional(),
  MASTRA_REFERENCE_ROOT: z.string().default('.'),
  AGENTHUB_WORKSPACE_ROOT: z.string().default('.'),
  AGENTHUB_SKILLS_ROOT: z.string().optional(),
  AGENTHUB_NATIVE_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(12).default(6),
  AGENTHUB_ENABLE_CODE_AGENT_EXECUTION: envBoolean.default(true),
  AGENTHUB_CODE_AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  AGENTHUB_CODE_AGENT_OUTPUT_LIMIT: z.coerce.number().int().positive().default(100_000),
})

export const env = envSchema.parse(Bun.env)
export type Env = z.infer<typeof envSchema>
