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
  AgentRoleType,
  RuntimeType,
  CodeAgentType,
  SandboxPolicy,
  TaskType,
  WsEvent,
  CORE_AGENT_EXPERT_PROFILES,
  type AgentExpertProfile,
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
  taskThreads,
  and,
  eq,
  asc,
  desc,
} from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import type { AgentRunProfile, MessageRow } from '../services/agent-runner'
import { broadcastSessionEvent, runAgentReply } from '../services/agent-runner'
import { OrchestratorEngine } from '../services/orchestrator/orchestrator-engine'
import {
  extractJsonObject,
  cleanPlanText,
  validateRealWorkerAssignments,
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
import { prepareTaskRuntimeThread } from '../services/orchestrator/task-thread-service'
import { checkInputGuardrails } from '../services/orchestrator/input-guardrails'
import { type ManagerDecisionEventContext } from '../services/orchestrator/manager-loop'
import { runController, type RunControllerRunContext } from '../services/orchestrator/run-controller'
import { buildAgUiMemberProposalContinueEvent } from '../services/protocols'
import { blackboard, Blackboard } from '../services/blackboard'
import {
  buildDynamicOrchestratorPlan,
  loadWorkspaceAgentRelationsForPlanning,
} from '../services/orchestrator/plan-generator'
import {
  buildPlanningFailureArtifactMetadata,
  extractPlanningFailureArtifacts,
} from '../services/orchestrator/planning-failure-artifacts'
import { decideOrchestratorAction } from '../services/orchestrator/orchestrator-decision'
import {
  confirmAgentDraftSchema,
  type AgentDraft,
  buildAgentDraft,
  parseAgentDraft,
  normalizeAgentDraftInput,
} from '../services/agent-draft'

import { buildAgentProfile } from '../services/agents/profile-builder'

const agentDraftSchema = z.object({
  content: z.string().min(1).max(10000),
})

const confirmMemberProposalsSchema = z.object({
  profileIds: z.array(z.string().min(1).max(120)).min(1).max(5),
})

const updateMessageSchema = z.object({
  content: z.string().min(1).max(10000),
})

type PlanAgent = {
  key: string
  name: string
  role: string
  roleType?: AgentRoleType
  color?: string
  systemPrompt?: string
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

type OrchestratorPlan = {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: PlanAgent[]
  phases?: PlanPhase[]
  tasks: PlanTask[]
}

const INTERRUPTIBLE_RUN_STATUSES = new Set(['planning', 'running', 'synthesizing'])

type DispatchMonitor = {
  dispatchId: string
  groupSessionId?: string
  taskIds: string[]
}

async function projectPlanningFailureArtifacts(
  list: Array<typeof messages.$inferSelect>,
  workspaceId?: string | null,
) {
  if (!workspaceId || !list.some((message) => needsPlanningFailureArtifactProjection(message))) {
    return list
  }

  const [workspaceRecord] = await db
    .select({ projectPath: workspaces.projectPath })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  if (!workspaceRecord?.projectPath) return list

  return list.map((message) => {
    if (!needsPlanningFailureArtifactProjection(message)) return message

    const metadata = asMessageMetadata(message.metadata)
    const error = typeof metadata.error === 'string' ? metadata.error : message.content
    const recoveredArtifacts = extractPlanningFailureArtifacts(error, workspaceRecord.projectPath)
    if (!recoveredArtifacts.length) return message

    const runId =
      typeof metadata.runId === 'string' && metadata.runId.trim()
        ? metadata.runId
        : `planning-failure-${message.id}`
    return {
      ...message,
      metadata: {
        ...metadata,
        ...buildPlanningFailureArtifactMetadata(recoveredArtifacts, runId, workspaceId),
      },
    }
  })
}

function needsPlanningFailureArtifactProjection(message: typeof messages.$inferSelect) {
  const metadata = asMessageMetadata(message.metadata)
  if (metadata.systemEvent !== 'orchestrator_plan_failed') return false
  if (metadata.recoveredPlanningArtifacts === true) return false
  if (metadata.file_card) return false
  return typeof metadata.error === 'string' || message.content.includes('Orchestrator')
}

function asMessageMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
    const items = await projectPlanningFailureArtifacts(list, session.workspaceId)
    return c.json({ items })
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
  .post('/:sessionId/:messageId/resend', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, 'Session not found')

    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    const messageIndex = list.findIndex((message) => message.id === messageId)
    const message = messageIndex >= 0 ? list[messageIndex] : null
    if (
      !message ||
      message.senderType !== 'user' ||
      message.senderId !== user.sub ||
      message.sessionId !== sessionId
    ) {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'User message not found')
    }

    const affected = collectAffectedMessages(list, messageIndex)
    for (const item of affected) {
      await db.delete(messages).where(eq(messages.id, item.id))
    }
    const removedMessageIds = affected.map((item) => item.id)
    const { cancelAgentReply } = await import('../services/agent-runner')
    cancelAgentReply(sessionId)
    if (removedMessageIds.length) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCancelled,
        payload: { sessionId, removedMessageIds },
      })
    }

    if (session.type === 'group' && session.workspaceId) {
      const agentRows = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.workspaceId, session.workspaceId))
        .orderBy(asc(workspaceAgents.orderIdx))

      routeGroupMessageThroughOrchestrator(
        sessionId,
        message.content,
        agentRows,
        session.workspaceId,
        user.sub,
        message,
      ).catch((err: any) =>
        logger.error({ err: err?.message, sessionId }, 'Orchestrator routing failed on resend'),
      )
    } else {
      const profile = await profileForDirectSession(session)
      runAgentReply(sessionId, message, profile).catch((err: any) =>
        logger.error({ err: err?.message, sessionId }, 'runAgentReply failed on resend'),
      )
    }

    return c.json({ removedMessageIds })
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

      const content = previousUser.content
      routeGroupMessageThroughOrchestrator(
        sessionId,
        content,
        agentRows,
        session.workspaceId,
        user.sub,
        previousUser,
      ).catch((err: any) =>
        logger.error({ err: err?.message, sessionId }, 'Orchestrator routing failed on regenerate'),
      )
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
    const { content, type, metadata, mentions } = c.req.valid('json')
    const nextMetadata =
      metadata || mentions.length
        ? {
            ...(metadata ?? {}),
            ...(mentions.length ? { mentions } : {}),
          }
        : null
    const [msg] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: user.sub,
        senderType: 'user',
        type,
        content,
        metadata: nextMetadata,
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
        const mentionedAgents = resolveMentionedAgents(mentions, agentRows)
        if (mentionedAgents.length > 0) {
          routeGroupMessageToMentionedAgents({
            sessionId,
            session,
            message: msg,
            metadata: nextMetadata,
            mentionedAgents,
          }).catch((err: any) =>
            logger.error({ err: err?.message, sessionId }, 'Group mention routing failed'),
          )
          return c.json(msg)
        }

        const activeTaskContext = await loadActiveTaskContext(sessionId)
        const repliedToMessage = msg.replyToMessageId
          ? ((await db.select().from(messages).where(eq(messages.id, msg.replyToMessageId)).limit(1))[0] as
              | MessageRow
              | undefined)
          : undefined
        const directWorkerTarget = chooseDirectWorkerReplyTarget({
          sourceMessage: msg,
          repliedToMessage,
          activeTaskContext,
          agentRows,
        })
        if (directWorkerTarget) {
          const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1)
          const profile = toAgentProfile(directWorkerTarget, workspace?.projectPath)
          runAgentReply(
            sessionId,
            {
              ...msg,
              metadata: {
                ...(msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {}),
                directWorkerReply: true,
                replyTargetAgentId: directWorkerTarget.id,
                replyTargetAgentName: directWorkerTarget.name,
              },
            },
            profile,
          ).catch((err: any) =>
            logger.error({ err: err?.message, sessionId }, 'Direct worker room reply failed'),
          )
          return c.json(msg)
        }

        const orchestrator = agentRows.find((agent) => agent.roleType === 'orchestrator')
        if (orchestrator) {
          const attachedToActiveRun = await handleHumanInterruptForActiveRun({
            groupSessionId: sessionId,
            workspaceId: session.workspaceId,
            ownerId: user.sub,
            content,
            userMessageId: msg.id,
            orchestrator,
          })
          if (attachedToActiveRun) {
            return c.json(msg)
          }
        }

        routeGroupMessageThroughOrchestrator(
          sessionId,
          content,
          agentRows,
          session.workspaceId,
          user.sub,
          msg,
        ).catch((err: any) =>
          logger.error({ err: err?.message, sessionId }, 'Orchestrator routing failed'),
        )
      } else {
        if (session && isOrchestratorTaskSession(session)) {
          const attachedToTaskThread = await handleHumanInterruptFromTaskThreadSession({
            session,
            ownerId: user.sub,
            content,
            userMessageId: msg.id,
          })
          if (attachedToTaskThread) {
            return c.json(msg)
          }
        }
        let profile = session ? await profileForDirectSession(session) : undefined
        if (profile && metadata?.safetyMode && typeof metadata.safetyMode === 'string') {
          profile = applySafetyMode(profile, metadata.safetyMode)
        }
        runAgentReply(sessionId, msg, profile).catch((err: any) =>
          logger.error({ err: err?.message, sessionId }, 'runAgentReply failed on new message'),
        )
      }
    }
    return c.json(msg)
  })
  .post('/:sessionId/agent-draft', zValidator('json', agentDraftSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    if (session.type !== 'group' || !session.workspaceId) {
      const [prompt] = await db
        .insert(messages)
        .values({
          sessionId,
          senderId: 'system',
          senderType: 'system',
          type: 'text',
          content:
            '请先打开或创建一个 Agent Group，再通过聊天创建 Agent。这样新 Agent 才能加入明确的 workspace 和Agent 联系人列表。',
          metadata: { systemEvent: 'agent_draft_requires_group', agentDraftStatus: 'requires_group' },
        })
        .returning()
      if (!prompt) throw AppError.fromCode(AppErrorCodes.INTERNAL_ERROR, 'Agent 群组提示创建失败')
      return c.json(prompt)
    }

    const draft = await buildAgentDraft(content)
    const [card] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'system',
        senderType: 'system',
        type: 'task_card',
        content: `已生成 ${draft.name} Agent 草案。确认后会加入当前 Agent Group。`,
        metadata: { systemEvent: 'agent_draft_created', agentDraft: draft, agentDraftStatus: 'draft' },
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
  .post(
    '/:sessionId/member-proposals/:messageId/confirm',
    zValidator('json', confirmMemberProposalsSchema),
    async (c) => {
      const user = c.get('user')
      const sessionId = c.req.param('sessionId')
      const messageId = c.req.param('messageId')
      const { profileIds } = c.req.valid('json')

      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
      if (
        !session ||
        session.ownerId !== user.sub ||
        session.type !== 'group' ||
        !session.workspaceId
      ) {
        throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, 'Agent 群组会话不存在')
      }

      const [proposalMessage] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
      if (!proposalMessage || proposalMessage.sessionId !== sessionId) {
        throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '补员建议消息不存在')
      }

      const metadata = proposalMessage.metadata ?? {}
      if (metadata.memberProposalStatus !== 'pending') {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '补员建议已经处理或不可确认')
      }

      const allowedProfileIds = new Set(readMemberProposalProfileIds(metadata.memberProposals))
      const selectedProfileIds = Array.from(new Set(profileIds)).filter((id) => allowedProfileIds.has(id))
      if (!selectedProfileIds.length) {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '请选择 Orchestrator 建议中的 Agent')
      }

      const existingAgents = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.workspaceId, session.workspaceId))
        .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
      const existingProfileIds = new Set(
        existingAgents
          .map((agent) => readExpertProfileId(agent.roleProfile))
          .filter((id): id is string => Boolean(id)),
      )
      const existingNames = new Set(existingAgents.map((agent) => normalizeAgentIdentity(agent.name)))
      const createdAgents: Array<typeof workspaceAgents.$inferSelect> = []
      const reusedAgents: Array<typeof workspaceAgents.$inferSelect> = []
      let orderIdx = existingAgents.length

      for (const profileId of selectedProfileIds) {
        const profile = CORE_AGENT_EXPERT_PROFILES.find((item) => item.id === profileId)
        if (!profile) continue

        const existing =
          existingAgents.find((agent) => readExpertProfileId(agent.roleProfile) === profile.id) ??
          existingAgents.find((agent) => normalizeAgentIdentity(agent.name) === normalizeAgentIdentity(profile.name))
        if (existing) {
          reusedAgents.push(existing)
          continue
        }
        if (existingProfileIds.has(profile.id) || existingNames.has(normalizeAgentIdentity(profile.name))) {
          continue
        }

        const [agent] = await db
          .insert(workspaceAgents)
          .values({
            ...expertProfileToAgentInsert(profile),
            workspaceId: session.workspaceId,
            orderIdx,
          })
          .returning()
        if (agent) {
          createdAgents.push(agent)
          existingProfileIds.add(profile.id)
          existingNames.add(normalizeAgentIdentity(profile.name))
          orderIdx += 1
        }
      }

      const agentsToJoin = [...reusedAgents, ...createdAgents]
      if (!agentsToJoin.length) {
        throw AppError.fromCode(AppErrorCodes.AGENT_REPLY_FAILED, '没有创建或加入新的 Agent')
      }

      await ensureSessionMembers(sessionId, user.sub, agentsToJoin.map((agent) => agent.id))
      const updatedSession = await refreshGroupMemberMetadata(session, user.sub)
      await db
        .update(workspaces)
        .set({ updatedAt: new Date() })
        .where(eq(workspaces.id, session.workspaceId))

      const [updatedMessage] = await db
        .update(messages)
        .set({
          content: `已加入：${agentsToJoin.map((agent) => agent.name).join('、')}。现在可以让 Orchestrator 重新规划并分发任务。`,
          metadata: {
            ...metadata,
            memberProposalStatus: 'confirmed',
            confirmedProfileIds: selectedProfileIds,
            createdAgentIds: createdAgents.map((agent) => agent.id),
            reusedAgentIds: reusedAgents.map((agent) => agent.id),
          },
        })
        .where(eq(messages.id, messageId))
        .returning()

      const message = updatedMessage ?? proposalMessage
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCompleted,
        payload: { sessionId, message },
      })

      return c.json({ agents: agentsToJoin, message, session: updatedSession ?? session })
    },
  )
  .post('/:sessionId/member-proposals/:messageId/continue', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (
      !session ||
      session.ownerId !== user.sub ||
      session.type !== 'group' ||
      !session.workspaceId
    ) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, 'Agent 群组会话不存在')
    }

    const [proposalMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    if (!proposalMessage || proposalMessage.sessionId !== sessionId) {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '补员建议消息不存在')
    }

    const metadata = proposalMessage.metadata ?? {}
    if (metadata.memberProposalStatus !== 'confirmed') {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '请先确认补员，再继续分发')
    }
    if (metadata.memberProposalContinueStatus === 'running') {
      return c.json({ message: proposalMessage, started: false })
    }

    const goal =
      readString(metadata.memberProposalGoal) ??
      (await findPreviousUserMessageContent(sessionId, proposalMessage.id))
    if (!goal) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '找不到需要继续分发的原始用户目标')
    }

    const runningMessage = await updateMemberProposalContinueState({
      message: proposalMessage,
      metadata,
      content: `已加入建议成员。Orchestrator 正在基于新成员重新规划并分发任务。`,
      status: 'running',
      goal,
    })
    broadcastMemberProposalContinueStatus({
      sessionId,
      messageId: proposalMessage.id,
      status: 'running',
      goal,
    })

    continueMemberProposalPlanning({
      session,
      ownerId: user.sub,
      proposalMessageId: proposalMessage.id,
      goal,
    }).catch((err: any) =>
      logger.error(
        { err: err?.message, sessionId, messageId: proposalMessage.id },
        'Member proposal continue failed',
      ),
    )

    return c.json({ message: runningMessage, started: true })
  })

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function findPreviousUserMessageContent(sessionId: string, beforeMessageId: string) {
  const list = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt))
  const index = list.findIndex((message) => message.id === beforeMessageId)
  if (index < 0) return null
  const previousUser = [...list.slice(0, index)]
    .reverse()
    .find((message) => message.senderType === 'user' && message.content.trim())
  return previousUser?.content.trim() || null
}

