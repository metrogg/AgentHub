import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { AppError, AppErrorCodes } from '../lib/error'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlink, writeFile } from 'node:fs/promises'
import { sendMessageSchema } from '@agenthub/shared'
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
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import type { AgentRunProfile, MessageRow } from '../services/agent-runner'
import { OrchestratorEngine } from '../services/orchestrator/orchestrator-engine'
import { Planner } from '../services/orchestrator/planner'
import {
  extractJsonObject,
  cleanPlanText,
  normalizeTaskOutputContract,
  normalizeTaskValidation,
  titleFromGoal,
} from '../services/orchestrator/planner'
import type { ExecutionPlan, TaskOutputContract, TaskValidation } from '../services/orchestrator/types'
import { emitRunEvent } from '../services/orchestrator/run-events'
import { initializeRunLedger } from '../services/orchestrator/run-ledger'
import { checkInputGuardrails } from '../services/orchestrator/input-guardrails'
import { selectAgentForTask } from '../services/orchestrator/agent-router'
import {
  confirmAgentDraftSchema,
  type AgentDraft,
  buildAgentDraft,
  parseAgentDraft,
  normalizeAgentDraftInput,
} from '../services/agent-draft'
import { type DemoArtifact, buildDemoArtifacts, artifactSummary } from '../services/artifact-demo'

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
        status: z.enum(['pending', 'running', 'done', 'failed']).optional(),
    })
  ),
})

const updateMessageSchema = z.object({
  content: z.string().min(1).max(10000),
})

const PLAN_AGENTS = [
  {
    key: 'architect',
    name: 'Architect',
    role: '规划',
    color: '#6366f1',
    systemPrompt: '你是架构师。优先拆解目标、定义边界、给出里程碑与依赖关系。',
  },
  {
    key: 'coder',
    name: 'Coder',
    role: '实现',
    color: '#10b981',
    systemPrompt: '你是实现者。负责代码实现、组件接入和小步验证。先理解上下文,再小步迭代。',
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    role: '审查',
    color: '#ef4444',
    systemPrompt: '你是审查者。检查风险、交互漏洞和缺失的测试。直接、克制、不绕弯。',
  },
] as const

