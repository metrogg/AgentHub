import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from '../env'

export interface SkillhubSearchItem {
  slug: string
  title: string
  description: string
  version?: string
  source: string
  remoteSource?: string
  category?: string
  tags?: string[]
  ownerName?: string
  downloads?: number
  installs?: number
  stars?: number
  updatedAt?: number
}

export interface SkillhubSearchResult {
  ok: boolean
  items: SkillhubSearchItem[]
  message: string
  indexedCount?: number
}

interface SkillhubIndex {
  items: SkillhubSearchItem[]
  updatedAt: number
  seeds: string[]
}

interface SkillhubCachePayload extends SkillhubIndex {
  version: 1
}

interface SkillhubCatalogOptions {
  cacheFilePath?: string | null
  cacheTtlMs?: number
  concurrency?: number
  fetchImpl?: typeof fetch
  initialSeeds?: string[]
  maxQueries?: number
  requestTimeoutMs?: number
  searchLimit?: number
  timeBudgetMs?: number
}

const serviceDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(serviceDir, '../../../..')
const defaultCacheFilePath = env.AGENTHUB_APP_DATA_DIR
  ? resolve(env.AGENTHUB_APP_DATA_DIR, 'cache', 'skillhub-index.json')
  : resolve(projectRoot, 'storage', 'cache', 'skillhub-index.json')

const DEFAULT_SEARCH_LIMIT = 80
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_INDEX_TIME_BUDGET_MS = 30_000
const DEFAULT_MAX_QUERIES = 260
const DEFAULT_CONCURRENCY = 8

const alphaNumericSeeds = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
const defaultInitialSeeds = [
  '*',
  '',
  ...alphaNumericSeeds,
  'skill',
  'tools',
  'agent',
  'mcp',
  'browser',
  'search',
  'web',
  'github',
  'git',
  'python',
  'typescript',
  'react',
  'database',
  'sql',
  'doc',
  'word',
  'pdf',
  'ppt',
  'excel',
  'image',
  'video',
  'audio',
  'office',
  'writing',
  'research',
  'analysis',
  'data',
  'design',
  'translate',
  'test',
  'automation',
  'security',
  'productivity',
  'content',
  'finance',
  'knowledge',
  'memory',
  'notes',
  'email',
  'calendar',
  'notion',
  'obsidian',
  'figma',
  'diagram',
  'chart',
  'crawler',
  'scrape',
  '文档',
  '表格',
  '演示',
  '图片',
  '视频',
  '音频',
  '搜索',
  '网页',
  '浏览器',
  '研究',
  '写作',
  '翻译',
  '数据',
  '分析',
  '设计',
  '办公',
  '金融',
  '知识',
  '笔记',
  '代码',
  '测试',
  '安全',
  '自动化',
]

const seedStopWords = new Set([
  'and',
  'are',
  'can',
  'for',
  'from',
  'into',
  'that',
  'the',
  'this',
  'use',
  'user',
  'using',
  'when',
  'with',
  'your',
])

export class SkillhubCatalogService {
  private readonly cacheFilePath: string | null
  private readonly cacheTtlMs: number
  private readonly concurrency: number
  private readonly fetchImpl: typeof fetch
  private readonly initialSeeds: string[]
  private readonly maxQueries: number
  private readonly requestTimeoutMs: number
  private readonly searchLimit: number
  private readonly timeBudgetMs: number
  private index: SkillhubIndex | null = null
  private indexPromise: Promise<SkillhubIndex> | null = null

