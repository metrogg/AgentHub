import type { AgentConfigInput, AgentRelationType } from './api'
import { defaultAgentRelations, inferRoleType } from './agentRolePresets'

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
const legacyAgentConfigKey = 'agenthub.agentConfig'

export const defaultAgentConfigs: SavedAgentConfig[] = [
  createSavedAgent({
    roleType: 'orchestrator',
    name: 'Orchestrator',
    role: '总指挥',
    description: '群聊总指挥，负责理解用户需求、制定计划并调度其他 Agent 协作完成复杂任务。',
    systemPrompt: '你是群聊总指挥。你的职责是理解用户意图，分析任务复杂度，制定执行计划，并决定调用哪些 Agent 来完成任务。你不需要直接写代码，而是专注于规划和协调。',
    color: '#7c3aed',
    runtimeType: 'code-agent',
    codeAgentType: 'claude-code',
    capabilityTags: ['orchestrate', 'plan', 'dispatch', 'coordinate'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
  }),
  createSavedAgent({
    roleType: 'coder',
    name: 'Coder',
    role: '实现',
    description: '负责代码实现、组件接入和小步验证。',
    systemPrompt: '你是实现者。负责代码实现、组件接入和小步验证。先理解上下文，再小步迭代。',
    color: '#10b981',
    runtimeType: 'code-agent',
    codeAgentType: 'codex',
    capabilityTags: ['code', 'implementation'],
    toolPermissions: ['workspace:read', 'workspace:write'],
    approvalRequired: false,
  }),
  createSavedAgent({
    roleType: 'reviewer',
    name: 'Reviewer',
    role: '审查',
    description: '检查风险、交互漏洞和缺失的测试。',
    systemPrompt: '你是审查者。检查风险、交互洞和缺失的测试。直接、克制、不绕弯。',
    color: '#ef4444',
    runtimeType: 'code-agent',
    codeAgentType: 'claude-code',
    capabilityTags: ['review', 'quality'],
  }),
]

export const defaultAgentLibrary: AgentLibraryState = {
  schemaVersion: 2,
  agents: defaultAgentConfigs,
  relations: buildDefaultSavedRelations(defaultAgentConfigs),
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
        // 如果迁移添加了 orchestrator，保存回 localStorage
        const hadOrchestrator = Array.isArray(parsed?.agents)
          ? parsed.agents.some((a: unknown) => {
              const agent = a as { roleType?: string; name?: string; role?: string }
              return agent.roleType === 'orchestrator' || (agent.name ?? '').toLowerCase().includes('orchestrator') || (agent.role ?? '').includes('总指挥')
            })
          : false
        if (!hadOrchestrator) {
          saveAgentLibraryState(state)
        }
        return state
      }
    } catch {
      // Keep the app usable when local config is broken.
    }
  }

  const migrated = migrateLegacyAgentConfig()
  const initial = migrated ? [migrated, ...defaultAgentConfigs] : defaultAgentConfigs
  const state = normalizeLibraryState({ agents: initial, relations: buildDefaultSavedRelations(initial) })
  saveAgentLibraryState(state)
  return state
}

export function saveAgentLibrary(agents: SavedAgentConfig[]) {
  const current = loadAgentLibraryState()
  saveAgentLibraryState({ schemaVersion: 2, agents, relations: pruneRelations(current.relations, agents) })
}

export function saveAgentLibraryState(state: AgentLibraryState) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(agentLibraryStorageKey, JSON.stringify(state))
  window.dispatchEvent(new CustomEvent(agentLibraryChangeEvent, { detail: state.agents }))
}

export function createSavedAgent(input: Partial<AgentConfigInput> & Pick<AgentConfigInput, 'name' | 'role'>): SavedAgentConfig {
  const now = new Date().toISOString()
  const runtimeType = input.runtimeType ?? 'code-agent'
  return normalizeSavedAgent({
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
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
    codeAgentType: runtimeType === 'code-agent' ? (input.codeAgentType ?? 'claude-code') : null,
    capabilityTags: input.capabilityTags ?? [],
    toolPermissions: input.toolPermissions ?? [],
    sandboxPolicy: input.sandboxPolicy ?? 'workspace-write',
    contextPolicy: input.contextPolicy ?? 'workspace-aware',
    autoInvoke: input.autoInvoke ?? true,
    approvalRequired: input.approvalRequired ?? (input.runtimeType === 'code-agent' ? false : true),
    createdAt: now,
    updatedAt: now,
  })!
}

