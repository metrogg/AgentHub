export const AGENT_ROLE_TYPES = [
  'orchestrator',
  'clarifier',
  'architect',
  'researcher',
  'coder',
  'verifier',
  'reviewer',
  'integrator',
  'custom',
] as const

export const AGENT_RELATION_TYPES = [
  'handoff_to',
  'reviewed_by',
  'fallback_to',
  'reports_to',
  'blocks',
] as const

export type AgentRoleType = (typeof AGENT_ROLE_TYPES)[number]
export type AgentRelationType = (typeof AGENT_RELATION_TYPES)[number]

export interface AgentRoleProfile {
  goal: string
  responsibilities: string[]
  acceptsTaskTypes: string[]
  produces: string[]
  requiredInputs: string[]
  qualityGates: string[]
  canUseTools: string[]
  cannotDo: string[]
}

export interface AgentRolePreset {
  roleType: AgentRoleType
  name: string
  role: string
  description: string
  systemPrompt: string
  color: string
  runtimeType: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  capabilityTags: string[]
  toolPermissions: string[]
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
  contextPolicy: 'recent-only' | 'pinned-recent' | 'workspace-aware'
  autoInvoke: boolean
  approvalRequired: boolean
  roleProfile: AgentRoleProfile
}

export const ROLE_PRESETS: Record<Exclude<AgentRoleType, 'custom'>, AgentRolePreset> = {
  orchestrator: {
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
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    roleProfile: {
      goal: '理解用户意图并协调多 Agent 协作完成任务。',
      responsibilities: ['理解需求', '制定计划', '调度 Agent', '汇总结果'],
      acceptsTaskTypes: ['read', 'design', 'synthesize'],
      produces: ['decision', 'risk', 'task_output'],
      requiredInputs: ['user_goal'],
      qualityGates: ['计划必须可执行', 'Agent 分工必须明确'],
      canUseTools: ['chat', 'workspace:read'],
      cannotDo: ['直接修改代码', '绕过用户确认执行高风险操作'],
    },
  },
  clarifier: {
    roleType: 'clarifier',
    name: 'Clarifier',
    role: '需求澄清',
    description: '澄清目标、范围、约束和验收标准，避免团队在模糊需求上误跑。',
    systemPrompt: '你是需求澄清 Agent。先判断目标是否清楚；如有关键缺口，提出少量可回答的问题；输出假设、边界和验收标准。',
    color: '#0f766e',
    runtimeType: 'llm',
    capabilityTags: ['clarify', 'requirements', 'acceptance'],
    toolPermissions: ['chat'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    roleProfile: {
      goal: '把模糊用户目标转成可规划任务。',
      responsibilities: ['澄清目标', '整理约束', '定义验收标准'],
      acceptsTaskTypes: ['read', 'design'],
      produces: ['decision', 'risk', 'task_output'],
      requiredInputs: ['user_goal'],
      qualityGates: ['问题必须少而关键', '假设必须显式'],
      canUseTools: ['chat'],
      cannotDo: ['修改代码', '替用户做高风险决定'],
    },
  },
  architect: {
    roleType: 'architect',
    name: 'Architect',
    role: '架构规划',
    description: '拆解目标、定义边界、规划里程碑和依赖关系。',
    systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑、依赖关系和任务契约。',
    color: '#6366f1',
    runtimeType: 'code-agent',
    codeAgentType: 'claude-code',
    capabilityTags: ['planning', 'architecture', 'design'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    roleProfile: {
      goal: '把需求拆成可执行协作计划。',
      responsibilities: ['模块拆解', '接口定义', '任务依赖', '输出契约'],
      acceptsTaskTypes: ['read', 'design', 'synthesize'],
      produces: ['decision', 'risk', 'task_output'],
      requiredInputs: ['goal', 'requirements', 'workspace_context'],
      qualityGates: ['依赖清晰', '任务边界明确', '验收标准可检查'],
      canUseTools: ['workspace:read'],
      cannotDo: ['直接提交代码变更'],
    },
  },
  researcher: {
    roleType: 'researcher',
    name: 'Researcher',
    role: '资料研究',
    description: '补充资料、比较方案、阅读上下文并标记不确定点。',
    systemPrompt: '你是研究员。补充资料、比较方案、标记不确定点，给出来源和置信度。',
    color: '#f59e0b',
    runtimeType: 'code-agent',
    codeAgentType: 'opencode',
    capabilityTags: ['research', 'sources', 'analysis'],
    toolPermissions: ['chat', 'workspace:read', 'skills:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    roleProfile: {
      goal: '提供可追溯事实和方案比较。',
      responsibilities: ['资料收集', '相似实现分析', '风险标记'],
      acceptsTaskTypes: ['read', 'research'],
      produces: ['fact', 'risk', 'decision'],
      requiredInputs: ['research_question'],
      qualityGates: ['标明来源', '区分事实和推断'],
      canUseTools: ['workspace:read', 'skills:read'],
      cannotDo: ['修改代码'],
    },
  },
  coder: {
    roleType: 'coder',
    name: 'Coder',
    role: '代码实现',
    description: '负责代码实现、组件接入和小步验证。',
    systemPrompt: '你是实现者。按任务契约小步修改代码，优先保持现有风格，完成后给出 diff、验证结果和风险。',
    color: '#10b981',
    runtimeType: 'code-agent',
    codeAgentType: 'codex',
    capabilityTags: ['code', 'implementation', 'workspace-write'],
    toolPermissions: ['chat', 'workspace:read', 'workspace:write'],
    sandboxPolicy: 'workspace-write',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    roleProfile: {
      goal: '按契约实现代码变更。',
      responsibilities: ['代码修改', '本地验证', '产物记录'],
      acceptsTaskTypes: ['code', 'test'],
      produces: ['artifact_ref', 'diff_summary', 'test_result', 'task_output'],
      requiredInputs: ['spec', 'allowed_paths', 'acceptance_criteria'],
      qualityGates: ['只改允许路径', '验证命令有结果', '输出 diff 摘要'],
      canUseTools: ['workspace:read', 'workspace:write'],
      cannotDo: ['绕过审查合并', '修改无关文件'],
    },
  },
  verifier: {
    roleType: 'verifier',
    name: 'Verifier',
    role: '验证执行',
    description: '在沙箱中运行测试、构建、类型检查，产出 pass/fail 报告和日志。',
    systemPrompt: '你是验证执行 Agent。在隔离环境中运行测试、构建、类型检查等验证命令，产出结构化测试结果。你只做验证，不修改代码。',
    color: '#d946ef',
    runtimeType: 'code-agent',
    codeAgentType: 'claude-code',
    capabilityTags: ['verify', 'test', 'build', 'typecheck', 'lint'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    roleProfile: {
      goal: '可靠地验证代码变更是否通过自动化检查。',
      responsibilities: ['运行测试', '执行构建', '类型检查', '输出结构化结果'],
      acceptsTaskTypes: ['test', 'verify'],
      produces: ['test_result', 'task_output'],
      requiredInputs: ['project_path', 'test_commands', 'expected_outcomes'],
      qualityGates: ['命令必须可复现', '结果必须结构化', '失败必须有日志'],
      canUseTools: ['workspace:read'],
      cannotDo: ['修改代码', '跳过失败测试'],
    },
  },
  reviewer: {
    roleType: 'reviewer',
    name: 'Reviewer',
    role: '代码审查',
    description: '检查风险、交互漏洞、代码质量和缺失测试。',
    systemPrompt: '你是审查者。优先指出 bug、风险、回归和缺失测试；结论直接、可执行，不重写无关代码。',
    color: '#ef4444',
    runtimeType: 'code-agent',
    codeAgentType: 'claude-code',
    capabilityTags: ['review', 'quality', 'test'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    roleProfile: {
      goal: '审查代码变更并给出修复建议。',
      responsibilities: ['diff 审查', '测试缺口', '安全边界', '回归风险'],
      acceptsTaskTypes: ['review', 'test'],
      produces: ['risk', 'test_result', 'task_output'],
      requiredInputs: ['diff', 'contract', 'test_result'],
      qualityGates: ['发现必须可定位', '建议必须可执行'],
      canUseTools: ['workspace:read'],
      cannotDo: ['默认直接修改代码', '批准未验证变更'],
    },
  },
  integrator: {
    roleType: 'integrator',
    name: 'Integrator',
    role: '汇总交付',
    description: '整合多 Agent 产出、冲突和风险，形成最终交付建议。',
    systemPrompt: '你是交付整合者。汇总各 Agent 的产出、冲突、验证结果和剩余风险，给用户清晰的最终建议。',
    color: '#2563eb',
    runtimeType: 'code-agent',
    codeAgentType: 'claude-code',
    capabilityTags: ['synthesize', 'delivery', 'summary'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
    roleProfile: {
      goal: '把协作过程整理成用户可决策的交付结果。',
      responsibilities: ['最终汇总', '风险说明', '合并建议'],
      acceptsTaskTypes: ['synthesize', 'review'],
      produces: ['decision', 'risk', 'task_output'],
      requiredInputs: ['task_outputs', 'review_results', 'conflicts'],
      qualityGates: ['区分已完成和未完成', '明确下一步'],
      canUseTools: ['workspace:read'],
      cannotDo: ['未经用户确认合并代码'],
    },
  },
}

/** 默认代码团队角色（总指挥-实现-审查） */
export const DEFAULT_CODE_TEAM_ROLE_TYPES: Array<Exclude<AgentRoleType, 'custom' | 'clarifier' | 'architect' | 'researcher' | 'verifier' | 'integrator'>> = [
  'orchestrator',
  'coder',
  'reviewer',
]

/** 默认代码团队协作关系：Orchestrator -> Coder -> Reviewer */
export const DEFAULT_CODE_TEAM_RELATIONS: Array<{
  sourceRoleType: AgentRoleType
  targetRoleType: AgentRoleType
  relationType: AgentRelationType
  note: string
}> = [
  { sourceRoleType: 'orchestrator', targetRoleType: 'coder', relationType: 'handoff_to', note: '总指挥派发任务给实现者' },
  { sourceRoleType: 'coder', targetRoleType: 'reviewer', relationType: 'reviewed_by', note: '代码实现后由 Reviewer 审查' },
  { sourceRoleType: 'coder', targetRoleType: 'orchestrator', relationType: 'fallback_to', note: '实现受阻时回到总指挥重新规划' },
]

export function rolePresetValues(roleType: Exclude<AgentRoleType, 'custom'>) {
  const preset = ROLE_PRESETS[roleType]
  return {
    name: preset.name,
    role: preset.role,
    roleType: preset.roleType,
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    roleProfile: preset.roleProfile as unknown as Record<string, unknown>,
    color: preset.color,
    runtimeType: preset.runtimeType,
    codeAgentType: preset.codeAgentType ?? null,
    capabilityTags: preset.capabilityTags,
    toolPermissions: preset.toolPermissions,
    sandboxPolicy: preset.sandboxPolicy,
    contextPolicy: preset.contextPolicy,
    autoInvoke: preset.autoInvoke,
    approvalRequired: preset.approvalRequired,
  }
}

export function inferRoleType(agent: {
  roleType?: string | null
  name?: string | null
  role?: string | null
  capabilityTags?: string[] | null
}): AgentRoleType {
  if (agent.roleType && agent.roleType !== 'custom') return agent.roleType as AgentRoleType
  const text = [agent.name ?? '', agent.role ?? '', ...(agent.capabilityTags ?? [])].join(' ').toLowerCase()
  if (text.includes('orchestrator') || text.includes('总指挥') || text.includes('协调') || text.includes('调度')) return 'orchestrator'
  if (text.includes('clarif') || text.includes('需求') || text.includes('澄清')) return 'clarifier'
  if (text.includes('architect') || text.includes('规划') || text.includes('架构')) return 'architect'
  if (text.includes('research') || text.includes('研究')) return 'researcher'
  if (text.includes('coder') || text.includes('code') || text.includes('实现')) return 'coder'
  if (text.includes('verif') || text.includes('验证') || text.includes('测试') || text.includes('build')) return 'verifier'
  if (text.includes('review') || text.includes('审查')) return 'reviewer'
  if (text.includes('integrat') || text.includes('summary') || text.includes('交付') || text.includes('汇总')) return 'integrator'
  return 'custom'
}
