import type { AgentConfigInput } from './api'

export interface SavedAgentConfig extends AgentConfigInput {
  id: string
  createdAt: string
  updatedAt: string
}

export const agentLibraryStorageKey = 'agenthub.agentLibrary'
export const agentLibraryChangeEvent = 'agenthub:agent-library-change'
const legacyAgentConfigKey = 'agenthub.agentConfig'

export const defaultAgentConfigs: SavedAgentConfig[] = [
  createSavedAgent({
    name: 'Architect',
    role: '规划',
    description: '拆解目标、定义边界、规划里程碑和依赖关系。',
    systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑与依赖关系。',
    color: '#6366f1',
    capabilityTags: ['planning', 'architecture'],
  }),
  createSavedAgent({
    name: 'Coder',
    role: '实现',
    description: '负责代码实现、组件接入和小步验证。',
    systemPrompt: '你是实现者。负责代码实现、组件接入和小步验证。先理解上下文，再小步迭代。',
    color: '#10b981',
    runtimeType: 'code-agent',
    codeAgentType: 'codex',
    capabilityTags: ['code', 'implementation'],
    toolPermissions: ['workspace:read', 'workspace:write'],
  }),
  createSavedAgent({
    name: 'Researcher',
    role: '研究',
    description: '补充资料、比较方案、标记不确定点。',
    systemPrompt: '你是研究员。补充资料、比较方案、标记不确定点。给出参考来源。',
    color: '#f59e0b',
    capabilityTags: ['research', 'sources'],
  }),
  createSavedAgent({
    name: 'Reviewer',
    role: '审查',
    description: '检查风险、交互漏洞和缺失的测试。',
    systemPrompt: '你是审查者。检查风险、交互洞和缺失的测试。直接、克制、不绕弯。',
    color: '#ef4444',
    capabilityTags: ['review', 'quality'],
  }),
]

export function loadAgentLibrary(): SavedAgentConfig[] {
  if (typeof window === 'undefined') return defaultAgentConfigs
  const raw = window.localStorage.getItem(agentLibraryStorageKey)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map(normalizeSavedAgent).filter(Boolean) as SavedAgentConfig[]
      if (Array.isArray(parsed?.agents)) return parsed.agents.map(normalizeSavedAgent).filter(Boolean) as SavedAgentConfig[]
    } catch {
      // Keep the app usable when local config is broken.
    }
  }

  const migrated = migrateLegacyAgentConfig()
  const initial = migrated ? [migrated, ...defaultAgentConfigs] : defaultAgentConfigs
  saveAgentLibrary(initial)
  return initial
}

export function saveAgentLibrary(agents: SavedAgentConfig[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(agentLibraryStorageKey, JSON.stringify({ agents }))
  window.dispatchEvent(new CustomEvent(agentLibraryChangeEvent, { detail: agents }))
}

export function createSavedAgent(input: Partial<AgentConfigInput> & Pick<AgentConfigInput, 'name' | 'role'>): SavedAgentConfig {
  const now = new Date().toISOString()
  return normalizeSavedAgent({
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    name: input.name,
    role: input.role,
    description: input.description ?? '',
    avatar: input.avatar ?? null,
    systemPrompt: input.systemPrompt ?? '',
    color: input.color ?? '#111827',
    modelId: input.modelId ?? null,
    runtimeType: input.runtimeType ?? 'llm',
    codeAgentType: input.runtimeType === 'code-agent' ? (input.codeAgentType ?? 'codex') : null,
    capabilityTags: input.capabilityTags ?? [],
    toolPermissions: input.toolPermissions ?? [],
    sandboxPolicy: input.sandboxPolicy ?? 'workspace-write',
    contextPolicy: input.contextPolicy ?? 'workspace-aware',
    autoInvoke: input.autoInvoke ?? true,
    approvalRequired: input.approvalRequired ?? true,
    createdAt: now,
    updatedAt: now,
  })!
}

export function toAgentConfigInput(agent: SavedAgentConfig): AgentConfigInput {
  return {
    name: agent.name,
    role: agent.role,
    description: agent.description ?? '',
    avatar: agent.avatar ?? null,
    systemPrompt: agent.systemPrompt ?? '',
    color: agent.color ?? '#111827',
    modelId: agent.modelId ?? null,
    runtimeType: agent.runtimeType ?? 'llm',
    codeAgentType: agent.runtimeType === 'code-agent' ? (agent.codeAgentType ?? 'codex') : null,
    capabilityTags: [...(agent.capabilityTags ?? [])],
    toolPermissions: [...(agent.toolPermissions ?? [])],
    sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
    contextPolicy: agent.contextPolicy ?? 'workspace-aware',
    autoInvoke: agent.autoInvoke ?? true,
    approvalRequired: agent.approvalRequired ?? true,
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
    description: input.description?.trim() ?? '',
    avatar: input.avatar ?? null,
    systemPrompt: input.systemPrompt?.trim() ?? '',
    color: input.color || '#111827',
    modelId: input.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (input.codeAgentType ?? 'codex') : null,
    capabilityTags: Array.isArray(input.capabilityTags) ? input.capabilityTags : [],
    toolPermissions: Array.isArray(input.toolPermissions) && input.toolPermissions.length ? input.toolPermissions : [],
    sandboxPolicy: input.sandboxPolicy ?? 'workspace-write',
    contextPolicy: input.contextPolicy ?? 'workspace-aware',
    autoInvoke: input.autoInvoke ?? true,
    approvalRequired: input.approvalRequired ?? true,
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
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
