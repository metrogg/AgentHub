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
  rooms,
  timelineEvents,
  and,
  eq,
  asc,
  desc,
} from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import type { AgentRunProfile, MessageRow } from '../services/agent-runner'
import { broadcastSessionEvent, runAgentReply } from '../services/agent-runner'
import { emitRunEvent } from '../services/orchestrator/run-events'
import { runController } from '../services/orchestrator/run-controller'
import { buildAgUiMemberProposalContinueEvent } from '../services/protocols'
import { blackboard, Blackboard } from '../services/blackboard'
import {
  appendMessageControlEvent,
  appendHumanMessageRoomFirst,
  recordHumanMessageInRoomTimeline,
  stepCoordinatorForGroupMessage,
  stepTaskRoomAfterHumanMessage,
} from '../services/rooms/room-chat-bridge'
import { listSessionMessagesRoomFirst } from '../services/rooms/timeline-message-projection'
import type { ManagerAction } from '../services/manager-runtime'
import type { DispatchMonitor } from '../services/manager-runtime/planning-dispatcher'
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

const INTERRUPTIBLE_RUN_STATUSES = new Set(['planning', 'running', 'synthesizing'])

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
    return c.json({ items: await listSessionMessagesRoomFirst({ sessionId, legacyMessages: list }) })
  })
  .delete('/:sessionId/all', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.clear',
      body: '已清空本会话消息显示。',
      metadata: { clearedAt: new Date().toISOString() },
    })
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
    const editedAt = new Date().toISOString()
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.edit',
      body: content,
      metadata: {
        targetMessageId: message.id,
        targetEventId: extractRoomEventId(message),
        content,
        editedAt,
      },
    })
    const [updated] = await db
      .update(messages)
      .set({
        content,
        metadata: {
          ...metadata,
          ...(typeof metadata.displayContent === 'string' ? { displayContent: content } : {}),
          editedAt,
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
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.redact',
      body: '已撤回旧回复，准备重新发送。',
      metadata: buildMessageRedactionMetadata(affected, {
        reason: 'resend',
        sourceMessageId: message.id,
      }),
    })
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
      stepCoordinatorForGroupMessage({
        session,
        userId: user.sub,
        userName: user.username,
        message,
      }).catch((err: any) =>
        logger.error({ err: err?.message, sessionId }, 'ManagerRuntime room step failed on resend'),
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
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.pin',
      body: '已置顶消息。',
      metadata: {
        targetMessageId: message.id,
        targetEventId: extractRoomEventId(message),
        pinned: true,
        pinnedAt: new Date().toISOString(),
      },
    })
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
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.pin',
      body: '已取消置顶消息。',
      metadata: {
        targetMessageId: message.id,
        targetEventId: extractRoomEventId(message),
        pinned: false,
        unpinnedAt: new Date().toISOString(),
      },
    })
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
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.redact',
      body: '已撤回消息及其关联回复。',
      metadata: buildMessageRedactionMetadata([target, ...affected], {
        reason: 'delete',
        rollback,
        rollbackResult,
      }),
    })
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

    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.redact',
      body: '已撤回旧回复，准备重新生成。',
      metadata: buildMessageRedactionMetadata([message], {
        reason: 'regenerate',
        sourceMessageId: previousUser.id,
      }),
    })
    await db.delete(messages).where(eq(messages.id, message.id))
    const { cancelAgentReply } = await import('../services/agent-runner')
    cancelAgentReply(sessionId)
    if (session.type === 'group') {
      stepCoordinatorForGroupMessage({
        session,
        userId: user.sub,
        userName: user.username,
        message: previousUser,
      }).catch((err: any) =>
        logger.error({ err: err?.message, sessionId }, 'ManagerRuntime room step failed on regenerate'),
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
    const { message: msg } = await appendHumanMessageRoomFirst({
      session,
      userId: user.sub,
      userName: user.username,
      content,
      type,
      metadata: nextMetadata,
      replyToMessageId: metadata?.replyToMessageId as string | undefined,
    })
    // Trigger agent reply asynchronously (do not await to keep response fast).
    if (msg && !metadata?.skipAgentReply) {
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
      if (session?.type === 'group') {
        if (session.workspaceId) {
          const agentRows = await db
            .select()
            .from(workspaceAgents)
            .where(eq(workspaceAgents.workspaceId, session.workspaceId))
            .orderBy(asc(workspaceAgents.orderIdx))
          const mentionedAgents = resolveMentionedAgents(mentions, agentRows)
          // Mention 信息已通过 Room timeline 传递（nextMetadata.mentions），由 ManagerRuntime 统一决策
          if (mentionedAgents.length > 0) {
            logger.info({ sessionId, mentionedAgentIds: mentionedAgents.map((a) => a.id) }, 'Group mention detected; delegating to ManagerRuntime')
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
            const routedToTaskRoom = await routeGroupReplyToWorkerTaskRoom({
              groupSessionId: sessionId,
              message: msg,
              userId: user.sub,
              userName: user.username,
              targetWorker: directWorkerTarget,
              activeTaskContext,
            })
            if (routedToTaskRoom) return c.json(msg)
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
        }

        await stepCoordinatorForGroupMessage({
          session,
          userId: user.sub,
          userName: user.username,
          message: msg,
        }).catch((err: any) => {
          logger.error({ err: err?.message, sessionId }, 'ManagerRuntime room step failed')
          return null
        })
        return c.json(msg)
      } else {
        if (session && isOrchestratorTaskSession(session)) {
          const taskRoomResult = await stepTaskRoomAfterHumanMessage({
            session,
            userId: user.sub,
            userName: user.username,
            message: msg,
          }).catch((err: any) => {
            logger.error({ err: err?.message, sessionId }, 'Task room WorkerRuntime resume step failed')
            return null
          })
          if (taskRoomResult?.consumed) {
            return c.json(msg)
          }
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

      const proposalRef = await loadMemberProposalRef(sessionId, messageId)
      if (!proposalRef) {
        throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '补员建议消息不存在')
      }

      const metadata = proposalRef.metadata
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

      const message = await updateMemberProposalRef({
        ref: proposalRef,
        content: `已加入：${agentsToJoin.map((agent) => agent.name).join('、')}。现在可以让 Manager 重新规划并分发任务。`,
        metadata: {
          ...metadata,
          memberProposalStatus: 'confirmed',
          confirmedProfileIds: selectedProfileIds,
          createdAgentIds: createdAgents.map((agent) => agent.id),
          reusedAgentIds: reusedAgents.map((agent) => agent.id),
        },
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

    const proposalRef = await loadMemberProposalRef(sessionId, messageId)
    if (!proposalRef) {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '补员建议消息不存在')
    }

    const metadata = proposalRef.metadata
    if (metadata.memberProposalStatus !== 'confirmed') {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '请先确认补员，再继续分发')
    }
    if (metadata.memberProposalContinueStatus === 'running') {
      return c.json({ message: memberProposalRefMessage(proposalRef), started: false })
    }

    const goal =
      readString(metadata.memberProposalGoal) ??
      (await findPreviousUserMessageContent(sessionId, proposalRef.id))
    if (!goal) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '找不到需要继续分发的原始用户目标')
    }

    const runningMessage = await updateMemberProposalContinueState({
      ref: proposalRef,
      metadata,
      content: `已加入建议成员。Orchestrator 正在基于新成员重新规划并分发任务。`,
      status: 'running',
      goal,
    })
    broadcastMemberProposalContinueStatus({
      sessionId,
      messageId: proposalRef.id,
      status: 'running',
      goal,
    })

    continueMemberProposalPlanning({
      session,
      ownerId: user.sub,
      userName: user.username,
      proposalMessageId: proposalRef.id,
      goal,
    }).catch((err: any) =>
      logger.error(
        { err: err?.message, sessionId, messageId: proposalRef.id },
        'Member proposal continue failed',
      ),
    )

    return c.json({ message: runningMessage, started: true })
  })

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

type MemberProposalRef = {
  id: string
  sessionId: string
  content: string
  metadata: Record<string, unknown>
  legacyMessage?: typeof messages.$inferSelect | null
  roomEvent?: typeof timelineEvents.$inferSelect | null
  roomId?: string | null
  targetEventId?: string | null
}

async function loadMemberProposalRef(sessionId: string, messageId: string): Promise<MemberProposalRef | null> {
  if (messageId.startsWith('room:')) {
    const eventId = messageId.slice('room:'.length).trim()
    if (!eventId) return null
    const [row] = await db
      .select({
        event: timelineEvents,
        room: rooms,
      })
      .from(timelineEvents)
      .innerJoin(rooms, eq(rooms.id, timelineEvents.roomId))
      .where(and(eq(timelineEvents.id, eventId), eq(rooms.sessionId, sessionId)))
      .limit(1)
    if (!row?.event) return null
    const updates = await db
      .select()
      .from(timelineEvents)
      .where(and(eq(timelineEvents.roomId, row.room.id), eq(timelineEvents.type, 'system')))
      .orderBy(asc(timelineEvents.sequence))
    let content = row.event.body
    const metadata = { ...(row.event.metadata ?? {}) }
    for (const update of updates) {
      if (update.metadata?.kind !== 'member-proposal.update') continue
      if (update.metadata?.targetEventId !== row.event.id) continue
      const patch = update.metadata.patch
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
        Object.assign(metadata, patch as Record<string, unknown>)
      }
      if (typeof update.metadata.content === 'string' && update.metadata.content.trim()) {
        content = update.metadata.content
      } else if (update.body.trim()) {
        content = update.body
      }
    }
    return {
      id: `room:${row.event.id}`,
      sessionId,
      content,
      metadata,
      legacyMessage: null,
      roomEvent: row.event,
      roomId: row.room.id,
      targetEventId: row.event.id,
    }
  }

  const [proposalMessage] = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
  if (!proposalMessage || proposalMessage.sessionId !== sessionId) return null
  return {
    id: proposalMessage.id,
    sessionId,
    content: proposalMessage.content,
    metadata: proposalMessage.metadata ?? {},
    legacyMessage: proposalMessage,
    roomEvent: null,
    roomId: readNestedString(proposalMessage.metadata ?? {}, ['roomTimeline', 'roomId']) ??
      readNestedString(proposalMessage.metadata ?? {}, ['roomTimelineProjection', 'roomId']),
    targetEventId: null,
  }
}