export function toAgentConfigInput(agent: SavedAgentConfig): AgentConfigInput {
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
    runtimeType: agent.runtimeType ?? 'llm',
    codeAgentType: agent.runtimeType === 'code-agent' ? (agent.codeAgentType ?? 'codex') : null,
    capabilityTags: [...(agent.capabilityTags ?? [])],
    toolPermissions: [...(agent.toolPermissions ?? [])],
    sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
    contextPolicy: agent.contextPolicy ?? 'workspace-aware',
    autoInvoke: agent.autoInvoke ?? true,
    approvalRequired: agent.runtimeType === 'code-agent' ? false : (agent.approvalRequired ?? true),
  }
}

export function saveAgentToLibrary(agents: SavedAgentConfig[], draft: AgentConfigInput, id?: string) {
  const now = new Date().toISOString()
  const existing = id ? agents.find((agent) => agent.id === id) : null
  const next = normalizeSavedAgent({
    ...(existing ?? {}),
    ...draft,
    id: existing?.id ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  if (!next) return agents
  const updated = existing ? agents.map((agent) => (agent.id === existing.id ? next : agent)) : [next, ...agents]
  saveAgentLibrary(updated)
  return updated
}

function normalizeSavedAgent(value: unknown): SavedAgentConfig | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SavedAgentConfig>
  if (!input.name?.trim() || !input.role?.trim()) return null
  const runtimeType = input.runtimeType ?? 'llm'
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
    codeAgentType: runtimeType === 'code-agent' ? (input.codeAgentType ?? 'codex') : null,
    capabilityTags: Array.isArray(input.capabilityTags) ? input.capabilityTags : [],
    toolPermissions: Array.isArray(input.toolPermissions) && input.toolPermissions.length ? input.toolPermissions : [],
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
    ? parsed.agents.map(normalizeSavedAgent).filter(Boolean) as SavedAgentConfig[]
    : defaultAgentConfigs

  // 迁移：如果缺少 orchestrator，自动添加
  const hasOrchestrator = agents.some((a) => (a.roleType ?? inferRoleType(a)) === 'orchestrator')
  if (!hasOrchestrator) {
    const orchestratorPreset = defaultAgentConfigs.find((a) => a.roleType === 'orchestrator')
    if (orchestratorPreset) {
      agents = [orchestratorPreset, ...agents]
    }
  }

  const relations = Array.isArray(parsed.relations)
    ? parsed.relations.map(normalizeSavedRelation).filter(Boolean) as SavedAgentRelation[]
    : buildDefaultSavedRelations(agents)
  const pruned = pruneRelations(relations, agents)
  return { schemaVersion: 2, agents, relations: pruned }
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

function buildDefaultSavedRelations(agents: SavedAgentConfig[]): SavedAgentRelation[] {
  const now = new Date().toISOString()
  return defaultAgentRelations.flatMap((relation) => {
    const source = agents.find((agent) => (agent.roleType ?? inferRoleType(agent)) === relation.sourceRoleType)
    const target = agents.find((agent) => (agent.roleType ?? inferRoleType(agent)) === relation.targetRoleType)
    if (!source || !target) return []
    return [{
      id: `${relation.sourceRoleType}-${relation.relationType}-${relation.targetRoleType}`,
      sourceAgentId: source.id,
      targetAgentId: target.id,
      relationType: relation.relationType,
      note: relation.note,
      createdAt: now,
      updatedAt: now,
    }]
  })
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

function migrateLegacyAgentConfig() {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(legacyAgentConfigKey)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const profile = parsed?.profile
    if (!profile?.name) return null
    return createSavedAgent({
      name: profile.name,
      role: profile.tone ?? '默认',
      description: profile.description ?? '',
      systemPrompt: profile.instruction ?? '',
    })
  } catch {
    return null
  }
}
