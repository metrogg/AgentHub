import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { logger } from '../lib/logger'
import { streamReply } from '../services/llm'
import { AGENT_ROLE_TYPES } from '../services/workspace/agent-role-presets'

const agentConfigDraftSchema = z.object({
  name: z.string().max(60),
  role: z.string().max(60),
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
  sandboxPolicy: z.enum(['workspace-write', 'danger-full-access']).default('workspace-write'),
  contextPolicy: z.enum(['recent-only', 'pinned-recent', 'workspace-aware']).default('workspace-aware'),
  autoInvoke: z.boolean().default(true),
  approvalRequired: z.boolean().default(true),
})

const agentConfigPatchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  role: z.string().min(1).max(60).optional(),
  roleType: z.enum(AGENT_ROLE_TYPES).optional(),
  description: z.string().max(500).optional(),
  avatar: z.string().max(500).nullable().optional(),
  systemPrompt: z.string().max(4000).optional(),
  roleProfile: z.record(z.unknown()).nullable().optional(),
  color: z.string().max(20).optional(),
  modelId: z.string().max(120).nullable().optional(),
  runtimeType: z.enum(['llm', 'code-agent']).optional(),
  codeAgentType: z.enum(['codex', 'claude-code', 'opencode', 'gemini']).nullable().optional(),
  capabilityTags: z.array(z.string().max(40)).max(12).optional(),
  skillIds: z.array(z.string().max(120)).max(40).optional(),
  toolPermissions: z.array(z.string().max(80)).max(30).optional(),
  sandboxPolicy: z.enum(['workspace-write', 'danger-full-access']).optional(),
  contextPolicy: z.enum(['recent-only', 'pinned-recent', 'workspace-aware']).optional(),
  autoInvoke: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
})

const agentConfigEditSchema = z.object({
  instruction: z.string().min(1).max(5000),
  draft: agentConfigDraftSchema,
})

export const agentConfigRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .post('/edit', zValidator('json', agentConfigEditSchema), async (c) => {
    const { instruction, draft } = c.req.valid('json')

    const system = [
      '你是 AgentHub 的 Agent 配置编辑器。',
      '用户会给出当前 Agent 配置和自然语言修改要求。你要判断应该改哪些字段，并返回严格 JSON。',
      '只修改用户明确要求或强相关的字段；不要因为风格偏好重写整份配置。',
      '不要改变 AgentHub 的产品分层：Skills/MCP/Rules/CLI 是能力层，不是 Agent 类型。',
      'runtimeType 只能是 "code-agent" 或 "llm"；codeAgentType 只能是 "codex"、"claude-code"、"opencode"、"gemini" 或 null。',
      'sandboxPolicy 只能是 "workspace-write" 或 "danger-full-access"；不要输出 read-only。',
      'contextPolicy 只能是 "recent-only"、"pinned-recent"、"workspace-aware"。',
      '返回 JSON 对象格式：{"summary":"一句话说明","patch":{...只包含需要修改的字段...}}。',
      'patch 允许字段：name, role, roleType, description, avatar, systemPrompt, roleProfile, color, modelId, runtimeType, codeAgentType, capabilityTags, skillIds, toolPermissions, sandboxPolicy, contextPolicy, autoInvoke, approvalRequired。',
      '不要输出 Markdown、代码块或额外解释。',
    ].join('\n')

    const prompt = JSON.stringify(
      {
        instruction: instruction.trim(),
        currentAgent: draft,
      },
      null,
      2,
    )

    return streamSSE(c, async (stream) => {
      let output = ''
      try {
        for await (const delta of streamReply([{ role: 'user', content: prompt }], system)) {
          output += delta
          await stream.writeSSE({ data: delta, event: 'chunk' })
          if (output.length > 16_000) break
        }

        const result = parseAgentConfigEditResult(output)
        await stream.writeSSE({ data: JSON.stringify(result), event: 'result' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || 'Agent 配置修改失败')
        logger.error({ err: message }, 'Agent config edit stream failed')
        await stream.writeSSE({ data: message, event: 'error' })
      }
      await stream.writeSSE({ data: '', event: 'done' })
    })
  })

function parseAgentConfigEditResult(output: string) {
  const jsonText = extractJsonObject(output)
  if (!jsonText) throw new Error('模型未返回可解析的字段补丁')
  const parsedJson = JSON.parse(jsonText) as { summary?: unknown; patch?: unknown }
  const parsedPatch = agentConfigPatchSchema.safeParse(parsedJson.patch)
  if (!parsedPatch.success) {
    throw new Error(`模型返回的字段补丁不符合 schema：${parsedPatch.error.issues[0]?.message ?? 'invalid'}`)
  }
  return {
    summary: typeof parsedJson.summary === 'string' ? parsedJson.summary.trim() : '已生成字段修改建议',
    patch: parsedPatch.data,
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
