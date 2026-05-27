import { logger } from '../lib/logger'
import type { AgentRunProfile } from './agent-runner'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type StarOfficeState = 'idle' | 'writing' | 'researching' | 'executing' | 'syncing' | 'error'

export const DEFAULT_STAR_OFFICE_URL = 'http://127.0.0.1:19000'
const DEFAULT_JOIN_KEY = 'ocj_example_team_01'
const REQUEST_TIMEOUT_MS = 2500

const joinedAgents = new Map<string, string>()
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

export function starOfficeUrl() {
  return (process.env.AGENTHUB_STAR_OFFICE_URL || process.env.STAR_OFFICE_URL || DEFAULT_STAR_OFFICE_URL).replace(/\/+$/, '')
}

export function starOfficeJoinKey() {
  return process.env.AGENTHUB_STAR_OFFICE_JOIN_KEY || process.env.STAR_OFFICE_JOIN_KEY || DEFAULT_JOIN_KEY
}

export function starOfficeRoot() {
  const rawRoot = process.env.AGENTHUB_STAR_OFFICE_ROOT || process.env.STAR_OFFICE_ROOT || 'storage/Star-Office-UI'
  if (isAbsolute(rawRoot)) return rawRoot

  const candidates = [
    process.env.PROJECT_ROOT?.trim(),
    PROJECT_ROOT,
    process.cwd(),
    resolve(process.cwd(), '../..'),
  ].filter(Boolean) as string[]
  for (const base of [...new Set(candidates)]) {
    const candidate = resolve(base, rawRoot)
    if (existsSync(candidate)) return candidate
  }
  return resolve(PROJECT_ROOT, rawRoot)
}

function enabled() {
  return process.env.AGENTHUB_STAR_OFFICE_SYNC !== 'false'
}

function agentCacheKey(profile: AgentRunProfile) {
  return `${profile.projectPath ?? 'global'}:${profile.id}`
}

function officeAgentName(profile: AgentRunProfile) {
  return profile.name || profile.role || profile.id
}

export function starOfficeStateForProfile(profile?: AgentRunProfile): StarOfficeState {
  const text = [
    profile?.name,
    profile?.role,
    profile?.description,
    profile?.runtimeType,
    profile?.codeAgentType,
    ...(profile?.capabilityTags ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (/research|search|资料|调研|研究/.test(text)) return 'researching'
  if (/code|codex|claude-code|opencode|gemini|coder|开发|实现|代码|执行/.test(text)) return 'executing'
  if (/sync|deploy|发布|同步|部署/.test(text)) return 'syncing'
  return 'writing'
}

export async function pushStarOfficeAgentState(
  profile: AgentRunProfile | undefined,
  state: StarOfficeState,
  detail: string
) {
  if (!profile || !enabled()) return

  try {
    const agentId = await ensureStarOfficeAgent(profile)
    if (!agentId) return
    await postJson('/agent-push', {
      agentId,
      joinKey: starOfficeJoinKey(),
      name: officeAgentName(profile),
      state,
      detail,
    })
  } catch (error) {
    logger.debug({ err: error instanceof Error ? error.message : String(error), agentId: profile.id }, 'Star Office push skipped')
  }
}

async function ensureStarOfficeAgent(profile: AgentRunProfile) {
  const cacheKey = agentCacheKey(profile)
  const cached = joinedAgents.get(cacheKey)
  if (cached) return cached

  await ensureLocalJoinKey()
  const response = await postJson('/join-agent', {
    name: officeAgentName(profile),
    joinKey: starOfficeJoinKey(),
    state: 'idle',
    detail: 'AgentHub 已加入办公室',
  })

  const agentId = typeof response.agentId === 'string' ? response.agentId : null
  if (agentId) joinedAgents.set(cacheKey, agentId)
  return agentId
}

async function ensureLocalJoinKey() {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(starOfficeUrl())) return

  const key = starOfficeJoinKey()
  const file = join(starOfficeRoot(), 'join-keys.json')
  let data: { keys?: Array<Record<string, unknown>> } = { keys: [] }
  try {
    data = JSON.parse(await readFile(file, 'utf8')) as { keys?: Array<Record<string, unknown>> }
  } catch {
    data = { keys: [] }
  }

  const keys = Array.isArray(data.keys) ? data.keys : []
  if (keys.some((item) => item.key === key)) return

  keys.push({
    key,
    used: false,
    reusable: true,
    maxConcurrent: 32,
    usedBy: null,
    usedByAgentId: null,
    usedAt: null,
  })
  await mkdir(starOfficeRoot(), { recursive: true })
  await writeFile(file, JSON.stringify({ keys }, null, 2), 'utf8')
}

async function postJson(path: string, body: Record<string, unknown>) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${starOfficeUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Star Office ${path} returned ${response.status}`)
    return (await response.json()) as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}
