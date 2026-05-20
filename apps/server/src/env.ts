import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8000),
  DATABASE_URL: z.string().default('./storage/agenthub.db'),
  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-in-production-please'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(['debug', 'info', 'warn', 'error']))
    .default('info'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  MASTRA_REFERENCE_ROOT: z.string().default('F:\\Learning\\mastra\\mastra-main'),
  AGENTHUB_WORKSPACE_ROOT: z.string().default('F:\\Learning\\AgentHub'),
})

export const env = envSchema.parse(Bun.env)
export type Env = z.infer<typeof envSchema>
