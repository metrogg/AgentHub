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
import { broadcastSessionEvent } from '../services/agent-runner'
import { emitRunEvent } from '../services/orchestrator/run-events'
import { buildAgUiMemberProposalContinueEvent } from '../services/protocols'
import {
  appendMessageControlEvent,
  appendHumanMessageRoomFirst,
  stepCoordinatorForGroupMessage,
} from '../services/rooms/room-chat-bridge'
import { roomService } from '../services/rooms/room-service'
import { listSessionMessagesRoomFirst } from '../services/rooms/timeline-message-projection'
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
    // Legacy runAgentReply path removed; cancellation is now handled by WorkerRuntime.stopTaskRoom
    // for task rooms, and direct room dispatch does not support mid-flight cancellation yet.
    return c.json({ cancelled: false, reason: 'legacy-cancel-removed' })
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
    if (removedMessageIds.length) {
      broadcastSessionEvent(sessionId, {
        type: WsEvent.MessageCancelled,
        payload: { sessionId, removedMessageIds },
      })
    }

    // HiClaw model: dispatch the existing timeline event to trigger Manager/Worker
    const { matrixRoomEventDispatcher } = await import('../services/rooms/matrix-event-dispatcher')
    const room = await roomService.ensureRoomForSession(sessionId, session.ownerId)
    const timelineEvents = await roomService.listTimelineEvents({ roomId: room.id, limit: 500 })
    const matchingEvent = timelineEvents.find((e) => e.metadata?.messageId === message.id)
    if (matchingEvent) {
      await matrixRoomEventDispatcher.dispatchTimelineEvent(matchingEvent.id).catch(() => {})
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

    // HiClaw model: dispatch the previous user message to trigger Manager/Worker
    const { matrixRoomEventDispatcher } = await import('../services/rooms/matrix-event-dispatcher')
    const room = await roomService.ensureRoomForSession(sessionId, session.ownerId)
    const timelineEvents = await roomService.listTimelineEvents({ roomId: room.id, limit: 500 })
    const matchingEvent = timelineEvents.find((e) => e.metadata?.messageId === previousUser.id)
    if (matchingEvent) {
      await matrixRoomEventDispatcher.dispatchTimelineEvent(matchingEvent.id).catch(() => {})
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
    // HiClaw model: appendHumanMessageRoomFirst() already wrote the message to the Room timeline
    // and dispatched it via MatrixRoomEventDispatcher. The Manager/Worker will pick it up
    // via /sync or platform-timeline dispatch. No manual step trigger needed here.
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
      const prompt = await appendAgentDraftTimelineCard({
        session,
        userId: user.sub,
        content:
          '请先打开或创建一个 Agent Group，再通过聊天创建 Agent。这样新 Agent 才能加入明确的 workspace 和 Agent 联系人列表。',
        metadata: { systemEvent: 'agent_draft_requires_group', agentDraftStatus: 'requires_group' },
        messageType: 'text',
      })
      return c.json(prompt)
    }

    const draft = await buildAgentDraft(content)
    const card = await appendAgentDraftTimelineCard({
      session,
      userId: user.sub,
      content: `已生成 ${draft.name} Agent 草案。确认后会加入当前 Agent Group。`,
      metadata: { systemEvent: 'agent_draft_created', agentDraft: draft, agentDraftStatus: 'draft' },
      messageType: 'task_card',
    })
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
      const draftRef = await loadAgentDraftRef(sessionId, messageId)
      if (!draftRef)
        throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'Agent 草案不存在')

      const cardMetadata = draftRef.metadata as {
        agentDraftStatus?: unknown
        createdAgentId?: unknown
      } | null
      if (draftRef.messageType !== 'task_card')
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
        return c.json({ agent: existingAgent, message: agentDraftRefMessage(draftRef) })
      }
      if (cardMetadata?.agentDraftStatus !== 'draft') {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '消息不是可编辑的 Agent 草案')
      }

      const metadataDraft = parseAgentDraft(draftRef.metadata)
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
      const updatedCard = await updateAgentDraftRef({
        ref: draftRef,
        content: `${agent.name} 已加入当前 Agent Group。`,
        metadata: {
          ...draftRef.metadata,
          agentDraft: draft,
          agentDraftStatus: 'confirmed',
          createdAgentId: agent.id,
        },
      })

      return c.json({ agent, message: updatedCard })
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