  constructor(options: SkillhubCatalogOptions = {}) {
    this.cacheFilePath = options.cacheFilePath === undefined ? defaultCacheFilePath : options.cacheFilePath
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 12))
    this.fetchImpl = options.fetchImpl ?? fetch
    this.initialSeeds = dedupeSeeds(options.initialSeeds ?? defaultInitialSeeds)
    this.maxQueries = Math.max(1, options.maxQueries ?? DEFAULT_MAX_QUERIES)
    this.requestTimeoutMs = Math.max(1000, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    this.searchLimit = Math.max(1, Math.min(options.searchLimit ?? DEFAULT_SEARCH_LIMIT, 120))
    this.timeBudgetMs = Math.max(1000, options.timeBudgetMs ?? DEFAULT_INDEX_TIME_BUDGET_MS)
  }

  async search(q: string, options: { limit?: number } = {}): Promise<SkillhubSearchResult> {
    const query = q.trim()
    const limit = Math.max(1, Math.min(options.limit ?? this.searchLimit, 120))
    let remoteError = ''
    const remoteItems = await this.searchRemote(query || '*', 100).catch((error) => {
      remoteError = error instanceof Error ? error.message : String(error)
      return [] as SkillhubSearchItem[]
    })

    if (isBroadQuery(query)) {
      const cached = await this.loadCachedIndex().catch(() => null)
      this.warmIndex()
      const items = rankAndDedupeSkillhubItems([...remoteItems, ...(cached?.items ?? [])], query).slice(0, limit)
      if (!items.length && remoteError) {
        return { ok: false, items: [], message: remoteError }
      }
      return {
        ok: true,
        items,
        indexedCount: cached?.items.length,
        message: cached?.items.length
          ? `SkillHub 搜索完成：${items.length} 个结果，索引 ${cached.items.length} 个技能`
          : `SkillHub 搜索完成：${items.length} 个结果`,
      }
    }

    let index: SkillhubIndex | null = null
    let indexError = ''
    try {
      index = await this.getIndex()
    } catch (error) {
      indexError = error instanceof Error ? error.message : String(error)
    }

    const indexedItems = index ? searchIndexedSkillhubItems(index.items, query) : []
    const items = rankAndDedupeSkillhubItems([...remoteItems, ...indexedItems], query).slice(0, limit)
    if (!items.length && remoteError && indexError) {
      return { ok: false, items: [], message: `${remoteError}; ${indexError}` }
    }
    return {
      ok: true,
      items,
      indexedCount: index?.items.length,
      message: index?.items.length
        ? `SkillHub 搜索完成：${items.length} 个结果，索引 ${index.items.length} 个技能`
        : `SkillHub 搜索完成：${items.length} 个结果`,
    }
  }

  warmIndex() {
    void this.getIndex().catch(() => undefined)
  }

  private async getIndex(): Promise<SkillhubIndex> {
    const cached = await this.loadCachedIndex()
    if (cached?.items.length) {
      if (Date.now() - cached.updatedAt > this.cacheTtlMs) this.warmRebuild()
      return cached
    }
    return this.buildOrJoinIndex()
  }

  private warmRebuild() {
    void this.buildOrJoinIndex().catch(() => undefined)
  }

  private buildOrJoinIndex() {
    if (!this.indexPromise) {
      this.indexPromise = this.buildIndex().finally(() => {
        this.indexPromise = null
      })
    }
    return this.indexPromise
  }

  private async loadCachedIndex(): Promise<SkillhubIndex | null> {
    if (this.index?.items.length) return this.index
    if (!this.cacheFilePath || !existsSync(this.cacheFilePath)) return null
    const raw = await readFile(this.cacheFilePath, 'utf8')
    const payload = JSON.parse(raw) as Partial<SkillhubCachePayload>
    if (payload.version !== 1 || !Array.isArray(payload.items)) return null
    const items = payload.items.map(normalizeSkillhubItem).filter((item): item is SkillhubSearchItem => Boolean(item))
    if (!items.length) return null
    this.index = {
      items: dedupeSkillhubItems(items),
      updatedAt: typeof payload.updatedAt === 'number' ? payload.updatedAt : 0,
      seeds: Array.isArray(payload.seeds) ? payload.seeds.filter((seed): seed is string => typeof seed === 'string') : [],
    }
    return this.index
  }

  private async buildIndex(): Promise<SkillhubIndex> {
    const itemMap = new Map<string, SkillhubSearchItem>()
    const queried = new Set<string>()
    const queued = new Set<string>()
    const queue: string[] = []
    const startedAt = Date.now()

    const enqueue = (seed: string) => {
      const normalized = normalizeSeed(seed)
      if (normalized === null || queried.has(normalized) || queued.has(normalized)) return
      queued.add(normalized)
      queue.push(normalized)
    }

    for (const seed of this.initialSeeds) enqueue(seed)

    while (queue.length && queried.size < this.maxQueries && Date.now() - startedAt < this.timeBudgetMs) {
      const batch: string[] = []
      while (queue.length && batch.length < this.concurrency && queried.size + batch.length < this.maxQueries) {
        const seed = queue.shift()!
        queued.delete(seed)
        if (queried.has(seed)) continue
        queried.add(seed)
        batch.push(seed)
      }
      if (!batch.length) break

      const settled = await Promise.allSettled(batch.map((seed) => this.searchRemote(seed, 100)))
      for (const result of settled) {
        if (result.status !== 'fulfilled') continue
        const added: SkillhubSearchItem[] = []
        for (const item of result.value) {
          const next = mergeSkillhubItem(itemMap.get(item.slug.toLowerCase()), item)
          if (!itemMap.has(item.slug.toLowerCase())) added.push(next)
          itemMap.set(next.slug.toLowerCase(), next)
        }
        for (const item of added) {
          for (const seed of extractSeedTerms(item)) enqueue(seed)
        }
      }
    }

    const index: SkillhubIndex = {
      items: rankAndDedupeSkillhubItems([...itemMap.values()], '*'),
      updatedAt: Date.now(),
      seeds: [...queried],
    }
    this.index = index
    await this.writeCache(index).catch(() => undefined)
    return index
  }

  private async writeCache(index: SkillhubIndex) {
    if (!this.cacheFilePath) return
    await mkdir(dirname(this.cacheFilePath), { recursive: true })
    const payload: SkillhubCachePayload = { version: 1, ...index }
    await writeFile(this.cacheFilePath, JSON.stringify(payload), 'utf8')
  }

  private async searchRemote(query: string, limit: number) {
    const url = new URL('https://lightmake.site/api/v1/search')
    url.searchParams.set('q', query)
    url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 100))))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'AgentHub/SkillHub',
        },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as any
      const rawItems: unknown[] = Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.items)
          ? payload.items
          : []
      return rawItems
        .map(normalizeSkillhubItem)
        .filter((item): item is SkillhubSearchItem => Boolean(item))
    } finally {
      clearTimeout(timer)
    }
  }
}

