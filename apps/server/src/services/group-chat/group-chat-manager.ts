import { db, messages, sessions, workspaceAgents, workspaces, sessionMembers, eq, and, asc, desc } from '@agenthub/db'
import { logger } from '../../lib/logger'
import { broadcastSessionEvent, runAgentReply, type AgentRunProfile, type MessageRow } from '../agent-runner'
import { SpeakerSelector, isOrchestratorAlias } from './speaker-selector'
import { buildDynamicOrchestratorPlan } from '../orchestrator/plan-generator'
import type {
  GroupChatAgent,
  GroupChatConfig,
  GroupChatMessage,
  GroupChatState,
  SpeakerSelectionResult,
} from './types'
import { DEFAULT_GROUP_CHAT_CONFIG } from './types'

/**
 * 评估用户意图复杂度，判断是否需要 Orchestrator 介入
 * 基于启发式规则：多文件引用、阶段关键词、架构意图等
 */
function assessIntentComplexity(content: string): boolean {
  const lower = content.toLowerCase()
  let signals = 0

  // 多文件引用 (≥2)
  const fileRefs = content.match(/[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|vue|css|scss|html|sql|json|yaml|yml|toml|md)\b/gi)
  if (fileRefs && new Set(fileRefs.map((f) => f.toLowerCase())).size >= 2) signals += 2

  // 多阶段关键词
  const phasePatterns = [
    /先.{2,20}然后/,
    /先.{2,20}再/,
    /第[一二三四五六七八九十\d]步/,
    /step\s*\d/i,
    /first.{5,30}then/i,
    /首先.{2,20}接着/,
    /\d+\.\s+\S.{3,}/m,
  ]
  if (phasePatterns.some((p) => p.test(content))) signals += 2

  // 架构/系统级意图
  const archKeywords = [
    '架构', '重构', '系统设计', '整体', '全流程', '端到端', '从零开始',
    'architecture', 'refactor', 'system design', 'end-to-end', 'full stack',
    'fullstack', '全栈', '迁移', 'migration',
  ]
  if (archKeywords.some((k) => lower.includes(k))) signals += 2

  // 多 Agent 协作暗示
  const collabKeywords = [
    '同时', '并行', '一起', '分别', '各自', '协作',
    'simultaneously', 'in parallel', 'together', 'respectively',
  ]
  if (collabKeywords.some((k) => lower.includes(k))) signals += 1

  // 复杂任务动词 + 技术对象
  const complexVerbs = [
    '实现', '创建', '搭建', '开发', '构建', '设计',
    'implement', 'create', 'build', 'develop', 'design',
  ]
  const techObjects = [
    'api', 'ui', '数据库', 'database', '认证', 'auth', '组件',
    'component', '服务', 'service', '模块', 'module', '页面', 'page',
  ]
  if (complexVerbs.some((v) => lower.includes(v)) && techObjects.some((t) => lower.includes(t))) signals += 1

  // 长消息 + 技术内容
  if (content.length > 200 && techObjects.some((t) => lower.includes(t))) signals += 1

  return signals >= 3
}

/**
 * 检查消息中是否显式提到了 @orchestrator / @协调器
 */
function isOrchestratorMentioned(content: string): boolean {
  return /(^|\s)@(orchestrator|coordinator|agenthub)\b/i.test(content) || content.includes('@协调器') || content.includes('@调度')
}

/**
 * GroupChatManager — 群聊总控
 *
 * 核心职责：
 * 1. 接收用户消息，决定谁来回复
 * 2. 调用 Agent 获取回复
 * 3. 解析回复中的 @mention，自动路由到下一个 Agent
 * 4. 管理对话轮次，防止死循环
 * 5. 广播所有事件到前端
 *
 * 与旧版 runGroupReplies 的区别：
 * - 旧版：Orchestrator 自动生成计划 → 按 DAG 执行 → 汇总
 * - 新版：对话式协作 → @mention 路由 / LLM 选择 → Agent 自然协作
 */
export class GroupChatManager {
  private speakerSelector = new SpeakerSelector()
  private config: GroupChatConfig

