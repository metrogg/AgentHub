import {
  db,
  messages,
  sessions,
  sessionMembers,
  workspaceAgents,
  workspaces,
  eq,
  and,
  asc,
  desc,
} from '@agenthub/db'
import { inArray } from 'drizzle-orm'
import { logger } from '../../lib/logger'
import {
  broadcastSessionEvent,
  runAgentReply,
  type AgentRunProfile,
  type MessageRow,
} from '../agent-runner'
import { buildDynamicOrchestratorPlan } from '../orchestrator/plan-generator'
import type { GroupChatAgent, GroupChatConfig, GroupChatMessage, GroupChatState } from './types'
import { DEFAULT_GROUP_CHAT_CONFIG } from './types'
import { WsEvent } from '@agenthub/shared'

/**
 * 从消息内容中提取 @mention 的 Agent
 */
function extractMentions(content: string, agents: GroupChatAgent[]): GroupChatAgent[] {
  const lower = content.toLowerCase()
  const mentioned: GroupChatAgent[] = []

  for (const agent of agents) {
    const names = [agent.name, agent.name.toLowerCase()]
    if (agent.role) {
      names.push(agent.role)
    }

    for (const name of names) {
      const token = name.trim().toLowerCase()
      if (!token) continue
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 查找群聊中的 Orchestrator Agent（按 roleType 优先匹配，回退到名称）
 */
function findOrchestrator(agents: GroupChatAgent[]): GroupChatAgent | undefined {
  const byRoleType = agents.find((a) => a.roleType === 'orchestrator')
  if (byRoleType) return byRoleType
  return agents.find((a) => {
    const text = [a.name, a.role ?? '', ...(a.capabilityTags ?? [])].join(' ').toLowerCase()
    return (
      text.includes('orchestrator') ||
      text.includes('总指挥') ||
      text.includes('协调') ||
      text.includes('调度')
    )
  })
}

/**
 * GroupChatManager — 群聊总控
 *
 * 核心职责：
 * 1. 接收用户消息，决定谁来回复
 * 2. 无 @mention → Orchestrator 接收
 * 3. @mention → 特定 Agent 接收
 * 4. Agent 回复中的 @mention 自动路由到下一个 Agent
 * 5. 复杂任务额外生成 Orchestrator 计划卡片
 */
export class GroupChatManager {
  private config: GroupChatConfig

  constructor(config?: Partial<GroupChatConfig>) {
    this.config = { ...DEFAULT_GROUP_CHAT_CONFIG, ...config }
  }

  /**
   * 处理群聊消息的入口
   */
  async handleMessage(params: {
    workspaceId: string
    sessionId: string
    userMsg: MessageRow
    content: string
  }): Promise<void> {
    const { sessionId, userMsg, content } = params
    const workspaceId = await resolveGroupWorkspaceId(sessionId, params.workspaceId)

    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
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

    const agents: GroupChatAgent[] = agentRows.map((row) => toGroupChatAgent(row))
    const orchestrator = findOrchestrator(agents)

    const state: GroupChatState = {
      turnCount: 0,
      consecutiveCount: 0,
      waitingForUser: false,
      finished: false,
    }

    const failureCounts = new Map<string, number>()
    const history = await this.loadHistory(sessionId)

    await this.conversationLoop({
      workspaceId,
      sessionId,
      userMsg,
      content,
      agents,
      orchestrator,
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
    orchestrator: GroupChatAgent | undefined
    projectPath: string | null
    state: GroupChatState
    history: GroupChatMessage[]
    failureCounts: Map<string, number>
  }): Promise<void> {
    const { workspaceId, sessionId, agents, orchestrator, projectPath, state, failureCounts } =
      params
    let { history } = params

    // 用户消息加入历史
    const userGroupMsg: GroupChatMessage = {
      id: params.userMsg.id,
      senderId: params.userMsg.senderId,
      senderType: 'user',
      senderName: '用户',
      content: params.content,
      mentions: extractMentions(params.content, agents).map((a) => a.name),
      createdAt: new Date(params.userMsg.createdAt),
    }
    history = [...history, userGroupMsg]

    // === 确定第一个接收消息的 Agent ===
    const mentioned = extractMentions(params.content, agents)
    let currentAgent: GroupChatAgent | null = null
    let pendingAgents: GroupChatAgent[] = []
    let turnReason = ''

    if (mentioned.length > 0) {
      // 用户 @了特定 Agent
      currentAgent = mentioned[0]!
      pendingAgents = mentioned.slice(1)
      turnReason = `用户 @${currentAgent.name}`
    } else if (orchestrator) {
      // 无 @mention → Orchestrator 接收
      currentAgent = orchestrator
      turnReason = '总指挥接收（无 @mention）'
    } else {
      // 无 Orchestrator 且无 @mention
      logger.warn({ sessionId }, 'GroupChatManager: no orchestrator and no @mention, skipping')
      await db.insert(messages).values({
        sessionId,
        senderId: 'system',
        senderType: 'system',
        type: 'text',
        content: '群聊中未配置总指挥（Orchestrator），请 @具体 Agent 或添加总指挥角色。',
        metadata: { systemEvent: 'no_orchestrator' },
      })
      return
    }

    // 如果是复杂任务且由 Orchestrator 接收，额外生成计划卡片
    if (currentAgent === orchestrator && this.isComplexTask(params.content)) {
      this.triggerOrchestratorPlan({ workspaceId, sessionId, content: params.content, agents })
    }

    // 对话循环：当前 Agent 回复 → 检查 @mention → 下一个 Agent
    while (currentAgent && !state.finished && state.turnCount < this.config.maxTotalTurns) {
      // 检查 session 是否还存在
      const [currentSession] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
      if (!currentSession) {
        logger.warn({ sessionId }, 'GroupChatManager: session deleted, stopping')
        break
      }

      // 跳过失败次数过多的 Agent
      if ((failureCounts.get(currentAgent.id) ?? 0) >= 2) {
        logger.warn(
          { agent: currentAgent.name },
          'GroupChatManager: agent exceeded failure limit, skipping',
        )
        break
      }

      logger.info(
        { agent: currentAgent.name, reason: turnReason, turn: state.turnCount },
        'GroupChatManager: agent turn',
      )

      const profile = toAgentProfile(currentAgent, projectPath)
      const prompt = this.buildAgentPrompt(currentAgent, history, agents)

      state.turnCount++
      state.lastSpeakerId = currentAgent.id

      // 广播 Agent 开始发言
      broadcastSessionEvent(sessionId, {
        type: WsEvent.AgentTyping,
        payload: {
          sessionId,
          agentId: currentAgent.id,
          agentName: currentAgent.name,
          turn: state.turnCount,
        },
      })

      // 调用 Agent
      const agentUserMsg: MessageRow = {
        id: crypto.randomUUID(),
        sessionId,
        senderId: 'group-chat-manager',
        senderType: 'user',
        type: 'text',
        content: prompt,
        metadata: {
          groupChatTurn: state.turnCount,
          selectedBy: 'route',
          selectionReason: turnReason,
          isGroupChatSystemMessage: true,
        },
        createdAt: new Date(),
      }

      const result = await runAgentReply(sessionId, agentUserMsg, profile)

      if (!result.ok) {
        const failCount = (failureCounts.get(currentAgent.id) ?? 0) + 1
        failureCounts.set(currentAgent.id, failCount)

        const errorReply = await this.getAgentReply(sessionId, result.messageId)
        const errorContent = errorReply?.content || `${currentAgent.name} 执行失败`

        logger.warn(
          {
            agent: currentAgent.name,
            cancelled: result.cancelled,
            failCount,
            error: errorContent.slice(0, 200),
          },
          'GroupChatManager: agent reply failed',
        )

        if (result.cancelled) {
          state.finished = true
          state.finishReason = 'user_stop'
          break
        }

        // 失败信息加入历史
        const errorMsg: GroupChatMessage = {
          id: `error-${state.turnCount}`,
          senderId: currentAgent.id,
          senderType: 'agent',
          senderName: currentAgent.name,
          content: errorContent,
          mentions: [],
          createdAt: new Date(),
        }
        history = [...history, errorMsg]

        // 检查是否所有 Agent 都失败
        const allAgentsFailed = agents.every((a) => (failureCounts.get(a.id) ?? 0) >= 2)
        if (allAgentsFailed) {
          logger.error(
            { failureCounts: Object.fromEntries(failureCounts) },
            'GroupChatManager: all agents failed',
          )
          state.finished = true
          state.finishReason = 'error'
          await db.insert(messages).values({
            sessionId,
            senderId: 'system',
            senderType: 'system',
            type: 'text',
            content: '所有 Agent 均执行失败，请检查配置后重试。',
            metadata: { systemEvent: 'all_agents_failed' },
          })
          break
        }

        break // 失败后停止本轮
      }

      // 读取 Agent 回复
      const agentReply = await this.getAgentReply(sessionId, result.messageId)
      if (!agentReply) {
        logger.warn({ messageId: result.messageId }, 'GroupChatManager: could not read agent reply')
        break
      }

      // 更新历史
      const agentGroupMsg: GroupChatMessage = {
        id: agentReply.id,
        senderId: currentAgent.id,
        senderType: 'agent',
        senderName: currentAgent.name,
        content: agentReply.content,
        mentions: extractMentions(agentReply.content, agents).map((a) => a.name),
        createdAt: new Date(agentReply.createdAt),
      }
      history = [...history, agentGroupMsg]

      // 检查 Agent 回复中是否 @了其他 Agent。多个 @ 会按顺序排队执行。
      const replyMentions: GroupChatAgent[] = extractMentions(agentReply.content, agents)
      const queuedIds = new Set(pendingAgents.map((a) => a.id))
      for (const mentionedAgent of replyMentions) {
        if (mentionedAgent.id === currentAgent.id || queuedIds.has(mentionedAgent.id)) continue
        pendingAgents.push(mentionedAgent)
        queuedIds.add(mentionedAgent.id)
      }
      const nextAgent = pendingAgents.shift()

      if (nextAgent) {
        currentAgent = nextAgent
        turnReason = `Agent 派发 @${currentAgent.name}`
        continue
      }

      // 没有 @mention，本轮结束
      state.finished = true
      state.finishReason = 'task_complete'
      break
    }

    if (state.turnCount >= this.config.maxTotalTurns) {
      logger.warn({ turns: state.turnCount }, 'GroupChatManager: hit max turns')
      state.finishReason = 'max_turns'
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
   * 判断任务是否复杂（是否需要生成结构化计划卡片）
   */
  private isComplexTask(content: string): boolean {
    const lower = content.toLowerCase()
    let signals = 0

    const fileRefs = content.match(
      /[\w./-]+\.(ts|tsx|js|jsx|py|rs|go|java|vue|css|scss|html|sql|json|yaml|yml|toml|md)\b/gi,
    )
    if (fileRefs && new Set(fileRefs.map((f) => f.toLowerCase())).size >= 2) signals += 2

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

    const archKeywords = [
      '架构',
      '重构',
      '系统设计',
      '整体',
      '全流程',
      '端到端',
      '从零开始',
      'architecture',
      'refactor',
      'system design',
      'end-to-end',
      'full stack',
      'fullstack',
      '全栈',
      '迁移',
      'migration',
    ]
    if (archKeywords.some((k) => lower.includes(k))) signals += 2

    const collabKeywords = [
      '同时',
      '并行',
      '一起',
      '分别',
      '各自',
      '协作',
      'simultaneously',
      'in parallel',
      'together',
      'respectively',
    ]
    if (collabKeywords.some((k) => lower.includes(k))) signals += 1

    const complexVerbs = [
      '实现',
      '创建',
      '搭建',
      '开发',
      '构建',
      '设计',
      '制作',
      '做一个',
      '生成',
      'implement',
      'create',
      'build',
      'develop',
      'design',
      'make',
      'generate',
    ]
    const techObjects = [
      'api',
      'ui',
      '数据库',
      'database',
      '认证',
      'auth',
      '组件',
      'component',
      '服务',
      'service',
      '模块',
      'module',
      '页面',
      'page',
      '网站',
      '网页',
      'webapp',
      'web app',
      'site',
      'website',
    ]
    const hasComplexVerb = complexVerbs.some((v) => lower.includes(v))
    const hasTechObject = techObjects.some((t) => lower.includes(t))
    if (hasComplexVerb && hasTechObject) signals += 1
    if (
      hasComplexVerb &&
      ['网站', '网页', 'webapp', 'web app', 'site', 'website'].some((t) => lower.includes(t))
    )
      signals += 2

    if (content.length > 200 && techObjects.some((t) => lower.includes(t))) signals += 1

    return signals >= 3
  }

  /**
   * 构造发送给 Agent 的 prompt
   */
  private buildAgentPrompt(
    agent: GroupChatAgent,
    history: GroupChatMessage[],
    agents: GroupChatAgent[],
  ): string {
    const recentHistory = history.slice(-10)
    const isCodeAgent = agent.runtimeType === 'code-agent' && agent.codeAgentType
    const isOrchestrator = agent.roleType === 'orchestrator'

    const userGoal = history.find((m) => m.senderType === 'user')?.content || ''
    const agentDirectory = agents
      .map((item) => {
        const runtime = `${item.runtimeType}${item.codeAgentType ? `/${item.codeAgentType}` : ''}`
        return `- @${item.name}: ${item.role || 'Agent'} (${runtime})`
      })
      .join('\n')

    const agentWork = recentHistory
      .filter((m) => m.senderType === 'agent' && m.senderId !== agent.id)
      .map(
        (m) => `${m.senderName}: ${m.content.slice(0, 300)}${m.content.length > 300 ? '...' : ''}`,
      )
      .join('\n')

    if (isCodeAgent) {
      const parts = [
        `你是 ${agent.name}（${agent.role || 'Agent'}）。`,
        agent.systemPrompt ? `\n${agent.systemPrompt}` : '',
        `\n\n当前群聊 Agent 名单：\n${agentDirectory || '- 无其他 Agent'}`,
        `\n\n用户原始目标：${userGoal}`,
      ]

      if (isOrchestrator) {
        parts.push(
          [
            '\n总指挥执行要求：',
            '- 用户没有 @具体 Agent 时，由你先接收并判断任务复杂度。',
            '- 复杂任务先制定阶段计划；需要落盘时可以创建或更新 plan.md。',
            '- 按 Stage 推进：信息收集 -> 设计方案 -> 实现 -> 验收 -> 汇总。',
            '- 需要其他 Agent 时，在回复中明确 @Agent名，并说明交付物、输入、输出和验收标准。',
            '- 每一阶段结束时汇总已完成内容、证据、风险和下一步。',
            '- 不要假装其他 Agent 已完成工作；只有看到群聊历史里对应回复后才能汇总其结果。',
            '- 禁止只回复 “Understood”“收到”“好的” 这类确认语；你必须给出中文阶段计划或明确派发。',
            '- 对“做网站/开发页面/webapp”这类复杂任务，第一轮至少派发 @Researcher 做资料收集，或说明为什么不需要。',
          ].join('\n'),
        )
      }

      if (agentWork) {
        parts.push(`\n其他 Agent 已完成的工作：\n${agentWork}`)
      }

      const lastAgentMsg = recentHistory.filter((m) => m.senderType === 'agent').slice(-1)[0]
      if (lastAgentMsg && lastAgentMsg.mentions?.includes(agent.name)) {
        const request = lastAgentMsg.content.slice(0, 500)
        parts.push(`\n${lastAgentMsg.senderName} 请求你帮忙：${request}`)
      }

      parts.push(
        isOrchestrator
          ? `\n请输出当前阶段的总指挥回复。如果需要派发任务，请使用 @Agent名。`
          : `\n请在当前工作区中完成上述任务。完成后请说明你做了什么。`,
      )
      return parts.join('')
    }

    const historyText = recentHistory
      .map((m) => {
        const sender = m.senderType === 'user' ? '用户' : m.senderName || m.senderId
        return `[${sender}]: ${m.content.slice(0, 500)}${m.content.length > 500 ? '...' : ''}`
      })
      .join('\n')

    return [
      `你是 ${agent.name}（${agent.role || '助手'}）。`,
      agent.systemPrompt ? `\n${agent.systemPrompt}` : '',
      `\n\n当前群聊 Agent 名单：\n${agentDirectory || '- 无其他 Agent'}`,
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
   * 触发 Orchestrator 计划生成（复杂任务时调用）
   */
  private async triggerOrchestratorPlan(params: {
    workspaceId: string
    sessionId: string
    content: string
    agents: GroupChatAgent[]
  }): Promise<void> {
    const { workspaceId, sessionId, content, agents } = params
    const orchestrator = findOrchestrator(agents)

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
        senderId: orchestrator?.id ?? 'orchestrator',
        senderType: 'agent' as const,
        type: 'task_card',
        content: loadingPlan.summary,
        metadata: {
          agentName: orchestrator?.name ?? 'Orchestrator',
          plan: { ...loadingPlan, messageId: '' },
        },
      })
      .returning()

    if (loadingCard) {
      const loadingPlanWithId = { ...loadingPlan, messageId: loadingCard.id }
      await db
        .update(messages)
        .set({
          metadata: { agentName: orchestrator?.name ?? 'Orchestrator', plan: loadingPlanWithId },
        })
        .where(eq(messages.id, loadingCard.id))
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCompleted,
        payload: {
          sessionId,
          message: {
            ...loadingCard,
            metadata: { agentName: orchestrator?.name ?? 'Orchestrator', plan: loadingPlanWithId },
          },
        },
      })
    }

    // 后台异步生成完整计划
    ;(async () => {
      try {
        const plan = await buildDynamicOrchestratorPlan(content, agents, workspaceId)
        if (loadingCard) {
          const planWithId = { ...plan, messageId: loadingCard.id }
          await db
            .update(messages)
            .set({
              content: plan.summary,
              metadata: { agentName: orchestrator?.name ?? 'Orchestrator', plan: planWithId },
            })
            .where(eq(messages.id, loadingCard.id))
          const [updatedCard] = await db
            .select()
            .from(messages)
            .where(eq(messages.id, loadingCard.id))
            .limit(1)
          if (updatedCard) {
            broadcastSessionEvent(sessionId, {
              type: WsEvent.MessageCompleted,
              payload: {
                sessionId,
                message: {
                  ...updatedCard,
                  metadata: { agentName: orchestrator?.name ?? 'Orchestrator', plan: planWithId },
                },
              },
            })
          }
        }
      } catch (err: any) {
        logger.error(
          { err: err?.message, sessionId },
          'GroupChatManager: Orchestrator plan generation failed',
        )
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
            .set({
              content: failedPlan.summary,
              metadata: {
                agentName: orchestrator?.name ?? 'Orchestrator',
                plan: { ...failedPlan, messageId: loadingCard.id },
              },
            })
            .where(eq(messages.id, loadingCard.id))
          const [failedCard] = await db
            .select()
            .from(messages)
            .where(eq(messages.id, loadingCard.id))
            .limit(1)
          if (failedCard) {
            broadcastSessionEvent(sessionId, {
              type: WsEvent.MessageCompleted,
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
async function resolveGroupWorkspaceId(sessionId: string, fallbackWorkspaceId: string) {
  const members = await db
    .select()
    .from(sessionMembers)
    .where(eq(sessionMembers.sessionId, sessionId))
  const memberAgentIds = members
    .filter((member) => member.memberType === 'agent')
    .map((member) => member.memberId)

  if (!memberAgentIds.length) return fallbackWorkspaceId

  const memberAgents = await db
    .select()
    .from(workspaceAgents)
    .where(inArray(workspaceAgents.id, memberAgentIds))
  const workspaceCounts = new Map<string, number>()
  for (const agent of memberAgents) {
    workspaceCounts.set(agent.workspaceId, (workspaceCounts.get(agent.workspaceId) ?? 0) + 1)
  }

  const bestEntry = [...workspaceCounts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!bestEntry) return fallbackWorkspaceId
  const [bestWorkspaceId, bestCount] = bestEntry
  if (bestWorkspaceId === fallbackWorkspaceId) return fallbackWorkspaceId

  const fallbackCount = workspaceCounts.get(fallbackWorkspaceId) ?? 0
  if (bestCount <= fallbackCount) return fallbackWorkspaceId

  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
  const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {}
  await db
    .update(sessions)
    .set({
      workspaceId: bestWorkspaceId,
      metadata: {
        ...metadata,
        agentIds: memberAgents
          .filter((agent) => agent.workspaceId === bestWorkspaceId)
          .sort((a, b) => a.orderIdx - b.orderIdx)
          .map((agent) => agent.id),
        previousWorkspaceId: fallbackWorkspaceId,
        repairedWorkspaceMismatchAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))

  logger.warn(
    { sessionId, fallbackWorkspaceId, resolvedWorkspaceId: bestWorkspaceId },
    'GroupChatManager repaired mismatched group workspace from session members',
  )

  return bestWorkspaceId
}

function toGroupChatAgent(row: typeof workspaceAgents.$inferSelect): GroupChatAgent {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    roleType: (row.roleType as GroupChatAgent['roleType']) ?? undefined,
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
    roleType: agent.roleType,
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
