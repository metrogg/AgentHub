import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { AppError, AppErrorCodes } from '../lib/error'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlink, writeFile } from 'node:fs/promises'
import {
  sendMessageSchema,
  ROLE_PRESETS,
  DEFAULT_CODE_TEAM_ROLE_TYPES,
  TaskStatus,
  AgentRoleType,
  RuntimeType,
  CodeAgentType,
  SandboxPolicy,
  TaskType,
  WsEvent,
} from '@agenthub/shared'
import { logger } from '../lib/logger'
import {
  db,
  messages,
  sessions,
  sessionMembers,
  workspaceAgents,
  workspaceAgentRelations,
  workspaces,
  workspaceTasks,
  orchestratorRuns,
  and,
  eq,
  asc,
  desc,
} from '@agenthub/db'
import { inArray } from 'drizzle-orm'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import type { AgentRunProfile, MessageRow } from '../services/agent-runner'
import { broadcastSessionEvent, runAgentReply } from '../services/agent-runner'
import { OrchestratorEngine } from '../services/orchestrator/orchestrator-engine'
import {
  extractJsonObject,
  cleanPlanText,
  normalizeTaskOutputContract,
  normalizeTaskValidation,
  titleFromGoal,
} from '../services/orchestrator/planner'
import type {
  ExecutionPlan,
  TaskOutputContract,
  TaskValidation,
} from '../services/orchestrator/types'
import { emitRunEvent } from '../services/orchestrator/run-events'
import { initializeRunLedger } from '../services/orchestrator/run-ledger'
import { checkInputGuardrails } from '../services/orchestrator/input-guardrails'
import {
  buildDynamicOrchestratorPlan,
  loadWorkspaceAgentRelationsForPlanning,
} from '../services/orchestrator/plan-generator'
import {
  confirmAgentDraftSchema,
  type AgentDraft,
  buildAgentDraft,
  parseAgentDraft,
  normalizeAgentDraftInput,
} from '../services/agent-draft'
import { type DemoArtifact, buildDemoArtifacts, artifactSummary } from '../services/artifact-demo'

import { intentRouter } from '../services/orchestrator/intent-router'
import { buildAgentProfile } from '../services/agents/profile-builder'
import {
  createWorkspaceGroupSession,
  ensureAgentChildSession,
} from '../services/workspace/session-manager'

const orchestratorPlanSchema = z.object({
  content: z.string().min(1).max(10000),
})

const artifactDemoSchema = z.object({
  content: z.string().min(1).max(10000),
})

const agentDraftSchema = z.object({
  content: z.string().min(1).max(10000),
})

const updateOrchestratorPlanSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      agentKey: z.string().min(1).optional(),
      status: z.enum(Object.values(TaskStatus) as [string, ...string[]]).optional(),
    }),
  ),
})

const updateMessageSchema = z.object({
  content: z.string().min(1).max(10000),
})

// PLAN_AGENTS removed: fallback now uses unified ROLE_PRESETS from @agenthub/shared

type PlanAgent = {
  key: string
  name: string
  role: string
  roleType?: AgentRoleType
  color: string
  systemPrompt: string
  description?: string
  roleProfile?: Record<string, unknown> | null
  modelId?: string | null
  runtimeType?: RuntimeType
  codeAgentType?: CodeAgentType | null
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: SandboxPolicy
}

type PlanTask = {
  id: string
  phaseId?: string
  title: string
  description: string
  agentKey: string
  status?: TaskStatus
  taskType?: TaskType
  dependencies?: string[]
  parallelGroup?: string
  maxRetries?: number
  fallbackAgentId?: string
  outputContract?: TaskOutputContract
  validation?: TaskValidation
  agentSelection?: {
    selectedAgentKey: string
    score: number
    rationale: string[]
    reviewerAgentKey?: string
    fallbackAgentKey?: string
  }
}

type PlanPhase = {
  id: string
  title: string
  purpose: string
  taskIds: string[]
}

type OrchestratorDispatchResult = {
  runId: string
  workspaceId: string
  groupSessionId?: string
  tasks: Array<{ taskId: string; sessionId: string; title: string; agentName: string }>
}

type OrchestratorPlan = {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: PlanAgent[]
  phases?: PlanPhase[]
  tasks: PlanTask[]
  dispatchResult?: OrchestratorDispatchResult
}

type DispatchMonitor = {
  dispatchId: string
  groupSessionId?: string
  taskIds: string[]
}

