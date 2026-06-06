import type { ManagerAction, MemberProposal } from './types'

const ROLE_TYPES = new Set([
  'clarifier',
  'architect',
  'researcher',
  'coder',
  'verifier',
  'reviewer',
  'integrator',
  'custom',
])

const CODE_AGENT_TYPES = new Set(['codex', 'claude-code', 'opencode', 'gemini'])
const WORKER_RUNTIME_BASES = new Set(['openclaw', 'qwenpaw', 'codex', 'claude-code', 'opencode', 'gemini'])
const SANDBOX_POLICIES = new Set(['workspace-write', 'danger-full-access'])
const CONTEXT_POLICIES = new Set(['recent-only', 'pinned-recent', 'workspace-aware'])

export function memberProposalsFromManagerAction(action: ManagerAction): MemberProposal[] {
  if (action.type === 'propose_members') {
    return normalizeMemberProposals(action.memberProposals)
  }
  if (action.type !== 'create_worker') return []
  const metadata = asRecord(action.metadata)
  const explicitProposal = asRecord(metadata.memberProposal)
  const proposal = normalizeMemberProposal({
    expertProfileId: stringValue(metadata.expertProfileId) ?? stringValue(explicitProposal.expertProfileId),
    name:
      stringValue(metadata.name) ??
      stringValue(metadata.workerName) ??
      stringValue(explicitProposal.name) ??
      action.taskTitle ??
      'New Worker',
    role:
      stringValue(metadata.role) ??
      stringValue(metadata.workerRole) ??
      stringValue(explicitProposal.role) ??
      action.message ??
      'Worker',
    reason:
      action.reason ??
      stringValue(metadata.reason) ??
      stringValue(explicitProposal.reason) ??
      'Manager requested a new Worker for the current goal.',
    expectedContribution:
      stringValue(metadata.expectedContribution) ??
      stringValue(explicitProposal.expectedContribution) ??
      action.taskDescription ??
      action.message,
    category: stringValue(metadata.category) ?? stringValue(explicitProposal.category),
    roleType: stringValue(metadata.roleType) ?? stringValue(explicitProposal.roleType),
    description:
      stringValue(metadata.description) ??
      stringValue(explicitProposal.description) ??
      action.taskDescription ??
      action.message,
    systemPrompt: stringValue(metadata.systemPrompt) ?? stringValue(explicitProposal.systemPrompt),
    runtimeType: stringValue(metadata.runtimeType) ?? stringValue(explicitProposal.runtimeType),
    codeAgentType: stringValue(metadata.codeAgentType) ?? stringValue(explicitProposal.codeAgentType),
    workerRuntimeBase: stringValue(metadata.workerRuntimeBase) ?? stringValue(explicitProposal.workerRuntimeBase),
    color: stringValue(metadata.color) ?? stringValue(explicitProposal.color),
    modelId: stringValue(metadata.modelId) ?? stringValue(explicitProposal.modelId),
    capabilityTags: stringArray(metadata.capabilityTags) ?? stringArray(explicitProposal.capabilityTags),
    skillIds: stringArray(metadata.skillIds) ?? stringArray(explicitProposal.skillIds),
    toolPermissions: stringArray(metadata.toolPermissions) ?? stringArray(explicitProposal.toolPermissions),
    sandboxPolicy: stringValue(metadata.sandboxPolicy) ?? stringValue(explicitProposal.sandboxPolicy),
    contextPolicy: stringValue(metadata.contextPolicy) ?? stringValue(explicitProposal.contextPolicy),
  })
  return proposal ? [proposal] : []
}

export function normalizeMemberProposals(value: unknown): MemberProposal[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => normalizeMemberProposal(item))
    .filter((item): item is MemberProposal => Boolean(item))
}

export function normalizeMemberProposal(value: unknown): MemberProposal | null {
  const record = asRecord(value)
  const name = stringValue(record.name)
  const role = stringValue(record.role)
  const reason = stringValue(record.reason)
  if (!name || !role || !reason) return null
  const id = stringValue(record.expertProfileId) ?? `manager-worker:${slug(name)}`
  const roleType = stringValue(record.roleType)
  const codeAgentType = stringValue(record.codeAgentType)
  const workerRuntimeBase = stringValue(record.workerRuntimeBase)
  const sandboxPolicy = stringValue(record.sandboxPolicy)
  const contextPolicy = stringValue(record.contextPolicy)
  return {
    expertProfileId: id,
    name,
    role,
    reason,
    category: stringValue(record.category) ?? 'manager-requested',
    roleType: roleType && ROLE_TYPES.has(roleType) ? (roleType as MemberProposal['roleType']) : 'custom',
    description: stringValue(record.description) ?? stringValue(record.expectedContribution) ?? reason,
    systemPrompt:
      stringValue(record.systemPrompt) ??
      `你是 ${name}，角色是 ${role}。请根据任务目标、Room timeline 和共享产物完成被 @ 分配的工作。`,
    runtimeType: 'code-agent',
    codeAgentType: codeAgentType && CODE_AGENT_TYPES.has(codeAgentType) ? (codeAgentType as MemberProposal['codeAgentType']) : 'codex',
    workerRuntimeBase:
      workerRuntimeBase && WORKER_RUNTIME_BASES.has(workerRuntimeBase)
        ? (workerRuntimeBase as MemberProposal['workerRuntimeBase'])
        : codeAgentType && WORKER_RUNTIME_BASES.has(codeAgentType)
          ? (codeAgentType as MemberProposal['workerRuntimeBase'])
          : 'codex',
    color: stringValue(record.color) ?? '#0f766e',
    modelId: stringValue(record.modelId) ?? null,
    capabilityTags: stringArray(record.capabilityTags) ?? [],
    skillIds: stringArray(record.skillIds) ?? [],
    toolPermissions: stringArray(record.toolPermissions) ?? ['chat', 'workspace:read', 'workspace:write'],
    sandboxPolicy:
      sandboxPolicy && SANDBOX_POLICIES.has(sandboxPolicy) ? (sandboxPolicy as MemberProposal['sandboxPolicy']) : 'workspace-write',
    contextPolicy:
      contextPolicy && CONTEXT_POLICIES.has(contextPolicy) ? (contextPolicy as MemberProposal['contextPolicy']) : 'workspace-aware',
    expectedContribution: stringValue(record.expectedContribution) ?? reason,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return null
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return items.length ? items : null
}

function slug(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '')
  return normalized.slice(0, 72) || 'worker'
}
