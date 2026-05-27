import { api, type AgentConfigInput } from './api'
import {
  loadAgentLibrary,
  saveAgentLibrary,
  type SavedAgentConfig,
} from './agentLibrary'

let started = false

export async function ensureCodingToolsStartupLifecycle() {
  if (started || typeof window === 'undefined') return
  started = true

  repairLocalAgentLibrary()
  await api.ensureCodingToolsStartupLifecycle().catch(() => undefined)
}

function repairLocalAgentLibrary() {
  const agents = loadAgentLibrary()
  let changed = false
  const repaired = agents.map((agent) => {
    const next = normalizeCodingToolAgent(agent)
    if (next !== agent) changed = true
    return next
  })

  if (!changed) return
  saveAgentLibrary(repaired)
}

function normalizeCodingToolAgent(agent: SavedAgentConfig): SavedAgentConfig {
  if (agent.runtimeType !== 'code-agent') return agent
  const patch: Partial<AgentConfigInput> = {}
  if (!agent.codeAgentType) patch.codeAgentType = 'codex'
  if (agent.approvalRequired !== false) patch.approvalRequired = false
  if (!agent.sandboxPolicy) patch.sandboxPolicy = 'workspace-write'
  if (!agent.toolPermissions?.length) patch.toolPermissions = ['chat', 'workspace:read', 'workspace:write']
  if (!Object.keys(patch).length) return agent
  return { ...agent, ...patch, updatedAt: new Date().toISOString() }
}

export function resetCodingToolsStartupLifecycleForTests() {
  started = false
}