export const messageRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/:sessionId', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    return c.json({ items: list })
  })
  .delete('/:sessionId/all', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    await db.delete(messages).where(eq(messages.sessionId, sessionId))
    return c.json({ deleted: true })
  })
  .post('/:sessionId/cancel', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const { cancelAgentReply } = await import('../services/agent-runner')
    return c.json({ cancelled: cancelAgentReply(sessionId) })
  })
  .patch('/:sessionId/:messageId', zValidator('json', updateMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (
      !message ||
      message.sessionId !== sessionId ||
      message.senderType !== 'user' ||
      message.senderId !== user.sub
    ) {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    }

    const metadata =
      message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
    const [updated] = await db
      .update(messages)
      .set({
        content,
        metadata: {
          ...metadata,
          ...(typeof metadata.displayContent === 'string' ? { displayContent: content } : {}),
          editedAt: new Date().toISOString(),
        },
      })
      .where(eq(messages.id, messageId))
      .returning()
    if (!updated) throw AppError.fromCode(AppErrorCodes.MESSAGE_UPDATE_FAILED, '消息更新失败')
    return c.json(updated)
  })
  .patch('/:sessionId/:messageId/pin', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!message || message.sessionId !== sessionId)
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    const [updated] = await db
      .update(messages)
      .set({ isPinned: true })
      .where(eq(messages.id, messageId))
      .returning()
    if (!updated) throw AppError.fromCode(AppErrorCodes.MESSAGE_PIN_FAILED, '消息置顶失败')
    return c.json(updated)
  })
  .patch('/:sessionId/:messageId/unpin', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!message || message.sessionId !== sessionId)
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    const [updated] = await db
      .update(messages)
      .set({ isPinned: false })
      .where(eq(messages.id, messageId))
      .returning()
    if (!updated) throw AppError.fromCode(AppErrorCodes.MESSAGE_PIN_FAILED, '消息取消置顶失败')
    return c.json(updated)
  })
  .delete('/:sessionId/:messageId', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const rollback = c.req.query('rollback') !== 'false'
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    const targetIndex = list.findIndex((message) => message.id === messageId)
    const target = targetIndex >= 0 ? list[targetIndex] : null
    if (!target || target.senderType !== 'user' || target.senderId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    }

    const affected = collectAffectedMessages(list, targetIndex)
    const rollbackResult = rollback
      ? await rollbackCodeAgentChanges(session, affected)
      : { reverted: 0, failed: 0 }
    const ids = [target.id, ...affected.map((message) => message.id)]
    for (const id of ids) {
      await db.delete(messages).where(eq(messages.id, id))
    }
    const { cancelAgentReply } = await import('../services/agent-runner')
    cancelAgentReply(sessionId)
    return c.json({ removedMessageIds: ids, rollback: rollbackResult })
  })
  .post('/:sessionId/:messageId/regenerate', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    const messageIndex = list.findIndex((message) => message.id === messageId)
    const message = messageIndex >= 0 ? list[messageIndex] : null
    if (!message || message.senderType !== 'agent')
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'Agent 消息不存在')
    const previousUser = [...list.slice(0, messageIndex)]
      .reverse()
      .find((item) => item.senderType === 'user')
    if (!previousUser)
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '没有可重新生成的用户消息')

    await db.delete(messages).where(eq(messages.id, message.id))
    const { cancelAgentReply } = await import('../services/agent-runner')
    cancelAgentReply(sessionId)
    if (session.type === 'group' && session.workspaceId) {
      const agentRows = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.workspaceId, session.workspaceId))
        .orderBy(asc(workspaceAgents.orderIdx))

      const hasOrchestrator = agentRows.some((a) => a.roleType === 'orchestrator')
      const content = previousUser.content
      const mentionCount = (content.match(/@\S+/g) || []).length

      if (mentionCount > 0) {
        const mentionPattern = /@(\S+)/g
        let match
        const mentionedNames: string[] = []
        while ((match = mentionPattern.exec(content)) !== null) {
          mentionedNames.push(match[1]!.toLowerCase())
        }

        const matchedAgents = agentRows.filter(a => {
          const nameLower = a.name.toLowerCase()
          const roleLower = (a.role || '').toLowerCase()
          return mentionedNames.some(n => 
            nameLower === n || nameLower.includes(n) || roleLower === n || roleLower.includes(n)
          )
        })

        if (matchedAgents.length > 0) {
          const targetAgent = matchedAgents[0]!
          await ensureWorkspaceAgentChildSessions(session.workspaceId, user.sub)
          const [workspace] = await db
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, session.workspaceId))
            .limit(1)
          const profile = toAgentProfile(targetAgent, workspace?.projectPath)
          runAgentReply(sessionId, previousUser, profile).catch((err: any) =>
            logger.error({ err: err?.message, sessionId }, '@mention agent reply failed on regenerate'),
          )
        } else {
          const orchestrator = agentRows.find(a => a.roleType === 'orchestrator')
          if (orchestrator) {
            await ensureWorkspaceAgentChildSessions(session.workspaceId, user.sub)
            const [workspace] = await db
              .select()
              .from(workspaces)
              .where(eq(workspaces.id, session.workspaceId))
              .limit(1)
            const profile = toAgentProfile(orchestrator, workspace?.projectPath)
            runAgentReply(sessionId, previousUser, profile).catch((err: any) =>
              logger.error({ err: err?.message, sessionId }, '@mention fallback orchestrator reply failed on regenerate'),
            )
          }
        }
        return c.json({ removedMessageId: message.id })
      }

      if (!hasOrchestrator) {
        return c.json({ removedMessageId: message.id })
      }

      const routeResult = intentRouter.route({ content, hasOrchestrator, mentionCount: 0 })

      if (routeResult.decision === 'ConversationLoop') {
        handleSimpleReply(sessionId, content, agentRows, session.workspaceId, user.sub).catch(
          (err: any) => logger.error({ err: err?.message, sessionId }, 'Simple reply failed on regenerate'),
        )
      } else if (routeResult.decision === 'OrchestratorPlan') {
        generatePlanAndPushTaskBoard(sessionId, content, agentRows, session.workspaceId).catch(
          (err: any) => logger.error({ err: err?.message, sessionId }, 'Plan generation failed on regenerate'),
        )
      }
    } else {
      const profile = await profileForDirectSession(session)
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(sessionId, previousUser, profile).catch((err: any) =>
          logger.error({ err: err?.message, sessionId }, 'runAgentReply failed on regenerate'),
        )
      })
    }
    return c.json({ removedMessageId: message.id })
  })
  .post('/:sessionId', zValidator('json', sendMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const { content, type, metadata } = c.req.valid('json')
    const [msg] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: user.sub,
        senderType: 'user',
        type,
        content,
        metadata,
        replyToMessageId: metadata?.replyToMessageId as string | undefined,
      })
      .returning()
    // Trigger agent reply asynchronously (do not await to keep response fast).
    if (msg && !metadata?.skipAgentReply) {
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
      if (session?.type === 'group' && session.workspaceId) {
        const agentRows = await db
          .select()
          .from(workspaceAgents)
          .where(eq(workspaceAgents.workspaceId, session.workspaceId))
          .orderBy(asc(workspaceAgents.orderIdx))

        const hasOrchestrator = agentRows.some((a) => a.roleType === 'orchestrator')
        const mentionCount = (content.match(/@\S+/g) || []).length

        if (mentionCount > 0) {
          const mentionPattern = /@(\S+)/g
          let match
          const mentionedNames: string[] = []
          while ((match = mentionPattern.exec(content)) !== null) {
            mentionedNames.push(match[1]!.toLowerCase())
          }

          const matchedAgents = agentRows.filter(a => {
            const nameLower = a.name.toLowerCase()
            const roleLower = (a.role || '').toLowerCase()
            return mentionedNames.some(n => 
              nameLower === n || nameLower.includes(n) || roleLower === n || roleLower.includes(n)
            )
          })

          if (matchedAgents.length > 0) {
            const targetAgent = matchedAgents[0]!
            await ensureWorkspaceAgentChildSessions(session.workspaceId, user.sub)
            const [workspace] = await db
              .select()
              .from(workspaces)
              .where(eq(workspaces.id, session.workspaceId))
              .limit(1)
            const profile = toAgentProfile(targetAgent, workspace?.projectPath)
            runAgentReply(sessionId, msg, profile).catch((err: any) =>
              logger.error({ err: err?.message, sessionId }, '@mention agent reply failed'),
            )
          } else {
            const orchestrator = agentRows.find(a => a.roleType === 'orchestrator')
            if (orchestrator) {
              await ensureWorkspaceAgentChildSessions(session.workspaceId, user.sub)
              const [workspace] = await db
                .select()
                .from(workspaces)
                .where(eq(workspaces.id, session.workspaceId))
                .limit(1)
              const profile = toAgentProfile(orchestrator, workspace?.projectPath)
              runAgentReply(sessionId, msg, profile).catch((err: any) =>
                logger.error({ err: err?.message, sessionId }, '@mention fallback orchestrator reply failed'),
              )
            } else {
              await db.insert(messages).values({
                sessionId,
                senderId: 'system',
                senderType: 'system',
                type: 'text',
                content: '⚠️ 未找到指定的 Agent，也未配置 Orchestrator。',
                metadata: { systemEvent: 'no_orchestrator' },
              })
            }
          }
          return c.json(msg)
        }

        if (!hasOrchestrator) {
          await db.insert(messages).values({
            sessionId,
            senderId: 'system',
            senderType: 'system',
            type: 'text',
            content:
              '⚠️ 群聊中未配置 Orchestrator。请添加一个 Orchestrator Agent 或使用 @Agent名 指定回复对象。',
            metadata: { systemEvent: 'no_orchestrator' },
          })
          return c.json(msg)
        }

        const routeResult = intentRouter.route({ content, hasOrchestrator, mentionCount: 0 })

        if (routeResult.decision === 'ConversationLoop') {
          handleSimpleReply(sessionId, content, agentRows, session.workspaceId, user.sub).catch(
            (err: any) =>
              logger.error({ err: err?.message, sessionId }, 'Simple reply failed'),
          )
        } else if (routeResult.decision === 'OrchestratorPlan') {
          generatePlanAndPushTaskBoard(sessionId, content, agentRows, session.workspaceId).catch(
            (err: any) =>
              logger.error({ err: err?.message, sessionId }, 'Plan generation background task failed'),
          )
        }
      } else {
        const profile = session ? await profileForDirectSession(session) : undefined
        runAgentReply(sessionId, msg, profile).catch((err: any) =>
          logger.error({ err: err?.message, sessionId }, 'runAgentReply failed on new message'),
        )
      }
    }
    return c.json(msg)
  })
  .post('/:sessionId/orchestrator-plan', zValidator('json', orchestratorPlanSchema), async (c) => {
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const agentList = session.workspaceId
      ? await db
          .select()
          .from(workspaceAgents)
          .where(eq(workspaceAgents.workspaceId, session.workspaceId))
          .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
      : []
    const orchestratorAgent =
      agentList.find((agent) => agent.roleType === 'orchestrator') ??
      agentList.find(
        (agent) =>
          agent.name.toLowerCase().includes('orchestrator') || agent.role.includes('总指挥'),
      )

    // 先插入 loading 占位消息，立即返回，避免前端空白等待
    const loadingPlan: OrchestratorPlan = {
      kind: 'orchestrator_plan',
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
        senderType: 'agent',
        type: 'task_card',
        content: loadingPlan.summary,
        metadata: {
          agentName: orchestratorAgent?.name ?? 'Orchestrator',
          plan: { ...loadingPlan, messageId: '' },
        },
      })
      .returning()
    if (!loadingCard)
      throw AppError.fromCode(AppErrorCodes.ORCHESTRATOR_PLAN_FAILED, '编排计划卡片创建失败')

    const loadingPlanWithId = { ...loadingPlan, messageId: loadingCard.id }
    await db
      .update(messages)
      .set({
        metadata: { agentName: orchestratorAgent?.name ?? 'Orchestrator', plan: loadingPlanWithId },
      })
      .where(eq(messages.id, loadingCard.id))

    // 立即广播 loading 消息，让前端即时显示
    broadcastSessionEvent(sessionId, {
      type: WsEvent.MessageCompleted,
      payload: {
        sessionId,
        message: {
          ...loadingCard,
          metadata: {
            agentName: orchestratorAgent?.name ?? 'Orchestrator',
            plan: loadingPlanWithId,
          },
        },
      },
    })

    // 后台异步生成完整计划
    ;(async () => {
      try {
        const plan = await buildDynamicOrchestratorPlan(content, agentList, session.workspaceId)
        const runId = randomUUID()

        await db.insert(orchestratorRuns).values({
          id: runId,
          workspaceId: session.workspaceId!,
          groupSessionId: sessionId,
          planMessageId: loadingCard.id,
          status: 'planning',
          plan: plan as unknown as Record<string, unknown>,
        })

        await emitRunEvent({
          runId,
          workspaceId: session.workspaceId!,
          groupSessionId: sessionId,
          type: 'plan.created',
          payload: { title: plan.title, goal: plan.goal, taskCount: plan.tasks.length },
        })

        const planWithId = { ...plan, messageId: loadingCard.id }
        await db
          .update(messages)
          .set({
            content: plan.summary,
            metadata: { agentName: orchestratorAgent?.name ?? 'Orchestrator', plan: planWithId },
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
                metadata: {
                  agentName: orchestratorAgent?.name ?? 'Orchestrator',
                  plan: planWithId,
                },
              },
            },
          })
        }

        broadcastSessionEvent(sessionId, {
          type: WsEvent.TaskBoardPlanReady,
          payload: { runId, plan, sessionId },
        })
      } catch (err: any) {
        logger.error({ err: err?.message, sessionId }, 'Orchestrator plan generation failed, using fallback')
        const fallbackPlan = buildSimpleFallbackPlan(agentList, content)
        const runId = randomUUID()

        await db.insert(orchestratorRuns).values({
          id: runId,
          workspaceId: session.workspaceId!,
          groupSessionId: sessionId,
          planMessageId: loadingCard.id,
          status: 'planning',
          plan: fallbackPlan as unknown as Record<string, unknown>,
        })

        await emitRunEvent({
          runId,
          workspaceId: session.workspaceId!,
          groupSessionId: sessionId,
          type: 'plan.created',
          payload: { title: fallbackPlan.title, goal: fallbackPlan.goal, taskCount: fallbackPlan.tasks.length, isFallback: true },
        })

        const planWithId = { ...fallbackPlan, messageId: loadingCard.id }
        await db
          .update(messages)
          .set({
            content: fallbackPlan.summary,
            metadata: { agentName: orchestratorAgent?.name ?? 'Orchestrator', plan: planWithId },
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

        broadcastSessionEvent(sessionId, {
          type: WsEvent.TaskBoardPlanReady,
          payload: { runId, plan: fallbackPlan, sessionId },
        })
      }
    })()

    return c.json({ ...loadingCard, metadata: { plan: loadingPlanWithId } })
  })
  .post('/:sessionId/artifact-demo', zValidator('json', artifactDemoSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    }

    // 若 workspace 中存在名字匹配的 agent，使用其真实 id
    let artifactAgentId = 'artifact-agent'
    if (session.workspaceId) {
      const wsAgents = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.workspaceId, session.workspaceId))
      const matched = wsAgents.find(
        (a) => a.name.toLowerCase().includes('artifact') || a.role.toLowerCase().includes('产物'),
      )
      if (matched) artifactAgentId = matched.id
    }

    const artifacts = buildDemoArtifacts(content)
    const [card] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: artifactAgentId,
        senderType: 'agent',
        type: 'text',
        content: artifactSummary(artifacts),
        metadata: {
          agentName: 'Artifact Agent',
          role: '产物预览',
          runtimeType: 'llm',
          artifacts,
        },
      })
      .returning()
    if (!card) throw AppError.fromCode(AppErrorCodes.INTERNAL_ERROR, '产物卡片创建失败')
    return c.json(card)
  })
  .post('/:sessionId/agent-draft', zValidator('json', agentDraftSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    // 查找 workspace 中可能的 builder agent
    let builderAgentId = 'agent-builder'
    if (session.workspaceId) {
      const wsAgents = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.workspaceId, session.workspaceId))
      const matched = wsAgents.find(
        (a) =>
          a.name.toLowerCase().includes('builder') ||
          a.role.toLowerCase().includes('构建'),
      )
      if (matched) builderAgentId = matched.id
    }

    if (session.type !== 'group' || !session.workspaceId) {
      const [prompt] = await db
        .insert(messages)
        .values({
          sessionId,
          senderId: builderAgentId,
          senderType: 'agent',
          type: 'text',
          content:
            '请先打开或创建一个 Agent Group，再通过聊天创建 Agent。这样新 Agent 才能加入明确的 workspace 和Agent 联系人列表。',
          metadata: { agentDraftStatus: 'requires_group' },
        })
        .returning()
      if (!prompt) throw AppError.fromCode(AppErrorCodes.INTERNAL_ERROR, 'Agent 群组提示创建失败')
      return c.json(prompt)
    }

    const draft = buildAgentDraft(content)
    const [card] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: builderAgentId,
        senderType: 'agent',
        type: 'task_card',
        content: `已生成 ${draft.name} Agent 草案。确认后会加入当前 Agent Group。`,
        metadata: { agentDraft: draft, agentDraftStatus: 'draft' },
      })
      .returning()
    if (!card) throw AppError.fromCode(AppErrorCodes.INTERNAL_ERROR, 'Agent 草案创建失败')
    return c.json(card)
  })
  .post(
    '/:sessionId/agent-draft/:messageId/confirm',
    zValidator('json', confirmAgentDraftSchema),
    async (c) => {
      const user = c.get('user')
      const sessionId = c.req.param('sessionId')
      const messageId = c.req.param('messageId')
      const { draft: draftOverride } = c.req.valid('json')

      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
      if (
        !session ||
        session.ownerId !== user.sub ||
        session.type !== 'group' ||
        !session.workspaceId
      ) {
        throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, 'Agent 群组会话不存在')
      }
      const [card] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
      if (!card || card.sessionId !== sessionId)
        throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'Agent 草案不存在')

      const cardMetadata = card.metadata as {
        agentDraftStatus?: unknown
        createdAgentId?: unknown
      } | null
      if (card.type !== 'task_card')
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '消息不是 Agent 草案')
      if (cardMetadata?.agentDraftStatus === 'confirmed') {
        if (typeof cardMetadata.createdAgentId !== 'string') {
          throw AppError.fromCode(
            AppErrorCodes.VALIDATION_FAILED,
            'Agent 草案已确认但缺少创建的 Agent ID',
          )
        }
        const [existingAgent] = await db
          .select()
          .from(workspaceAgents)
          .where(
            and(
              eq(workspaceAgents.id, cardMetadata.createdAgentId),
              eq(workspaceAgents.workspaceId, session.workspaceId),
            ),
          )
          .limit(1)
        if (!existingAgent)
          throw AppError.fromCode(
            AppErrorCodes.AGENT_NOT_FOUND,
            '已确认的 Agent 草案指向不存在的 Agent',
          )
        return c.json({ agent: existingAgent, message: card })
      }
      if (cardMetadata?.agentDraftStatus !== 'draft') {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '消息不是可编辑的 Agent 草案')
      }

      const metadataDraft = parseAgentDraft(card.metadata)
      if (!metadataDraft)
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Agent 草案元数据无效')
      const draft = normalizeAgentDraftInput(draftOverride ?? metadataDraft)
      if (!draft) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Agent 草案元数据无效')

      const existing = await db
        .select({ id: workspaceAgents.id })
        .from(workspaceAgents)
        .where(eq(workspaceAgents.workspaceId, session.workspaceId))
      const [agent] = await db
        .insert(workspaceAgents)
        .values({ ...draft, workspaceId: session.workspaceId, orderIdx: existing.length })
        .returning()
      if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_REPLY_FAILED, 'Agent 创建失败')

      await db.insert(sessionMembers).values({
        sessionId,
        memberType: 'agent',
        memberId: agent.id,
      })
      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, session.workspaceId))
        .limit(1)
      await ensureAgentChildSession(
        session.workspaceId,
        workspace?.name ?? 'Agent Group',
        user.sub,
        agent,
      )
      await db
        .update(workspaces)
        .set({ updatedAt: new Date() })
        .where(eq(workspaces.id, session.workspaceId))
      const [updatedCard] = await db
        .update(messages)
        .set({
          content: `${agent.name} 已加入当前 Agent Group。`,
          metadata: {
            ...(card.metadata ?? {}),
            agentDraft: draft,
            agentDraftStatus: 'confirmed',
            createdAgentId: agent.id,
          },
        })
        .where(eq(messages.id, messageId))
        .returning()

      return c.json({ agent, message: updatedCard ?? card })
    },
  )
  .patch(
    '/:sessionId/orchestrator-plan/:messageId',
    zValidator('json', updateOrchestratorPlanSchema),
    async (c) => {
      const sessionId = c.req.param('sessionId')
      const messageId = c.req.param('messageId')
      const { tasks } = c.req.valid('json')

      const [card] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
      if (!card || card.sessionId !== sessionId || card.type !== 'task_card') {
        throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '计划卡片不存在')
      }

      const parsed = parsePlan(card.metadata)
      if (!parsed) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '计划元数据无效')

      const updates = new Map(tasks.map((task) => [task.id, task]))
      const agentKeys = new Set<string>(parsed.agents.map((agent) => agent.key))
      const nextPlan: OrchestratorPlan = {
        ...parsed,
        tasks: parsed.tasks.map((task) => {
          const patch = updates.get(task.id)
          if (!patch) return task
          return {
            ...task,
            agentKey:
              patch.agentKey && agentKeys.has(patch.agentKey)
                ? (patch.agentKey as PlanTask['agentKey'])
                : task.agentKey,
            status: (patch.status as TaskStatus | undefined) ?? task.status,
          }
        }),
      }

      const metadata = card.metadata && typeof card.metadata === 'object' ? card.metadata : {}
      const [updated] = await db
        .update(messages)
        .set({ content: nextPlan.summary, metadata: { ...metadata, plan: nextPlan } })
        .where(eq(messages.id, messageId))
        .returning()
      if (!updated) throw AppError.fromCode(AppErrorCodes.MESSAGE_UPDATE_FAILED, '计划卡片更新失败')
      return c.json(updated)
    },
  )
  .post('/:sessionId/orchestrator-plan/:messageId/dispatch', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')

    const [card] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!card || card.sessionId !== sessionId || card.type !== 'task_card') {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '计划卡片不存在')
    }

    const parsed = parsePlan(card.metadata)
    if (!parsed) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '计划元数据无效')

    // Guardrails: check user intent for dangerous operations
    const guardrails = checkInputGuardrails(parsed.goal)
    if (!guardrails.ok && guardrails.riskLevel === 'high') {
      return c.json(
        {
          ok: false,
          blocked: true,
          riskLevel: guardrails.riskLevel,
          violations: guardrails.violations,
          message: `请求被安全策略拦截：${guardrails.violations.join('；')}`,
        },
        400,
      )
    }

    const [sourceSession] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)

    let workspaceId: string
    let groupSessionId: string
    let createdAgents: Array<typeof workspaceAgents.$inferSelect>

    let agentsByKey: Map<string, typeof workspaceAgents.$inferSelect>

    if (sourceSession?.workspaceId && sourceSession.ownerId === user.sub) {
      // 复用当前会话绑定的 workspace，不因当前会话不是群聊而另建工作区。
      const existing = await dispatchPlanToExistingGroup(sourceSession, user.sub, parsed)
      workspaceId = existing.workspaceId
      if (sourceSession.type === 'group') {
        groupSessionId = existing.groupSessionId
      } else {
        // 修复 Bug 1: 如果源会话是 direct，必须找到/创建对应的 group session
        const { ensureGroupSession } = await import('../services/workspace/group-session')
        const groupSession = await ensureGroupSession(workspaceId, user.sub)
        groupSessionId = groupSession.id
      }
      agentsByKey = existing.agentsByKey
      createdAgents = Array.from(agentsByKey.values())
    } else {
      // 新建 workspace
      const [workspace] = await db
        .insert(workspaces)
        .values({ ownerId: user.sub, name: parsed.title, goal: parsed.goal })
        .returning()
      if (!workspace)
        throw AppError.fromCode(AppErrorCodes.WORKSPACE_CREATE_FAILED, '工作区创建失败')
      workspaceId = workspace.id

      createdAgents = await db
        .insert(workspaceAgents)
        .values(
          parsed.agents.map((agent, index) => ({
            workspaceId: workspace.id,
            name: agent.name,
            role: agent.role,
            roleType: agent.roleType ?? 'custom',
            description: agent.description ?? '',
            systemPrompt: agent.systemPrompt,
            roleProfile: agent.roleProfile ?? null,
            color: agent.color,
            modelId: agent.modelId ?? null,
            runtimeType: agent.runtimeType ?? 'llm',
            codeAgentType: agent.runtimeType === 'code-agent' ? agent.codeAgentType ?? null : null,
            capabilityTags: agent.capabilityTags ?? [],
            toolPermissions: agent.toolPermissions ?? [],
            sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
            orderIdx: index,
          })),
        )
        .returning()

      const groupSession = await createWorkspaceGroupSession(
        workspace.id,
        workspace.name,
        user.sub,
        createdAgents,
      )
      groupSessionId = groupSession.id
      agentsByKey = new Map<string, typeof workspaceAgents.$inferSelect>()
      for (let i = 0; i < parsed.agents.length; i++) {
        const agent = createdAgents[i]
        if (agent) agentsByKey.set(parsed.agents[i]!.key, agent)
      }
    }
    const childSessions = new Map<
      string,
      { sessionId: string; workspaceId: string; projectPath?: string | null }
    >()
    const taskResults: OrchestratorDispatchResult['tasks'] = []

    // 查询 workspace 获取 projectPath（用于 Git 分支隔离）
    const [workspaceRecord] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    const projectPath = workspaceRecord?.projectPath ?? null

    // 统一 runId：orchestratorRuns.id 和 ExecutionPlan.runId 使用同一个 UUID
    const runId = crypto.randomUUID()

    // 创建 workspaceTasks 和 child sessions
    // 每个任务独立 session，不复用，避免上下文污染
    // 如果任务 ID 已存在（旧 plan 使用 task1/task2 等简单 ID 导致冲突），自动分配新 UUID
    const taskIdRemap = new Map<string, string>()
    for (const [index, task] of parsed.tasks.entries()) {
      const agent = agentsByKey.get(task.agentKey)
      const phaseId = task.phaseId
      let taskId = task.id
      const existingTask = await db
        .select({ id: workspaceTasks.id })
        .from(workspaceTasks)
        .where(eq(workspaceTasks.id, taskId))
        .limit(1)
      if (existingTask.length > 0) {
        taskId = crypto.randomUUID()
        taskIdRemap.set(task.id, taskId)
        task.id = taskId
      }
      const [workspaceTask] = await db
        .insert(workspaceTasks)
        .values({
          id: taskId,
          workspaceId,
          agentId: agent?.id ?? null,
          title: task.title,
          description: task.description,
          status: 'pending',
          orderIdx: index,
          runId,
          phaseId,
          dependencies: (task.dependencies ?? []).map((depId) => taskIdRemap.get(depId) ?? depId),
          parallelGroup: task.parallelGroup,
          maxRetries: task.maxRetries ?? 2,
        })
        .returning()

      // Orchestrator 任务：每个 task 独立 session，不复用
      const [childSession] = await db
        .insert(sessions)
        .values({
          title: agent
            ? `${parsed.title} / ${agent.name} / ${task.title.slice(0, 24)}`
            : `${parsed.title} / ${task.title.slice(0, 24)}`,
          type: 'direct',
          ownerId: user.sub,
          workspaceId,
          workspaceAgentId: agent?.id ?? null,
          metadata: {
            kind: 'orchestrator-task',
            orchestratorRunId: runId,
            orchestratorTaskId: task.id,
          },
        })
        .returning()
      if (!childSession)
        throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '任务会话创建失败')

      if (workspaceTask) {
        await db
          .update(workspaceTasks)
          .set({ sessionId: childSession.id })
          .where(eq(workspaceTasks.id, workspaceTask.id))
      }

      childSessions.set(task.id, { sessionId: childSession.id, workspaceId, projectPath })
      taskResults.push({
        taskId: workspaceTask?.id ?? task.id,
        sessionId: childSession.id,
        title: task.title,
        agentName: agent?.name ?? 'Agent',
      })
    }

    // 修复 Bug 9: Task ID 重映射后同步更新 phases 中的 taskIds
    if (taskIdRemap.size > 0 && parsed.phases) {
      for (const phase of parsed.phases) {
        if (phase.taskIds) {
          phase.taskIds = phase.taskIds.map((tid) => taskIdRemap.get(tid) ?? tid)
        }
      }
    }

    // 构建 ExecutionPlan 并启动 OrchestratorEngine
    const executionRelations = await loadWorkspaceAgentRelationsForPlanning(workspaceId)

    const rawExecutionPlan: ExecutionPlan = {
      runId,
      title: parsed.title,
      goal: parsed.goal,
      phases: parsed.phases,
      agentRelations: executionRelations,
      agents: parsed.agents.map((a) => {
        const dbAgent = agentsByKey.get(a.key)
        return {
          id: dbAgent?.id ?? a.key,
          key: a.key,
          name: a.name,
          role: a.role,
          roleType: dbAgent?.roleType ?? a.roleType,
          description: a.description,
          color: a.color,
          systemPrompt: a.systemPrompt,
          roleProfile: dbAgent?.roleProfile ?? a.roleProfile,
          modelId: a.modelId,
          runtimeType: a.runtimeType ?? 'llm',
          codeAgentType: a.codeAgentType ?? undefined,
          capabilityTags: a.capabilityTags ?? [],
          toolPermissions: a.toolPermissions ?? [],
          sandboxPolicy: a.sandboxPolicy ?? 'workspace-write',
        }
      }),
      tasks: parsed.tasks.map((t, index) => ({
        id: t.id,
        phaseId: t.phaseId,
        title: t.title,
        description: t.description,
        agentId: agentsByKey.get(t.agentKey)?.id ?? t.agentKey,
        taskType: t.taskType,
        dependencies: t.dependencies ?? [],
        parallelGroup: t.parallelGroup,
        maxRetries: t.maxRetries ?? 2,
        fallbackAgentId: t.fallbackAgentId,
        outputContract: normalizeTaskOutputContract(t.outputContract, t.id),
        validation: normalizeTaskValidation(t.validation),
        agentSelection: t.agentSelection,
      })),
    }
    const executionPlan = initializeRunLedger(rawExecutionPlan)

    await db.insert(orchestratorRuns).values({
      id: runId,
      workspaceId,
      groupSessionId,
      planMessageId: messageId,
      status: 'running',
      plan: executionPlan as unknown as Record<string, unknown>,
    })

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      type: 'run.started',
      payload: { title: executionPlan.title, goal: executionPlan.goal },
    })
    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      type: 'plan.created',
      payload: {
        title: executionPlan.title,
        taskCount: executionPlan.tasks.length,
        agentCount: executionPlan.agents.length,
        phaseCount: executionPlan.phases?.length ?? 0,
      },
    })

    broadcastSessionEvent(groupSessionId, {
      type: 'task_board:plan_ready',
      payload: {
        runId,
        plan: {
          runId,
          title: executionPlan.title,
          goal: executionPlan.goal,
          collaborationMode: executionPlan.collaborationMode || 'mapreduce',
          phases: executionPlan.phases || [],
          tasks: executionPlan.tasks.map((t) => ({
            id: t.id,
            phaseId: t.phaseId || '',
            title: t.title,
            description: t.description,
            agentId: t.agentId,
            agentKey: executionPlan.agents.find((a) => a.id === t.agentId)?.key || t.agentId,
            agentName: executionPlan.agents.find((a) => a.id === t.agentId)?.name || t.agentId,
            dependencies: t.dependencies || [],
            taskType: t.taskType,
          })),
          agents: executionPlan.agents,
        },
        sessionId: groupSessionId,
      },
    })

    const engine = new OrchestratorEngine()
    engine
      .startRun({ runId, groupSessionId, workspaceId, plan: executionPlan, childSessions })
      .catch(async (err: any) => {
        logger.error({ err: err?.message, runId }, 'Orchestrator engine start failed')
        await db
          .update(orchestratorRuns)
          .set({ status: 'failed' })
          .where(eq(orchestratorRuns.id, runId))
        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          type: 'run.failed',
          severity: 'error',
          payload: { error: err?.message || '编排器引擎启动失败' },
        })
        const failedPlan = {
          ...parsed,
          tasks: parsed.tasks.map((t) => ({ ...t, status: 'failed' as const })),
        }
        await db
          .update(messages)
          .set({
            metadata: {
              ...(card.metadata ?? {}),
              plan: {
                ...failedPlan,
                dispatchResult: { runId, workspaceId, groupSessionId, tasks: taskResults },
              },
            },
          })
          .where(eq(messages.id, messageId))
      })

    const result: OrchestratorDispatchResult = {
      runId,
      workspaceId,
      groupSessionId,
      tasks: taskResults,
    }
    await updatePlanCardDispatchResult(messageId, card.metadata, parsed, result, groupSessionId)
    return c.json(result)
  })