type PlanAgent = {
  key: string
  name: string
  role: string
  roleType?: 'clarifier' | 'architect' | 'researcher' | 'coder' | 'reviewer' | 'integrator' | 'custom'
  color: string
  systemPrompt: string
  description?: string
  roleProfile?: Record<string, unknown> | null
  modelId?: string | null
  runtimeType?: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

type PlanTask = {
  id: string
  phaseId?: string
  title: string
  description: string
  agentKey: string
  status?: 'pending' | 'running' | 'done' | 'failed'
  taskType?: 'read' | 'research' | 'design' | 'code' | 'test' | 'review' | 'synthesize'
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
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
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
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    await db.delete(messages).where(eq(messages.sessionId, sessionId))
    return c.json({ deleted: true })
  })
  .post('/:sessionId/cancel', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const { cancelAgentReply } = await import('../services/agent-runner')
    return c.json({ cancelled: cancelAgentReply(sessionId) })
  })
  .patch('/:sessionId/:messageId', zValidator('json', updateMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!message || message.sessionId !== sessionId || message.senderType !== 'user' || message.senderId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    }

    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
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
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!message || message.sessionId !== sessionId) throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    const [updated] = await db.update(messages).set({ isPinned: true }).where(eq(messages.id, messageId)).returning()
    if (!updated) throw AppError.fromCode(AppErrorCodes.MESSAGE_PIN_FAILED, '消息置顶失败')
    return c.json(updated)
  })
  .patch('/:sessionId/:messageId/unpin', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!message || message.sessionId !== sessionId) throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, '消息不存在')
    const [updated] = await db.update(messages).set({ isPinned: false }).where(eq(messages.id, messageId)).returning()
    if (!updated) throw AppError.fromCode(AppErrorCodes.MESSAGE_PIN_FAILED, '消息取消置顶失败')
    return c.json(updated)
  })
  .delete('/:sessionId/:messageId', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const rollback = c.req.query('rollback') !== 'false'
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

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
    const rollbackResult = rollback ? await rollbackCodeAgentChanges(session, affected) : { reverted: 0, failed: 0 }
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
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    const messageIndex = list.findIndex((message) => message.id === messageId)
    const message = messageIndex >= 0 ? list[messageIndex] : null
    if (!message || message.senderType !== 'agent') throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'Agent 消息不存在')
    const previousUser = [...list.slice(0, messageIndex)].reverse().find((item) => item.senderType === 'user')
    if (!previousUser) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '没有可重新生成的用户消息')

    await db.delete(messages).where(eq(messages.id, message.id))
    const { cancelAgentReply } = await import('../services/agent-runner')
    cancelAgentReply(sessionId)
    if (session.type === 'group' && session.workspaceId) {
      runGroupReplies(session.workspaceId, sessionId, previousUser, previousUser.content).catch((err: any) => logger.error({ err: err?.message, sessionId }, 'runGroupReplies failed on regenerate'))
    } else {
      const profile = await profileForDirectSession(session)
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(sessionId, previousUser, profile).catch((err: any) => logger.error({ err: err?.message, sessionId }, 'runAgentReply failed on regenerate'))
      })
    }
    return c.json({ removedMessageId: message.id })
  })
  .post('/:sessionId', zValidator('json', sendMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    const { content, type, metadata } = c.req.valid('json')
    const [msg] = await db
      .insert(messages)
      .values({ sessionId, senderId: user.sub, senderType: 'user', type, content, metadata, replyToMessageId: metadata?.replyToMessageId as string | undefined })
      .returning()
    // Trigger agent reply asynchronously (do not await to keep response fast).
    if (msg && !metadata?.skipAgentReply) {
      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
      if (session?.type === 'group' && session.workspaceId) {
        await ensureWorkspaceAgentChildSessions(session.workspaceId, user.sub)
        runGroupReplies(session.workspaceId, sessionId, msg, content).catch((err: any) => logger.error({ err: err?.message, sessionId }, 'runGroupReplies failed on new message'))
      } else {
        const profile = session ? await profileForDirectSession(session) : undefined
        import('../services/agent-runner').then(({ runAgentReply }) => {
          runAgentReply(sessionId, msg, profile).catch((err: any) => logger.error({ err: err?.message, sessionId }, 'runAgentReply failed on new message'))
        })
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
    const plan = await buildDynamicOrchestratorPlan(content, agentList, session.workspaceId)
    const [card] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'orchestrator',
        senderType: 'agent',
        type: 'task_card',
        content: plan.summary,
        metadata: { plan: { ...plan, messageId: '' } },
      })
      .returning()
    if (!card) throw AppError.fromCode(AppErrorCodes.ORCHESTRATOR_PLAN_FAILED, '编排计划卡片创建失败')
    const planWithId = { ...plan, messageId: card.id }
    await db
      .update(messages)
      .set({ metadata: { plan: planWithId } })
      .where(eq(messages.id, card.id))
    return c.json({ ...card, metadata: { plan: planWithId } })
  })
  .post('/:sessionId/artifact-demo', zValidator('json', artifactDemoSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    }

    const artifacts = buildDemoArtifacts(content)
    const [card] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'artifact-agent',
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
    if (!session || session.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    if (session.type !== 'group' || !session.workspaceId) {
      const [prompt] = await db
        .insert(messages)
        .values({
          sessionId,
          senderId: 'agent-builder',
          senderType: 'agent',
          type: 'text',
          content: '请先打开或创建一个 Agent Group，再通过聊天创建 Agent。这样新 Agent 才能加入明确的 workspace 和Agent 联系人列表。',
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
        senderId: 'agent-builder',
        senderType: 'agent',
        type: 'task_card',
        content: `已生成 ${draft.name} Agent 草案。确认后会加入当前 Agent Group。`,
        metadata: { agentDraft: draft, agentDraftStatus: 'draft' },
      })
      .returning()
    if (!card) throw AppError.fromCode(AppErrorCodes.INTERNAL_ERROR, 'Agent 草案创建失败')
    return c.json(card)
  })
  .post('/:sessionId/agent-draft/:messageId/confirm', zValidator('json', confirmAgentDraftSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const { draft: draftOverride } = c.req.valid('json')

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub || session.type !== 'group' || !session.workspaceId) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, 'Agent 群组会话不存在')
    }
    const [card] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!card || card.sessionId !== sessionId) throw AppError.fromCode(AppErrorCodes.MESSAGE_NOT_FOUND, 'Agent 草案不存在')

    const cardMetadata = card.metadata as { agentDraftStatus?: unknown; createdAgentId?: unknown } | null
    if (card.type !== 'task_card') throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '消息不是 Agent 草案')
    if (cardMetadata?.agentDraftStatus === 'confirmed') {
      if (typeof cardMetadata.createdAgentId !== 'string') {
        throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Agent 草案已确认但缺少创建的 Agent ID')
      }
      const [existingAgent] = await db
        .select()
        .from(workspaceAgents)
        .where(and(eq(workspaceAgents.id, cardMetadata.createdAgentId), eq(workspaceAgents.workspaceId, session.workspaceId)))
        .limit(1)
      if (!existingAgent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, '已确认的 Agent 草案指向不存在的 Agent')
      return c.json({ agent: existingAgent, message: card })
    }
    if (cardMetadata?.agentDraftStatus !== 'draft') {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '消息不是可编辑的 Agent 草案')
    }

    const metadataDraft = parseAgentDraft(card.metadata)
    if (!metadataDraft) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'Agent 草案元数据无效')
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
    await db.update(workspaces).set({ updatedAt: new Date() }).where(eq(workspaces.id, session.workspaceId))
    const [updatedCard] = await db
      .update(messages)
      .set({
        content: `${agent.name} 已加入当前 Agent Group。`,
        metadata: { ...(card.metadata ?? {}), agentDraft: draft, agentDraftStatus: 'confirmed', createdAgentId: agent.id },
      })
      .where(eq(messages.id, messageId))
      .returning()

    return c.json({ agent, message: updatedCard ?? card })
  })
  .patch('/:sessionId/orchestrator-plan/:messageId', zValidator('json', updateOrchestratorPlanSchema), async (c) => {
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
          agentKey: patch.agentKey && agentKeys.has(patch.agentKey) ? (patch.agentKey as PlanTask['agentKey']) : task.agentKey,
          status: patch.status ?? task.status,
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
  })
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
      return c.json({
        ok: false,
        blocked: true,
        riskLevel: guardrails.riskLevel,
        violations: guardrails.violations,
        message: `请求被安全策略拦截：${guardrails.violations.join('；')}`,
      }, 400)
    }

    const [sourceSession] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)

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
      if (!workspace) throw AppError.fromCode(AppErrorCodes.WORKSPACE_CREATE_FAILED, '工作区创建失败')
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
            codeAgentType: agent.codeAgentType ?? null,
            capabilityTags: agent.capabilityTags ?? [],
            toolPermissions: agent.toolPermissions ?? [],
            sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
            orderIdx: index,
          }))
        )
        .returning()

      const groupSession = await createWorkspaceGroupSession(workspace.id, workspace.name, user.sub, createdAgents)
      groupSessionId = groupSession.id
      agentsByKey = new Map<string, typeof workspaceAgents.$inferSelect>()
      for (let i = 0; i < parsed.agents.length; i++) {
        const agent = createdAgents[i]
        if (agent) agentsByKey.set(parsed.agents[i]!.key, agent)
      }
    }
    const childSessions = new Map<string, { sessionId: string; workspaceId: string; projectPath?: string | null }>()
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
      const existingTask = await db.select({ id: workspaceTasks.id }).from(workspaceTasks).where(eq(workspaceTasks.id, taskId)).limit(1)
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
          title: agent ? `${parsed.title} / ${agent.name} / ${task.title.slice(0, 24)}` : `${parsed.title} / ${task.title.slice(0, 24)}`,
          type: 'direct',
          ownerId: user.sub,
          workspaceId,
          workspaceAgentId: agent?.id ?? null,
          metadata: { orchestratorRunId: runId, orchestratorTaskId: task.id },
        })
        .returning()
      if (!childSession) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '任务会话创建失败')

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

    const engine = new OrchestratorEngine()
    engine.startRun({ runId, groupSessionId, workspaceId, plan: executionPlan, childSessions }).catch(async (err: any) => {
      logger.error({ err: err?.message, runId }, 'Orchestrator engine start failed')
      await db.update(orchestratorRuns).set({ status: 'failed' }).where(eq(orchestratorRuns.id, runId))
      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        type: 'run.failed',
        severity: 'error',
        payload: { error: err?.message || '编排器引擎启动失败' },
      })
      const failedPlan = { ...parsed, tasks: parsed.tasks.map((t) => ({ ...t, status: 'failed' as const })) }
      await db
        .update(messages)
        .set({
          metadata: {
            ...(card.metadata ?? {}),
            plan: { ...failedPlan, dispatchResult: { runId, workspaceId, groupSessionId, tasks: taskResults } },
          },
        })
        .where(eq(messages.id, messageId))
    })

    const result: OrchestratorDispatchResult = { runId, workspaceId, groupSessionId, tasks: taskResults }
    await updatePlanCardDispatchResult(messageId, card.metadata, parsed, result)
    return c.json(result)
  })



