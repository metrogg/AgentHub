import type { AgentRunProfile } from '../agent-runner'

/**
 * 最小化的 Agent DB 行类型，兼容 workspaceAgents.$inferSelect 和 planner 生成的 agent 对象。
 * 只要求必须存在的字段，其余可选。
 */
export interface AgentRow {
  id: string
  name: string
  role?: string | null
  roleType?: string | null
  description?: string | null
  systemPrompt?: string | null
  roleProfile?: Record<string, unknown> | null
  color?: string | null
  modelId?: string | null
  runtimeType?: string | null
  codeAgentType?: string | null
  capabilityTags?: string[] | null
  skillIds?: string[] | null
  toolPermissions?: string[] | null
  sandboxPolicy?: string | null
  contextPolicy?: string | null
  approvalRequired?: boolean | null
}

/** PolicyGuard 评估后的策略覆盖 */
export interface PolicyOverrides {
  toolPermissions?: string[]
  sandboxPolicy?: string
  contextPolicy?: string
  approvalRequired?: boolean
}

/**
 * 统一的 AgentRunProfile 构建器。
 *
 * 替代以下重复实现：
 * - messages.ts:toAgentProfile
 * - workspace/agent-runtime.ts:workspaceAgentRunProfile
 * - orchestrator-engine.ts 内联 profile 构建
 *
 * @param agent - Agent DB 行或 planner 生成的 agent 对象
 * @param projectPath - 项目路径（可选，worktree 路径会覆盖）
 * @param overrides - PolicyGuard 策略覆盖（可选）
 */
export function buildAgentProfile(
  agent: AgentRow,
  projectPath?: string | null,
  overrides?: PolicyOverrides,
): AgentRunProfile {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role ?? undefined,
    roleType: agent.roleType ?? undefined,
    description: agent.description ?? undefined,
    systemPrompt: agent.systemPrompt ?? undefined,
    color: agent.color ?? undefined,
    modelId: agent.modelId ?? null,
    runtimeType: normalizeRuntimeType(agent.runtimeType),
    codeAgentType: normalizeCodeAgentType(agent),
    a2aEndpoint: resolveA2AEndpoint(agent),
    capabilityTags: agent.capabilityTags ?? [],
    skillIds: agent.skillIds ?? [],
    toolPermissions: overrides?.toolPermissions ?? agent.toolPermissions ?? [],
    sandboxPolicy: (overrides?.sandboxPolicy ?? agent.sandboxPolicy ?? 'workspace-write') as AgentRunProfile['sandboxPolicy'],
    contextPolicy: (overrides?.contextPolicy ?? agent.contextPolicy ?? 'workspace-aware') as AgentRunProfile['contextPolicy'],
    approvalRequired: overrides?.approvalRequired ?? agent.approvalRequired ?? false,
    projectPath: projectPath?.trim() || null,
  }
}

function resolveA2AEndpoint(agent: AgentRow): string | null {
  const profile = agent.roleProfile ?? {}
  const profileEndpoint =
    stringValue(profile.a2aEndpoint) ??
    stringValue(profile.agentCardUrl) ??
    stringValue(profile.endpoint)
  if (profileEndpoint) return profileEndpoint
  if (looksLikeUrl(agent.modelId) && stringValue(profile.protocol) === 'a2a') return agent.modelId!.trim()
  return null
}

function normalizeRuntimeType(value?: string | null): AgentRunProfile['runtimeType'] {
  if (value === 'llm') return 'llm'
  return 'code-agent'
}

function normalizeCodeAgentType(agent: AgentRow): AgentRunProfile['codeAgentType'] {
  if (normalizeRuntimeType(agent.runtimeType) !== 'code-agent') return undefined
  if (
    agent.codeAgentType === 'codex' ||
    agent.codeAgentType === 'claude-code' ||
    agent.codeAgentType === 'opencode' ||
    agent.codeAgentType === 'gemini'
  ) {
    return agent.codeAgentType
  }
  return 'codex'
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function looksLikeUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim())
}

/**
 * 构建带执行目录覆盖的 AgentRunProfile。
 * 参数名保留 worktreePath 兼容旧调用；当前也可传普通 Agent 工作目录。
 */
export function buildAgentProfileWithWorktree(
  agent: AgentRow,
  worktreePath: string | null | undefined,
  originalProjectPath: string | null | undefined,
  overrides?: PolicyOverrides,
): AgentRunProfile {
  const profile = buildAgentProfile(agent, worktreePath ?? originalProjectPath ?? null, overrides)
  return {
    ...profile,
    projectPath: worktreePath ?? originalProjectPath ?? null,
    originalProjectPath: originalProjectPath ?? null,
  }
}
