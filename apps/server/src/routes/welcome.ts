import { Hono } from 'hono'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { logger } from '../lib/logger'
import { streamReply } from '../services/llm'

interface QuickPromptItem {
  id: string
  label: string
  prompt: string
}

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

    const result = await generateQuickPrompts(seed, count)

    return c.json({
      generatedAt: new Date().toISOString(),
      items: result.items,
      seed,
      source: result.source,
      error: result.error,
    })
  })

async function generateQuickPrompts(seed: string, count: number): Promise<{
  items: QuickPromptItem[]
  source: 'llm' | 'unavailable'
  error?: string
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45_000)
  try {
    const system = [
      '你是 AgentHub 欢迎页的动态提示词生成器。',
      '根据当前时间、开发者可能的工作场景和多 Coding Agent 协作产品定位，生成一组可点击的中文快速对话建议。',
      '只返回严格 JSON，不要 Markdown，不要解释。',
      '每条必须适合直接发给 AgentHub，避免固定模板感，不要复用一套预置列表。',
      '返回结构：{"items":[{"label":"不超过12个中文字","prompt":"用户可直接发送的一句话任务"}]}',
    ].join('\n')
    const prompt = JSON.stringify({
      seed,
      count,
      language: 'zh-CN',
      product: 'AgentHub IM 式多 Coding Agent 协作平台',
      constraints: [
        '内容必须由本次模型动态生成',
        '不要生成营销口号',
        '优先覆盖代码实现、调研报告、文档/PDF/HTML 产物、多 Agent 协作、项目诊断等场景',
      ],
    })

    let output = ''
    for await (const delta of streamReply([{ role: 'user', content: prompt }], system, undefined, controller.signal)) {
      output += delta
      if (output.length > 10_000) break
    }

    const jsonText = extractJsonObject(output)
    if (!jsonText) throw new Error('模型未返回可解析 JSON')
    const parsed = JSON.parse(jsonText) as { items?: Array<{ label?: unknown; prompt?: unknown }> }
    const items = normalizePromptItems(parsed.items, count)
    if (!items.length) throw new Error('模型返回的快速提示为空')
    return { items, source: 'llm' }
  } catch (error: any) {
    const message = error?.name === 'AbortError'
      ? '快速提示模型生成超时'
      : error?.message || '快速提示模型生成失败'
    logger.warn({ err: message }, 'Dynamic quick prompts unavailable')
    return { items: [], source: 'unavailable', error: message }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizePromptItems(
  value: Array<{ label?: unknown; prompt?: unknown }> | undefined,
  count: number,
): QuickPromptItem[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const items: QuickPromptItem[] = []
  for (const item of value) {
    const label = typeof item.label === 'string' ? item.label.trim().slice(0, 24) : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim().slice(0, 500) : ''
    if (!label || !prompt || seen.has(prompt)) continue
    seen.add(prompt)
    items.push({ id: `llm-${items.length + 1}`, label, prompt })
    if (items.length >= count) break
  }
  return items
}

function extractJsonObject(value: string) {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}