function parsePlan(metadata: unknown): OrchestratorPlan | null {
  const plan = (metadata as { plan?: unknown } | null)?.plan
  if (!plan || typeof plan !== 'object') return null
  const candidate = plan as OrchestratorPlan
  if (candidate.kind !== 'orchestrator_plan' || !Array.isArray(candidate.tasks)) return null
  return candidate
}

function toAgentProfile(
  agent: typeof workspaceAgents.$inferSelect,
  projectPath?: string | null,
): AgentRunProfile {
  return buildAgentProfile(agent, projectPath)
}

async function profileForDirectSession(
  session: typeof sessions.$inferSelect,
): Promise<AgentRunProfile | undefined> {
  if (!session.workspaceAgentId) {
    if (!session.workspaceId) return undefined
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, session.workspaceId))
      .limit(1)
    if (!workspace) return undefined
    const agentList = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, workspace.id))
      .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
    if (agentList.length === 1 && agentList[0]) {
      await db
        .update(sessions)
        .set({ workspaceAgentId: agentList[0].id, updatedAt: new Date() })
        .where(eq(sessions.id, session.id))
      return toAgentProfile(agentList[0], workspace.projectPath)
    }
    const profile: AgentRunProfile = {
      id: `workspace:${workspace.id}`,
      name: workspace.name || 'Workspace Assistant',
      role: '工作区上下文助手',
      description: '当前会话已绑定到项目工作区，可读取工作区上下文。',
      color: '#111827',
      modelId: null,
      runtimeType: 'llm',
      capabilityTags: ['chat', 'workspace:read'],
      toolPermissions: ['chat', 'workspace:read'],
      sandboxPolicy: 'read-only',
      contextPolicy: 'workspace-aware',
      approvalRequired: false,
      systemPrompt: `你正在围绕当前项目工作区回复。请优先利用项目上下文回答，必要时明确指出缺少哪些文件或信息。`,
      projectPath: workspace.projectPath?.trim() || null,
      originalProjectPath: workspace.projectPath?.trim() || null,
    }
    return profile
  }
  const [agent] = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.id, session.workspaceAgentId))
    .limit(1)
  if (!agent || (session.workspaceId && agent.workspaceId !== session.workspaceId)) return undefined

  if (!session.workspaceId) return toAgentProfile(agent)
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1)
  return toAgentProfile(agent, workspace?.projectPath)
}

