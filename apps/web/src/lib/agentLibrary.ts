import { api } from './api'
import type { AgentConfigInput, AgentRelationType } from './api'
import { inferRoleType, presetForRole } from './agentRolePresets'

export interface SavedAgentConfig extends AgentConfigInput {
  id: string
  createdAt: string
  updatedAt: string
}

export interface SavedAgentRelation {
  id: string
  sourceAgentId: string
  targetAgentId: string
  relationType: AgentRelationType
  note?: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentLibraryState {
  schemaVersion: 2
  agents: SavedAgentConfig[]
  relations: SavedAgentRelation[]
}

export const agentLibraryStorageKey = 'agenthub.agentLibrary'
export const agentLibraryChangeEvent = 'agenthub:agent-library-change'
export const agentLibrarySyncErrorEvent = 'agenthub:agent-library-sync-error'
export const agentLibraryServerSettingKey = 'AGENT_LIBRARY'
export const legacyAgentConfigKey = 'agenthub.agentConfig'
let pendingServerSync: number | null = null
let pendingServerSyncState: AgentLibraryState | null = null
let serverReconcilePromise: Promise<AgentLibraryState> | null = null

export const defaultAgentLibrary: AgentLibraryState = {
  schemaVersion: 2,
  agents: [],
  relations: [],
}

export function loadAgentLibrary(): SavedAgentConfig[] {
  return loadAgentLibraryState().agents
}

export function loadAgentLibraryState(): AgentLibraryState {
  if (typeof window === 'undefined') return defaultAgentLibrary
  const raw = window.localStorage.getItem(agentLibraryStorageKey)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      const state = Array.isArray(parsed)
        ? normalizeLibraryState({ agents: parsed })
        : Array.isArray(parsed?.agents)
          ? normalizeLibraryState(parsed)
          : null
      if (state) {
        return state
      }
    } catch {
      // Keep the app usable when local config is broken.
    }
  }

  const state = normalizeLibraryState({
    agents: [],
    relations: [],
  })
  return state
}

export function clearLegacyAgentLibraryStorage() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(legacyAgentConfigKey)

  const current = parseAgentLibraryValue(window.localStorage.getItem(agentLibraryStorageKey))
  if (!current) return
  const normalized = normalizeLibraryState(current)
  if (JSON.stringify(current) !== JSON.stringify(normalized)) {
    writeAgentLibraryStateToStorage(normalized)
    queueAgentLibraryServerSync(normalized)
  }
}

export function saveAgentLibrary(agents: SavedAgentConfig[]) {
  const current = loadAgentLibraryState()
  saveAgentLibraryState(normalizeLibraryState({
    schemaVersion: 2,
    agents,
    relations: pruneRelations(current.relations, agents),
  }))
}

export function saveAgentLibraryState(state: AgentLibraryState) {
  const normalized = normalizeLibraryState(state)
  writeAgentLibraryStateToStorage(normalized)
  queueAgentLibraryServerSync(normalized)
}

export async function reconcileAgentLibraryWithServer(
  settingsMap?: Record<string, string>,
): Promise<AgentLibraryState> {
  if (typeof window === 'undefined') return defaultAgentLibrary
  if (serverReconcilePromise) return serverReconcilePromise

  serverReconcilePromise = (async () => {
    const local = readStoredAgentLibraryState()
    const settings = settingsMap ?? await api.getSettings()
    const server = parseAgentLibraryValue(settings[agentLibraryServerSettingKey])

    if (server) {
      if (!local || shouldPreferServerLibrary(server, local)) {
        writeAgentLibraryStateToStorage(server)
        return server
      }
      await syncAgentLibraryStateToServer(local)
      return local
    }

    const next = local ?? loadAgentLibraryState()
    writeAgentLibraryStateToStorage(next)
    await syncAgentLibraryStateToServer(next)
    return next
  })()

  try {
    return await serverReconcilePromise
  } finally {
    serverReconcilePromise = null
  }
}

export async function flushAgentLibraryServerSync() {
  if (typeof window === 'undefined') return
  const state = pendingServerSyncState
  if (!state) return
  if (pendingServerSync !== null) {
    window.clearTimeout(pendingServerSync)
    pendingServerSync = null
  }
  pendingServerSyncState = null
  await syncAgentLibraryStateToServer(state)
}

export async function syncAgentLibraryStateToServer(state: AgentLibraryState) {
  const normalized = normalizeLibraryState(state)
  await api.saveSettings({ [agentLibraryServerSettingKey]: JSON.stringify(normalized) })
}

function writeAgentLibraryStateToStorage(state: AgentLibraryState) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(agentLibraryStorageKey, JSON.stringify(state))
  window.dispatchEvent(new CustomEvent(agentLibraryChangeEvent, { detail: state.agents }))
}

