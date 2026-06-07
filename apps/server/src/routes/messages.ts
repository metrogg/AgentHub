import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { AppError, AppErrorCodes } from '../lib/error'
import { z } from 'zod'
import {
  sendMessageSchema,
  WsEvent,
  CORE_AGENT_EXPERT_PROFILES,
  type AgentExpertProfile,
} from '@agenthub/shared'
import { logger } from '../lib/logger'
import {
  db,
  sessions,
  sessionMembers,
  workspaceAgents,
  workspaces,
  rooms,
  timelineEvents,
  and,
  eq,
  asc,
} from '@agenthub/db'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import type { AgentRunProfile, MessageRow } from '../services/agent-runner'
import { broadcastSessionEvent } from '../services/agent-runner'
import { buildAgUiMemberProposalContinueEvent } from '../services/protocols'
import {
  appendMessageControlEvent,
  appendHumanMessageRoomFirst,
} from '../services/rooms/room-chat-bridge'
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
import { controllerApi } from '../services/controller-plane'
import { normalizeMemberProposals } from '../services/manager-runtime/member-proposals'
import type { MemberProposal } from '../services/manager-runtime/types'

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
    return c.json({ items: await listSessionMessagesRoomFirst({ sessionId }) })
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
    return c.json({ deleted: true })
  })
  .post('/:sessionId/cancel', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    return c.json({
      cancelled: false,
      reason: 'room-native-cancel-unavailable',
      message: '当前会话未绑定可取消的 RuntimeLease；任务子对话请使用 /stop 或任务控制入口。',
    })
  })
  .patch('/:sessionId/:messageId', zValidator('json', updateMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

    const target = await loadRoomTimelineMessageTarget(sessionId, messageId)
    if (!target || target.event.senderType !== 'human') {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    }
    const editedAt = new Date().toISOString()
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.edit',
      body: content,
      metadata: {
        targetMessageId: messageId,
        targetEventId: target.event.id,
        content,
        editedAt,
      },
    })
    const message = roomTimelineTargetToMessage(target, sessionId)
    return c.json({
      ...message,
      content,
      metadata: {
        ...(message.metadata ?? {}),
        displayContent: content,
        editedAt,
      },
    })
  })
  .post('/:sessionId/:messageId/resend', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

    const target = await loadRoomTimelineMessageTarget(sessionId, messageId)
    if (!target || target.event.senderType !== 'human') {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    }
    const content = await latestHumanMessageContent(target)
    if (!content) {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '原消息为空，无法重新发送。')
    }
    const metadata = {
      resentFromMessageId: messageId,
      resentFromEventId: target.event.id,
      source: 'room-first-resend',
    }
    const { message } = await appendHumanMessageRoomFirst({
      session,
      userId: user.sub,
      userName: user.username,
      content,
      type: 'text',
      metadata,
    })
    return c.json({ removedMessageIds: [], message })
  })
  .patch('/:sessionId/:messageId/pin', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const target = await loadRoomTimelineMessageTarget(sessionId, messageId)
    if (!target) throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.pin',
      body: '已置顶消息。',
      metadata: {
        targetMessageId: messageId,
        targetEventId: target.event.id,
        pinned: true,
        pinnedAt: new Date().toISOString(),
      },
    })
    return c.json({ ...roomTimelineTargetToMessage(target, sessionId), isPinned: true })
  })
  .patch('/:sessionId/:messageId/unpin', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const target = await loadRoomTimelineMessageTarget(sessionId, messageId)
    if (!target) throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.pin',
      body: '已取消置顶消息。',
      metadata: {
        targetMessageId: messageId,
        targetEventId: target.event.id,
        pinned: false,
        unpinnedAt: new Date().toISOString(),
      },
    })
    return c.json({ ...roomTimelineTargetToMessage(target, sessionId), isPinned: false })
  })
  .delete('/:sessionId/:messageId', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub)
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

    const target = await loadRoomTimelineMessageTarget(sessionId, messageId)
    if (!target || target.event.senderType !== 'human') {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    }
    await appendMessageControlEvent({
      session,
      userId: user.sub,
      userName: user.username,
      kind: 'message.redact',
      body: '已撤回消息。',
      metadata: buildTimelineRedactionMetadata({
        reason: 'delete',
        targetMessageId: messageId,
        targetEventId: target.event.id,
      }),
    })
    return c.json({ removedMessageIds: [messageId], rollback: { reverted: 0, failed: 0 } })
  })
  .post('/:sessionId/:messageId/regenerate', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    void user
    void sessionId
    void messageId
    throw AppError.fromCode(
      AppErrorCodes.VALIDATION_FAILED,
      '重新生成旧回复链路已删除；请在 Room 中发送新的消息触发 Manager/Worker。',
    )
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
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '请选择 Manager 建议中的 Agent')
      }

      const proposals = readMemberProposals(metadata.memberProposals)
      const proposalById = new Map(proposals.map((proposal) => [proposal.expertProfileId ?? proposal.name, proposal]))
      const existingAgents = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.workspaceId, session.workspaceId))
        .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
      const existingAgentIds = new Set(existingAgents.map((agent) => agent.id))
      const reconcileResults = []

      for (const profileId of selectedProfileIds) {
        const proposal = proposalById.get(profileId)
        const profile = CORE_AGENT_EXPERT_PROFILES.find((item) => item.id === profileId)
        const member = proposal ?? (profile ? proposalFromExpertProfile(profile) : null)
        if (!member) continue

        const runtimeBase =
          member.workerRuntimeBase ??
          member.codeAgentType ??
          profile?.workerRuntimeBase ??
          profile?.codeAgentType ??
          undefined
        try {
          const result = await controllerApi.createWorker({
            workspaceId: session.workspaceId,
            ownerId: user.sub,
            groupSessionId: session.id,
            joinGroupRoom: true,
            createDirectSession: true,
            announce: true,
            name: member.name,
            role: member.role,
            roleType: member.roleType ?? profile?.roleType ?? 'custom',
            description: member.description ?? profile?.description ?? member.reason,
            systemPrompt: member.systemPrompt ?? profile?.systemPrompt ?? '',
            roleProfile: memberRoleProfile(member, profile),
            color: member.color ?? profile?.color ?? '#0f766e',
            runtimeType: member.runtimeType ?? profile?.runtimeType ?? 'code-agent',
            runtimeBase,
            codeAgentType: member.codeAgentType ?? profile?.codeAgentType ?? undefined,
            modelId: member.modelId ?? null,
            capabilityTags: member.capabilityTags?.length ? member.capabilityTags : (profile?.capabilityTags ?? []),
            skillIds: member.skillIds?.length ? member.skillIds : (profile?.defaultSkillIds ?? []),
            toolPermissions: member.toolPermissions?.length ? member.toolPermissions : (profile?.toolPermissions ?? []),
            sandboxPolicy: member.sandboxPolicy ?? profile?.sandboxPolicy ?? 'workspace-write',
            contextPolicy: member.contextPolicy ?? profile?.contextPolicy ?? 'workspace-aware',
            autoInvoke: profile?.autoInvoke ?? true,
            approvalRequired: profile?.approvalRequired ?? true,
          })
          reconcileResults.push({
            profileId,
            proposal: member,
            agentId: result.agentId,
            workerInstanceId: result.workerInstanceId,
            runtimeBase: result.runtimeBase,
            stages: result.stages,
            groupRoomId: result.groupRoom?.id ?? null,
            directSessionId: result.directSession?.id ?? null,
            directRoomId: result.directRoom?.id ?? null,
            participantIds: result.participants.map((participant) => participant.id),
            announcements: result.announcements,
          })
        } catch (err: any) {
          throw AppError.fromCode(
            AppErrorCodes.VALIDATION_FAILED,
            `${member.name} 创建失败：${err?.message ?? 'Member Reconcile failed'}`,
          )
        }
      }

      const agentIds = Array.from(new Set(reconcileResults.map((result) => result.agentId)))
      const workspaceAgentRows = agentIds.length
        ? await db.select().from(workspaceAgents).where(eq(workspaceAgents.workspaceId, session.workspaceId))
        : []
      const agentsToJoin = workspaceAgentRows.filter((agent) => agentIds.includes(agent.id))
      if (!agentsToJoin.length) {
        throw AppError.fromCode(AppErrorCodes.AGENT_REPLY_FAILED, '没有创建或加入新的 Agent')
      }

      await ensureSessionMembers(sessionId, user.sub, agentsToJoin.map((agent) => agent.id))
      const updatedSession = await refreshGroupMemberMetadata(session, user.sub)
      await db
        .update(workspaces)
        .set({ updatedAt: new Date() })
        .where(eq(workspaces.id, session.workspaceId))
      const createdAgentIds = agentIds.filter((id) => !existingAgentIds.has(id))
      const reusedAgentIds = agentIds.filter((id) => existingAgentIds.has(id))

      const message = await updateMemberProposalRef({
        ref: proposalRef,
        content: `已加入：${agentsToJoin.map((agent) => agent.name).join('、')}。现在可以让 Manager 重新规划并分发任务。`,
        metadata: {
          ...metadata,
          memberProposalStatus: 'confirmed',
          confirmedProfileIds: selectedProfileIds,
          createdAgentIds,
          reusedAgentIds,
          workerInstanceIds: reconcileResults.map((result) => result.workerInstanceId),
          runtimeBases: reconcileResults.map((result) => result.runtimeBase),
          memberReconcileResults: reconcileResults.map((result) => ({
            profileId: result.profileId,
            agentId: result.agentId,
            workerInstanceId: result.workerInstanceId,
            runtimeBase: result.runtimeBase,
            stages: result.stages,
            groupRoomId: result.groupRoomId,
            directSessionId: result.directSessionId,
            directRoomId: result.directRoomId,
            participantIds: result.participantIds,
            announcements: result.announcements,
          })),
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
      content: `已加入建议成员。Manager 正在基于新成员重新规划并分发任务。`,
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
  roomEvent?: typeof timelineEvents.$inferSelect | null
  roomId?: string | null
  targetEventId?: string | null
}

type ProjectedMessageRow = MessageRow & {
  replyToMessageId?: string | null
}

type RoomTimelineMessageTarget = {
  event: typeof timelineEvents.$inferSelect
  room: typeof rooms.$inferSelect
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
      messageProjectionDisabled: true,
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
      roomEvent: row.event,
      roomId: row.room.id,
      targetEventId: row.event.id,
    }
  }

  return null
}