  constructor(config?: Partial<GroupChatConfig>) {
    this.config = { ...DEFAULT_GROUP_CHAT_CONFIG, ...config }
  }

  /**
   * 处理群聊消息的入口
   * 替代旧的 runGroupReplies 函数
   */
  async handleMessage(params: {
    workspaceId: string
    sessionId: string
    userMsg: MessageRow
    content: string
  }): Promise<void> {
    const { workspaceId, sessionId, userMsg, content } = params

    // 加载 workspace 和 agent 列表
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    if (!workspace) {
      logger.error({ workspaceId }, 'GroupChatManager: workspace not found')
      return
    }

    const projectPath = workspace.projectPath ?? null

    const agentRows = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, workspaceId))
      .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))

    if (agentRows.length === 0) {
      logger.warn({ workspaceId }, 'GroupChatManager: no agents in workspace')
      return
    }

    // 构建 GroupChatAgent 列表
    const agents: GroupChatAgent[] = agentRows.map((row) => toGroupChatAgent(row))

    // 初始化对话状态
    const state: GroupChatState = {
      turnCount: 0,
      consecutiveCount: 0,
      waitingForUser: false,
      finished: false,
    }

    // 跟踪每个 Agent 的失败次数
    const failureCounts = new Map<string, number>()

    // 加载对话历史
    const history = await this.loadHistory(sessionId)

    // 对话循环
    await this.conversationLoop({
      workspaceId,
      sessionId,
      userMsg,
      content,
      agents,
      projectPath,
      state,
      history,
      failureCounts,
    })
  }

  /**
   * 核心对话循环
   */
  private async conversationLoop(params: {
    workspaceId: string
    sessionId: string
    userMsg: MessageRow
    content: string
    agents: GroupChatAgent[]
    projectPath: string | null
    state: GroupChatState
    history: GroupChatMessage[]
    failureCounts: Map<string, number>
  }): Promise<void> {
    const { workspaceId, sessionId, agents, projectPath, state, failureCounts } = params
    let { history } = params

    // 用户消息已经由路由层插入 DB，这里直接加到历史
    const userGroupMsg: GroupChatMessage = {
      id: params.userMsg.id,
      senderId: params.userMsg.senderId,
      senderType: 'user',
      senderName: '用户',
      content: params.content,
      mentions: this.speakerSelector.extractMentions(params.content, agents).map((a) => a.name),
      createdAt: new Date(params.userMsg.createdAt),
    }
    history = [...history, userGroupMsg]

    // === 双模路由：无 @mention 时判断任务复杂度；显式 @orchestrator 也走 Orchestrator ===
    const userMentionedAnyone = userGroupMsg.mentions && userGroupMsg.mentions.length > 0
    const orchestratorMentioned = isOrchestratorMentioned(params.content)
    if (orchestratorMentioned || (!userMentionedAnyone && assessIntentComplexity(params.content))) {
      logger.info({ sessionId, reason: orchestratorMentioned ? 'explicit_orchestrator' : 'complex_intent' }, 'GroupChatManager: routing to Orchestrator plan')
      await this.triggerOrchestratorPlan({
        workspaceId,
        sessionId,
        content: params.content,
        agents,
      })
      state.finished = true
      state.finishReason = 'orchestrator_plan'
      state.waitingForUser = true
      return
    }

    while (!state.finished && state.turnCount < this.config.maxTotalTurns) {
      // 检查是否被外部取消
      const [currentSession] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
      if (!currentSession) {
        logger.warn({ sessionId }, 'GroupChatManager: session deleted, stopping')
        break
      }

      // === Step 1: 选择下一个发言的 Agent ===
      // 排除已失败 2 次以上的 Agent
      const eligibleAgents = agents.filter((a) => (failureCounts.get(a.id) ?? 0) < 2)
      const selection = await this.speakerSelector.select({
        messages: history,
        agents: eligibleAgents,
        lastSpeakerId: state.lastSpeakerId,
      })

      if (!selection.agent) {
        logger.info({ reason: selection.reason }, 'GroupChatManager: no speaker selected, stopping')
        state.finished = true
        state.finishReason = 'task_complete'
        break
      }

      const selectedAgent = selection.agent

      // 检查连续发言限制
      if (selectedAgent.id === state.lastSpeakerId) {
        state.consecutiveCount++
        if (state.consecutiveCount >= (selectedAgent.maxConsecutiveTurns || this.config.maxConsecutiveTurns)) {
          logger.info(
            { agent: selectedAgent.name, count: state.consecutiveCount },
            'GroupChatManager: agent hit consecutive turn limit, forcing switch',
          )
          // 强制选择其他 Agent
          const otherAgents = agents.filter((a) => a.id !== state.lastSpeakerId)
          if (otherAgents.length > 0) {
            const fallback: SpeakerSelectionResult = {
              agent: otherAgents[0]!,
              method: 'round-robin',
              reason: `强制切换（${selectedAgent.name} 连续发言过多）`,
              confidence: 0.3,
            }
            Object.assign(selection, fallback)
          } else {
            state.finished = true
            state.finishReason = 'task_complete'
            break
          }
        }
      } else {
        state.consecutiveCount = 0
      }

      logger.info(
        {
          agent: selectedAgent.name,
          method: selection.method,
          reason: selection.reason,
          turn: state.turnCount,
        },
        'GroupChatManager: selected speaker',
      )

      // === Step 2: 构造 Agent Profile ===
      const profile = toAgentProfile(selectedAgent, projectPath)

      // === Step 3: 调用 Agent ===
      // 构造完整 prompt（包含上下文提示），但不存入消息表，避免系统提示泄露到前端
      const prompt = this.buildAgentPrompt(selectedAgent, history, selection)

      // 更新状态
      state.turnCount++
      state.lastSpeakerId = selectedAgent.id

      // 广播 Agent 开始发言
      broadcastSessionEvent(sessionId, {
        type: 'agent:typing',
        payload: {
          sessionId,
          agentId: selectedAgent.id,
          agentName: selectedAgent.name,
          turn: state.turnCount,
        },
      })

      // 调用 Agent：使用合成 MessageRow 传递完整 prompt，不插入到消息表
      const agentUserMsg: MessageRow = {
        id: crypto.randomUUID(),
        sessionId,
        senderId: 'group-chat-manager',
        senderType: 'user',
        type: 'text',
        content: prompt,
        metadata: {
          groupChatTurn: state.turnCount,
          selectedBy: selection.method,
          selectionReason: selection.reason,
          isGroupChatSystemMessage: true,
        },
        createdAt: new Date(),
      }
      const result = await runAgentReply(sessionId, agentUserMsg, profile)

      // === Step 4: 处理 Agent 回复 ===
      if (!result.ok) {
        const failCount = (failureCounts.get(selectedAgent.id) ?? 0) + 1
        failureCounts.set(selectedAgent.id, failCount)

        // 读取错误内容，记录到历史
        const errorReply = await this.getAgentReply(sessionId, result.messageId)
        const errorContent = errorReply?.content || `${selectedAgent.name} 执行失败`

        logger.warn(
          { agent: selectedAgent.name, cancelled: result.cancelled, failCount, error: errorContent.slice(0, 200) },
          'GroupChatManager: agent reply failed',
        )

        if (result.cancelled) {
          state.finished = true
          state.finishReason = 'user_stop'
          break
        }

        // 将失败信息加入历史，让下一个 Agent 知道发生了什么
        const errorMsg: GroupChatMessage = {
          id: `error-${state.turnCount}`,
          senderId: selectedAgent.id,
          senderType: 'agent',
          senderName: selectedAgent.name,
          content: errorContent,
          mentions: [],
          createdAt: new Date(),
        }
        history = [...history, errorMsg]

        // 检查是否所有 Agent 都失败过
        const allAgentsFailed = agents
          .filter((a) => !isOrchestratorAlias(a))
          .every((a) => (failureCounts.get(a.id) ?? 0) >= 2)

        if (allAgentsFailed) {
          logger.error({ failureCounts: Object.fromEntries(failureCounts) }, 'GroupChatManager: all agents failed, stopping')
          state.finished = true
          state.finishReason = 'error'

          await db.insert(messages).values({
            sessionId,
            senderId: 'system',
            senderType: 'system',
            type: 'text',
            content: '所有 Agent 均执行失败，请检查 LLM 配置（API Key、模型 ID、Base URL）后重试。',
            metadata: { systemEvent: 'all_agents_failed' },
          })
          break
        }

        // 同一 Agent 失败超过 2 次，标记为不可用
        if (failCount >= 2) {
          logger.warn({ agent: selectedAgent.name, failCount }, 'GroupChatManager: agent exceeded failure limit, will not retry')
        }

        continue
      }

      // 读取 Agent 的回复内容
      const agentReply = await this.getAgentReply(sessionId, result.messageId)
      if (!agentReply) {
        logger.warn({ messageId: result.messageId }, 'GroupChatManager: could not read agent reply')
        continue
      }

      // 更新历史
      const agentGroupMsg: GroupChatMessage = {
        id: agentReply.id,
        senderId: selectedAgent.id,
        senderType: 'agent',
        senderName: selectedAgent.name,
        content: agentReply.content,
        mentions: this.speakerSelector.extractMentions(agentReply.content, agents).map((a) => a.name),
        createdAt: new Date(agentReply.createdAt),
      }
      history = [...history, agentGroupMsg]

      // === Step 5: 检查是否需要继续 ===
      // 如果 Agent 的回复 @了其他 Agent，下一轮会自动路由
      // 如果 Agent 说"任务完成"或类似关键词，停止
      if (this.isTaskComplete(agentReply.content)) {
        logger.info({ agent: selectedAgent.name }, 'GroupChatManager: agent indicated task complete')
        state.finished = true
        state.finishReason = 'task_complete'
        break
      }

      // 如果 Agent 的回复没有 @任何人，且不是用户 @的，检查是否需要继续
      const mentionedAgents = this.speakerSelector.extractMentions(agentReply.content, agents)
      const userMentionedAnyone = userGroupMsg.mentions && userGroupMsg.mentions.length > 0

      if (mentionedAgents.length === 0 && !userMentionedAnyone && selection.method !== 'mention') {
        // Agent 没有 @任何人，用户也没有 @任何人
        // 如果是 LLM 选择的，可以继续让 LLM 判断是否需要其他人
        // 如果是轮询的，也继续
        // 但如果是第一个 Agent 回复且没有 @其他人，可能是单轮对话
        if (state.turnCount >= 3) {
          // 已经有几轮对话了，让 LLM 判断是否需要继续
          try {
            const continueSelection = await this.speakerSelector.select({
              messages: history,
              agents,
              lastSpeakerId: state.lastSpeakerId,
            })
            if (!continueSelection.agent) {
              state.finished = true
              state.finishReason = 'task_complete'
              break
            }
          } catch {
            // LLM 选择失败，停止
            state.finished = true
            state.finishReason = 'task_complete'
            break
          }
        }
      }
    }

    // 对话结束
    if (state.turnCount >= this.config.maxTotalTurns) {
      logger.warn({ turns: state.turnCount }, 'GroupChatManager: hit max turns')
      state.finishReason = 'max_turns'

      // 插入系统消息提示
      await db.insert(messages).values({
        sessionId,
        senderId: 'system',
        senderType: 'system',
        type: 'text',
        content: `对话已达最大轮次（${this.config.maxTotalTurns}轮）。如需继续，请发送新消息。`,
        metadata: { systemEvent: 'max_turns_reached' },
      })
    }

    logger.info(
      { turns: state.turnCount, reason: state.finishReason },
      'GroupChatManager: conversation loop finished',
    )
  }

  /**
   * 构造发送给 Agent 的 prompt
   * code-agent（Claude Code / OpenCode）和 LLM 需要不同的 prompt 格式
   */
  private buildAgentPrompt(
    agent: GroupChatAgent,
    history: GroupChatMessage[],
    selection: SpeakerSelectionResult,
  ): string {
    const recentHistory = history.slice(-10)
    const isCodeAgent = agent.runtimeType === 'code-agent' && agent.codeAgentType

    // 提取用户的原始需求（第一条用户消息）
    const userGoal = history.find((m) => m.senderType === 'user')?.content || ''

    // 构建上下文摘要：其他 Agent 已经做了什么
    const agentWork = recentHistory
      .filter((m) => m.senderType === 'agent' && m.senderId !== agent.id)
      .map((m) => `${m.senderName}: ${m.content.slice(0, 300)}${m.content.length > 300 ? '...' : ''}`)
      .join('\n')

    if (isCodeAgent) {
      // Code Agent（Claude Code / OpenCode / Codex）：给原始任务，不包装
      // 它们有自己的 system prompt 和工具，不需要"你是 XXX"这种包装
      const parts = [`任务：${userGoal}`]

      if (agentWork) {
        parts.push(`\n其他 Agent 已完成的工作：\n${agentWork}`)
      }

      // 检查是否有其他 Agent @了当前 Agent
      const lastAgentMsg = recentHistory.filter((m) => m.senderType === 'agent').slice(-1)[0]
      if (lastAgentMsg && lastAgentMsg.mentions?.includes(agent.name)) {
        const request = lastAgentMsg.content.slice(0, 500)
        parts.push(`\n${lastAgentMsg.senderName} 请求你帮忙：${request}`)
      }

      parts.push(`\n请在当前工作区中完成上述任务。完成后请说明你做了什么。`)

      return parts.join('')
    }

    // LLM Agent：使用对话式 prompt
    const historyText = recentHistory
      .map((m) => {
        const sender = m.senderType === 'user' ? '用户' : m.senderName || m.senderId
        return `[${sender}]: ${m.content.slice(0, 500)}${m.content.length > 500 ? '...' : ''}`
      })
      .join('\n')

    return [
      `你是 ${agent.name}（${agent.role || '助手'}）。`,
      agent.systemPrompt ? `\n${agent.systemPrompt}` : '',
      `\n\n以下是群聊对话历史：\n${historyText}`,
      `\n\n现在轮到你发言。你可以：`,
      `\n- 回答用户问题或执行任务`,
      `\n- 如果需要其他 Agent 帮助，用 @Agent名 请求`,
      `\n- 如果需要用户确认，直接向用户提问`,
      `\n- 如果任务已完成，明确说明`,
    ].join('')
  }

  /**
   * 加载对话历史
   */
  private async loadHistory(sessionId: string): Promise<GroupChatMessage[]> {
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
      .limit(50)

    return rows.map((row) => ({
      id: row.id,
      senderId: row.senderId,
      senderType: row.senderType as 'user' | 'agent' | 'system',
      senderName: (row.metadata as Record<string, unknown> | null)?.agentName as string | undefined,
      content: row.content,
      mentions: [],
      createdAt: new Date(row.createdAt),
    }))
  }

  /**
   * 获取 Agent 的回复内容
   */
  private async getAgentReply(
    sessionId: string,
    messageId?: string,
  ): Promise<{ id: string; content: string; createdAt: Date } | null> {
    if (messageId) {
      const [msg] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
      if (msg) return { id: msg.id, content: msg.content, createdAt: new Date(msg.createdAt) }
    }

    // Fallback: 读取该 session 最新的一条 agent 消息
    const [msg] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.senderType, 'agent')))
      .orderBy(desc(messages.createdAt))
      .limit(1)

    if (!msg) return null
    return { id: msg.id, content: msg.content, createdAt: new Date(msg.createdAt) }
  }

  /**
   * 检查 Agent 是否表示任务完成
   */
  private isTaskComplete(content: string): boolean {
    const lower = content.toLowerCase()
    const completionPatterns = [
      /任务完成/,
      /已完成/,
      /已经完成/,
      /做好了/,
      /搞定了/,
      /done/i,
      /completed/i,
      /finished/i,
      /all\s+set/i,
    ]
    return completionPatterns.some((p) => p.test(lower))
  }

  /**
   * 触发 Orchestrator 计划生成
   * 当用户没有 @任何人且任务复杂时调用
   */
  private async triggerOrchestratorPlan(params: {
    workspaceId: string
    sessionId: string
    content: string
    agents: GroupChatAgent[]
  }): Promise<void> {
    const { workspaceId, sessionId, content, agents } = params

    // 插入 loading 占位卡片
    const loadingPlan = {
      kind: 'orchestrator_plan' as const,
      title: '计划生成中',
      goal: '正在分析任务并制定执行计划，请稍候...',
      summary: '正在分析任务并制定执行计划，请稍候...',
      tasks: [],
      agents: [],
    }

    const [loadingCard] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'orchestrator',
        senderType: 'agent' as const,
        type: 'task_card',
        content: loadingPlan.summary,
        metadata: { plan: { ...loadingPlan, messageId: '' } },
      })
      .returning()

    if (loadingCard) {
      const loadingPlanWithId = { ...loadingPlan, messageId: loadingCard.id }
      await db
        .update(messages)
        .set({ metadata: { plan: loadingPlanWithId } })
        .where(eq(messages.id, loadingCard.id))
      broadcastSessionEvent(sessionId, {
        type: 'message:completed',
        payload: { sessionId, message: { ...loadingCard, metadata: { plan: loadingPlanWithId } } },
      })
    }

    // 后台异步生成完整计划
    ;(async () => {
      try {
        const plan = await buildDynamicOrchestratorPlan(
          content,
          agents,
          workspaceId,
        )
        if (loadingCard) {
          const planWithId = { ...plan, messageId: loadingCard.id }
          await db
            .update(messages)
            .set({ content: plan.summary, metadata: { plan: planWithId } })
            .where(eq(messages.id, loadingCard.id))
          const [updatedCard] = await db.select().from(messages).where(eq(messages.id, loadingCard.id)).limit(1)
          if (updatedCard) {
            broadcastSessionEvent(sessionId, {
              type: 'message:completed',
              payload: { sessionId, message: { ...updatedCard, metadata: { plan: planWithId } } },
            })
          }
        }
      } catch (err: any) {
        logger.error({ err: err?.message, sessionId }, 'GroupChatManager: Orchestrator plan generation failed')
        if (loadingCard) {
          const failedPlan = {
            kind: 'orchestrator_plan' as const,
            title: '计划生成失败',
            goal: '分析任务时出错，请稍后重试',
            summary: '分析任务时出错，请稍后重试',
            tasks: [],
            agents: [],
          }
          await db
            .update(messages)
            .set({ content: failedPlan.summary, metadata: { plan: { ...failedPlan, messageId: loadingCard.id } } })
            .where(eq(messages.id, loadingCard.id))
          const [failedCard] = await db.select().from(messages).where(eq(messages.id, loadingCard.id)).limit(1)
          if (failedCard) {
            broadcastSessionEvent(sessionId, {
              type: 'message:completed',
              payload: { sessionId, message: failedCard },
            })
          }
        }
      }
    })()
  }
}