async function updateMemberProposalContinueState(params: {
  message: typeof messages.$inferSelect
  metadata: Record<string, unknown>
  content: string
  status: 'running' | 'completed' | 'failed'
  goal: string
  monitor?: DispatchMonitor
  error?: string
}) {
  const { message, metadata, content, status, goal, monitor, error } = params
  const nextMetadata: Record<string, unknown> = {
    ...metadata,
    memberProposalGoal: goal,
    memberProposalContinueStatus: status,
    memberProposalContinueUpdatedAt: new Date().toISOString(),
  }
  if (status === 'running') {
    nextMetadata.memberProposalContinueRequestedAt = new Date().toISOString()
    delete nextMetadata.memberProposalContinueError
  }
  if (monitor) {
    nextMetadata.continuedRunId = monitor.dispatchId
    nextMetadata.continuedTaskIds = monitor.taskIds
  }
  if (error) nextMetadata.memberProposalContinueError = error

  const [updated] = await db
    .update(messages)
    .set({ content, metadata: nextMetadata })
    .where(eq(messages.id, message.id))
    .returning()
  const result = updated ?? message
  broadcastSessionEvent(message.sessionId, {
    type: WsEvent.MessageCompleted,
    payload: { sessionId: message.sessionId, message: result },
  })
  return result
}