async function ensureWorkspaceAgentChildSessions(workspaceId: string, ownerId: string) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  if (!workspace || workspace.ownerId !== ownerId) return

  // 只给群聊 session_members 中的 Agent 创建 child session，避免 workspace 下所有 Agent 都出现子话题
  const [groupSession] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.type, 'group')))
    .orderBy(desc(sessions.createdAt))
    .limit(1)

  if (!groupSession) return

  const members = await db
    .select()
    .from(sessionMembers)
    .where(eq(sessionMembers.sessionId, groupSession.id))

  const agentMemberIds = members.filter((m) => m.memberType === 'agent').map((m) => m.memberId)

  if (agentMemberIds.length === 0) return

  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(
      and(
        eq(workspaceAgents.workspaceId, workspaceId),
        inArray(workspaceAgents.id, agentMemberIds),
      ),
    )
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))

  for (const agent of agents) {
    await ensureAgentChildSession(workspace.id, workspace.name, ownerId, agent)
  }
}

async function dispatchPlanToExistingGroup(
  session: typeof sessions.$inferSelect,
  ownerId: string,
  plan: OrchestratorPlan,
): Promise<{
  workspaceId: string
  groupSessionId: string
  agentsByKey: Map<string, typeof workspaceAgents.$inferSelect>
}> {
  if (!session.workspaceId)
    throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '会话未关联工作区')

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1)
  if (!workspace || workspace.ownerId !== ownerId) {
    throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
  }

  const existingAgents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspace.id))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  const agentsByKey = new Map<string, typeof workspaceAgents.$inferSelect>()
  for (const agent of existingAgents) {
    const direct = plan.agents.find((item) => item.key === agent.id)
    if (direct) {
      agentsByKey.set(direct.key, agent)
      continue
    }
    const name = agent.name.toLowerCase()
    const role = agent.role.toLowerCase()
    const roleType = agent.roleType.toLowerCase()
    const matched = plan.agents.find((item) => {
      const key = item.key.toLowerCase()
      return (
        name === item.name.toLowerCase() ||
        name.includes(key) ||
        role.includes(key) ||
        roleType === key ||
        (item.roleType ? roleType === item.roleType : false)
      )
    })
    if (matched) agentsByKey.set(matched.key, agent)
  }

  // 不再自动创建计划中的 Agent；所有 Agent 必须已在 workspace 中存在
  const missingAgents = plan.agents.filter((a) => !agentsByKey.has(a.key))
  if (missingAgents.length > 0) {
    logger.warn(
      { missing: missingAgents.map((a) => a.name), workspaceId: workspace.id },
      'dispatchPlanToExistingGroup: plan references agents not in workspace, skipping missing tasks',
    )
  }

  return { workspaceId: workspace.id, groupSessionId: session.id, agentsByKey }
}