function queueAgentLibraryServerSync(state: AgentLibraryState) {
  if (typeof window === 'undefined') return
  if (pendingServerSync !== null) window.clearTimeout(pendingServerSync)
  pendingServerSyncState = state
  pendingServerSync = window.setTimeout(() => {
    pendingServerSync = null
    const next = pendingServerSyncState
    pendingServerSyncState = null
    if (!next) return
    void syncAgentLibraryStateToServer(next).catch((error) => {
      window.dispatchEvent(new CustomEvent(agentLibrarySyncErrorEvent, { detail: error }))
    })
  }, 0)
}

function readStoredAgentLibraryState(): AgentLibraryState | null {
  if (typeof window === 'undefined') return null
  return parseAgentLibraryValue(window.localStorage.getItem(agentLibraryStorageKey))
}

function parseAgentLibraryValue(value?: string | null): AgentLibraryState | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? normalizeLibraryState({ agents: parsed })
      : Array.isArray(parsed?.agents)
        ? normalizeLibraryState(parsed)
        : null
  } catch {
    return null
  }
}

function shouldPreferServerLibrary(server: AgentLibraryState, local: AgentLibraryState) {
  if (JSON.stringify(server) === JSON.stringify(local)) return true
  return latestLibraryTime(server) >= latestLibraryTime(local)
}

function latestLibraryTime(state: AgentLibraryState) {
  const values = [
    ...state.agents.flatMap((agent) => [agent.updatedAt, agent.createdAt]),
    ...state.relations.flatMap((relation) => [relation.updatedAt, relation.createdAt]),
  ]
  return values.reduce((latest, value) => {
    const time = Date.parse(value)
    return Number.isFinite(time) ? Math.max(latest, time) : latest
  }, 0)
}

export function createSavedAgent(
  input: Partial<AgentConfigInput> & Pick<AgentConfigInput, 'name' | 'role'>,
): SavedAgentConfig {
  const now = new Date().toISOString()
  const runtimeType = normalizeRuntimeType(input.runtimeType)
  return normalizeSavedAgent({
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    name: input.name,
    role: input.role,
    roleType: input.roleType ?? 'custom',
    description: input.description ?? '',
    avatar: input.avatar ?? null,
    systemPrompt: input.systemPrompt ?? '',
    roleProfile: input.roleProfile ?? null,
    color: input.color ?? '#111827',
    modelId: input.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (input.codeAgentType ?? defaultCodeAgentTypeFor(input)) : null,
    capabilityTags: input.capabilityTags ?? [],
    skillIds: input.skillIds ?? [],
    toolPermissions: input.toolPermissions ?? [],
    sandboxPolicy: input.sandboxPolicy ?? 'workspace-write',
    contextPolicy: input.contextPolicy ?? 'workspace-aware',
    autoInvoke: input.autoInvoke ?? true,
    approvalRequired: input.approvalRequired ?? (runtimeType === 'code-agent' ? false : true),
    createdAt: now,
    updatedAt: now,
  })!
}

export function toAgentConfigInput(agent: SavedAgentConfig): AgentConfigInput {
  const runtimeType = normalizeRuntimeType(agent.runtimeType)
  return {
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType ?? inferRoleType(agent),
    description: agent.description ?? '',
    avatar: agent.avatar ?? null,
    systemPrompt: agent.systemPrompt ?? '',
    roleProfile: agent.roleProfile ?? null,
    color: agent.color ?? '#111827',
    modelId: agent.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (agent.codeAgentType ?? defaultCodeAgentTypeFor(agent)) : null,
    capabilityTags: [...(agent.capabilityTags ?? [])],
    skillIds: [...(agent.skillIds ?? [])],
    toolPermissions: [...(agent.toolPermissions ?? [])],
    sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
    contextPolicy: agent.contextPolicy ?? 'workspace-aware',
    autoInvoke: agent.autoInvoke ?? true,
    approvalRequired: runtimeType === 'code-agent' ? false : (agent.approvalRequired ?? true),
  }
}