function broadcastMemberProposalContinueStatus(params: {
  sessionId: string
  messageId: string
  status: 'running' | 'completed' | 'failed'
  goal: string
  runId?: string | null
  taskIds?: string[]
  error?: string
}) {
  broadcastSessionEvent(params.sessionId, {
    type: WsEvent.AgUiEvent,
    payload: buildAgUiMemberProposalContinueEvent({
      ref: {
        runId: params.runId ?? undefined,
        threadId: params.sessionId,
      },
      value: {
        messageId: params.messageId,
        goal: params.goal,
        status: params.status,
        runId: params.runId ?? undefined,
        taskIds: params.taskIds ?? [],
        error: params.error,
      },
    }),
  })
}

async function continueMemberProposalPlanning(params: {
  session: typeof sessions.$inferSelect
  ownerId: string
  proposalMessageId: string
  goal: string
}) {
  const { session, ownerId, proposalMessageId, goal } = params
  if (!session.workspaceId) return

  const [proposalMessage] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, proposalMessageId))
    .limit(1)
  if (!proposalMessage) return

  const metadata = proposalMessage.metadata ?? {}
  try {
    const agentRows = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, session.workspaceId))
      .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
    const monitor = await generatePlanAndPushTaskBoard(
      session.id,
      goal,
      agentRows,
      session.workspaceId,
      ownerId,
      { propagateErrors: true },
    )
    if (!monitor) throw new Error('Orchestrator 规划没有启动')
    const [latestMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, proposalMessageId))
      .limit(1)
    await updateMemberProposalContinueState({
      message: latestMessage ?? proposalMessage,
      metadata: (latestMessage?.metadata ?? metadata) as Record<string, unknown>,
      content: '已加入建议成员。Orchestrator 已重新规划并开始分发任务。',
      status: 'completed',
      goal,
      monitor,
    })
    await emitRunEvent({
      runId: monitor.dispatchId,
      workspaceId: session.workspaceId,
      groupSessionId: session.id,
      type: 'member_proposal.continued',
      payload: {
        messageId: proposalMessage.id,
        status: 'completed',
        goal,
        taskIds: monitor.taskIds,
      },
    })
  } catch (err: any) {
    const error = err?.message || 'Orchestrator 重新规划失败'
    const [latestMessage] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, proposalMessageId))
      .limit(1)
    await updateMemberProposalContinueState({
      message: latestMessage ?? proposalMessage,
      metadata: (latestMessage?.metadata ?? metadata) as Record<string, unknown>,
      content: `已加入建议成员，但 Orchestrator 重新规划失败：${error}`,
      status: 'failed',
      goal,
      error,
    })
    broadcastMemberProposalContinueStatus({
      sessionId: session.id,
      messageId: proposalMessage.id,
      status: 'failed',
      goal,
      error,
    })
    throw err
  }
}

function expertProfileToAgentInsert(profile: AgentExpertProfile) {
  return {
    name: profile.name,
    role: profile.role,
    roleType: profile.roleType,
    description: profile.description,
    avatar: null,
    systemPrompt: profile.systemPrompt,
    roleProfile: {
      expertProfileId: profile.id,
      category: profile.category,
      expertLevel: profile.riskLevel === 'high' ? 'specialist' : 'standard',
      background: profile.background,
      responsibilities: profile.capabilityTags,
      cannotDo: profile.cannotDo,
      acceptsTaskTypes: profile.acceptsTaskTypes,
      outputContract: profile.outputContract,
      qualityGates: profile.qualityGates,
      defaultSkillIds: profile.defaultSkillIds,
      recommendedMcpServers: profile.recommendedMcpServers,
      preferredTopologies: profile.preferredTopologies,
      riskLevel: profile.riskLevel,
    },
    color: profile.color,
    modelId: null,
    runtimeType: profile.runtimeType,
    codeAgentType: profile.runtimeType === 'code-agent' ? (profile.codeAgentType ?? 'codex') : null,
    capabilityTags: profile.capabilityTags,
    skillIds: profile.defaultSkillIds,
    toolPermissions: profile.toolPermissions,
    sandboxPolicy: profile.sandboxPolicy,
    contextPolicy: profile.contextPolicy,
    autoInvoke: profile.autoInvoke,
    approvalRequired: profile.runtimeType === 'code-agent' ? false : profile.approvalRequired,
  }
}

function readMemberProposalProfileIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const id = (item as { expertProfileId?: unknown }).expertProfileId
      return typeof id === 'string' ? id : ''
    })
    .filter(Boolean)
}

function readExpertProfileId(roleProfile: unknown) {
  if (!roleProfile || typeof roleProfile !== 'object') return ''
  const value = (roleProfile as { expertProfileId?: unknown }).expertProfileId
  return typeof value === 'string' ? value : ''
}

