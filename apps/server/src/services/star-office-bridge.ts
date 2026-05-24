import { logger } from '../lib/logger'
import type { AgentRunProfile } from './agent-runner'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type StarOfficeState = 'idle' | 'writing' | 'researching' | 'executing' | 'syncing' | 'error'

const DEFAULT_OFFICE_URL = 'http://127.0.0.1:19000'
const DEFAULT_JOIN_KEY = 'ocj_example_team_01'
const REQUEST_TIMEOUT_MS = 2500

const joinedAgents = new Map<string, string>()

function officeUrl() {
  return (process.env.AGENTHUB_STAR_OFFICE_URL || process.env.STAR_OFFICE_URL || DEFAULT_OFFICE_URL).replace(/\/+$/, '')
}

function joinKey() {
  return process.env.AGENTHUB_STAR_OFFICE_JOIN_KEY || process.env.STAR_OFFICE_JOIN_KEY || DEFAULT_JOIN_KEY
}

function localOfficeRoot() {
  return resolve(process.env.AGENTHUB_STAR_OFFICE_ROOT || process.env.STAR_OFFICE_ROOT || 'storage/Star-Office-UI')
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
  if (/code|codex|claude-code|opencode|coder|开发|实现|代码|执行/.test(text)) return 'executing'
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
      joinKey: joinKey(),
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
    joinKey: joinKey(),
    state: 'idle',
    detail: 'AgentHub 已加入办公室',
  })

  const agentId = typeof response.agentId === 'string' ? response.agentId : null
  if (agentId) joinedAgents.set(cacheKey, agentId)
  return agentId
}

async function ensureLocalJoinKey() {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(officeUrl())) return

  const key = joinKey()
  const file = join(localOfficeRoot(), 'join-keys.json')
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
  await mkdir(localOfficeRoot(), { recursive: true })
  await writeFile(file, JSON.stringify({ keys }, null, 2), 'utf8')
}

async function postJson(path: string, body: Record<string, unknown>) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${officeUrl()}${path}`, {
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