function toExecutionAgent(agent: PlanAgent): import('../services/orchestrator/types').ExecutionAgent {
  return {
    id: agent.key,
    key: agent.key,
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType,
    description: agent.description,
    color: agent.color,
    systemPrompt: agent.systemPrompt,
    roleProfile: agent.roleProfile,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType ?? 'llm',
    codeAgentType: agent.codeAgentType ?? undefined,
    capabilityTags: agent.capabilityTags ?? [],
    toolPermissions: agent.toolPermissions ?? [],
    sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
  }
}

function executionPlanToOrchestratorPlan(
  plan: import('../services/orchestrator/types').ExecutionPlan,
  planAgents: PlanAgent[],
): OrchestratorPlan {
  return {
    kind: 'orchestrator_plan',
    title: plan.title,
    goal: plan.goal,
    summary: `我已根据当前 Agent 团队把「${plan.title}」拆成 ${plan.tasks.length} 个子任务。确认后会创建或复用 Agent Group 并分发执行。`,
    agents: planAgents,
    phases: plan.phases?.map((p) => ({
      id: p.id,
      title: p.title,
      purpose: p.purpose,
      taskIds: p.taskIds,
    })),
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      phaseId: t.phaseId,
      title: t.title,
      description: t.description,
      agentKey: t.agentId,
      taskType: t.taskType,
      status: 'pending' as const,
      dependencies: t.dependencies,
      parallelGroup: t.parallelGroup,
      maxRetries: t.maxRetries,
      fallbackAgentId: t.fallbackAgentId,
      outputContract: t.outputContract,
      validation: t.validation,
      agentSelection: t.agentSelection,
    })),
  }
}

