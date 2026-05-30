import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { logger } from '../lib/logger'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { streamReply } from '../services/llm'
import { env } from '../env'

interface QuickPromptItem {
  id: string
  label: string
  prompt: string
}

const QUICK_PROMPT_COUNT = 10
const QUICK_PROMPT_TIMEOUT_MS = 45_000
const QUICK_PROMPT_CACHE_TTL_MS = 120_000
const QUICK_PROMPT_SYSTEM = [
  '你是 AgentHub 桌面端欢迎页的快速对话生成器。',
  '你的任务是生成一组可点击的短问题气泡，让用户能立刻开始一次有价值的对话。',
  '必须只输出 JSON，不要输出 Markdown、解释、编号、代码块或多余文本。',
].join('\n')

const quickPromptCache = new Map<
  string,
  { expiresAt: number; generatedAt: string; items: QuickPromptItem[]; seed: string }
>()
const quickPromptInflight = new Map<
  string,
  Promise<{ generatedAt: string; items: QuickPromptItem[]; seed: string }>
>()

export const welcomeRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .post('/quick-prompts', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const seed = typeof body.seed === 'string' && body.seed.trim()
      ? body.seed.trim().slice(0, 80)
      : randomUUID()
    const requestedCount = typeof body.count === 'number' && Number.isFinite(body.count)
      ? body.count
      : QUICK_PROMPT_COUNT
    const count = Math.min(12, Math.max(6, Math.floor(requestedCount)))
    let source: 'llm' | 'unavailable' = 'unavailable'
    let items: QuickPromptItem[] = []
    let generatedAt = new Date().toISOString()

    if (env.AGENTHUB_ENABLE_DYNAMIC_QUICK_PROMPTS) {
      try {
        const generated = await getDynamicQuickPrompts(seed, count)
        source = 'llm'
        items = generated.items
        generatedAt = generated.generatedAt
      } catch (error: any) {
        logger.warn(
          { err: error?.message || String(error) },
          'Dynamic welcome quick prompts unavailable',
        )
      }
    }

    return c.json({
      generatedAt,
      items,
      seed,
      source,
    })
  })

async function getDynamicQuickPrompts(seed: string, count: number) {
  const cacheKey = `count:${count}`
  const cached = quickPromptCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return {
      generatedAt: cached.generatedAt,
      items: seededShuffle(cached.items, `${seed}:cached-order`).slice(0, count),
      seed,
    }
  }

  const existing = quickPromptInflight.get(cacheKey)
  if (existing) {
    const result = await existing
    return {
      generatedAt: result.generatedAt,
      items: seededShuffle(result.items, `${seed}:inflight-order`).slice(0, count),
      seed,
    }
  }

  const pending = (async () => {
    const generatedAt = new Date().toISOString()
    const items = seededShuffle(
      await generateQuickPrompts(seed, count),
      `${seed}:generated-order`,
    ).slice(0, count)
    if (items.length < 6) {
      throw new Error('模型没有返回足够的快速对话问题')
    }
    quickPromptCache.set(cacheKey, {
      expiresAt: Date.now() + QUICK_PROMPT_CACHE_TTL_MS,
      generatedAt,
      items,
      seed,
    })
    return { generatedAt, items, seed }
  })()

  quickPromptInflight.set(cacheKey, pending)
  try {
    return await pending
  } finally {
    quickPromptInflight.delete(cacheKey)
  }
}

async function generateQuickPrompts(seed: string, count: number): Promise<QuickPromptItem[]> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error(`快速对话生成超时（${QUICK_PROMPT_TIMEOUT_MS / 1000}秒）`)),
    QUICK_PROMPT_TIMEOUT_MS,
  )
  let text = ''

  try {
    for await (const chunk of streamReply(
      [
        {
          role: 'user',
          content: buildQuickPromptInstruction(seed, count),
        },
      ],
      QUICK_PROMPT_SYSTEM,
      undefined,
      controller.signal,
    )) {
      text += chunk
    }
  } finally {
    clearTimeout(timeout)
  }

  return parseQuickPromptItems(text, seed, count)
}

function buildQuickPromptInstruction(seed: string, count: number) {
  return [
    `请生成 ${count} 个简体中文快速对话问题。`,
    `变化种子：${seed}`,
    `生成时间：${new Date().toISOString()}`,
    '',
    '输出限制：',
    '- 只返回一个 JSON 对象，格式为 {"items":[{"label":"...","prompt":"..."}]}。',
    '- items 数量必须刚好等于请求数量。',
    '- label 是气泡上展示的短问题，8-32 个汉字左右，可以混入少量英文技术名词，不要 emoji，不要引号，不要编号。',
    '- prompt 是点击后发送给模型的完整用户问题，12-90 个汉字左右，必须能独立触发一次对话。',
    '- 主题必须由你动态构思，覆盖代码/项目、学习/解释、效率/办公、AI/技术趋势、轻松创意等不同类型。',
    '- 不要编造实时新闻、价格、赛事、政策等需要联网核验的信息。',
    '- 每次生成都要参考变化种子，避免固定模板、避免重复上一次常见示例。',
  ].join('\n')
}

function parseQuickPromptItems(text: string, seed: string, count: number): QuickPromptItem[] {
  const jsonText = extractJsonObject(text)
  if (!jsonText) return []
  const parsed = JSON.parse(jsonText)
  const rawItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
  const seen = new Set<string>()
  const items: QuickPromptItem[] = []

  for (const raw of rawItems) {
    const label = normalizePromptText(raw?.label ?? raw?.text ?? raw?.question)
    const prompt = normalizePromptText(raw?.prompt ?? raw?.message ?? label)
    if (!label || !prompt || seen.has(label)) continue
    seen.add(label)
    items.push({
      id: `quick-${stableHash(`${seed}:${label}`)}`,
      label: clampText(label, 36),
      prompt: clampText(prompt, 96),
    })
    if (items.length >= count) break
  }

  return items
}

function extractJsonObject(text: string) {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return ''
  return trimmed.slice(start, end + 1)
}

function normalizePromptText(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
}

function clampText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function seededShuffle<T>(items: readonly T[], seed: string) {
  const copy = [...items]
  let state = stableHash(seed)
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
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