async function updatePlanCardDispatchResult(
  messageId: string,
  previousMetadata: Record<string, unknown> | null,
  plan: OrchestratorPlan,
  dispatchResult: OrchestratorDispatchResult,
  groupSessionId?: string,
) {
  const metadata = previousMetadata && typeof previousMetadata === 'object' ? previousMetadata : {}
  const runningPlan: OrchestratorPlan = {
    ...plan,
    dispatchResult,
    tasks: plan.tasks.map((task) => ({ ...task, status: 'pending' })),
  }
  await db
    .update(messages)
    .set({
      content: runningPlan.summary,
      metadata: { ...metadata, plan: runningPlan, dispatchResult },
    })
    .where(eq(messages.id, messageId))

  // 修复：广播更新后的 plan 卡片到群聊，确保前端状态同步
  if (groupSessionId) {
    const [updatedCard] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    if (updatedCard) {
      broadcastSessionEvent(groupSessionId, {
        type: WsEvent.MessageCompleted,
        payload: { sessionId: groupSessionId, message: updatedCard },
      })
    }
  }
}

function collectAffectedMessages(list: Array<typeof messages.$inferSelect>, targetIndex: number) {
  const affected: Array<typeof messages.$inferSelect> = []
  for (const message of list.slice(targetIndex + 1)) {
    if (message.senderType === 'user') break
    affected.push(message)
  }
  return affected
}

