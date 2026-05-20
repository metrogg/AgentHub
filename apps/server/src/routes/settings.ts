import { Hono } from 'hono'
import { db, settings, eq } from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

export const settingsRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const rows = await db.select().from(settings)
    const map: Record<string, string> = {}
    for (const r of rows) map[r.key] = r.value
    return c.json(map)
  })
  .post('/', async (c) => {
    const body = await c.req.json<Record<string, string>>()
    for (const [key, value] of Object.entries(body)) {
      const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
      if (existing.length > 0) {
        await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key))
      } else {
        await db.insert(settings).values({ key, value })
      }
    }
    return c.json({ success: true })
  })
  .post('/test-model', async (c) => {
    const input = await c.req.json<{
      provider?: string
      apiEndpoint?: string
      anthropicEndpoint?: string
      apiKey?: string
      apiKeyEnv?: string
    }>()

    const provider = input.provider?.trim() || 'openai'
    const endpoint = (provider === 'anthropic' ? input.apiEndpoint : input.apiEndpoint)?.trim()
    const apiKey = input.apiKey?.trim() || (input.apiKeyEnv ? Bun.env[input.apiKeyEnv] : undefined)

    if (!endpoint) {
      return c.json({ ok: false, message: 'API 端点不能为空' }, 400)
    }
    if (!apiKey) {
      return c.json({ ok: false, message: '未找到 API Key，请填写或配置环境变量' }, 400)
    }

    const normalized = endpoint.replace(/\/$/, '')
    const isAnthropic = provider === 'anthropic' || normalized.includes('anthropic.com')
    const url = isAnthropic ? `${normalized}/v1/models` : `${normalized}/models`
    const headers: Record<string, string> = isAnthropic
      ? {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        }
      : {
          Authorization: `Bearer ${apiKey}`,
        }

    try {
      const res = await fetch(url, { headers })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return c.json(
          {
            ok: false,
            status: res.status,
            message: text.slice(0, 240) || `连接失败：HTTP ${res.status}`,
          },
          200
        )
      }

      return c.json({ ok: true, status: res.status, message: '连接成功' })
    } catch (error: any) {
      return c.json({ ok: false, message: error?.message || '连接失败' }, 200)
    }
  })