function normalizeAgentIdentity(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function ensureSessionMembers(sessionId: string, ownerId: string, agentIds: string[]) {
  const existing = await db
    .select()
    .from(sessionMembers)
    .where(eq(sessionMembers.sessionId, sessionId))
  const keys = new Set(existing.map((member) => `${member.memberType}:${member.memberId}`))
  const wanted = [
    { memberType: 'user' as const, memberId: ownerId },
    ...agentIds.map((agentId) => ({ memberType: 'agent' as const, memberId: agentId })),
  ].filter((member) => !keys.has(`${member.memberType}:${member.memberId}`))
  if (wanted.length) {
    await db.insert(sessionMembers).values(wanted.map((member) => ({ sessionId, ...member })))
  }
}

async function refreshGroupMemberMetadata(session: typeof sessions.$inferSelect, ownerId: string) {
  if (!session.workspaceId) return session
  const members = await db
    .select()
    .from(sessionMembers)
    .where(eq(sessionMembers.sessionId, session.id))
  const agentIds = members
    .filter((member) => member.memberType === 'agent')
    .map((member) => member.memberId)
  const nextMetadata = {
    ...(session.metadata ?? {}),
    kind: 'workspace-agent-group',
    agentIds,
    agentCount: agentIds.length,
    memberCount: agentIds.length + 1,
  }
  const [updated] = await db
    .update(sessions)
    .set({
      metadata: nextMetadata,
      updatedAt: new Date(),
    })
    .where(and(eq(sessions.id, session.id), eq(sessions.ownerId, ownerId)))
    .returning()
  return updated ?? session
}

function toAgentProfile(
  agent: typeof workspaceAgents.$inferSelect,
  projectPath?: string | null,
): AgentRunProfile {
  return buildAgentProfile(agent, projectPath)
}

function applySafetyMode(profile: AgentRunProfile, mode: string): AgentRunProfile {
  switch (mode) {
    case 'full-access':
      return { ...profile, sandboxPolicy: 'workspace-write', approvalRequired: false }
    case 'ask':
    default:
      return { ...profile, sandboxPolicy: 'workspace-write', approvalRequired: true }
  }
}

function toCoordinatorProfile(
  agent: typeof workspaceAgents.$inferSelect,
  projectPath?: string | null,
): AgentRunProfile {
  return {
    ...buildAgentProfile(agent, projectPath),
    sandboxPolicy: 'workspace-write',
    toolPermissions: ['chat', 'workspace:read'],
    approvalRequired: false,
  }
}

async function findLatestInterruptibleRun(groupSessionId: string) {
  const runs = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.groupSessionId, groupSessionId))
    .orderBy(desc(orchestratorRuns.updatedAt), desc(orchestratorRuns.createdAt))
    .limit(20)

  return runs.find((run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status)) ?? null
}

async function findInterruptibleRunById(runId: string, groupSessionId: string) {
  const [run] = await db
    .select()
    .from(orchestratorRuns)
    .where(and(eq(orchestratorRuns.id, runId), eq(orchestratorRuns.groupSessionId, groupSessionId)))
    .limit(1)

  return run && INTERRUPTIBLE_RUN_STATUSES.has(run.status) ? run : null
}

async function persistSessionTransparencyMessage(input: {
  sessionId: string
  senderId: string
  senderType: 'agent' | 'system'
  content: string
  metadata: Record<string, unknown>
}) {
  const [message] = await db
    .insert(messages)
    .values({
      sessionId: input.sessionId,
      senderId: input.senderId,
      senderType: input.senderType,
      type: 'text',
      content: input.content,
      metadata: input.metadata,
    })
    .returning()

  if (message) {
    broadcastSessionEvent(input.sessionId, {
      type: WsEvent.MessageCompleted,
      payload: { sessionId: input.sessionId, message },
    })
  }

  return message ?? null
}

async function handleHumanInterruptForActiveRun(params: {
  groupSessionId: string
  workspaceId: string
  ownerId: string
  content: string
  userMessageId: string
  orchestrator: typeof workspaceAgents.$inferSelect
  runId?: string | null
  source?: {
    kind: 'group' | 'task_thread'
    taskThreadId?: string | null
    taskId?: string | null
    childSessionId?: string | null
    workerInstanceId?: string | null
    workspaceAgentId?: string | null
  }
}) {
  const activeRun = params.runId
    ? await findInterruptibleRunById(params.runId, params.groupSessionId)
    : await findLatestInterruptibleRun(params.groupSessionId)
  if (!activeRun) return false

  const namespace = Blackboard.namespace(params.workspaceId, activeRun.id)
  const interruptKey = `human_interrupts/${params.userMessageId}`
  const createdAt = new Date().toISOString()
  const note = await blackboard.write({
    namespace,
    key: interruptKey,
    value: {
      kind: 'human_interrupt',
      source: params.source?.kind ?? 'group',
      messageId: params.userMessageId,
      groupSessionId: params.groupSessionId,
      taskThreadId: params.source?.taskThreadId ?? null,
      taskId: params.source?.taskId ?? null,
      childSessionId: params.source?.childSessionId ?? null,
      workerInstanceId: params.source?.workerInstanceId ?? null,
      workspaceAgentId: params.source?.workspaceAgentId ?? null,
      content: params.content,
      actorType: 'user',
      actorId: params.ownerId,
      acknowledgedBy: {
        agentId: params.orchestrator.id,
        agentName: params.orchestrator.name,
      },
      createdAt,
    },
    agentId: params.orchestrator.id,
    taskId: params.source?.taskId ?? undefined,
    tags: [
      'human-interrupt',
      'hitl',
      ...(params.source?.kind === 'task_thread' ? ['task-thread'] : []),
    ],
  })

  await emitRunEvent({
    runId: activeRun.id,
    workspaceId: params.workspaceId,
    groupSessionId: params.groupSessionId,
    taskId: params.source?.taskId ?? undefined,
    threadId: params.source?.taskThreadId ?? undefined,
    workerInstanceId: params.source?.workerInstanceId ?? undefined,
    agentId: params.orchestrator.id,
    type: 'blackboard.written',
    payload: {
      key: interruptKey,
      version: note.version,
      summary:
        params.source?.kind === 'task_thread'
          ? 'Human provided an in-flight correction inside a TaskThread room.'
          : 'Human provided an in-flight correction for the current run.',
      source: 'human_interrupt',
      interruptSource: params.source?.kind ?? 'group',
      taskThreadId: params.source?.taskThreadId ?? null,
      childSessionId: params.source?.childSessionId ?? null,
      taskId: params.source?.taskId ?? null,
      taskTitle: 'Human interrupt',
      agentName: params.orchestrator.name,
      contentPreview: params.content.slice(0, 200),
    },
  })

  await runController.recordDecision(
    {
      runId: activeRun.id,
      workspaceId: params.workspaceId,
      groupSessionId: params.groupSessionId,
      actor: {
        id: params.orchestrator.id,
        name: params.orchestrator.name,
      },
    },
    {
      action: 'human_interrupt_received',
      reason: 'A human participant added or corrected requirements while the run is active.',
      message:
        params.source?.kind === 'task_thread'
          ? `Merged a TaskThread human instruction into the active run: ${params.content.slice(0, 160)}`
          : `Merged a new human instruction into the active run: ${params.content.slice(0, 160)}`,
    },
  )

  const liveThreads = await db
    .select()
    .from(taskThreads)
    .where(eq(taskThreads.runId, activeRun.id))
    .orderBy(desc(taskThreads.updatedAt), desc(taskThreads.createdAt))

  const forwardTargets = liveThreads.filter((thread) =>
    ['prepared', 'assigned', 'active'].includes(thread.status),
  )

  const groupAckContent =
    params.source?.kind === 'task_thread'
      ? forwardTargets.length > 0
        ? `我看到你在任务子对话里的补充要求，已并入当前协作，并同步给 ${forwardTargets.length} 个进行中的任务。`
        : '我看到你在任务子对话里的补充要求，已并入当前协作，并会在后续调度中按这个约束继续推进。'
      : forwardTargets.length > 0
        ? `收到新的补充要求，我已并入当前协作，并同步给 ${forwardTargets.length} 个进行中的任务。`
        : '收到新的补充要求，我已并入当前协作，并会在后续调度中按这个约束继续推进。'

  await persistSessionTransparencyMessage({
    sessionId: params.groupSessionId,
    senderId: params.orchestrator.id,
    senderType: 'agent',
    content: groupAckContent,
    metadata: {
      kind: 'manager-human-interrupt',
      systemEvent: 'manager_human_interrupt_ack',
      orchestratorRunId: activeRun.id,
      sourceMessageId: params.userMessageId,
      interruptSource: params.source?.kind ?? 'group',
      sourceTaskThreadId: params.source?.taskThreadId ?? null,
      sourceChildSessionId: params.source?.childSessionId ?? null,
      sourceTaskId: params.source?.taskId ?? null,
      blackboardRef: note,
      forwardedThreadCount: forwardTargets.length,
    },
  })

  for (const thread of forwardTargets) {
    await persistSessionTransparencyMessage({
      sessionId: thread.sessionId,
      senderId: params.orchestrator.id,
      senderType: 'agent',
      content: `用户补充了一条新的约束，请以此为准继续当前任务：${params.content}`,
      metadata: {
        kind: 'manager-human-interrupt-forwarded',
        systemEvent: 'manager_human_interrupt_forwarded',
        orchestratorRunId: activeRun.id,
        orchestratorTaskThreadId: thread.id,
        sourceMessageId: params.userMessageId,
        interruptSource: params.source?.kind ?? 'group',
        sourceTaskThreadId: params.source?.taskThreadId ?? null,
        sourceChildSessionId: params.source?.childSessionId ?? null,
        sourceTaskId: params.source?.taskId ?? null,
        blackboardRef: note,
      },
    })
  }

  await runController.reconcile({
    runId: activeRun.id,
    workspaceId: params.workspaceId,
    groupSessionId: params.groupSessionId,
    actor: {
      id: params.orchestrator.id,
      name: params.orchestrator.name,
    },
  })

  return true
}