async function buildDynamicOrchestratorPlan(
  content: string,
  agents: Array<typeof workspaceAgents.$inferSelect>,
  workspaceId?: string | null
): Promise<OrchestratorPlan> {
  const goal = normalizeOrchestratorGoal(content)
  const planningAgents = agents.length ? agents.map(planAgentFromWorkspaceAgent) : fallbackPlanAgents()

  let workspacePath: string | null = null
  if (workspaceId) {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    workspacePath = ws?.projectPath ?? null
  }

  const planner = new Planner()
  const executionPlan = await planner.createPlan({
    goal,
    agents: planningAgents.map(toExecutionAgent),
    workspacePath,
    useSpecFirst: false,
  })

  const plan = executionPlanToOrchestratorPlan(executionPlan, planningAgents)
  const relations = workspaceId ? await loadWorkspaceAgentRelationsForPlanning(workspaceId) : []
  return applyAgentSelections(plan, relations)
}

function normalizeOrchestratorGoal(content: string) {
  return (
    content
      .replace(/@orchestrator/gi, '')
      .replace(/@协调器/g, '')
      .trim() || '完成一个多 Agent 协作任务'
  )
}

function fallbackPlanAgents(): PlanAgent[] {
  return PLAN_AGENTS.map((agent) => ({
    ...agent,
    runtimeType: 'llm' as const,
    roleType: agent.key === 'architect' ? 'architect' : agent.key === 'coder' ? 'coder' : 'reviewer',
    capabilityTags: [],
    toolPermissions: ['chat'],
    sandboxPolicy: 'workspace-write' as const,
  }))
}