export function saveAgentToLibrary(
  agents: SavedAgentConfig[],
  draft: AgentConfigInput,
  id?: string,
) {
  const now = new Date().toISOString()
  const existing = id ? agents.find((agent) => agent.id === id) : null
  const next = normalizeSavedAgent({
    ...(existing ?? {}),
    ...draft,
    id:
      existing?.id ??
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  if (!next) return agents
  const updated = existing
    ? agents.map((agent) => (agent.id === existing.id ? next : agent))
    : [next, ...agents]
  saveAgentLibrary(updated)
  return updated
}

function normalizeSavedAgent(value: unknown): SavedAgentConfig | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SavedAgentConfig>
  if (!input.name?.trim() || !input.role?.trim()) return null
  const runtimeType = normalizeRuntimeType(input.runtimeType)
  return {
    id: input.id || `${Date.now()}-${Math.random()}`,
    name: input.name.trim(),
    role: input.role.trim(),
    roleType: input.roleType ?? inferRoleType(input),
    description: input.description?.trim() ?? '',
    avatar: input.avatar ?? null,
    systemPrompt: input.systemPrompt?.trim() ?? '',
    roleProfile: input.roleProfile ?? null,
    color: input.color || '#111827',
    modelId: input.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (input.codeAgentType ?? defaultCodeAgentTypeFor(input)) : null,
    capabilityTags: Array.isArray(input.capabilityTags) ? input.capabilityTags : [],
    skillIds: Array.isArray(input.skillIds) ? input.skillIds : [],
    toolPermissions:
      Array.isArray(input.toolPermissions) && input.toolPermissions.length
        ? input.toolPermissions
        : [],
    sandboxPolicy: input.sandboxPolicy ?? 'workspace-write',
    contextPolicy: input.contextPolicy ?? 'workspace-aware',
    autoInvoke: input.autoInvoke ?? true,
    approvalRequired: runtimeType === 'code-agent' ? false : (input.approvalRequired ?? true),
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}

function normalizeLibraryState(value: unknown): AgentLibraryState {
  const parsed = value as Partial<AgentLibraryState> & { agents?: unknown; relations?: unknown }
  let agents = Array.isArray(parsed.agents)
    ? (parsed.agents.map(normalizeSavedAgent).filter(Boolean) as SavedAgentConfig[])
    : []
  agents = dedupeSavedAgents(agents)
  agents = agents.filter((agent) => !isPlaceholderSavedAgent(agent))

  const relations = Array.isArray(parsed.relations)
    ? (parsed.relations.map(normalizeSavedRelation).filter(Boolean) as SavedAgentRelation[])
    : []
  const pruned = pruneRelations(relations, agents)
  return { schemaVersion: 2, agents, relations: pruned }
}

function isPlaceholderSavedAgent(agent: SavedAgentConfig) {
  const runtimeType = normalizeRuntimeType(agent.runtimeType)
  return (
    normalizeAgentText(agent.name) === 'new agent' &&
    normalizeAgentText(agent.role) === '协作' &&
    normalizeAgentText(agent.description ?? '') ===
      normalizeAgentText('描述这个 Agent 的职责、产出和适合处理的任务。') &&
    normalizeAgentText(agent.systemPrompt ?? '') ===
      normalizeAgentText('你是 AgentHub 中的协作 Agent。先理解目标，再给出清晰、可执行的结果。') &&
    runtimeType === 'code-agent' &&
    (agent.codeAgentType ?? 'codex') === 'codex'
  )
}

function normalizeAgentText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function defaultCodeAgentTypeFor(
  input: Partial<Pick<AgentConfigInput, 'roleType' | 'name' | 'role' | 'capabilityTags'>>,
) {
  const roleType = input.roleType ?? inferRoleType(input)
  const preset = roleType === 'custom' ? undefined : presetForRole(roleType)
  return preset?.codeAgentType ?? 'codex'
}

function dedupeSavedAgents(agents: SavedAgentConfig[]) {
  const seen = new Set<string>()
  return agents.filter((agent) => {
    const runtimeType = normalizeRuntimeType(agent.runtimeType)
    const codeAgentType = runtimeType === 'code-agent' ? (agent.codeAgentType ?? '').trim().toLowerCase() : ''
    const key = [
      agent.name.trim().toLowerCase(),
      agent.role.trim().toLowerCase(),
      runtimeType,
      codeAgentType,
    ].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeRuntimeType(value?: string | null): SavedAgentConfig['runtimeType'] {
  return value === 'llm' ? 'llm' : 'code-agent'
}

function normalizeSavedRelation(value: unknown): SavedAgentRelation | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SavedAgentRelation>
  if (!input.sourceAgentId || !input.targetAgentId || !input.relationType) return null
  const now = new Date().toISOString()
  return {
    id: input.id || `${Date.now()}-${Math.random()}`,
    sourceAgentId: input.sourceAgentId,
    targetAgentId: input.targetAgentId,
    relationType: input.relationType,
    note: input.note ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
}

function pruneRelations(relations: SavedAgentRelation[], agents: SavedAgentConfig[]) {
  const ids = new Set(agents.map((agent) => agent.id))
  const seen = new Set<string>()
  return relations.filter((relation) => {
    if (!ids.has(relation.sourceAgentId) || !ids.has(relation.targetAgentId)) return false
    const key = `${relation.sourceAgentId}:${relation.targetAgentId}:${relation.relationType}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