function isOrchestratorTaskSession(session: typeof sessions.$inferSelect | null | undefined) {
  if (!session || session.type !== 'direct') return false
  const metadata =
    session.metadata && typeof session.metadata === 'object'
      ? (session.metadata as Record<string, unknown>)
      : null
  return metadata?.kind === 'orchestrator-task'
}

async function handleHumanInterruptFromTaskThreadSession(params: {
  session: typeof sessions.$inferSelect
  ownerId: string
  content: string
  userMessageId: string
}) {
  if (!isOrchestratorTaskSession(params.session)) return false

  const [thread] = await db
    .select()
    .from(taskThreads)
    .where(eq(taskThreads.sessionId, params.session.id))
    .limit(1)

  if (!thread) {
    await persistSessionTransparencyMessage({
      sessionId: params.session.id,
      senderId: 'system',
      senderType: 'system',
      content: '这条消息已保留在任务子对话里，但没有找到对应的 TaskThread 资源，无法接入当前协作控制面。',
      metadata: {
        kind: 'task-thread-human-interrupt-unlinked',
        systemEvent: 'task_thread_human_interrupt_unlinked',
        sourceMessageId: params.userMessageId,
      },
    })
    return true
  }

  const [orchestrator] = await db
    .select()
    .from(workspaceAgents)
    .where(and(eq(workspaceAgents.workspaceId, thread.workspaceId), eq(workspaceAgents.roleType, 'orchestrator')))
    .orderBy(asc(workspaceAgents.orderIdx))
    .limit(1)

  if (!orchestrator) {
    await persistSessionTransparencyMessage({
      sessionId: params.session.id,
      senderId: 'system',
      senderType: 'system',
      content: '这条消息已保留在任务子对话里，但当前工作区没有 Orchestrator，无法把它并入协作控制面。',
      metadata: {
        kind: 'task-thread-human-interrupt-no-orchestrator',
        systemEvent: 'task_thread_human_interrupt_no_orchestrator',
        sourceMessageId: params.userMessageId,
        taskThreadId: thread.id,
        orchestratorRunId: thread.runId,
        orchestratorTaskId: thread.taskId,
        groupSessionId: thread.groupSessionId,
      },
    })
    return true
  }

  const attached = await handleHumanInterruptForActiveRun({
    groupSessionId: thread.groupSessionId,
    workspaceId: thread.workspaceId,
    ownerId: params.ownerId,
    content: params.content,
    userMessageId: params.userMessageId,
    orchestrator,
    runId: thread.runId,
    source: {
      kind: 'task_thread',
      taskThreadId: thread.id,
      taskId: thread.taskId,
      childSessionId: params.session.id,
      workerInstanceId: thread.workerInstanceId,
      workspaceAgentId: thread.workspaceAgentId,
    },
  })

  if (!attached) {
    await persistSessionTransparencyMessage({
      sessionId: params.session.id,
      senderId: orchestrator.id,
      senderType: 'agent',
      content: '我看到你在这个任务子对话里的补充，但当前没有可接管的运行。请回到主群聊继续发起或恢复协作。',
      metadata: {
        kind: 'task-thread-human-interrupt-inactive',
        systemEvent: 'task_thread_human_interrupt_inactive',
        sourceMessageId: params.userMessageId,
        taskThreadId: thread.id,
        orchestratorRunId: thread.runId,
        orchestratorTaskId: thread.taskId,
        groupSessionId: thread.groupSessionId,
      },
    })
  }

  return true
}

async function routeGroupMessageThroughOrchestrator(
  sessionId: string,
  content: string,
  agentRows: typeof workspaceAgents.$inferSelect[],
  workspaceId: string,
  ownerId: string,
  sourceMessage?: MessageRow,
) {
  const orchestrator = agentRows.find((a) => a.roleType === 'orchestrator')
  if (!orchestrator) {
    const [message] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'system',
        senderType: 'system',
        type: 'text',
        content: '⚠️ 群聊中未配置 Orchestrator。请先添加 Orchestrator Agent。',
        metadata: { systemEvent: 'no_orchestrator' },
      })
      .returning()
    if (message) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCompleted,
        payload: { sessionId, message },
      })
    }
    return
  }

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  const recentMessages = await loadRecentRoomMessages(sessionId, agentRows)
  const activeTaskContext = await loadActiveTaskContext(sessionId)

  let decision: Awaited<ReturnType<typeof decideOrchestratorAction>>
  try {
    decision = await decideOrchestratorAction({
      content,
      agents: agentRows,
      workspaceGoal: workspace?.goal ?? null,
      workspacePath: workspace?.projectPath ?? null,
      activeTaskContext,
      recentMessages,
    })
  } catch (err: any) {
    const message = err?.message || '模型没有返回有效的 Orchestrator 决策'
    logger.warn({ err: message, sessionId }, 'Orchestrator decision failed')
    const [failedMessage] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: orchestrator.id,
        senderType: 'agent',
        type: 'text',
        content: `Orchestrator 决策失败：${message}。请检查当前 Orchestrator 模型配置后重试。`,
        metadata: {
          systemEvent: 'orchestrator_decision_failed',
          error: message,
        },
      })
      .returning()
    if (failedMessage) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCompleted,
        payload: { sessionId, message: failedMessage },
      })
    }
    return
  }

  const memberProposals = Array.isArray(decision.memberProposals) ? decision.memberProposals : []

  if (decision.action === 'plan') {
    const managerRun = await runController.start({
      workspaceId,
      groupSessionId: sessionId,
      goal: content,
      actor: orchestrator,
      decision: {
        action: decision.action,
        reason: decision.reason,
        message: decision.message,
        memberProposalCount: memberProposals.length,
      },
    })
    await generatePlanAndPushTaskBoard(sessionId, content, agentRows, workspaceId, ownerId, {
      run: managerRun,
      decision: {
        action: decision.action,
        reason: decision.reason,
        message: decision.message,
        memberProposalCount: memberProposals.length,
      },
    })
    return
  }

  const decisionContent = decision.message?.trim() || ''
  const replyTarget = resolveReplyTargetAgent(agentRows, orchestrator, decision)

  if (decision.action === 'reply' && replyTarget && memberProposals.length === 0) {
    const profile =
      replyTarget.roleType === 'orchestrator'
        ? toCoordinatorProfile(replyTarget, workspace?.projectPath)
        : toAgentProfile(replyTarget, workspace?.projectPath)
    const replyMessage: MessageRow = sourceMessage
      ? {
          ...sourceMessage,
          metadata: {
            ...(sourceMessage.metadata && typeof sourceMessage.metadata === 'object'
              ? sourceMessage.metadata
              : {}),
            routedByOrchestrator: true,
            orchestratorDecision: decision.action,
            decisionReason: decision.reason,
            replyTargetAgentId: replyTarget.id,
            replyTargetAgentName: replyTarget.name,
            ...(decisionContent ? { orchestratorRoutingHint: decisionContent } : {}),
          },
        }
      : {
          id: randomUUID(),
          sessionId,
          senderId: ownerId,
          senderType: 'user',
          type: 'text',
          content,
          metadata: {
            routedByOrchestrator: true,
            orchestratorDecision: decision.action,
            decisionReason: decision.reason,
            replyTargetAgentId: replyTarget.id,
            replyTargetAgentName: replyTarget.name,
            ...(decisionContent ? { orchestratorRoutingHint: decisionContent } : {}),
          },
          createdAt: new Date(),
        }

    await runAgentReply(sessionId, replyMessage, profile)
    return
  }

  if (decisionContent || memberProposals.length) {
    const [message] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: orchestrator.id,
        senderType: 'agent',
        type: 'text',
        content: decisionContent || '模型返回了补员建议，但没有提供可展示说明。请在下方确认建议成员。',
        metadata: {
          systemEvent: 'orchestrator_decision',
          orchestratorDecision: decision.action,
          decisionReason: decision.reason,
          ...(memberProposals.length
            ? {
                memberProposalStatus: 'pending',
                memberProposals,
                memberProposalGoal: content,
              }
            : {}),
        },
      })
      .returning()
    if (message) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCompleted,
        payload: { sessionId, message },
      })
    }
    return
  }

  const profile = toCoordinatorProfile(orchestrator, workspace?.projectPath)
  const agentUserMsg: MessageRow = {
    id: randomUUID(),
    sessionId,
    senderId: orchestrator.id,
    senderType: 'user',
    type: 'text',
    content,
    metadata: { isOrchestratorHandoff: true, orchestratorDecision: decision.action, decisionReason: decision.reason },
    createdAt: new Date(),
  }

  try {
    await runAgentReply(sessionId, agentUserMsg, profile)
  } catch (err: any) {
    throw err
  }
}