function memberProposalRefMessage(ref: MemberProposalRef): typeof messages.$inferSelect {
  if (ref.legacyMessage) return ref.legacyMessage
  return {
    id: ref.id,
    sessionId: ref.sessionId,
    senderId: 'manager',
    senderType: 'agent',
    type: 'task_card',
    content: ref.content,
    metadata: ref.metadata,
    isPinned: false,
    replyToMessageId: null,
    createdAt: ref.roomEvent?.createdAt ?? new Date(),
  }
}

async function updateMemberProposalRef(params: {
  ref: MemberProposalRef
  content: string
  metadata: Record<string, unknown>
}) {
  if (params.ref.legacyMessage) {
    const [updated] = await db
      .update(messages)
      .set({ content: params.content, metadata: params.metadata })
      .where(eq(messages.id, params.ref.legacyMessage.id))
      .returning()
    const result = updated ?? params.ref.legacyMessage
    broadcastSessionEvent(params.ref.sessionId, {
      type: WsEvent.MessageCompleted,
      payload: { sessionId: params.ref.sessionId, message: result },
    })
    return result
  }

  if (!params.ref.roomId || !params.ref.targetEventId) {
    throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '补员建议事件不存在')
  }
  await appendTimelineMemberProposalUpdate({
    roomId: params.ref.roomId,
    targetEventId: params.ref.targetEventId,
    content: params.content,
    metadata: params.metadata,
  })
  return {
    ...memberProposalRefMessage(params.ref),
    content: params.content,
    metadata: params.metadata,
  }
}

