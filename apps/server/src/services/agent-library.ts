import { db, eq, settings, workspaceAgents } from '@agenthub/db'

export const AGENT_LIBRARY_SETTING_KEY = 'AGENT_LIBRARY'

export interface SavedAgentConfig {
  id: string
  name: string
  role: string
  roleType?: string
  description?: string
  avatar?: string | null
  systemPrompt?: string
  roleProfile?: Record<string, unknown> | null
  color?: string
  modelId?: string | null
  runtimeType?: string
  codeAgentType?: string | null
  capabilityTags?: string[]
  skillIds?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: string
  contextPolicy?: string
  autoInvoke?: boolean
  approvalRequired?: boolean
  createdAt: string
  updatedAt: string
}

interface AgentLibraryState {
  schemaVersion: 2
  agents: SavedAgentConfig[]
  relations: unknown[]
}

export async function syncWorkspaceAgentToAgentLibrary(
  agent: typeof workspaceAgents.$inferSelect,
): Promise<SavedAgentConfig> {
  const library = await readAgentLibraryState()
  const existing = findExistingSavedAgent(library.agents, agent)
  const savedAgent = workspaceAgentToSavedAgentConfig(agent, existing)
  const agents = [savedAgent, ...library.agents.filter((item) => item.id !== savedAgent.id && !sameSavedAgentIdentity(item, savedAgent))]
  const next: AgentLibraryState = {
    schemaVersion: 2,
    agents,
    relations: pruneRelations(library.relations, agents),
  }
  await db
    .insert(settings)
    .values({
      key: AGENT_LIBRARY_SETTING_KEY,
      value: JSON.stringify(next),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: JSON.stringify(next),
        updatedAt: new Date(),
      },
    })
  return savedAgent
}

async function readAgentLibraryState(): Promise<AgentLibraryState> {
  const [row] = await db.select().from(settings).where(eq(settings.key, AGENT_LIBRARY_SETTING_KEY)).limit(1)
  if (!row?.value) return { schemaVersion: 2, agents: [], relations: [] }
  try {
    const parsed = JSON.parse(row.value) as Partial<AgentLibraryState> & { agents?: unknown; relations?: unknown }
    return {
      schemaVersion: 2,
      agents: Array.isArray(parsed.agents)
        ? parsed.agents.map(normalizeSavedAgent).filter((agent): agent is SavedAgentConfig => Boolean(agent))
        : [],
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
    }
  } catch {
    return { schemaVersion: 2, agents: [], relations: [] }
  }
}

function workspaceAgentToSavedAgentConfig(
  agent: typeof workspaceAgents.$inferSelect,
  existing: SavedAgentConfig | null,
): SavedAgentConfig {
  const now = new Date().toISOString()
  const runtimeType = normalizeRuntimeType(agent.runtimeType)
  return {
    id: existing?.id ?? agent.id,
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType ?? 'custom',
    description: agent.description ?? '',
    avatar: agent.avatar ?? null,
    systemPrompt: agent.systemPrompt ?? '',
    roleProfile: agent.roleProfile ?? null,
    color: agent.color ?? '#111827',
    modelId: runtimeType === 'code-agent' ? (agent.modelId ?? null) : agent.modelId,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (agent.codeAgentType ?? null) : null,
    capabilityTags: Array.isArray(agent.capabilityTags) ? agent.capabilityTags : [],
    skillIds: Array.isArray(agent.skillIds) ? agent.skillIds : [],
    toolPermissions: Array.isArray(agent.toolPermissions) ? agent.toolPermissions : [],
    sandboxPolicy: normalizeSandboxPolicy(agent.sandboxPolicy),
    contextPolicy: agent.contextPolicy ?? 'workspace-aware',
    autoInvoke: agent.autoInvoke ?? true,
    approvalRequired: runtimeType === 'code-agent' ? false : (agent.approvalRequired ?? true),
    createdAt: existing?.createdAt ?? dateToIso(agent.createdAt) ?? now,
    updatedAt: now,
  }
}

function findExistingSavedAgent(
  agents: SavedAgentConfig[],
  workspaceAgent: typeof workspaceAgents.$inferSelect,
) {
  const byId = agents.find((agent) => agent.id === workspaceAgent.id)
  if (byId) return byId
  const candidate = workspaceAgentToSavedAgentConfig(workspaceAgent, null)
  return agents.find((agent) => sameSavedAgentIdentity(agent, candidate)) ?? null
}

function normalizeSavedAgent(value: unknown): SavedAgentConfig | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SavedAgentConfig>
  const name = input.name?.trim()
  const role = input.role?.trim()
  if (!name || !role) return null
  const runtimeType = normalizeRuntimeType(input.runtimeType)
  const now = new Date().toISOString()
  return {
    id: input.id?.trim() || `${name}:${role}`,
    name,
    role,
    roleType: input.roleType ?? 'custom',
    description: input.description?.trim() ?? '',
    avatar: input.avatar ?? null,
    systemPrompt: input.systemPrompt?.trim() ?? '',
    roleProfile: input.roleProfile ?? null,
    color: input.color || '#111827',
    modelId: runtimeType === 'code-agent' ? (input.modelId ?? null) : input.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (input.codeAgentType ?? null) : null,
    capabilityTags: Array.isArray(input.capabilityTags) ? input.capabilityTags : [],
    skillIds: Array.isArray(input.skillIds) ? input.skillIds : [],
    toolPermissions: Array.isArray(input.toolPermissions) ? input.toolPermissions : [],
    sandboxPolicy: normalizeSandboxPolicy(input.sandboxPolicy),
    contextPolicy: input.contextPolicy ?? 'workspace-aware',
    autoInvoke: input.autoInvoke ?? true,
    approvalRequired: runtimeType === 'code-agent' ? false : (input.approvalRequired ?? true),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
}

function sameSavedAgentIdentity(a: SavedAgentConfig, b: SavedAgentConfig) {
  return (
    a.name.trim().toLowerCase() === b.name.trim().toLowerCase() &&
    a.role.trim().toLowerCase() === b.role.trim().toLowerCase() &&
    normalizeRuntimeType(a.runtimeType) === normalizeRuntimeType(b.runtimeType) &&
    normalizeCodeAgentType(a.codeAgentType) === normalizeCodeAgentType(b.codeAgentType)
  )
}

function pruneRelations(relations: unknown[], agents: SavedAgentConfig[]) {
  const ids = new Set(agents.map((agent) => agent.id))
  return relations.filter((relation) => {
    if (!relation || typeof relation !== 'object') return false
    const item = relation as { sourceAgentId?: unknown; targetAgentId?: unknown }
    return typeof item.sourceAgentId === 'string' && typeof item.targetAgentId === 'string' && ids.has(item.sourceAgentId) && ids.has(item.targetAgentId)
  })
}

function normalizeRuntimeType(value?: string | null) {
  return value === 'llm' ? 'llm' : 'code-agent'
}

function normalizeCodeAgentType(value?: string | null) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeSandboxPolicy(value?: string | null) {
  return value === 'danger-full-access' ? 'danger-full-access' : 'workspace-write'
}

function dateToIso(value: Date | string | number | null | undefined) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