function resolveReplyTargetAgent(
  agentRows: typeof workspaceAgents.$inferSelect[],
  orchestrator: typeof workspaceAgents.$inferSelect,
  decision: Awaited<ReturnType<typeof decideOrchestratorAction>>,
) {
  const targetId = decision.replyTargetAgentId?.trim()
  if (targetId) {
    const byId = agentRows.find((agent) => agent.id === targetId)
    if (byId) return byId
  }

  const targetName = decision.replyTargetAgentName?.trim().toLowerCase()
  if (targetName) {
    const byName = agentRows.find((agent) => agent.name.trim().toLowerCase() === targetName)
    if (byName) return byName
  }

  return decision.action === 'reply' && orchestrator ? orchestrator : null
}

async function loadRecentRoomMessages(
  sessionId: string,
  agentRows: typeof workspaceAgents.$inferSelect[],
  limit = 8,
) {
  const recent = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(limit * 2)

  const agentNames = new Map(agentRows.map((agent) => [agent.id, agent.name]))
  return recent
    .filter((message) => {
      if (message.type !== 'text') return false
      if (!message.content.trim()) return false
      return message.senderType === 'user' || message.senderType === 'agent' || message.senderType === 'system'
    })
    .slice()
    .reverse()
    .slice(-limit)
    .map((message) => {
      const metadata =
        message.metadata && typeof message.metadata === 'object'
          ? (message.metadata as Record<string, unknown>)
          : null
      const metadataName =
        typeof metadata?.agentName === 'string'
          ? metadata.agentName
          : typeof metadata?.managerName === 'string'
            ? metadata.managerName
            : typeof metadata?.workerName === 'string'
              ? metadata.workerName
              : null
      return {
        senderType: message.senderType as 'user' | 'agent' | 'system',
        senderName:
          message.senderType === 'agent'
            ? agentNames.get(message.senderId) ?? metadataName ?? null
            : message.senderType === 'user'
              ? '用户'
              : metadataName,
        content: message.content.trim(),
      }
    })
}

async function loadActiveTaskContext(sessionId: string) {
  const tasks = await db
    .select({
      taskId: workspaceTasks.id,
      taskTitle: workspaceTasks.title,
      taskStatus: workspaceTasks.status,
      progressStatus: workspaceTasks.progressStatus,
      agentId: workspaceTasks.agentId,
      threadStatus: taskThreads.status,
      agentName: workspaceAgents.name,
      clarificationCount: workspaceTasks.clarificationCount,
      errorLog: workspaceTasks.errorLog,
    })
    .from(workspaceTasks)
    .leftJoin(taskThreads, eq(taskThreads.taskId, workspaceTasks.id))
    .leftJoin(workspaceAgents, eq(workspaceAgents.id, workspaceTasks.agentId))
    .where(eq(taskThreads.groupSessionId, sessionId))
    .orderBy(desc(taskThreads.updatedAt), desc(workspaceTasks.updatedAt))
    .limit(8)

  return tasks
    .filter((task) => {
      const threadStatus = task.threadStatus ?? null
      const taskStatus = task.taskStatus ?? null
      return (
        threadStatus === 'prepared' ||
        threadStatus === 'assigned' ||
        threadStatus === 'active' ||
        taskStatus === 'pending' ||
        taskStatus === 'running' ||
        taskStatus === 'blocked'
      )
    })
    .map((task) => ({
      taskId: task.taskId,
      taskTitle: task.taskTitle,
      taskStatus: task.taskStatus,
      taskThreadStatus: task.threadStatus ?? null,
      agentId: task.agentId ?? null,
      agentName: task.agentName ?? null,
      progressStatus: task.progressStatus ?? task.errorLog ?? null,
      awaitingClarification: (task.clarificationCount ?? 0) > 0 || task.taskStatus === 'blocked',
    }))
}

function chooseDirectWorkerReplyTarget(input: {
  sourceMessage?: MessageRow
  repliedToMessage?: MessageRow
  activeTaskContext: Awaited<ReturnType<typeof loadActiveTaskContext>>
  agentRows: typeof workspaceAgents.$inferSelect[]
}) {
  const metadata =
    input.sourceMessage?.metadata && typeof input.sourceMessage.metadata === 'object'
      ? (input.sourceMessage.metadata as Record<string, unknown>)
      : null
  const replyToMessageId =
    input.sourceMessage?.replyToMessageId && typeof input.sourceMessage.replyToMessageId === 'string'
      ? input.sourceMessage.replyToMessageId
      : null

  const mentionedAgentIds = Array.isArray(metadata?.mentions)
    ? metadata!.mentions.filter((item): item is string => typeof item === 'string')
    : []
  if (mentionedAgentIds.length > 0) return null

  const workersById = new Map(
    input.agentRows.filter((agent) => agent.roleType !== 'orchestrator').map((agent) => [agent.id, agent] as const),
  )
  if (!replyToMessageId && !metadata?.replyToMessageId) return null

  const repliedToMetadata =
    input.repliedToMessage?.metadata && typeof input.repliedToMessage.metadata === 'object'
      ? (input.repliedToMessage.metadata as Record<string, unknown>)
      : null
  if (!input.repliedToMessage || input.repliedToMessage.senderType !== 'agent') return null

  const targetAgentId = typeof repliedToMetadata?.agentId === 'string'
    ? repliedToMetadata.agentId
    : typeof repliedToMetadata?.workerAgentId === 'string'
      ? repliedToMetadata.workerAgentId
      : typeof repliedToMetadata?.workspaceAgentId === 'string'
        ? repliedToMetadata.workspaceAgentId
        : input.repliedToMessage.senderId
  const targetWorker = workersById.get(targetAgentId)
  if (!targetWorker) return null

  const repliedTaskId =
    typeof repliedToMetadata?.orchestratorTaskId === 'string'
      ? repliedToMetadata.orchestratorTaskId
      : typeof repliedToMetadata?.taskId === 'string'
        ? repliedToMetadata.taskId
        : null
  const relatedActiveTask = input.activeTaskContext.find((task) => {
    if (task.agentId !== targetWorker.id) return false
    if (repliedTaskId && task.taskId !== repliedTaskId) return false
    return (
      task.awaitingClarification ||
      task.taskThreadStatus === 'active' ||
      task.taskStatus === 'running' ||
      task.taskStatus === 'blocked'
    )
  })

  return relatedActiveTask ? targetWorker : null
}

