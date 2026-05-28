import { logger } from '../../lib/logger'
import { streamReply } from '../llm'
import type {
  GroupChatAgent,
  GroupChatMessage,
  SpeakerSelectionInput,
  SpeakerSelectionResult,
} from './types'

/**
 * SpeakerSelector — 决定群聊中下一个发言的 Agent
 *
 * 优先级：
 * 1. 用户消息中的 @mention → 直接路由
 * 2. Agent 回复中的 @mention → Agent 主动请求
 * 3. LLM 根据上下文选择 → 智能调度
 * 4. 轮询兜底 → 保证有 Agent 回复
 */
export class SpeakerSelector {
  /**
   * 从消息内容中提取 @mention 的 Agent 名称
   */
  extractMentions(content: string, agents: GroupChatAgent[]): GroupChatAgent[] {
    const lower = content.toLowerCase()
    const mentioned: GroupChatAgent[] = []

    for (const agent of agents) {
      const names = [agent.name, agent.name.toLowerCase()]
      // 也匹配角色关键词
      if (agent.role) {
        names.push(agent.role)
      }

      for (const name of names) {
        const token = name.trim().toLowerCase()
        if (!token) continue
        // 支持 @AgentName 和 @AgentName 两种格式
        if (
          lower.includes(`@${token}`) ||
          new RegExp(`@\\s*${escapeRegExp(token)}(?:\\s|$|[，。！？.,!?;:：])`, 'i').test(content)
        ) {
          if (!mentioned.find((m) => m.id === agent.id)) {
            mentioned.push(agent)
          }
          break
        }
      }
    }

    return mentioned
  }

  /**
   * 选择下一个发言的 Agent
   */
  async select(input: SpeakerSelectionInput): Promise<SpeakerSelectionResult> {
    const { messages, agents, lastSpeakerId } = input

    if (agents.length === 0) {
      return { agent: null, method: 'none', reason: '没有可用的 Agent', confidence: 0 }
    }

    // 过滤掉 Orchestrator alias agent（避免和系统 orchestrator 冲突）
    const availableAgents = agents.filter((a) => !isOrchestratorAlias(a))

    if (availableAgents.length === 0) {
      return { agent: null, method: 'none', reason: '没有可用的非协调器 Agent', confidence: 0 }
    }

    // 获取最新一条用户消息
    const lastUserMsg = [...messages].reverse().find((m) => m.senderType === 'user')

    // === 优先级 1: 用户消息中的 @mention ===
    if (lastUserMsg) {
      const mentioned = this.extractMentions(lastUserMsg.content, availableAgents)
      if (mentioned.length > 0) {
        // 选择第一个被 @mention 的 Agent
        const target = mentioned[0]!
        return {
          agent: target,
          method: 'mention',
          reason: `用户 @${target.name}`,
          confidence: 1.0,
        }
      }
    }

    // === 优先级 2: 最近 Agent 回复中的 @mention ===
    const lastAgentMsg = [...messages].reverse().find((m) => m.senderType === 'agent')
    if (lastAgentMsg) {
      const mentioned = this.extractMentions(lastAgentMsg.content, availableAgents)
      // 排除刚刚发言的 Agent 自己
      const filtered = mentioned.filter((m) => m.id !== lastAgentMsg.senderId)
      if (filtered.length > 0) {
        const target = filtered[0]!
        return {
          agent: target,
          method: 'mention',
          reason: `Agent ${lastAgentMsg.senderName || lastAgentMsg.senderId} @${target.name}`,
          confidence: 0.9,
        }
      }
    }

    // === 优先级 3: LLM 选择 ===
    try {
      const result = await this.selectWithLlm(messages, availableAgents, lastSpeakerId)
      if (result.agent) {
        return result
      }
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'SpeakerSelector LLM selection failed, falling back to round-robin')
    }

