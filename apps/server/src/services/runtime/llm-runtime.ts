import { logger } from '../../lib/logger'
import { streamReplyParts } from '../llm'
import { harnessManager } from '../harness'
import type { AgentOutputChunk, AgentProfile, AgentRuntime, ExecutionContext } from './agent-runtime'

export class LlmRuntime implements AgentRuntime {
  readonly runtimeType = 'llm'
  readonly displayName = 'LLM 对话'

  async *execute(ctx: ExecutionContext): AsyncGenerator<AgentOutputChunk> {
    const { profile, prompt, history, signal, workspacePath } = ctx

    const system = await buildAgentSystem(profile, workspacePath)

    const llmMessages = history.map((m) => ({
      role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content,
    }))

    llmMessages.push({ role: 'user', content: prompt })

    try {
      for await (const chunk of streamReplyParts(llmMessages, system, profile.modelId ?? undefined, signal)) {
        if (signal?.aborted) break
        yield {
          kind: chunk.type === 'reasoning-delta' ? 'reasoning' : 'text',
          text: chunk.text,
        }
      }
    } catch (error: any) {
      if (signal?.aborted) return
      logger.error({ err: error?.message, sessionId: ctx.sessionId }, 'LlmRuntime execute error')
      yield { kind: 'text', text: `\n\n[错误：${error?.message || 'LLM 调用失败'}]` }
    }
  }
}

async function buildAgentSystem(profile: AgentProfile, workspacePath?: string | null): Promise<string> {
  // 如果工作区有 .agenthub/ 目录，使用 Harness 组装系统提示
  // 优先用 workspacePath（可能是 git worktree），其次用 originalProjectPath
  const harnessPaths = [workspacePath, profile.originalProjectPath].filter(Boolean) as string[]
  for (const path of harnessPaths) {
    try {
      await harnessManager.loadFromWorkspace(path)
      return harnessManager.buildSystemPrompt({ agent: profile, workspacePath: path })
    } catch (err) {
      logger.error({ err, path }, 'Harness buildSystemPrompt failed, trying fallback')
    }
  }

  return [
    profile.systemPrompt || `你是 ${profile.name}，AgentHub 中的协作智能体。`,
    profile.role ? `你在群聊中的角色：${profile.role}。` : '',
    profile.description ? `能力摘要：${profile.description}。` : '',
    profile.runtimeType ? `运行时绑定：${profile.runtimeType}。` : '',
    profile.capabilityTags?.length ? `能力标签：${profile.capabilityTags.join('、')}。` : '',
    profile.toolPermissions?.length ? `允许的工具范围：${profile.toolPermissions.join('、')}。` : '允许的工具范围：仅聊天。',
    profile.sandboxPolicy ? `沙箱策略：${profile.sandboxPolicy}。` : '',
    profile.contextPolicy ? `上下文策略：${profile.contextPolicy}。` : '',
    workspacePath ? `项目工作区路径：${workspacePath}。` : '',
    profile.approvalRequired
      ? '如果用户请求可能修改文件、运行命令、访问网络、部署或接触密钥，请先请求用户明确确认，再执行或给出执行指令。'
      : '',
    '你正在多 Agent 群聊中回复。请聚焦自己的角色，用中文给出清晰、可执行的回答；如需要其他 Agent 接续，请明确写出交接需求。',
  ]
    .filter(Boolean)
    .join('\n')
}