function planAgentFromWorkspaceAgent(agent: typeof workspaceAgents.$inferSelect): PlanAgent {
  return {
    key: agent.id,
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType,
    description: agent.description,
    roleProfile: agent.roleProfile,
    color: agent.color,
    systemPrompt: agent.systemPrompt,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType ?? undefined,
    capabilityTags: agent.capabilityTags,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: agent.sandboxPolicy,
  }
}

async function loadWorkspaceAgentRelationsForPlanning(workspaceId: string) {
  return db
    .select({
      sourceAgentId: workspaceAgentRelations.sourceAgentId,
      targetAgentId: workspaceAgentRelations.targetAgentId,
      relationType: workspaceAgentRelations.relationType,
      note: workspaceAgentRelations.note,
    })
    .from(workspaceAgentRelations)
    .where(eq(workspaceAgentRelations.workspaceId, workspaceId))
}

function applyAgentSelections(plan: OrchestratorPlan, relations: Awaited<ReturnType<typeof loadWorkspaceAgentRelationsForPlanning>>): OrchestratorPlan {
  const executionAgents = plan.agents.map((agent) => ({
    id: agent.key,
    key: agent.key,
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType,
    description: agent.description,
    color: agent.color,
    systemPrompt: agent.systemPrompt,
    roleProfile: agent.roleProfile,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType ?? 'llm',
    codeAgentType: agent.codeAgentType ?? undefined,
    capabilityTags: agent.capabilityTags ?? [],
    toolPermissions: agent.toolPermissions ?? [],
    sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
  }))
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      const selection = selectAgentForTask({
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          agentId: task.agentKey,
          taskType: task.taskType,
          dependencies: task.dependencies ?? [],
          maxRetries: task.maxRetries ?? 1,
        },
        agents: executionAgents,
        relations,
      })
      return {
        ...task,
        agentKey: selection.selectedAgentKey || task.agentKey,
        agentSelection: selection,
      }
    }),
  }
}


function parsePlan(metadata: unknown): OrchestratorPlan | null {
  const plan = (metadata as { plan?: unknown } | null)?.plan
  if (!plan || typeof plan !== 'object') return null
  const candidate = plan as OrchestratorPlan
  if (candidate.kind !== 'orchestrator_plan' || !Array.isArray(candidate.tasks)) return null
  return candidate
}

function buildDispatchPrompt(
  plan: OrchestratorPlan,
  task: PlanTask,
  agent?: typeof workspaceAgents.$inferSelect
) {
  return [
    agent ? `你是 ${agent.name}(${agent.role})。${agent.systemPrompt}` : '你是 AgentHub 协作 Agent。',
    `\n协作目标: ${plan.goal}`,
    `\n当前子任务: ${task.title}`,
    `\n任务说明: ${task.description}`,
    '\n请先给出简短工作计划，再产出结果。遇到需要其他 Agent 配合的内容，请在结尾用「需协作:」列出。',
  ].join('')
}

const ORCHESTRATOR_PROFILE: AgentRunProfile = {
  id: 'orchestrator',
  name: 'Orchestrator',
  role: 'Coordinator',
  color: '#111827',
  systemPrompt:
    'You are the AgentHub coordinator. Read the group chat context, clarify the goal, split work between agents, and keep the team aligned. Reply with concise next actions.',
  runtimeType: 'llm',
  capabilityTags: [],
  toolPermissions: [],
  sandboxPolicy: 'workspace-write',
  contextPolicy: 'workspace-aware',
  approvalRequired: true,
}

function withWorkspacePath(profile: AgentRunProfile, projectPath?: string | null): AgentRunProfile {
  const trimmed = projectPath?.trim()
  return trimmed ? { ...profile, projectPath: trimmed } : profile
}

function toAgentProfile(agent: typeof workspaceAgents.$inferSelect, projectPath?: string | null): AgentRunProfile {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    color: agent.color,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType ?? undefined,
    capabilityTags: agent.capabilityTags,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: agent.sandboxPolicy,
    contextPolicy: agent.contextPolicy,
    approvalRequired: agent.approvalRequired,
    systemPrompt: agent.systemPrompt,
    projectPath: projectPath?.trim() || null,
  }
}