export const __messageRouteTestHooks = {
  chooseDirectWorkerReplyTarget,
  isOrchestratorTaskSession,
}

function resolveMentionedAgents(
  mentions: string[],
  agentRows: typeof workspaceAgents.$inferSelect[],
) {
  if (!mentions.length) return []
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]))
  const resolved: typeof workspaceAgents.$inferSelect[] = []
  const seen = new Set<string>()
  for (const mention of mentions) {
    const agent = agentsById.get(mention)
    if (!agent || seen.has(agent.id)) continue
    seen.add(agent.id)
    resolved.push(agent)
  }
  return resolved
}

async function routeGroupMessageToMentionedAgents(params: {
  sessionId: string
  session: typeof sessions.$inferSelect
  message: typeof messages.$inferSelect
  metadata: Record<string, unknown> | null
  mentionedAgents: typeof workspaceAgents.$inferSelect[]
}) {
  const [workspace] = params.session.workspaceId
    ? await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, params.session.workspaceId))
        .limit(1)
    : [null]

  for (const agent of params.mentionedAgents) {
    let profile =
      agent.roleType === 'orchestrator'
        ? toCoordinatorProfile(agent, workspace?.projectPath ?? null)
        : toAgentProfile(agent, workspace?.projectPath ?? null)
    if (params.metadata?.safetyMode && typeof params.metadata.safetyMode === 'string') {
      profile = applySafetyMode(profile, params.metadata.safetyMode)
    }
    await runAgentReply(params.sessionId, params.message, profile)
  }
}

async function profileForDirectSession(session: typeof sessions.$inferSelect) {
  if (!session.workspaceAgentId) return undefined
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

async function startPlanRunInExistingGroup(params: {
  sessionId: string
  plan: OrchestratorPlan
  workspaceId: string
  ownerId: string
  planMessageId?: string | null
  runId?: string
  run?: RunControllerRunContext
}): Promise<DispatchMonitor> {
  const { sessionId, plan, workspaceId, ownerId, planMessageId } = params

  const [sourceSession] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  if (!sourceSession || sourceSession.ownerId !== ownerId || sourceSession.workspaceId !== workspaceId) {
    throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '群聊会话不存在')
  }

  const { agentsByKey } = await dispatchPlanToExistingGroup(sourceSession, ownerId, plan)

  const validationAgents = plan.agents
    .map((agent) => {
      const dbAgent = agentsByKey.get(agent.key)
      return {
        id: dbAgent?.id ?? agent.key,
        key: agent.key,
        name: dbAgent?.name ?? agent.name,
        roleType: dbAgent?.roleType ?? agent.roleType,
      }
    })
  const validationError = validateRealWorkerAssignments({
    agents: validationAgents,
    tasks: plan.tasks.map((task) => ({
      agentId: agentsByKey.get(task.agentKey)?.id ?? task.agentKey,
      title: task.title,
    })),
  })
  if (validationError) {
    throw AppError.fromCode(AppErrorCodes.ORCHESTRATOR_PLAN_INVALID, validationError)
  }

  const childSessions = new Map<
    string,
    {
      sessionId: string
      workspaceId: string
      projectPath?: string | null
      taskThreadId?: string | null
      workerInstanceId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
    }
  >()
  const taskThreadsByTaskId = new Map<
    string,
    {
      threadId: string
      sessionId: string
      workerInstanceId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
    }
  >()

  const [workspaceRecord] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
  const projectPath = workspaceRecord?.projectPath ?? null
  const runId = params.runId ?? randomUUID()
  const managerRun: RunControllerRunContext = params.run ?? {
    runId,
    workspaceId,
    groupSessionId: sessionId,
  }
  const taskIdRemap = new Map<string, string>()

  for (const [index, task] of plan.tasks.entries()) {
    const agent = agentsByKey.get(task.agentKey)
    let taskId = task.id
    const existingTask = await db
      .select({ id: workspaceTasks.id })
      .from(workspaceTasks)
      .where(eq(workspaceTasks.id, taskId))
      .limit(1)
    if (existingTask.length > 0) {
      taskId = randomUUID()
      taskIdRemap.set(task.id, taskId)
      task.id = taskId
    }
    const dependencies = (task.dependencies ?? []).map((depId) => taskIdRemap.get(depId) ?? depId)
    task.dependencies = dependencies

    const [workspaceTask] = await db
      .insert(workspaceTasks)
      .values({
        id: taskId,
        workspaceId,
        agentId: agent?.id ?? null,
        title: task.title,
        description: task.description,
        status: 'pending',
        sessionId: null,
        orderIdx: index,
        runId,
        phaseId: task.phaseId,
        dependencies,
        parallelGroup: task.parallelGroup,
        maxRetries: task.maxRetries ?? 2,
      })
      .returning()

    if (!workspaceTask) continue

    const outputContract = normalizeTaskOutputContract(task.outputContract, taskId)
    const runtimeThread = await prepareTaskRuntimeThread({
      workspaceId,
      ownerId,
      runId,
      taskId,
      groupSessionId: sessionId,
      workspaceName: workspaceRecord?.name ?? plan.title,
      projectPath,
      taskTitle: task.title,
      taskDescription: task.description,
      goal: plan.goal,
      agent,
      dependencies,
      acceptanceCriteria: outputContract?.acceptanceCriteria,
      requiredArtifacts: outputContract?.requiredArtifacts,
    })

    childSessions.set(task.id, {
      sessionId: runtimeThread.sessionId,
      workspaceId: runtimeThread.workspaceId,
      projectPath: runtimeThread.projectPath,
      taskThreadId: runtimeThread.taskThreadId,
      workerInstanceId: runtimeThread.workerInstanceId ?? null,
      sharedTaskRelativeRoot: runtimeThread.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: runtimeThread.sharedTaskSpecPath ?? null,
    })
    taskThreadsByTaskId.set(task.id, {
      threadId: runtimeThread.taskThreadId,
      sessionId: runtimeThread.sessionId,
      workerInstanceId: runtimeThread.workerInstanceId ?? null,
      sharedTaskRelativeRoot: runtimeThread.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: runtimeThread.sharedTaskSpecPath ?? null,
    })
  }

  if (taskIdRemap.size > 0 && plan.phases) {
    for (const phase of plan.phases) {
      phase.taskIds = phase.taskIds.map((taskId) => taskIdRemap.get(taskId) ?? taskId)
    }
  }

  const executionRelations = await loadWorkspaceAgentRelationsForPlanning(workspaceId)
  const rawExecutionPlan: ExecutionPlan = {
    runId,
    title: plan.title,
    goal: plan.goal,
    phases: plan.phases,
    collaborationMode: (plan as OrchestratorPlan & { collaborationMode?: ExecutionPlan['collaborationMode'] })
      .collaborationMode,
    agentRelations: executionRelations,
    agents: plan.agents.map((a) => {
      const dbAgent = agentsByKey.get(a.key)
      return {
        id: dbAgent?.id ?? a.key,
        key: a.key,
        name: dbAgent?.name ?? a.name,
        role: dbAgent?.role ?? a.role,
        roleType: dbAgent?.roleType ?? a.roleType,
        description: dbAgent?.description ?? a.description,
        color: dbAgent?.color ?? a.color,
        systemPrompt: dbAgent?.systemPrompt ?? a.systemPrompt,
        roleProfile: dbAgent?.roleProfile ?? a.roleProfile,
        modelId: dbAgent?.modelId ?? a.modelId,
        runtimeType: dbAgent?.runtimeType ?? a.runtimeType ?? 'llm',
        codeAgentType: dbAgent?.codeAgentType ?? a.codeAgentType ?? undefined,
        capabilityTags: dbAgent?.capabilityTags ?? a.capabilityTags ?? [],
        toolPermissions: dbAgent?.toolPermissions ?? a.toolPermissions ?? [],
        sandboxPolicy:
          (dbAgent?.sandboxPolicy ?? a.sandboxPolicy) === 'danger-full-access'
            ? 'danger-full-access'
            : 'workspace-write',
      }
    }),
    tasks: plan.tasks.map((t) => ({
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
      childSessionId: childSessions.get(t.id)?.sessionId ?? null,
    })),
  }
  const executionPlan = initializeRunLedger(rawExecutionPlan)

  await runController.prepareForDispatch(managerRun, {
    plan: executionPlan as unknown as Record<string, unknown>,
    planMessageId: planMessageId ?? null,
    taskCount: executionPlan.tasks.length,
    agentCount: executionPlan.agents.length,
    phaseCount: executionPlan.phases?.length ?? 0,
  })
  await emitRunEvent({
    runId,
    workspaceId,
    groupSessionId: sessionId,
    type: 'plan.created',
    payload: {
      title: executionPlan.title,
      goal: executionPlan.goal,
      collaborationMode: executionPlan.collaborationMode || 'mapreduce',
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
          childSessionId: childSessions.get(t.id)?.sessionId ?? null,
          taskThreadId: childSessions.get(t.id)?.taskThreadId ?? null,
          workerInstanceId: childSessions.get(t.id)?.workerInstanceId ?? null,
          sharedTaskRelativeRoot: childSessions.get(t.id)?.sharedTaskRelativeRoot ?? null,
          sharedTaskSpecPath: childSessions.get(t.id)?.sharedTaskSpecPath ?? null,
        })),
        agents: executionPlan.agents,
      },
      taskCount: executionPlan.tasks.length,
      agentCount: executionPlan.agents.length,
      phaseCount: executionPlan.phases?.length ?? 0,
    },
  })

  for (const task of executionPlan.tasks) {
    const threadInfo = taskThreadsByTaskId.get(task.id)
    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId: sessionId,
      taskId: task.id,
      threadId: threadInfo?.threadId ?? null,
      agentId: task.agentId,
      type: 'task.planned',
      payload: {
        taskId: task.id,
        title: task.title,
        description: task.description,
        workspaceAgentId: task.agentId,
        workerInstanceId: threadInfo?.workerInstanceId ?? childSessions.get(task.id)?.workerInstanceId ?? null,
        dependencies: task.dependencies ?? [],
        childSessionId: threadInfo?.sessionId ?? childSessions.get(task.id)?.sessionId ?? null,
        sessionId: threadInfo?.sessionId ?? childSessions.get(task.id)?.sessionId ?? null,
        taskThreadId: threadInfo?.threadId ?? childSessions.get(task.id)?.taskThreadId ?? null,
        groupSessionId: sessionId,
        sharedTaskRelativeRoot: threadInfo?.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: threadInfo?.sharedTaskSpecPath ?? null,
      },
    })
    if (threadInfo) {
      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId: sessionId,
        taskId: task.id,
        threadId: threadInfo.threadId,
        agentId: task.agentId,
        type: 'thread.prepared',
        payload: {
          taskId: task.id,
          threadId: threadInfo.threadId,
          taskThreadId: threadInfo.threadId,
          sessionId: threadInfo.sessionId,
          childSessionId: threadInfo.sessionId,
          groupSessionId: sessionId,
          workerInstanceId: threadInfo.workerInstanceId ?? null,
          status: 'prepared',
          sharedTaskRelativeRoot: threadInfo.sharedTaskRelativeRoot ?? null,
          sharedTaskSpecPath: threadInfo.sharedTaskSpecPath ?? null,
        },
      })
    }
  }

  await runController.reconcile({
    runId,
    workspaceId,
    groupSessionId: sessionId,
  })

  const engine = new OrchestratorEngine()
  engine
    .startRun({
      runId,
      groupSessionId: sessionId,
      workspaceId,
      plan: executionPlan,
      childSessions,
      run: managerRun,
    })
    .catch(async (err: any) => {
      logger.error({ err: err?.message, runId }, 'Auto orchestrator engine start failed')
      await runController.fail(managerRun, {
        error: err?.message || '编排器引擎启动失败',
        stage: 'engine-start',
      })
    })
  return {
    dispatchId: runId,
    groupSessionId: sessionId,
    taskIds: executionPlan.tasks.map((task) => task.id),
  }
}