async function rollbackCodeAgentChanges(
  session: typeof sessions.$inferSelect,
  affected: Array<typeof messages.$inferSelect>,
) {
  const cwd = await rollbackCwd(session)
  if (!cwd) return { reverted: 0, failed: 0 }
  let reverted = 0
  let failed = 0

  for (const message of [...affected].reverse()) {
    const run = readCodeAgentRun(message.metadata)
    if (!run) continue
    for (const file of [...(run.files ?? [])].reverse()) {
      if (!file.diff || !file.diff.trim()) continue
      const ok = await reverseApplyDiff(cwd, file.diff)
      if (ok) reverted += 1
      else failed += 1
    }
  }
  return { reverted, failed }
}

async function rollbackCwd(session: typeof sessions.$inferSelect) {
  if (!session.workspaceId) return null
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1)
  return workspace?.projectPath?.trim() || null
}

function readCodeAgentRun(metadata: Record<string, unknown> | null) {
  const value = metadata?.codeAgentRun
  if (!value || typeof value !== 'object') return null
  const run = value as { type?: unknown; files?: unknown }
  if (run.type !== 'code-agent-run' || !Array.isArray(run.files)) return null
  return run as { files: Array<{ diff?: string }> }
}

async function reverseApplyDiff(cwd: string, diff: string) {
  const file = join(tmpdir(), `agenthub-revert-${randomUUID()}.patch`)
  try {
    await writeFile(file, diff, 'utf8')
    const check = await runGit(cwd, ['apply', '--check', '-R', '--whitespace=nowarn', file])
    if (check !== 0) return false
    return (await runGit(cwd, ['apply', '-R', '--whitespace=nowarn', file])) === 0
  } catch {
    return false
  } finally {
    await unlink(file).catch(() => undefined)
  }
}