async function profileForDirectSession(session: typeof sessions.$inferSelect) {
  if (!session.workspaceAgentId) return undefined
  const [agent] = await db.select().from(workspaceAgents).where(eq(workspaceAgents.id, session.workspaceAgentId)).limit(1)
  if (!agent || (session.workspaceId && agent.workspaceId !== session.workspaceId)) return undefined

  if (!session.workspaceId) return toAgentProfile(agent)
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1)
  return toAgentProfile(agent, workspace?.projectPath)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasMention(content: string, aliases: string[]) {
  const lower = content.toLowerCase()
  return aliases.some((alias) => {
    const token = alias.trim()
    if (!token) return false
    const normalized = token.toLowerCase()
    // 修复 Bug 14: 移除 \b 单词边界，因为中文没有单词边界概念
    return lower.includes(`@${normalized}`) || new RegExp(`@\\s*${escapeRegExp(normalized)}(?:\\s|$|[，。！？.,!?;])`, 'i').test(content)
  })
}

function aliasesForAgent(agent: typeof workspaceAgents.$inferSelect) {
  const role = agent.role.toLowerCase()
  const name = agent.name.toLowerCase()
  const aliases = new Set([agent.name, name, agent.role, role, ...agent.capabilityTags])
  if (name.includes('coder') || role.includes('code') || role.includes('实现')) {
    aliases.add('coder')
    aliases.add('code')
    aliases.add('代码')
  }
  if (name.includes('architect') || role.includes('arch') || role.includes('规划')) {
    aliases.add('architect')
    aliases.add('架构')
    aliases.add('规划')
  }
  if (name.includes('review') || role.includes('review') || role.includes('审查')) {
    aliases.add('reviewer')
    aliases.add('review')
    aliases.add('审查')
  }
  if (name.includes('research') || role.includes('research') || role.includes('研究')) {
    aliases.add('researcher')
    aliases.add('research')
    aliases.add('研究')
  }
  return [...aliases]
}

async function runGroupReplies(workspaceId: string, sessionId: string, msg: MessageRow, content: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  const projectPath = workspace?.projectPath ?? null
  const agentList = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))

  const profiles: AgentRunProfile[] = []
  const seen = new Set<string>()
  const pushProfile = (profile: AgentRunProfile) => {
    if (seen.has(profile.id)) return
    seen.add(profile.id)
    profiles.push(profile)
  }

  if (hasMention(content, ['orchestrator', 'coordinator', 'agenthub', '协调器', '调度'])) {
    pushProfile(withWorkspacePath(ORCHESTRATOR_PROFILE, projectPath))
  }

  for (const agent of agentList) {
    if (hasMention(content, aliasesForAgent(agent))) {
      pushProfile(toAgentProfile(agent, projectPath))
    }
  }

  if (!profiles.length) {
    const autoAgents = agentList.filter((agent) => agent.autoInvoke)
    if (autoAgents.length === 1) {
      pushProfile(toAgentProfile(autoAgents[0]!, projectPath))
    } else {
      pushProfile(withWorkspacePath(ORCHESTRATOR_PROFILE, projectPath))
    }
  }

  const { runAgentReply } = await import('../services/agent-runner')
  await Promise.allSettled(profiles.map((profile) => runAgentReply(sessionId, msg, profile)))
}

async function createWorkspaceGroupSession(
  workspaceId: string,
  workspaceName: string,
  ownerId: string,
  agents: Array<typeof workspaceAgents.$inferSelect>
) {
  const [session] = await db
    .insert(sessions)
    .values({
      title: `${workspaceName} / Agent Group`,
      type: 'group',
      ownerId,
      workspaceId,
    })
    .returning()
  if (!session) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '群组会话创建失败')

  await db.insert(sessionMembers).values([
    { sessionId: session.id, memberType: 'user', memberId: ownerId },
    { sessionId: session.id, memberType: 'agent', memberId: 'orchestrator' },
    ...agents.map((agent) => ({ sessionId: session.id, memberType: 'agent' as const, memberId: agent.id })),
  ])

  // Note: child sessions are lazily created when tasks are dispatched
  // (see dispatchPlanToExistingGroup and orchestrator-engine).
  // Pre-creating them here leads to orphan sessions when the orchestrator
  // plans do not include every workspace agent.

  return session
}

