import { z } from 'zod'
import { AGENT_ROLE_TYPES, inferRoleType } from './workspace/agent-role-presets'

export const confirmAgentDraftSchema = z.object({
  draft: z
    .object({
      name: z.string().min(1).max(60),
      role: z.string().min(1).max(60),
      roleType: z.enum(AGENT_ROLE_TYPES).default('custom'),
      description: z.string().max(500).default(''),
      avatar: z.string().max(500).nullable().optional(),
      systemPrompt: z.string().max(4000).default(''),
      roleProfile: z.record(z.unknown()).nullable().optional(),
      color: z.string().max(20).default('#111827'),
      modelId: z.string().max(120).nullable().optional(),
      runtimeType: z.enum(['llm', 'code-agent', 'mcp', 'a2a']).default('llm'),
      codeAgentType: z.enum(['codex', 'claude-code', 'opencode', 'gemini']).nullable().optional(),
      capabilityTags: z.array(z.string().max(40)).max(12).default([]),
      toolPermissions: z.array(z.string().max(80)).max(30).default(['chat']),
      sandboxPolicy: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
      contextPolicy: z.enum(['recent-only', 'pinned-recent', 'workspace-aware']).default('workspace-aware'),
      autoInvoke: z.boolean().default(true),
      approvalRequired: z.boolean().default(true),
    })
    .optional(),
})

export type AgentDraft = NonNullable<z.infer<typeof confirmAgentDraftSchema>['draft']>

export function buildAgentDraft(content: string): AgentDraft {
  const codeAgentType = inferCodeAgentType(content)
  const runtimeType = codeAgentType ? 'code-agent' : 'llm'
  const role = inferAgentRole(content)
  const name = inferAgentName(content, role, codeAgentType)
  const capabilityTags = inferCapabilityTags(content, role)
  const toolPermissions = inferToolPermissions(content)
  const roleType = inferRoleType({ name, role, capabilityTags, roleType: 'custom' })
  return {
    name,
    role,
    roleType,
    description: `${role} Agent，负责${capabilityTags.slice(0, 3).join('、') || '协作任务'}。`,
    avatar: null,
    systemPrompt: buildAgentSystemPrompt(role, capabilityTags),
    roleProfile: null,
    color: colorForRole(role),
    modelId: null,
    runtimeType,
    codeAgentType: codeAgentType ?? null,
    capabilityTags,
    toolPermissions,
    sandboxPolicy: toolPermissions.includes('workspace:write') ? 'workspace-write' : 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: codeAgentType ? false : true,
  }
}

export function inferCodeAgentType(content: string): AgentDraft['codeAgentType'] {
  const lower = content.toLowerCase()
  if (lower.includes('claude')) return 'claude-code'
  if (lower.includes('opencode') || lower.includes('open code')) return 'opencode'
  if (lower.includes('gemini')) return 'gemini'
  if (lower.includes('codex')) return 'codex'
  return null
}

export function inferAgentRole(content: string) {
  const lower = content.toLowerCase()
  if (/review|审查|测试|质量/.test(lower)) return '审查'
  if (/research|研究|调研/.test(lower)) return '研究'
  if (/deploy|部署|发布|运维/.test(lower)) return '部署'
  if (/front|react|vue|页面|前端|ui/.test(lower)) return '前端实现'
  if (/backend|server|api|后端|接口/.test(lower)) return '后端实现'
  if (/architect|架构|规划/.test(lower)) return '规划'
  return /coder|code|实现|代码/.test(lower) ? '实现' : '协作'
}

export function inferAgentName(content: string, role: string, codeAgentType: AgentDraft['codeAgentType']) {
  const explicit = /(?:创建|添加|新建)\s*(?:一个)?\s*([A-Za-z][A-Za-z0-9_-]{1,24})\s*(?:Agent|代理|助手)/i.exec(content)?.[1]
  if (explicit && !['agent', 'coder', 'code'].includes(explicit.toLowerCase())) return explicit
  const prefix = codeAgentType === 'claude-code' ? 'Claude' : codeAgentType === 'opencode' ? 'OpenCode' : codeAgentType === 'gemini' ? 'Gemini' : codeAgentType === 'codex' ? 'Codex' : ''
  const suffix = role.includes('前端') ? 'Frontend' : role.includes('后端') ? 'Backend' : role.includes('审查') ? 'Reviewer' : role.includes('部署') ? 'Deploy' : 'Coder'
  return [prefix, suffix].filter(Boolean).join(' ') || 'Custom Agent'
}

