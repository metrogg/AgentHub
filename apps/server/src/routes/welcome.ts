import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { QUICK_PROMPT_POOL, type QuickPromptItem } from '../data/quick-prompts-pool'

export const welcomeRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .post('/quick-prompts', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const seed = typeof body.seed === 'string' && body.seed.trim()
      ? body.seed.trim().slice(0, 80)
      : Date.now().toString(36)
    const requestedCount = typeof body.count === 'number' && Number.isFinite(body.count)
      ? body.count
      : 10
    const count = Math.min(12, Math.max(6, Math.floor(requestedCount)))

    const items = seededShuffle(QUICK_PROMPT_POOL, seed).slice(0, count)

    return c.json({
      generatedAt: new Date().toISOString(),
      items,
      seed,
      source: 'preset' as const,
    })
  })

function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const copy = [...items]
  let state = stableHash(seed)
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const target = state % (index + 1)
    const tmp = copy[index]!
    copy[index] = copy[target]!
    copy[target] = tmp
  }
  return copy
}

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
