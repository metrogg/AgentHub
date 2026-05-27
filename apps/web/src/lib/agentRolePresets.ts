import type { AgentConfigInput, AgentRelationType, AgentRoleType } from './api'

export interface AgentRolePreset extends AgentConfigInput {
  roleType: Exclude<AgentRoleType, 'custom'>
  label: string
  acceptsTaskTypes: string[]
  produces: string[]
}

export const agentRolePresets: AgentRolePreset[] = [
  {
    roleType: 'clarifier',
    label: '需求澄清',
    name: 'Clarifier',
    role: '需求澄清',
    description: '澄清目标、范围、约束和验收标准，避免团队在模糊需求上误跑。',
    systemPrompt: '你是需求澄清 Agent。先判断目标是否清楚；如有关键缺口，提出少量可回答的问题；输出假设、边界和验收标准。',
    color: '#0f766e',
    runtimeType: 'llm',
    codeAgentType: null,
    capabilityTags: ['clarify', 'requirements', 'acceptance'],
    toolPermissions: ['chat'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    acceptsTaskTypes: ['read', 'design'],
    produces: ['decision', 'risk', 'task_output'],
  },
  {
    roleType: 'architect',
    label: '架构规划',
    name: 'Architect',
    role: '架构规划',
    description: '拆解目标、定义边界、规划里程碑和依赖关系。',
    systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑、依赖关系和任务契约。',
    color: '#6366f1',
    runtimeType: 'llm',
    codeAgentType: null,
    capabilityTags: ['planning', 'architecture', 'design'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    acceptsTaskTypes: ['read', 'design', 'synthesize'],
    produces: ['decision', 'risk', 'task_output'],
  },
  {
    roleType: 'researcher',
    label: '资料研究',
    name: 'Researcher',
    role: '资料研究',
    description: '补充资料、比较方案、阅读上下文并标记不确定点。',
    systemPrompt: '你是研究员。补充资料、比较方案、标记不确定点，给出来源和置信度。',
    color: '#f59e0b',
    runtimeType: 'llm',
    codeAgentType: null,
    capabilityTags: ['research', 'sources', 'analysis'],
    toolPermissions: ['chat', 'workspace:read', 'skills:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    acceptsTaskTypes: ['read', 'research'],
    produces: ['fact', 'risk', 'decision'],
  },
  {
    roleType: 'coder',
    label: '代码实现',
    name: 'Coder',
    role: '代码实现',
    description: '负责代码实现、组件接入和小步验证。',
    systemPrompt: '你是实现者。按任务契约小步修改代码，优先保持现有风格，完成后给出 diff、验证结果和风险。',
    color: '#10b981',
    runtimeType: 'code-agent',
    codeAgentType: 'claude-code',
    capabilityTags: ['code', 'implementation', 'workspace-write'],
    toolPermissions: ['chat', 'workspace:read', 'workspace:write'],
    sandboxPolicy: 'workspace-write',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    acceptsTaskTypes: ['code', 'test'],
    produces: ['artifact_ref', 'diff_summary', 'test_result', 'task_output'],
  },
  {
    roleType: 'reviewer',
    label: '代码审查',
    name: 'Reviewer',
    role: '代码审查',
    description: '检查风险、交互漏洞、代码质量和缺失测试。',
    systemPrompt: '你是审查者。优先指出 bug、风险、回归和缺失测试；结论直接、可执行，不重写无关代码。',
    color: '#ef4444',
    runtimeType: 'llm',
    codeAgentType: null,
    capabilityTags: ['review', 'quality', 'test'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    acceptsTaskTypes: ['review', 'test'],
    produces: ['risk', 'test_result', 'task_output'],
  },
  {
    roleType: 'integrator',
    label: '汇总交付',
    name: 'Integrator',
    role: '汇总交付',
    description: '整合多 Agent 产出、冲突和风险，形成最终交付建议。',
    systemPrompt: '你是交付整合者。汇总各 Agent 的产出、冲突、验证结果和剩余风险，给用户清晰的最终建议。',
    color: '#2563eb',
    runtimeType: 'llm',
    codeAgentType: null,
    capabilityTags: ['synthesize', 'delivery', 'summary'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    acceptsTaskTypes: ['synthesize', 'review'],
    produces: ['decision', 'risk', 'task_output'],
  },
]

export const defaultAgentRelations: Array<{
  sourceRoleType: AgentRoleType
  targetRoleType: AgentRoleType
  relationType: AgentRelationType
  note: string
}> = [
  { sourceRoleType: 'clarifier', targetRoleType: 'architect', relationType: 'handoff_to', note: '需求澄清后交给架构规划' },
  { sourceRoleType: 'architect', targetRoleType: 'coder', relationType: 'handoff_to', note: '架构计划交给实现者' },
  { sourceRoleType: 'coder', targetRoleType: 'reviewer', relationType: 'reviewed_by', note: '代码实现完成后由 Reviewer 审查' },
  { sourceRoleType: 'reviewer', targetRoleType: 'integrator', relationType: 'handoff_to', note: '审查结论交给汇总交付' },
  { sourceRoleType: 'coder', targetRoleType: 'architect', relationType: 'fallback_to', note: '实现受阻时回到架构拆解' },
]

export function presetForRole(roleType?: AgentRoleType) {
  return agentRolePresets.find((preset) => preset.roleType === roleType)
}

export function inferRoleType(input: Partial<Pick<AgentConfigInput, 'name' | 'role' | 'capabilityTags' | 'roleType'>>): AgentRoleType {
  if (input.roleType && input.roleType !== 'custom') return input.roleType
  const text = [input.name ?? '', input.role ?? '', ...(input.capabilityTags ?? [])].join(' ').toLowerCase()
  if (text.includes('clarif') || text.includes('需求') || text.includes('澄清')) return 'clarifier'
  if (text.includes('architect') || text.includes('规划') || text.includes('架构')) return 'architect'
  if (text.includes('research') || text.includes('研究')) return 'researcher'
  if (text.includes('coder') || text.includes('code') || text.includes('实现')) return 'coder'
  if (text.includes('review') || text.includes('test') || text.includes('审查')) return 'reviewer'
  if (text.includes('integrat') || text.includes('summary') || text.includes('交付') || text.includes('汇总')) return 'integrator'
  return 'custom'
}