async function appendTimelineMemberProposalUpdate(input: {
  roomId: string
  targetEventId: string
  content: string
  metadata: Record<string, unknown>
}) {
  const { roomService } = await import('../services/rooms')
  return roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderType: 'manager',
    type: 'system',
    body: input.content,
    metadata: {
      kind: 'member-proposal.update',
      targetEventId: input.targetEventId,
      content: input.content,
      patch: input.metadata,
    },
  })
}

async function findPreviousUserMessageContent(sessionId: string, beforeMessageId: string) {
  if (beforeMessageId.startsWith('room:')) {
    const beforeEventId = beforeMessageId.slice('room:'.length).trim()
    if (beforeEventId) {
      const [beforeEventRow] = await db
        .select({
          event: timelineEvents,
          room: rooms,
        })
        .from(timelineEvents)
        .innerJoin(rooms, eq(rooms.id, timelineEvents.roomId))
        .where(and(eq(timelineEvents.id, beforeEventId), eq(rooms.sessionId, sessionId)))
        .limit(1)
      if (beforeEventRow?.event) {
        const timeline = await db
          .select()
          .from(timelineEvents)
          .where(eq(timelineEvents.roomId, beforeEventRow.room.id))
          .orderBy(asc(timelineEvents.sequence))
        const previousHuman = timeline
          .filter((event) => event.sequence < beforeEventRow.event.sequence)
          .reverse()
          .find((event) => event.senderType === 'human' && event.body.trim())
        if (previousHuman?.body.trim()) return previousHuman.body.trim()
      }
    }
  }

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
  ref: MemberProposalRef
  metadata: Record<string, unknown>
  content: string
  status: 'running' | 'completed' | 'failed'
  goal: string
  monitor?: DispatchMonitor
  error?: string
}) {
  const { ref, metadata, content, status, goal, monitor, error } = params
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

  return updateMemberProposalRef({ ref, content, metadata: nextMetadata })
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
  userName?: string | null
  proposalMessageId: string
  goal: string
}) {
  const { session, ownerId, userName, proposalMessageId, goal } = params
  if (!session.workspaceId) return

  const proposalRef = await loadMemberProposalRef(session.id, proposalMessageId)
  if (!proposalRef) return

  const metadata = proposalRef.metadata
  try {
    const { message: continueMessage } = await appendHumanMessageRoomFirst({
      session,
      userId: ownerId,
      userName,
      content: `补员已确认。请 Manager 基于当前群聊成员继续处理原始目标，并把需要执行的工作分派到真实任务子对话：${goal}`,
      type: 'text',
      metadata: {
        kind: 'member-proposal-continue',
        sourceProposalMessageId: proposalRef.id,
        memberProposalGoal: goal,
        noLegacyFallback: true,
      },
      replyToMessageId: proposalRef.id,
    })
    const step = await stepCoordinatorForGroupMessage({
      session,
      userId: ownerId,
      userName,
      message: continueMessage,
    })
    const latestRef = await loadMemberProposalRef(session.id, proposalMessageId)
    await updateMemberProposalContinueState({
      ref: latestRef ?? proposalRef,
      metadata: (latestRef?.metadata ?? metadata) as Record<string, unknown>,
      content: '已加入建议成员。Manager Runtime 已收到继续协作请求，并已按其输出继续处理。',
      status: 'completed',
      goal,
    })
    broadcastMemberProposalContinueStatus({
      sessionId: session.id,
      messageId: proposalRef.id,
      status: 'completed',
      goal,
      taskIds: step.actions.filter((action) => action.type === 'assign').map((action) => action.taskKey ?? action.taskTitle ?? 'assign'),
    })
  } catch (err: any) {
    const error = err?.message || 'Orchestrator 重新规划失败'
    const latestRef = await loadMemberProposalRef(session.id, proposalMessageId)
    await updateMemberProposalContinueState({
      ref: latestRef ?? proposalRef,
      metadata: (latestRef?.metadata ?? metadata) as Record<string, unknown>,
      content: `已加入建议成员，但 Orchestrator 重新规划失败：${error}`,
      status: 'failed',
      goal,
      error,
    })
    broadcastMemberProposalContinueStatus({
      sessionId: session.id,
      messageId: proposalRef.id,
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
  const [session] = await db.select().from(sessions).where(eq(sessions.id, input.sessionId)).limit(1)
  if (!session) return null
  const { roomService } = await import('../services/rooms')
  const room = await roomService.ensureRoomForSession(session.id, session.ownerId)
  const event = await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: input.senderType === 'system' ? 'system' : 'manager',
    type: input.senderType === 'system' ? 'system' : 'manager.message',
    body: input.content,
    metadata: {
      ...input.metadata,
      source: 'session-transparency',
      legacyMessageProjectionDisabled: true,
    },
  })

  return {
    id: `room:${event.id}`,
    sessionId: input.sessionId,
    senderId: input.senderId,
    senderType: input.senderType,
    type: 'text',
    content: input.content,
    metadata: input.metadata,
    isPinned: false,
    replyToMessageId: null,
    createdAt: event.createdAt,
  }
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

async function loadActiveTaskContext(sessionId: string) {
  const tasks = await db
    .select({
      taskId: workspaceTasks.id,
      taskTitle: workspaceTasks.title,
      taskStatus: workspaceTasks.status,
      progressStatus: workspaceTasks.progressStatus,
      agentId: workspaceTasks.agentId,
      taskThreadId: taskThreads.id,
      taskThreadSessionId: taskThreads.sessionId,
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
      taskThreadId: task.taskThreadId ?? null,
      taskThreadSessionId: task.taskThreadSessionId ?? null,
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

async function routeGroupReplyToWorkerTaskRoom(input: {
  groupSessionId: string
  message: typeof messages.$inferSelect
  userId: string
  userName?: string | null
  targetWorker: typeof workspaceAgents.$inferSelect
  activeTaskContext: Awaited<ReturnType<typeof loadActiveTaskContext>>
}) {
  const targetTask = input.activeTaskContext.find(
    (task) =>
      task.agentId === input.targetWorker.id &&
      (task.awaitingClarification ||
        task.taskThreadStatus === 'active' ||
        task.taskStatus === 'running' ||
        task.taskStatus === 'blocked'),
  )
  if (!targetTask?.taskThreadSessionId) return false
  const [taskSession] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, targetTask.taskThreadSessionId))
    .limit(1)
  if (!taskSession || !isOrchestratorTaskSession(taskSession)) return false

  const { message: taskRoomMessage } = await appendHumanMessageRoomFirst({
    session: taskSession,
    userId: input.userId,
    userName: input.userName,
    type: input.message.type,
    content: input.message.content,
    metadata: {
      ...(input.message.metadata && typeof input.message.metadata === 'object' ? input.message.metadata : {}),
      source: 'group-worker-reply',
      groupSessionId: input.groupSessionId,
      groupMessageId: input.message.id,
      targetWorkerId: input.targetWorker.id,
      targetWorkerName: input.targetWorker.name,
      taskId: targetTask.taskId,
      taskThreadId: targetTask.taskThreadId,
    },
    replyToMessageId: null,
  })

  await stepTaskRoomAfterHumanMessage({
    session: taskSession,
    userId: input.userId,
    userName: input.userName,
    message: taskRoomMessage,
  }).catch((err: any) => {
    logger.error(
      {
        err: err?.message,
        groupSessionId: input.groupSessionId,
        taskSessionId: taskSession.id,
        targetWorkerId: input.targetWorker.id,
      },
      'Group reply to Worker task room failed',
    )
    return null
  })
  return true
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

function collectAffectedMessages(list: Array<typeof messages.$inferSelect>, targetIndex: number) {
  const affected: Array<typeof messages.$inferSelect> = []
  for (const message of list.slice(targetIndex + 1)) {
    if (message.senderType === 'user') break
    affected.push(message)
  }
  return affected
}

function extractRoomEventId(message: typeof messages.$inferSelect) {
  if (message.id.startsWith('room:')) return message.id.slice('room:'.length)
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
  return (
    readNestedString(metadata, ['roomTimeline', 'eventId']) ??
    readNestedString(metadata, ['roomTimelineProjection', 'eventId'])
  )
}

function buildMessageRedactionMetadata(
  affected: Array<typeof messages.$inferSelect>,
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    redactedAt: new Date().toISOString(),
    targetMessageIds: affected.map((message) => message.id),
    targetEventIds: affected.map(extractRoomEventId).filter((id): id is string => Boolean(id)),
    targetMessages: affected.map((message) => {
      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
      return {
        messageId: message.id,
        senderType: message.senderType,
        sourceMessageId: typeof metadata.sourceMessageId === 'string' ? metadata.sourceMessageId : undefined,
        actionType: typeof metadata.actionType === 'string' ? metadata.actionType : undefined,
        roomId: readNestedString(metadata, ['roomTimeline', 'roomId']) ?? readNestedString(metadata, ['roomTimelineProjection', 'roomId']),
      }
    }),
  }
}

function readNestedString(record: Record<string, unknown>, path: string[]) {
  let current: unknown = record
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' && current.trim() ? current : null
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