    // === 优先级 4: 轮询兜底 ===
    return this.selectRoundRobin(availableAgents, lastSpeakerId)
  }

  /**
   * LLM 选择发言者
   */
  private async selectWithLlm(
    messages: GroupChatMessage[],
    agents: GroupChatAgent[],
    lastSpeakerId?: string,
  ): Promise<SpeakerSelectionResult> {
    const recentMessages = messages.slice(-10)
    const agentCatalog = agents.map((a) => ({
      name: a.name,
      role: a.role || '通用助手',
      capabilities: a.capabilityTags.join('、') || '通用',
    }))

    const conversationContext = recentMessages
      .map((m) => {
        const sender = m.senderType === 'user' ? '用户' : m.senderName || m.senderId
        return `${sender}: ${m.content.slice(0, 300)}${m.content.length > 300 ? '...' : ''}`
      })
      .join('\n')

    const system = `你是一个群聊协调者。根据对话上下文，选择最合适的下一个发言者。

可用 Agent：
${agentCatalog.map((a) => `- ${a.name}（${a.role}）：${a.capabilities}`).join('\n')}

规则：
1. 不要选择刚刚发言的 Agent（避免连续发言），除非只有这一个 Agent
2. 如果对话刚开始（用户刚发第一条消息），选择最擅长规划或分析的 Agent
3. 如果有 Agent 在讨论实现细节，选择 Coder 类 Agent
4. 如果有 Agent 完成了代码，选择 Reviewer 类 Agent
5. 如果对话似乎已经完成，选择 null

只返回 JSON，不要其他内容：
{"agentName": "Agent名称", "reason": "选择原因"}
如果没有合适的 Agent 或任务已完成：{"agentName": null, "reason": "原因"}`

    const userPrompt = `最近对话：
${conversationContext}

${lastSpeakerId ? `上一个发言的 Agent: ${lastSpeakerId}` : '这是对话开始'}

请选择下一个发言的 Agent。`

    let output = ''
    for await (const delta of streamReply([{ role: 'user', content: userPrompt }], system)) {
      output += delta
      if (output.length > 2000) break
    }

    const jsonText = extractJsonObject(output)
    if (!jsonText) {
      throw new Error('LLM 返回的不是有效 JSON')
    }

    const parsed = JSON.parse(jsonText) as { agentName: string | null; reason: string }
    if (!parsed.agentName) {
      return { agent: null, method: 'llm', reason: parsed.reason || 'LLM 认为任务已完成', confidence: 0.8 }
    }

    const selected = agents.find(
      (a) => a.name.toLowerCase() === parsed.agentName!.toLowerCase() || a.id === parsed.agentName,
    )

    if (!selected) {
      throw new Error(`LLM 选择了不存在的 Agent: ${parsed.agentName}`)
    }

    return {
      agent: selected,
      method: 'llm',
      reason: parsed.reason,
      confidence: 0.7,
    }
  }

  /**
   * 轮询选择：跳过刚刚发言的 Agent，按顺序轮流
   */
  private selectRoundRobin(agents: GroupChatAgent[], lastSpeakerId?: string): SpeakerSelectionResult {
    if (agents.length === 0) {
      return { agent: null, method: 'round-robin', reason: '没有可用 Agent', confidence: 0 }
    }

    if (agents.length === 1) {
      return { agent: agents[0]!, method: 'round-robin', reason: '只有一个 Agent', confidence: 0.5 }
    }

    // 找到上一个发言者的索引，选择下一个
    const lastIndex = agents.findIndex((a) => a.id === lastSpeakerId)
    const nextIndex = (lastIndex + 1) % agents.length
    const selected = agents[nextIndex]!

    return {
      agent: selected,
      method: 'round-robin',
      reason: `轮询选择（上次: ${lastIndex >= 0 ? agents[lastIndex]!.name : '无'}）`,
      confidence: 0.4,
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function isOrchestratorAlias(agent: GroupChatAgent): boolean {
  const text = [agent.name, agent.role, ...(agent.capabilityTags ?? [])].join(' ').toLowerCase()
  return text.includes('orchestrator') || text.includes('协调器') || text.includes('调度')
}

function extractJsonObject(value: string): string | null {
  const cleaned = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}
