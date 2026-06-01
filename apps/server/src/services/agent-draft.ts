import { z } from 'zod'
import { streamReply } from './llm'
import { AGENT_ROLE_TYPES } from './workspace/agent-role-presets'

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
      runtimeType: z.enum(['llm', 'code-agent']).default('code-agent'),
      codeAgentType: z.enum(['codex', 'claude-code', 'opencode', 'gemini']).nullable().optional(),
      capabilityTags: z.array(z.string().max(40)).max(12).default([]),
      skillIds: z.array(z.string().max(120)).max(40).default([]),
      toolPermissions: z.array(z.string().max(80)).max(30).default(['chat']),
      sandboxPolicy: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
      contextPolicy: z.enum(['recent-only', 'pinned-recent', 'workspace-aware']).default('workspace-aware'),
      autoInvoke: z.boolean().default(true),
      approvalRequired: z.boolean().default(true),
    })
    .optional(),
})

export type AgentDraft = NonNullable<z.infer<typeof confirmAgentDraftSchema>['draft']>

const modelAgentDraftSchema = z.object({
  name: z.string().min(1).max(60),
  role: z.string().min(1).max(60),
  roleType: z.enum(AGENT_ROLE_TYPES),
  description: z.string().max(500),
  avatar: z.string().max(500).nullable(),
  systemPrompt: z.string().max(4000),
  roleProfile: z.record(z.unknown()).nullable(),
  color: z.string().max(20),
  modelId: z.string().max(120).nullable(),
  runtimeType: z.enum(['llm', 'code-agent']),
  codeAgentType: z.enum(['codex', 'claude-code', 'opencode', 'gemini']).nullable(),
  capabilityTags: z.array(z.string().max(40)).max(12),
  skillIds: z.array(z.string().max(120)).max(40).default([]),
  toolPermissions: z.array(z.string().max(80)).max(30),
  sandboxPolicy: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  contextPolicy: z.enum(['recent-only', 'pinned-recent', 'workspace-aware']),
  autoInvoke: z.boolean(),
  approvalRequired: z.boolean(),
})

export async function buildAgentDraft(content: string): Promise<AgentDraft> {
  const system = [
    '你是 AgentHub 的 Agent 草案生成器。',
    '根据用户的自然语言需求，动态生成一个可加入当前 Agent Group 的 Agent 配置草案。',
    '只返回严格 JSON，不要 Markdown，不要解释。',
    '不要使用固定团队模板；根据用户这次表达决定名称、职责、运行时、工具权限和系统提示。',
    'runtimeType 可选 "code-agent"、"llm"。默认使用 code-agent；llm 只作为没有可用 Coding Tools 时的兜底。',
    'code-agent 是 AgentHub 的主要 Agent 基底，必须设置 codeAgentType 为 "codex"、"claude-code"、"opencode" 或 "gemini"。',
    'MCP、Skills、Rules 是 code-agent 可使用的工具/能力，不是 runtimeType。不要输出 runtimeType="mcp" 或 runtimeType="a2a"。',
    'sandboxPolicy 必须和职责匹配：只读研究/审查用 read-only；需要改项目文件才用 workspace-write；除非用户明确要求且风险可控，不要用 danger-full-access。',
    'roleType 只能是 orchestrator、clarifier、architect、researcher、coder、verifier、reviewer、integrator、custom。',
    '返回字段：name, role, roleType, description, avatar, systemPrompt, roleProfile, color, modelId, runtimeType, codeAgentType, capabilityTags, skillIds, toolPermissions, sandboxPolicy, contextPolicy, autoInvoke, approvalRequired。',
  ].join('\n')

  let output = ''
  for await (const delta of streamReply(
    [{ role: 'user', content: content.trim() }],
    system,
  )) {
    output += delta
    if (output.length > 12_000) break
  }

  const jsonText = extractJsonObject(output)
  if (!jsonText) throw new Error('Agent 草案生成失败：模型未返回 JSON')

  const parsed = modelAgentDraftSchema.safeParse(JSON.parse(jsonText))
  if (!parsed.success) {
    throw new Error(`Agent 草案生成失败：模型返回不符合 schema（${parsed.error.issues[0]?.message ?? 'invalid'}）`)
  }
  return parsed.data
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
  const runtimeType = draft.runtimeType ?? 'code-agent'
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    roleType: draft.roleType ?? 'custom',
    description: draft.description?.trim() ?? '',
    avatar: draft.avatar ?? null,
    systemPrompt: draft.systemPrompt?.trim() ?? '',
    roleProfile: draft.roleProfile ?? null,
    color: draft.color ?? '#111827',
    modelId: draft.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (draft.codeAgentType ?? 'codex') : null,
    capabilityTags: draft.capabilityTags ?? [],
    skillIds: draft.skillIds ?? [],
    toolPermissions: draft.toolPermissions?.length ? draft.toolPermissions : ['chat'],
    sandboxPolicy: draft.sandboxPolicy ?? 'workspace-write',
    contextPolicy: draft.contextPolicy ?? 'workspace-aware',
    autoInvoke: draft.autoInvoke ?? true,
    approvalRequired: runtimeType === 'code-agent' ? false : (draft.approvalRequired ?? true),
  }
}

function extractJsonObject(value: string) {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}