type AgentDraftRef = {
  id: string
  sessionId: string
  content: string
  metadata: Record<string, unknown>
  messageType: string
  legacyMessage?: typeof messages.$inferSelect | null
  roomEvent?: typeof timelineEvents.$inferSelect | null
  roomId?: string | null
  targetEventId?: string | null
}

async function appendAgentDraftTimelineCard(input: {
  session: typeof sessions.$inferSelect
  userId: string
  content: string
  metadata: Record<string, unknown>
  messageType: 'text' | 'task_card'
}) {
  const { roomService } = await import('../services/rooms')
  const room = await roomService.ensureRoomForSession(input.session.id, input.userId)
  const event = await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'system',
    type: 'system',
    body: input.content,
    metadata: {
      ...input.metadata,
      messageType: input.messageType,
      source: 'agent-draft',
      legacyMessageProjectionDisabled: true,
    },
  })
  return agentDraftRefMessage({
    id: `room:${event.id}`,
    sessionId: input.session.id,
    content: input.content,
    metadata: {
      ...input.metadata,
      messageType: input.messageType,
      source: 'agent-draft',
    },
    messageType: input.messageType,
    legacyMessage: null,
    roomEvent: event,
    roomId: room.id,
    targetEventId: event.id,
  })
}

async function loadAgentDraftRef(sessionId: string, messageId: string): Promise<AgentDraftRef | null> {
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
      if (update.metadata?.kind !== 'agent-draft.update') continue
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
    const messageType = readString(metadata.messageType) ?? 'text'
    return {
      id: `room:${row.event.id}`,
      sessionId,
      content,
      metadata,
      messageType,
      legacyMessage: null,
      roomEvent: row.event,
      roomId: row.room.id,
      targetEventId: row.event.id,
    }
  }

  const [draftMessage] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
  if (!draftMessage || draftMessage.sessionId !== sessionId) return null
  return {
    id: draftMessage.id,
    sessionId,
    content: draftMessage.content,
    metadata: draftMessage.metadata ?? {},
    messageType: draftMessage.type,
    legacyMessage: draftMessage,
    roomEvent: null,
    roomId:
      readNestedString(draftMessage.metadata ?? {}, ['roomTimeline', 'roomId']) ??
      readNestedString(draftMessage.metadata ?? {}, ['roomTimelineProjection', 'roomId']),
    targetEventId: null,
  }
}

function agentDraftRefMessage(ref: AgentDraftRef): typeof messages.$inferSelect {
  if (ref.legacyMessage) return ref.legacyMessage
  return {
    id: ref.id,
    sessionId: ref.sessionId,
    senderId: 'system',
    senderType: 'system',
    type: ref.messageType,
    content: ref.content,
    metadata: ref.metadata,
    isPinned: false,
    replyToMessageId: null,
    createdAt: ref.roomEvent?.createdAt ?? new Date(),
  }
}

async function updateAgentDraftRef(params: {
  ref: AgentDraftRef
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
    throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'Agent 草案事件不存在')
  }
  await appendTimelineAgentDraftUpdate({
    roomId: params.ref.roomId,
    targetEventId: params.ref.targetEventId,
    content: params.content,
    metadata: params.metadata,
  })
  return {
    ...agentDraftRefMessage(params.ref),
    content: params.content,
    metadata: params.metadata,
  }
}

async function appendTimelineAgentDraftUpdate(input: {
  roomId: string
  targetEventId: string
  content: string
  metadata: Record<string, unknown>
}) {
  const { roomService } = await import('../services/rooms')
  return roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderType: 'system',
    type: 'system',
    body: input.content,
    metadata: {
      kind: 'agent-draft.update',
      targetEventId: input.targetEventId,
      content: input.content,
      patch: input.metadata,
    },
  })
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
    codeAgentType: profile.codeAgentType ?? 'codex',
    capabilityTags: profile.capabilityTags,
    skillIds: profile.defaultSkillIds,
    toolPermissions: profile.toolPermissions,
    sandboxPolicy: profile.sandboxPolicy,
    contextPolicy: profile.contextPolicy,
    autoInvoke: profile.autoInvoke,
    approvalRequired: false,
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