async function runGit(cwd: string, args: string[]) {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    env: process.env,
  })
  return await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(124), 5000)),
  ])
}

async function handleSimpleReply(
  sessionId: string,
  content: string,
  agentRows: any[],
  workspaceId: string,
  ownerId: string,
): Promise<void> {
  const orchestrator = agentRows.find((a) => a.roleType === 'orchestrator')
  if (!orchestrator) return

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)

  const profile = toAgentProfile(orchestrator, workspace?.projectPath)

  await ensureWorkspaceAgentChildSessions(workspaceId, ownerId)

  const agentUserMsg: MessageRow = {
    id: randomUUID(),
    sessionId,
    senderId: 'orchestrator',
    senderType: 'user',
    type: 'text',
    content,
    metadata: { isOrchestratorHandoff: true },
    createdAt: new Date(),
  }

  await runAgentReply(sessionId, agentUserMsg, profile)
}

async function generatePlanAndPushTaskBoard(
  sessionId: string,
  content: string,
  agents: any[],
  workspaceId: string,
): Promise<void> {
  const [placeholderMsg] = await db
    .insert(messages)
    .values({
      sessionId,
      senderId: 'system',
      senderType: 'system',
      type: 'text',
      content: '🔍 正在分析任务，生成执行计划...',
      metadata: { systemEvent: 'plan_generating' },
    })
    .returning()

  if (!placeholderMsg) return

  broadcastSessionEvent(sessionId, {
    type: WsEvent.MessageCompleted,
    payload: { sessionId, message: placeholderMsg },
  })

  try {
    const plan = await buildDynamicOrchestratorPlan(content, agents, workspaceId)
    const runId = randomUUID()

    await db.insert(orchestratorRuns).values({
      id: runId,
      workspaceId,
      groupSessionId: sessionId,
      planMessageId: placeholderMsg.id,
      status: 'planning',
      plan: plan as unknown as Record<string, unknown>,
    })

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId: sessionId,
      type: 'plan.created',
      payload: { title: plan.title, goal: plan.goal, taskCount: plan.tasks.length },
    })

    await db
      .update(messages)
      .set({ content: `✅ 执行计划已生成：${plan.summary}` })
      .where(eq(messages.id, placeholderMsg.id))

    broadcastSessionEvent(sessionId, {
      type: WsEvent.TaskBoardPlanReady,
      payload: { runId, plan, sessionId },
    })
  } catch (err: any) {
    logger.error({ err: err?.message, sessionId }, 'Plan generation failed, using fallback plan')

    await db
      .update(messages)
      .set({ content: '⚠️ 计划生成失败，使用默认方案：架构师 → 实现者 → 审查者' })
      .where(eq(messages.id, placeholderMsg.id))

    const fallbackPlan = buildSimpleFallbackPlan(agents, content)
    const runId = randomUUID()

    await db.insert(orchestratorRuns).values({
      id: runId,
      workspaceId,
      groupSessionId: sessionId,
      planMessageId: placeholderMsg.id,
      status: 'planning',
      plan: fallbackPlan as unknown as Record<string, unknown>,
    })

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId: sessionId,
      type: 'plan.created',
      payload: {
        title: fallbackPlan.title,
        goal: fallbackPlan.goal,
        taskCount: fallbackPlan.tasks.length,
        isFallback: true,
      },
    })

    broadcastSessionEvent(sessionId, {
      type: WsEvent.TaskBoardPlanReady,
      payload: { runId, plan: fallbackPlan, sessionId },
    })
  }
}