export function inferCapabilityTags(content: string, role: string) {
  const tags = new Set<string>()
  const candidates: Array<[RegExp, string]> = [
    [/react|前端|页面|ui/i, '前端'],
    [/node|server|api|后端|接口/i, '后端'],
    [/test|测试|qa/i, '测试'],
    [/deploy|部署|发布/i, '部署'],
    [/review|审查|质量/i, '审查'],
    [/research|研究|调研/i, '研究'],
    [/workflow|流程|编排/i, '编排'],
  ]
  for (const [pattern, tag] of candidates) {
    if (pattern.test(content)) tags.add(tag)
  }
  if (role) tags.add(role)
  return [...tags].slice(0, 8)
}

export function inferToolPermissions(content: string) {
  const lower = content.toLowerCase()
  const permissions = new Set<string>(['chat'])
  if (/读|读取|read|项目|workspace|文件/.test(lower)) permissions.add('workspace:read')
  if (/写|修改|实现|代码|write|workspace/.test(lower)) permissions.add('workspace:write')
  if (/预览|preview|shell/.test(lower)) permissions.add('shell:preview')
  if (/部署|发布|deploy/.test(lower)) permissions.add('deploy:preview')
  return [...permissions]
}

export function buildAgentSystemPrompt(role: string, tags: string[]) {
  return [
    `你是 AgentHub 中的${role} Agent。`,
    tags.length ? `你的能力标签是：${tags.join('、')}。` : '',
    '请基于当前会话上下文给出可执行产出；涉及文件修改、命令执行、部署或密钥时先说明风险并等待用户确认。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function colorForRole(role: string) {
  if (role.includes('前端')) return '#2563eb'
  if (role.includes('后端')) return '#0f766e'
  if (role.includes('审查')) return '#ef4444'
  if (role.includes('部署')) return '#7c3aed'
  if (role.includes('研究')) return '#f59e0b'
  if (role.includes('规划')) return '#6366f1'
  return '#111827'
}

export function parseAgentDraft(metadata: unknown) {
  const draft = (metadata as { agentDraft?: unknown } | null)?.agentDraft
  return normalizeAgentDraftInput(draft)
}

export function normalizeAgentDraftInput(value: unknown): AgentDraft | null {
  if (!value || typeof value !== 'object') return null
  const parsed = confirmAgentDraftSchema.shape.draft.safeParse(value)
  if (!parsed.success || !parsed.data) return null
  const draft = parsed.data
  const runtimeType = draft.runtimeType ?? 'llm'
  const nativeReadOnly = runtimeType === 'mcp'
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    roleType: draft.roleType ?? inferRoleType({
      name: draft.name,
      role: draft.role,
      capabilityTags: draft.capabilityTags ?? [],
      roleType: 'custom',
    }),
    description: draft.description?.trim() ?? '',
    avatar: draft.avatar ?? null,
    systemPrompt: draft.systemPrompt?.trim() ?? '',
    roleProfile: draft.roleProfile ?? null,
    color: draft.color ?? '#111827',
    modelId: draft.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (draft.codeAgentType ?? 'codex') : null,
    capabilityTags: draft.capabilityTags ?? [],
    toolPermissions: nativeReadOnly ? ['workspace:read', 'skills:read'] : draft.toolPermissions?.length ? draft.toolPermissions : ['chat'],
    sandboxPolicy: nativeReadOnly ? 'read-only' : (draft.sandboxPolicy ?? 'workspace-write'),
    contextPolicy: draft.contextPolicy ?? 'workspace-aware',
    autoInvoke: draft.autoInvoke ?? true,
    approvalRequired: nativeReadOnly ? true : runtimeType === 'code-agent' ? false : (draft.approvalRequired ?? true),
  }
}