/**
 * 将 workspaceAgents 行转换为 GroupChatAgent
 */
function toGroupChatAgent(row: typeof workspaceAgents.$inferSelect): GroupChatAgent {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    systemPrompt: row.systemPrompt ?? undefined,
    color: row.color ?? undefined,
    modelId: row.modelId,
    runtimeType: (row.runtimeType as AgentRunProfile['runtimeType']) ?? 'llm',
    codeAgentType: (row.codeAgentType as AgentRunProfile['codeAgentType']) ?? undefined,
    capabilityTags: row.capabilityTags ?? [],
    toolPermissions: row.toolPermissions ?? [],
    sandboxPolicy: (row.sandboxPolicy as AgentRunProfile['sandboxPolicy']) ?? 'workspace-write',
    contextPolicy: 'workspace-aware',
    approvalRequired: false,
    responseStrategy: 'when_relevant',
    canDelegateTo: [],
    maxConsecutiveTurns: 3,
  }
}

/**
 * 将 GroupChatAgent 转换为 AgentRunProfile（给 agent-runner 使用）
 */
function toAgentProfile(agent: GroupChatAgent, projectPath: string | null): AgentRunProfile {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    color: agent.color,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: agent.capabilityTags,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: agent.sandboxPolicy,
    contextPolicy: agent.contextPolicy,
    approvalRequired: agent.approvalRequired,
    systemPrompt: agent.systemPrompt,
    projectPath: projectPath?.trim() || null,
  }
}
