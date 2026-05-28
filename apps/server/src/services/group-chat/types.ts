import type { AgentProfile } from '../runtime/agent-runtime'

/**
 * 群聊中的 Agent 扩展信息
 * 在 AgentProfile 基础上增加群聊协作所需的行为策略
 */
export interface GroupChatAgent extends AgentProfile {
  /** 回复策略：always=每次都回复, when_mentioned=只有被@时才回复, when_relevant=相关时才回复 */
  responseStrategy: 'always' | 'when_mentioned' | 'when_relevant'
  /** 可以委托给哪些 Agent（by name） */
  canDelegateTo: string[]
  /** 连续发言上限，防止一个 Agent 独占对话 */
  maxConsecutiveTurns: number
}

/** 群聊消息（结构化） */
export interface GroupChatMessage {
  id: string
  senderId: string           // 'user' | agent.id | 'orchestrator' | 'system'
  senderType: 'user' | 'agent' | 'system'
  senderName?: string        // 显示名
  content: string
  mentions?: string[]        // @了谁（agent name 列表）
  createdAt: Date
}

/** 群聊运行配置 */
export interface GroupChatConfig {
  /** 最大总轮次，防止无限循环 */
  maxTotalTurns: number
  /** 同一 Agent 最大连续发言次数 */
  maxConsecutiveTurns: number
}

/** 默认群聊配置 */
export const DEFAULT_GROUP_CHAT_CONFIG: GroupChatConfig = {
  maxTotalTurns: 20,
  maxConsecutiveTurns: 3,
}

/** 群聊运行状态 */
export interface GroupChatState {
  /** 当前轮次 */
  turnCount: number
  /** 最后发言的 Agent ID */
  lastSpeakerId?: string
  /** 同一 Agent 连续发言次数 */
  consecutiveCount: number
  /** 是否正在等待用户输入 */
  waitingForUser: boolean
  /** 是否已结束 */
  finished: boolean
  /** 结束原因 */
  finishReason?: 'user_stop' | 'max_turns' | 'task_complete' | 'error' | 'orchestrator_plan'
}
