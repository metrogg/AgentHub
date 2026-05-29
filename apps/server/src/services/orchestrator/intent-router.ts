import { buildDynamicOrchestratorPlan } from './plan-generator'
import { db, messages, eq } from '@agenthub/db'
import { broadcastSessionEvent } from '../agent-runner'
import { WsEvent } from '@agenthub/shared'
import { logger } from '../../lib/logger'

export type RouteDecision = 'DirectReply' | 'OrchestratorPlan' | 'ConversationLoop' | 'NoOrchestrator'

export interface RouteResult {
  decision: RouteDecision
  reason: string
}

export class IntentRouter {
  private defaultSignalsThreshold: number

  constructor(signalsThreshold?: number) {
    this.defaultSignalsThreshold = signalsThreshold ?? 3
  }

  route(params: {
    content: string
    hasOrchestrator: boolean
    mentionCount: number
    workspaceOverrides?: { signalsThreshold?: number }
  }): RouteResult {
    const { content, hasOrchestrator, mentionCount, workspaceOverrides } = params
    const threshold = workspaceOverrides?.signalsThreshold ?? this.defaultSignalsThreshold

    if (mentionCount > 0) {
      return { decision: 'DirectReply', reason: '用户 @了特定 Agent' }
    }

    if (!hasOrchestrator) {
      return { decision: 'NoOrchestrator', reason: '群聊中未配置 Orchestrator' }
    }

    if (this.assessComplexity(content, threshold)) {
      return { decision: 'OrchestratorPlan', reason: '检测到复杂任务，生成编排计划' }
    }

    return { decision: 'ConversationLoop', reason: 'Orchestrator 直接回复' }
  }

  assessComplexity(content: string, threshold?: number): boolean {
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
      '架构','重构','系统设计','整体','全流程','端到端','从零开始',
      'architecture','refactor','system design','end-to-end','full stack','fullstack',
      '全栈','迁移','migration',
    ]
    if (archKeywords.some((k) => lower.includes(k))) signals += 2

    const collabKeywords = [
      '同时','并行','一起','分别','各自','协作',
      'simultaneously','in parallel','together','respectively',
    ]
    if (collabKeywords.some((k) => lower.includes(k))) signals += 1

    const complexVerbs = [
      '实现','创建','搭建','开发','构建','设计','制作','做一个','生成',
      'implement','create','build','develop','design','make','generate',
    ]
    const techObjects = [
      'api','ui','数据库','database','认证','auth','组件','component','服务',
      'service','模块','module','页面','page','网站','网页','webapp','web app','site','website',
    ]
    const hasComplexVerb = complexVerbs.some((v) => lower.includes(v))
    const hasTechObject = techObjects.some((t) => lower.includes(t))
    if (hasComplexVerb && hasTechObject) signals += 1
    if (hasComplexVerb && ['网站','网页','webapp','web app','site','website'].some((t) => lower.includes(t)))
      signals += 2

    if (content.length > 200 && techObjects.some((t) => lower.includes(t))) signals += 1

    return signals >= (threshold ?? this.defaultSignalsThreshold)
  }
}

export const intentRouter = new IntentRouter()

export async function generatePlanCardBackground(
  sessionId: string,
  content: string,
  agents: any[],
  workspaceId?: string | null,
): Promise<void> {
  const orchestratorAgent =
    agents.find((a: any) => a.roleType === 'orchestrator') ??
    agents.find((a: any) => a.name.toLowerCase().includes('orchestrator'))

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
      senderId: orchestratorAgent?.id ?? 'orchestrator',
      senderType: 'agent' as const,
      type: 'task_card',
      content: loadingPlan.summary,
      metadata: {
        agentName: orchestratorAgent?.name ?? 'Orchestrator',
        plan: { ...loadingPlan, messageId: '' },
      },
    })
    .returning()

  if (!loadingCard) return

  const loadingPlanWithId = { ...loadingPlan, messageId: loadingCard.id }
  await db
    .update(messages)
    .set({ metadata: { agentName: orchestratorAgent?.name ?? 'Orchestrator', plan: loadingPlanWithId } })
    .where(eq(messages.id, loadingCard.id))

  broadcastSessionEvent(sessionId, {
    type: WsEvent.MessageCompleted,
    payload: {
      sessionId,
      message: { ...loadingCard, metadata: { agentName: orchestratorAgent?.name ?? 'Orchestrator', plan: loadingPlanWithId } },
    },
  })

  try {
    const plan = await buildDynamicOrchestratorPlan(content, agents, workspaceId)
    const planWithId = { ...plan, messageId: loadingCard.id }
    await db
      .update(messages)
      .set({ content: plan.summary, metadata: { agentName: orchestratorAgent?.name ?? 'Orchestrator', plan: planWithId } })
      .where(eq(messages.id, loadingCard.id))
    const [updatedCard] = await db.select().from(messages).where(eq(messages.id, loadingCard.id)).limit(1)
    if (updatedCard) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCompleted,
        payload: { sessionId, message: { ...updatedCard, metadata: { agentName: orchestratorAgent?.name ?? 'Orchestrator', plan: planWithId } } },
      })
    }
  } catch (err: any) {
    logger.error({ err: err?.message, sessionId }, 'IntentRouter: plan card generation failed')
    const failedPlan = { kind: 'orchestrator_plan' as const, title: '计划生成失败', goal: '分析任务时出错，请稍后重试', summary: '分析任务时出错，请稍后重试', tasks: [], agents: [] }
    await db.update(messages).set({ content: failedPlan.summary, metadata: { agentName: orchestratorAgent?.name ?? 'Orchestrator', plan: { ...failedPlan, messageId: loadingCard.id } } }).where(eq(messages.id, loadingCard.id))
    const [failedCard] = await db.select().from(messages).where(eq(messages.id, loadingCard.id)).limit(1)
    if (failedCard) {
      broadcastSessionEvent(sessionId, { type: WsEvent.MessageCompleted, payload: { sessionId, message: failedCard } })
    }
  }
}