function agentDraftRefMessage(ref: AgentDraftRef): ProjectedMessageRow {
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
      roomEvent: row.event,
      roomId: row.room.id,
      targetEventId: row.event.id,
    }
  }

  return null
}

function memberProposalRefMessage(ref: MemberProposalRef): ProjectedMessageRow {
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
  const before = await loadRoomTimelineMessageTarget(sessionId, beforeMessageId)
  if (!before) return null
  const timeline = await db
    .select()
    .from(timelineEvents)
    .where(eq(timelineEvents.roomId, before.room.id))
    .orderBy(asc(timelineEvents.sequence))
  const previousHuman = timeline
    .filter((event) => event.sequence < before.event.sequence)
    .reverse()
    .find((event) => event.senderType === 'human' && event.body.trim())
  return previousHuman?.body.trim() || null
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
    // HiClaw model: write message to Room timeline, dispatcher handles the rest.
    // appendHumanMessageRoomFirst() dispatches via matrixRoomEventDispatcher automatically.
    await appendHumanMessageRoomFirst({
      session,
      userId: ownerId,
      userName,
      content: `补员已确认。请 Manager 基于当前群聊成员继续处理原始目标，并把需要执行的工作分派到真实任务子对话：${goal}`,
      type: 'text',
      metadata: {
        kind: 'member-proposal-continue',
        sourceProposalMessageId: proposalRef.id,
        memberProposalGoal: goal,
        roomNativeDispatch: true,
      },
      replyToMessageId: proposalRef.id,
    })
    const latestRef = await loadMemberProposalRef(session.id, proposalMessageId)
    await updateMemberProposalContinueState({
      ref: latestRef ?? proposalRef,
      metadata: (latestRef?.metadata ?? metadata) as Record<string, unknown>,
      content: '已加入建议成员。Manager Runtime 已收到继续协作请求。',
      status: 'completed',
      goal,
    })
    broadcastMemberProposalContinueStatus({
      sessionId: session.id,
      messageId: proposalRef.id,
      status: 'completed',
      goal,
      taskIds: [],
    })
  } catch (err: any) {
    const error = err?.message || 'Manager 重新规划失败'
    const latestRef = await loadMemberProposalRef(session.id, proposalMessageId)
    await updateMemberProposalContinueState({
      ref: latestRef ?? proposalRef,
      metadata: (latestRef?.metadata ?? metadata) as Record<string, unknown>,
      content: `已加入建议成员，但 Manager 重新规划失败：${error}`,
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

function readMemberProposalProfileIds(value: unknown) {
  return readMemberProposals(value)
    .map((item) => item.expertProfileId)
    .filter((id): id is string => Boolean(id))
}

function readMemberProposals(value: unknown): MemberProposal[] {
  return normalizeMemberProposals(value)
}

function proposalFromExpertProfile(profile: AgentExpertProfile): MemberProposal {
  return {
    expertProfileId: profile.id,
    name: profile.name,
    role: profile.role,
    reason: profile.description,
    category: profile.category,
    roleType: profile.roleType,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    runtimeType: profile.runtimeType,
    codeAgentType: profile.codeAgentType ?? null,
    workerRuntimeBase: profile.workerRuntimeBase ?? profile.codeAgentType ?? null,
    color: profile.color,
    modelId: null,
    capabilityTags: profile.capabilityTags,
    skillIds: profile.defaultSkillIds,
    toolPermissions: profile.toolPermissions,
    sandboxPolicy: profile.sandboxPolicy,
    contextPolicy: profile.contextPolicy,
    expectedContribution: profile.outputContract.join('；'),
  }
}

function memberRoleProfile(member: MemberProposal, profile?: AgentExpertProfile | null) {
  return {
    ...(profile
      ? {
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
        }
      : {}),
    proposalId: member.expertProfileId,
    proposalReason: member.reason,
    expectedContribution: member.expectedContribution,
    memberProposalCategory: member.category,
    workerRuntimeBase: member.workerRuntimeBase ?? member.codeAgentType ?? profile?.workerRuntimeBase ?? profile?.codeAgentType ?? null,
  }
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

async function loadRoomTimelineMessageTarget(
  sessionId: string,
  messageId: string,
): Promise<RoomTimelineMessageTarget | null> {
  if (!messageId.startsWith('room:')) return null
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
  return row
}

async function latestHumanMessageContent(target: RoomTimelineMessageTarget) {
  let content = target.event.body.trim()
  const targetMessageId = `room:${target.event.id}`
  const updates = await db
    .select()
    .from(timelineEvents)
    .where(and(eq(timelineEvents.roomId, target.room.id), eq(timelineEvents.type, 'system')))
    .orderBy(asc(timelineEvents.sequence))

  for (const update of updates) {
    if (update.sequence <= target.event.sequence) continue
    const metadata =
      update.metadata && typeof update.metadata === 'object'
        ? (update.metadata as Record<string, unknown>)
        : {}
    if (readString(metadata.kind) !== 'message.edit') continue
    const targetMessageIds = [
      readString(metadata.targetMessageId),
      ...readStringArray(metadata.targetMessageIds),
      ...readStringArray(metadata.targetEventIds).map((id) => `room:${id}`),
    ]
    const targetEventIds = [
      readString(metadata.targetEventId),
      ...readStringArray(metadata.targetEventIds),
    ]
    if (!targetMessageIds.includes(targetMessageId) && !targetEventIds.includes(target.event.id)) {
      continue
    }
    const nextContent = readString(metadata.content) ?? readString(update.body)
    if (nextContent) content = nextContent
  }

  return content.trim() || null
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function roomTimelineTargetToMessage(
  target: RoomTimelineMessageTarget,
  sessionId: string,
): ProjectedMessageRow {
  const metadata =
    target.event.metadata && typeof target.event.metadata === 'object'
      ? (target.event.metadata as Record<string, unknown>)
      : {}
  const senderType =
    target.event.senderType === 'human'
      ? 'user'
      : target.event.senderType === 'system' || target.event.type === 'system'
        ? 'system'
        : 'agent'
  return {
    id: `room:${target.event.id}`,
    sessionId,
    senderId: target.event.senderParticipantId ?? target.event.senderType,
    senderType,
    type: typeof metadata.messageType === 'string' ? metadata.messageType : 'text',
    content: target.event.body,
    metadata: {
      ...metadata,
      roomTimeline: {
        roomId: target.room.id,
        roomKind: target.room.kind,
        providerRoomId: target.room.providerRoomId,
        eventId: target.event.id,
        providerEventId: target.event.providerEventId,
        sequence: target.event.sequence,
        eventType: target.event.type,
      },
      displayContent: target.event.body,
    },
    isPinned: false,
    replyToMessageId: typeof metadata.replyToMessageId === 'string' ? metadata.replyToMessageId : null,
    createdAt: target.event.createdAt,
  }
}

function buildTimelineRedactionMetadata(extra: {
  reason: string
  targetMessageId: string
  targetEventId: string
}) {
  return {
    ...extra,
    redactedAt: new Date().toISOString(),
    targetMessageIds: [extra.targetMessageId],
    targetEventIds: [extra.targetEventId],
  }
}