async function generatePlanAndPushTaskBoard(
  sessionId: string,
  content: string,
  agents: any[],
  workspaceId: string,
  ownerId: string,
  options: {
    propagateErrors?: boolean
    decision?: ManagerDecisionEventContext
    run?: RunControllerRunContext
    runId?: string
  } = {},
): Promise<DispatchMonitor | null> {
  const orchestratorAgent = agents.find((a: any) => a.roleType === 'orchestrator')

  const guardrails = checkInputGuardrails(content)
  if (!guardrails.ok && guardrails.riskLevel === 'high') {
    const [blockedMessage] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'system',
        senderType: 'system',
        type: 'text',
        content: `请求被安全策略拦截：${guardrails.violations.join('；')}`,
        metadata: {
          systemEvent: 'orchestrator_blocked',
          riskLevel: guardrails.riskLevel,
          violations: guardrails.violations,
        },
      })
      .returning()
    if (blockedMessage) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCompleted,
        payload: { sessionId, message: blockedMessage },
      })
    }
    if (options.run) {
      await runController.fail(options.run, {
        error: `请求被安全策略拦截：${guardrails.violations.join('；')}`,
        stage: 'guardrails',
      })
    }
    return null
  }

  broadcastSessionEvent(sessionId, {
    type: WsEvent.AgentTyping,
    payload: {
      sessionId,
      agentId: orchestratorAgent?.id ?? 'orchestrator',
      agentName: orchestratorAgent?.name ?? 'Orchestrator',
      phase: 'planning',
    },
  })

  const managerRun =
    options.run ??
    (await runController.start({
      workspaceId,
      groupSessionId: sessionId,
      goal: content,
      actor: orchestratorAgent,
      decision: options.decision ?? null,
    }))
  const runId = options.runId ?? managerRun.runId

  try {
    const plan = await buildDynamicOrchestratorPlan(content, agents, workspaceId)
    return await startPlanRunInExistingGroup({
      sessionId,
      plan,
      workspaceId,
      ownerId,
      runId,
      run: managerRun,
    })
  } catch (err: any) {
    const message = err?.message || '模型没有返回可执行的任务计划'
    logger.warn({ err: message, sessionId }, 'Dynamic orchestrator plan failed')
    const [workspaceRecord] = await db
      .select({ projectPath: workspaces.projectPath })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    const recoveredArtifacts = extractPlanningFailureArtifacts(message, workspaceRecord?.projectPath)
    const recoveredArtifactMetadata = buildPlanningFailureArtifactMetadata(
      recoveredArtifacts,
      runId,
      workspaceId,
    )
    await runController.fail(managerRun, {
      error: message,
      stage: 'planning',
    })
    const [failedMessage] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'system',
        senderType: 'system',
        type: 'text',
        content: `Orchestrator 规划失败：${message}`,
        metadata: {
          systemEvent: 'orchestrator_plan_failed',
          error: message,
          ...recoveredArtifactMetadata,
        },
      })
      .returning()
    if (failedMessage) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCompleted,
        payload: { sessionId, message: failedMessage },
      })
    }
    if (options.propagateErrors) throw err
    return null
  }
}