export const globalSkillhubCatalog = new SkillhubCatalogService()

function searchIndexedSkillhubItems(items: SkillhubSearchItem[], query: string) {
  return items
    .map((item) => ({ item, score: scoreSkillhubItem(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || comparePopularity(b.item, a.item))
    .map((entry) => entry.item)
}

function rankAndDedupeSkillhubItems(items: SkillhubSearchItem[], query: string) {
  return dedupeSkillhubItems(items)
    .map((item) => ({ item, score: scoreSkillhubItem(item, query) }))
    .sort((a, b) => b.score - a.score || comparePopularity(b.item, a.item))
    .map((entry) => entry.item)
}

function dedupeSkillhubItems(items: SkillhubSearchItem[]) {
  const map = new Map<string, SkillhubSearchItem>()
  for (const item of items) {
    const key = item.slug.trim().toLowerCase()
    if (!key) continue
    map.set(key, mergeSkillhubItem(map.get(key), item))
  }
  return [...map.values()]
}

function scoreSkillhubItem(item: SkillhubSearchItem, query: string) {
  if (isBroadQuery(query)) return popularityScore(item)
  const normalizedQuery = normalizeSearch(query)
  const tokens = tokenizeSearchQuery(query)
  if (!normalizedQuery && tokens.length === 0) return 0

  const slug = normalizeSearch(item.slug)
  const title = normalizeSearch(item.title)
  const searchable = normalizeSearch(
    [
      item.slug,
      item.title,
      item.description,
      item.version,
      item.source,
      item.remoteSource,
      item.category,
      item.ownerName,
      ...(item.tags ?? []),
    ].join(' '),
  )

  let score = 0
  if (slug === normalizedQuery) score += 1000
  if (title === normalizedQuery) score += 900
  if (slug.includes(normalizedQuery)) score += 220
  if (title.includes(normalizedQuery)) score += 180
  if (searchable.includes(normalizedQuery)) score += 80

  for (const token of tokens) {
    if (slug.includes(token)) score += 70
    else if (title.includes(token)) score += 55
    else if (searchable.includes(token)) score += 25
  }

  return score + Math.min(popularityScore(item), 20)
}

function comparePopularity(a: SkillhubSearchItem, b: SkillhubSearchItem) {
  return popularityScore(a) - popularityScore(b)
}

function popularityScore(item: SkillhubSearchItem) {
  return (
    numberScore(item.downloads, 0.01) +
    numberScore(item.installs, 0.02) +
    numberScore(item.stars, 1) +
    numberScore(item.updatedAt, 0.000000001)
  )
}

function numberScore(value: number | undefined, weight: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.log10(Math.max(1, value)) * weight : 0
}

function extractSeedTerms(item: SkillhubSearchItem) {
  const seeds: string[] = []
  const add = (value: string | undefined) => {
    for (const token of tokenizeSeedText(value ?? '')) seeds.push(token)
  }

  seeds.push(item.slug)
  for (const part of item.slug.split(/[-_/]+/)) add(part)
  add(item.title)
  add(item.category)
  for (const tag of item.tags ?? []) add(tag)
  add(item.description.slice(0, 600))

  return dedupeSeeds(seeds).slice(0, 12)
}

function tokenizeSeedText(value: string) {
  const normalized = cleanSkillhubText(value)
  const english = normalized
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 32 && !seedStopWords.has(token))

  const cjk: string[] = []
  for (const match of normalized.matchAll(/[\u4e00-\u9fa5]{2,16}/g)) {
    const value = match[0]
    if (value.length <= 6) {
      cjk.push(value)
      continue
    }
    for (let index = 0; index <= value.length - 2; index += 2) {
      cjk.push(value.slice(index, Math.min(value.length, index + 4)))
    }
  }

  return [...english, ...cjk]
}

function tokenizeSearchQuery(value: string) {
  return dedupeSeeds(tokenizeSeedText(value)).filter((token) => token !== '*')
}

function normalizeSkillhubItem(value: any): SkillhubSearchItem | null {
  const slug = stringValue(value?.slug || value?.id || value?.name)
  if (!slug) return null
  const title = stringValue(value?.displayName || value?.title || value?.name || slug)
  const description = stringValue(value?.description_zh || value?.description || value?.summary)
  const version = stringValue(value?.version)
  const category = stringValue(value?.category)
  const remoteSource = stringValue(value?.remoteSource || value?.source)
  const ownerName = stringValue(value?.ownerName || value?.owner_name)
  const tags = Array.isArray(value?.tags) ? value.tags.map(stringValue).filter(Boolean) : undefined
  return {
    slug,
    title: cleanSkillhubText(title || slug),
    description: cleanSkillhubText(description),
    ...(version ? { version } : {}),
    source: 'SkillHub',
    ...(remoteSource ? { remoteSource } : {}),
    ...(category ? { category } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...numberField('downloads', value?.downloads),
    ...numberField('installs', value?.installs),
    ...numberField('stars', value?.stars),
    ...numberField('updatedAt', value?.updatedAt ?? value?.updated_at),
  }
}

function mergeSkillhubItem(existing: SkillhubSearchItem | undefined, next: SkillhubSearchItem) {
  if (!existing) return next
  return {
    ...existing,
    ...next,
    description: longerText(existing.description, next.description),
    title: longerText(existing.title, next.title),
    downloads: maxNumber(existing.downloads, next.downloads),
    installs: maxNumber(existing.installs, next.installs),
    stars: maxNumber(existing.stars, next.stars),
    updatedAt: maxNumber(existing.updatedAt, next.updatedAt),
    tags: dedupeSeeds([...(existing.tags ?? []), ...(next.tags ?? [])]),
  }
}

function numberField(key: 'downloads' | 'installs' | 'stars' | 'updatedAt', value: unknown) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? { [key]: number } : {}
}

function maxNumber(a: number | undefined, b: number | undefined) {
  if (typeof a !== 'number') return b
  if (typeof b !== 'number') return a
  return Math.max(a, b)
}

function longerText(a: string, b: string) {
  return b.length > a.length ? b : a
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function isBroadQuery(query: string) {
  const normalized = query.trim()
  return !normalized || normalized === '*'
}

function normalizeSearch(value: string | undefined | null) {
  return cleanSkillhubText(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function normalizeSeed(value: string) {
  const normalized = cleanSkillhubText(value).toLowerCase().trim()
  if (!normalized) return ''
  if (normalized === '*') return '*'
  if (normalized.length > 48) return null
  return normalized
}

function dedupeSeeds(values: string[]) {
  const seen = new Set<string>()
  const next: string[] = []
  for (const value of values) {
    const seed = normalizeSeed(value)
    if (seed === null || seen.has(seed)) continue
    seen.add(seed)
    next.push(seed)
  }
  return next
}

function cleanSkillhubText(value: string) {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[锟絔]{2,}/g, '')
    .trim()
}

export const __skillhubCatalogTestHooks = {
  extractSeedTerms,
  normalizeSkillhubItem,
  searchIndexedSkillhubItems,
}