function buildSimpleFallbackPlan(agents: any[], content?: string): OrchestratorPlan {
  const goal = normalizeFallbackGoal(content)
  const planAgents: PlanAgent[] = agents.length
    ? agents.slice(0, Math.max(1, Math.min(agents.length, 3))).map((a: any) => ({
        key: a.id,
        name: a.name,
        role: a.role ?? '助手',
        roleType: a.roleType,
        color: a.color ?? '#6366f1',
        systemPrompt: a.systemPrompt ?? '',
        description: a.description,
        roleProfile: a.roleProfile ?? null,
        modelId: a.modelId ?? null,
        runtimeType: a.runtimeType ?? 'llm',
        codeAgentType: a.codeAgentType ?? null,
        capabilityTags: a.capabilityTags ?? [],
        toolPermissions: a.toolPermissions ?? [],
        sandboxPolicy: a.sandboxPolicy ?? 'workspace-write',
      }))
    : DEFAULT_CODE_TEAM_ROLE_TYPES.slice(0, 3).map((key) => {
        const preset = ROLE_PRESETS[key]
        return {
          key,
          name: preset.name,
          role: preset.role,
          color: preset.color,
          systemPrompt: preset.systemPrompt,
          runtimeType: preset.runtimeType as RuntimeType,
          roleType: key,
          capabilityTags: preset.capabilityTags ?? [],
          toolPermissions: preset.toolPermissions ?? [],
          sandboxPolicy: (preset.sandboxPolicy ?? 'workspace-write') as SandboxPolicy,
        }
      })

  const architect = planAgents[0]!
  const coder = planAgents[1] ?? planAgents[0]!
  const reviewer = planAgents[2] ?? planAgents[0]!

  const taskId1 = randomUUID()
  const taskId2 = randomUUID()
  const taskId3 = randomUUID()

  return {
    kind: 'orchestrator_plan',
    title: '默认三阶段计划',
    goal,
    summary: '⚠️ AI 计划生成失败，使用默认方案：架构师 → 实现者 → 审查者',
    agents: planAgents,
    tasks: [
      {
        id: taskId1,
        title: '梳理架构与交付范围',
        description: `围绕「${goal}」定义核心目标、交付物、边界和验收标准`,
        agentKey: architect.key,
        dependencies: [],
        maxRetries: 2,
      },
      {
        id: taskId2,
        title: '实现核心功能',
        description: '根据架构设计产出可执行实现方案，完成关键路径开发',
        agentKey: coder.key,
        dependencies: [taskId1],
        maxRetries: 2,
      },
      {
        id: taskId3,
        title: '审查风险与测试建议',
        description: '检查交互边界、异常状态、测试缺口和交付风险，给出可直接执行的修复建议',
        agentKey: reviewer.key,
        dependencies: [taskId2],
        maxRetries: 2,
      },
    ],
  }
}

function normalizeFallbackGoal(content?: string): string {
  if (!content) return '完成多 Agent 协作任务'
  return (
    content
      .replace(/@orchestrator/gi, '')
      .replace(/@协调器/g, '')
      .trim() || '完成多 Agent 协作任务'
  )
}
