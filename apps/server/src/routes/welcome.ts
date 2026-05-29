import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { logger } from '../lib/logger'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { streamReply } from '../services/llm'

interface QuickPromptItem {
  id: string
  label: string
  prompt: string
}

const QUICK_PROMPT_COUNT = 10
const QUICK_PROMPT_SYSTEM = [
  '你是 AgentHub 桌面端欢迎页的快速对话生成器。',
  '你的任务是生成一组可点击的短问题气泡，让用户能立刻开始一次有价值的对话。',
  '必须只输出 JSON，不要输出 Markdown、解释、编号、代码块或多余文本。',
].join('\n')

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
    let source: 'llm' | 'fallback' = 'llm'
    let items: QuickPromptItem[] = []

    try {
      items = await generateQuickPrompts(seed, count)
    } catch (error: any) {
      source = 'fallback'
      logger.warn({ err: error?.message || String(error) }, 'Failed to generate welcome quick prompts')
    }

    if (items.length < 6) {
      source = 'fallback'
      items = fallbackQuickPrompts(seed, count)
    }

    return c.json({
      generatedAt: new Date().toISOString(),
      items,
      seed,
      source,
    })
  })

async function generateQuickPrompts(seed: string, count: number): Promise<QuickPromptItem[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('快速对话生成超时')), 14_000)
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
    '- 主题必须多样：至少 2 个代码/项目问题，2 个学习/解释问题，2 个效率/办公问题，1 个 AI/技术趋势问题，1 个轻松创意问题。',
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

function fallbackQuickPrompts(seed: string, count: number): QuickPromptItem[] {
  const pool = [
    ['帮我拆解一个小工具需求', '帮我把一个小工具需求拆成可执行的开发步骤，并指出风险点。'],
    ['这个项目适合怎么重构', '请从架构、状态管理和测试三个角度，分析一个项目适合怎样重构。'],
    ['解释一下前端构建流程', '用通俗语言解释前端从源码到上线的构建流程。'],
    ['给我一个学习路线', '请根据我的目标生成一份 7 天学习路线，并每天给一个练习。'],
    ['帮我整理会议纪要', '给我一个清晰的会议纪要模板，包含待办、负责人和截止时间。'],
    ['写一封更自然的邮件', '帮我把一封工作邮件改得更自然、礼貌、简洁。'],
    ['最近 AI 开发该关注什么', '不依赖实时新闻，概括最近 AI 开发者值得关注的长期趋势。'],
    ['设计一个轻量小游戏', '帮我设计一个 10 分钟能开局的轻量小游戏玩法。'],
    ['帮我写代码审查清单', '给我一份适合日常项目的代码审查清单，按优先级排列。'],
    ['如何排查接口 500', '请给我一套排查接口 500 错误的步骤，从日志到数据库逐层检查。'],
    ['把想法变成任务卡', '把一个模糊想法整理成任务卡，包含目标、范围、验收标准。'],
    ['解释一个复杂概念', '请用类比、例子和一句话总结，解释一个复杂技术概念。'],
  ] as const
  return seededShuffle(pool, seed)
    .slice(0, count)
    .map(([label, prompt]) => ({
      id: `fallback-${stableHash(`${seed}:${label}`)}`,
      label,
      prompt,
    }))
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