async function ensureAgentChildSession(
  workspaceId: string,
  workspaceName: string,
  ownerId: string,
  agent: typeof workspaceAgents.$inferSelect | null,
  taskTitle?: string
) {
  if (agent) {
    const [existing] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.ownerId, ownerId),
          eq(sessions.type, 'direct'),
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.workspaceAgentId, agent.id)
        )
      )
      .orderBy(desc(sessions.updatedAt))
      .limit(1)
    if (existing) return existing
  }

  const [created] = await db
    .insert(sessions)
    .values({
      title: agent ? `${workspaceName} / ${agent.name}` : `${workspaceName} / ${taskTitle?.slice(0, 24) || 'Agent'}`,
      type: 'direct',
      ownerId,
      workspaceId,
      workspaceAgentId: agent?.id ?? null,
    })
    .returning()
  if (!created) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, 'Agent 子会话创建失败')
  return created
}

async function ensureWorkspaceAgentChildSessions(workspaceId: string, ownerId: string) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  if (!workspace || workspace.ownerId !== ownerId) return
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  for (const agent of agents) {
    await ensureAgentChildSession(workspace.id, workspace.name, ownerId, agent)
  }
}

async function dispatchPlanToExistingGroup(
  session: typeof sessions.$inferSelect,
  ownerId: string,
  plan: OrchestratorPlan
): Promise<{ workspaceId: string; groupSessionId: string; agentsByKey: Map<string, typeof workspaceAgents.$inferSelect> }> {
  if (!session.workspaceId) throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '会话未关联工作区')

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1)
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
    const matched = plan.agents.find((item) => {
      const key = item.key.toLowerCase()
      return name === item.name.toLowerCase() || name.includes(key) || role.includes(key)
    })
    if (matched) agentsByKey.set(matched.key, agent)
  }

  const createdAgents: Array<typeof workspaceAgents.$inferSelect> = []
  for (const [index, planAgent] of plan.agents.entries()) {
    if (agentsByKey.has(planAgent.key)) continue
    const [created] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace.id,
        name: planAgent.name,
        role: planAgent.role,
        roleType: planAgent.roleType ?? 'custom',
        description: planAgent.description ?? '',
        systemPrompt: planAgent.systemPrompt,
        roleProfile: planAgent.roleProfile ?? null,
        color: planAgent.color,
        modelId: planAgent.modelId ?? null,
        runtimeType: planAgent.runtimeType ?? 'llm',
        codeAgentType: planAgent.codeAgentType ?? null,
        capabilityTags: planAgent.capabilityTags ?? [],
        toolPermissions: planAgent.toolPermissions ?? [],
        sandboxPolicy: planAgent.sandboxPolicy ?? 'workspace-write',
        orderIdx: existingAgents.length + index,
      })
      .returning()
    if (created) {
      agentsByKey.set(planAgent.key, created)
      createdAgents.push(created)
    }
  }

  if (createdAgents.length) {
    await db.insert(sessionMembers).values(
      createdAgents.map((agent) => ({
        sessionId: session.id,
        memberType: 'agent' as const,
        memberId: agent.id,
      }))
    )
    // 修复 Bug 10: 为新创建的 agent 创建 child sessions
    for (const agent of createdAgents) {
      await ensureAgentChildSession(workspace.id, workspace.name, ownerId, agent)
    }
  }

  return { workspaceId: workspace.id, groupSessionId: session.id, agentsByKey }
}

async function updatePlanCardDispatchResult(
  messageId: string,
  previousMetadata: Record<string, unknown> | null,
  plan: OrchestratorPlan,
  dispatchResult: OrchestratorDispatchResult
) {
  const metadata = previousMetadata && typeof previousMetadata === 'object' ? previousMetadata : {}
  const runningPlan: OrchestratorPlan = {
    ...plan,
    dispatchResult,
    tasks: plan.tasks.map((task) => ({ ...task, status: 'pending' })),
  }
  await db
    .update(messages)
    .set({ content: runningPlan.summary, metadata: { ...metadata, plan: runningPlan, dispatchResult } })
    .where(eq(messages.id, messageId))
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
  affected: Array<typeof messages.$inferSelect>
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
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1)
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
  return await Promise.race([proc.exited, new Promise<number>((resolve) => setTimeout(() => resolve(124), 5000))])
}
