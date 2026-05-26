import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlink, writeFile } from 'node:fs/promises'
import { sendMessageSchema } from '@agenthub/shared'
import {
  db,
  messages,
  sessions,
  sessionMembers,
  workspaceAgents,
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
import { streamReply } from '../services/llm'
import { OrchestratorEngine } from '../services/orchestrator/orchestrator-engine'
import type { ExecutionPlan } from '../services/orchestrator/types'
import { harnessManager } from '../services/harness'

const orchestratorPlanSchema = z.object({
  content: z.string().min(1).max(10000),
})

const artifactDemoSchema = z.object({
  content: z.string().min(1).max(10000),
})

const agentDraftSchema = z.object({
  content: z.string().min(1).max(10000),
})

const confirmAgentDraftSchema = z.object({
  draft: z
    .object({
      name: z.string().min(1).max(60),
      role: z.string().min(1).max(60),
      description: z.string().max(500).default(''),
      avatar: z.string().max(500).nullable().optional(),
      systemPrompt: z.string().max(4000).default(''),
      color: z.string().max(20).default('#111827'),
      modelId: z.string().max(120).nullable().optional(),
      runtimeType: z.enum(['llm', 'code-agent', 'mcp', 'a2a']).default('llm'),
      codeAgentType: z.enum(['codex', 'claude-code', 'opencode', 'gemini']).nullable().optional(),
      capabilityTags: z.array(z.string().max(40)).max(12).default([]),
      toolPermissions: z.array(z.string().max(80)).max(30).default(['chat']),
      sandboxPolicy: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
      contextPolicy: z.enum(['recent-only', 'pinned-recent', 'workspace-aware']).default('workspace-aware'),
      autoInvoke: z.boolean().default(true),
      approvalRequired: z.boolean().default(true),
    })
    .optional(),
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
  color: string
  systemPrompt: string
  description?: string
  modelId?: string | null
  runtimeType?: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

type PlanTask = {
  id: string
  title: string
  description: string
  agentKey: string
  status?: 'pending' | 'running' | 'done' | 'failed'
  dependencies?: string[]
  parallelGroup?: string
  maxRetries?: number
  fallbackAgentId?: string
}

type OrchestratorDispatchResult = {
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
  tasks: PlanTask[]
  dispatchResult?: OrchestratorDispatchResult
}

type AgentDraft = NonNullable<z.infer<typeof confirmAgentDraftSchema>['draft']>

type DemoArtifact =
  | {
      id: string
      type: 'preview'
      title: string
      description: string
      url: string
      previewKind: 'dev-server' | 'static-html' | 'iframe'
      status: 'ready' | 'building' | 'failed'
    }
  | {
      id: string
      type: 'diff'
      title: string
      description: string
      filePath: string
      language: string
      diff: string
    }
  | {
      id: string
      type: 'file'
      title: string
      description: string
      path: string
      mimeType: string
      size: number
      url: string
    }
  | {
      id: string
      type: 'deploy'
      title: string
      description: string
      provider: string
      status: 'pending' | 'running' | 'ready' | 'failed'
      url: string
      logs: string[]
    }
  | {
      id: string
      type: 'workflow'
      title: string
      description: string
      nodes: Array<{
        id: string
        label: string
        type: 'agent' | 'tool' | 'input' | 'output'
        agentKey?: string
        agentName?: string
        agentColor?: string
      }>
      edges: Array<{ from: string; to: string; label?: string }>
    }

type DispatchMonitor = {
  dispatchId: string
  groupSessionId?: string
  taskIds: string[]
}


export const messageRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    return c.json({ items: list })
  })
  .post('/:sessionId/cancel', async (c) => {
    const sessionId = c.req.param('sessionId')
    const { cancelAgentReply } = await import('../services/agent-runner')
    return c.json({ cancelled: cancelAgentReply(sessionId) })
  })
  .patch('/:sessionId/:messageId', zValidator('json', updateMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw new HTTPException(404, { message: 'Session not found' })

    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!message || message.sessionId !== sessionId || message.senderType !== 'user' || message.senderId !== user.sub) {
      throw new HTTPException(404, { message: 'Message not found' })
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
    if (!updated) throw new HTTPException(500, { message: 'Failed to update message' })
    return c.json(updated)
  })
  .patch('/:sessionId/:messageId/pin', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw new HTTPException(404, { message: 'Session not found' })
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!message || message.sessionId !== sessionId) throw new HTTPException(404, { message: 'Message not found' })
    const [updated] = await db.update(messages).set({ isPinned: true }).where(eq(messages.id, messageId)).returning()
    if (!updated) throw new HTTPException(500, { message: 'Failed to pin message' })
    return c.json(updated)
  })
  .patch('/:sessionId/:messageId/unpin', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw new HTTPException(404, { message: 'Session not found' })
    const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!message || message.sessionId !== sessionId) throw new HTTPException(404, { message: 'Message not found' })
    const [updated] = await db.update(messages).set({ isPinned: false }).where(eq(messages.id, messageId)).returning()
    if (!updated) throw new HTTPException(500, { message: 'Failed to unpin message' })
    return c.json(updated)
  })
  .delete('/:sessionId/:messageId', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const rollback = c.req.query('rollback') !== 'false'
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw new HTTPException(404, { message: 'Session not found' })

    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    const targetIndex = list.findIndex((message) => message.id === messageId)
    const target = targetIndex >= 0 ? list[targetIndex] : null
    if (!target || target.senderType !== 'user' || target.senderId !== user.sub) {
      throw new HTTPException(404, { message: 'Message not found' })
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
    if (!session || session.ownerId !== user.sub) throw new HTTPException(404, { message: 'Session not found' })

    const list = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
    const messageIndex = list.findIndex((message) => message.id === messageId)
    const message = messageIndex >= 0 ? list[messageIndex] : null
    if (!message || message.senderType !== 'agent') throw new HTTPException(404, { message: 'Agent message not found' })
    const previousUser = [...list.slice(0, messageIndex)].reverse().find((item) => item.senderType === 'user')
    if (!previousUser) throw new HTTPException(400, { message: 'No user message to regenerate from' })

    await db.delete(messages).where(eq(messages.id, message.id))
    const { cancelAgentReply } = await import('../services/agent-runner')
    cancelAgentReply(sessionId)
    if (session.type === 'group' && session.workspaceId) {
      runGroupReplies(session.workspaceId, sessionId, previousUser, previousUser.content).catch(() => {})
    } else {
      const profile = await profileForDirectSession(session)
      import('../services/agent-runner').then(({ runAgentReply }) => {
        runAgentReply(sessionId, previousUser, profile).catch(() => {})
      })
    }
    return c.json({ removedMessageId: message.id })
  })
  .post('/:sessionId', zValidator('json', sendMessageSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
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
        runGroupReplies(session.workspaceId, sessionId, msg, content).catch(() => {})
      } else {
        const profile = session ? await profileForDirectSession(session) : undefined
        import('../services/agent-runner').then(({ runAgentReply }) => {
          runAgentReply(sessionId, msg, profile).catch(() => {})
        })
      }
    }
    return c.json(msg)
  })
  .post('/:sessionId/orchestrator-plan', zValidator('json', orchestratorPlanSchema), async (c) => {
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session) throw new HTTPException(404, { message: 'Session not found' })
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
    if (!card) throw new HTTPException(500, { message: 'Failed to create plan card' })
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
      throw new HTTPException(404, { message: 'Session not found' })
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
    if (!card) throw new HTTPException(500, { message: 'Failed to create artifact card' })
    return c.json(card)
  })
  .post('/:sessionId/agent-draft', zValidator('json', agentDraftSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const { content } = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub) throw new HTTPException(404, { message: 'Session not found' })
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
      if (!prompt) throw new HTTPException(500, { message: 'Failed to create agent group prompt' })
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
    if (!card) throw new HTTPException(500, { message: 'Failed to create agent draft' })
    return c.json(card)
  })
  .post('/:sessionId/agent-draft/:messageId/confirm', zValidator('json', confirmAgentDraftSchema), async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')
    const { draft: draftOverride } = c.req.valid('json')

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
    if (!session || session.ownerId !== user.sub || session.type !== 'group' || !session.workspaceId) {
      throw new HTTPException(404, { message: 'Agent Group session not found' })
    }
    const [card] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!card || card.sessionId !== sessionId) throw new HTTPException(404, { message: 'Agent draft not found' })

    const cardMetadata = card.metadata as { agentDraftStatus?: unknown; createdAgentId?: unknown } | null
    if (card.type !== 'task_card') throw new HTTPException(400, { message: 'Message is not an agent draft' })
    if (cardMetadata?.agentDraftStatus === 'confirmed') {
      if (typeof cardMetadata.createdAgentId !== 'string') {
        throw new HTTPException(409, { message: 'Agent draft is already confirmed but missing created agent id' })
      }
      const [existingAgent] = await db
        .select()
        .from(workspaceAgents)
        .where(and(eq(workspaceAgents.id, cardMetadata.createdAgentId), eq(workspaceAgents.workspaceId, session.workspaceId)))
        .limit(1)
      if (!existingAgent) throw new HTTPException(409, { message: 'Confirmed agent draft points to a missing agent' })
      return c.json({ agent: existingAgent, message: card })
    }
    if (cardMetadata?.agentDraftStatus !== 'draft') {
      throw new HTTPException(400, { message: 'Message is not an editable agent draft' })
    }

    const metadataDraft = parseAgentDraft(card.metadata)
    if (!metadataDraft) throw new HTTPException(400, { message: 'Invalid agent draft metadata' })
    const draft = normalizeAgentDraftInput(draftOverride ?? metadataDraft)
    if (!draft) throw new HTTPException(400, { message: 'Invalid agent draft metadata' })

    const existing = await db
      .select({ id: workspaceAgents.id })
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, session.workspaceId))
    const [agent] = await db
      .insert(workspaceAgents)
      .values({ ...draft, workspaceId: session.workspaceId, orderIdx: existing.length })
      .returning()
    if (!agent) throw new HTTPException(500, { message: 'Failed to create Agent' })

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
      throw new HTTPException(404, { message: 'Plan card not found' })
    }

    const parsed = parsePlan(card.metadata)
    if (!parsed) throw new HTTPException(400, { message: 'Invalid plan metadata' })

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
    if (!updated) throw new HTTPException(500, { message: 'Failed to update plan card' })
    return c.json(updated)
  })
  .post('/:sessionId/orchestrator-plan/:messageId/dispatch', async (c) => {
    const user = c.get('user')
    const sessionId = c.req.param('sessionId')
    const messageId = c.req.param('messageId')

    const [card] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!card || card.sessionId !== sessionId || card.type !== 'task_card') {
      throw new HTTPException(404, { message: 'Plan card not found' })
    }

    const parsed = parsePlan(card.metadata)
    if (!parsed) throw new HTTPException(400, { message: 'Invalid plan metadata' })

    const [sourceSession] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)

    let workspaceId: string
    let groupSessionId: string
    let createdAgents: Array<typeof workspaceAgents.$inferSelect>

    let agentsByKey: Map<string, typeof workspaceAgents.$inferSelect>

    if (sourceSession?.type === 'group' && sourceSession.workspaceId && sourceSession.ownerId === user.sub) {
      // 复用已有 workspace
      const existing = await dispatchPlanToExistingGroup(sourceSession, user.sub, parsed)
      workspaceId = existing.workspaceId
      groupSessionId = existing.groupSessionId ?? sessionId
      agentsByKey = existing.agentsByKey
      createdAgents = Array.from(agentsByKey.values())
    } else {
      // 新建 workspace
      const [workspace] = await db
        .insert(workspaces)
        .values({ ownerId: user.sub, name: parsed.title, goal: parsed.goal })
        .returning()
      if (!workspace) throw new HTTPException(500, { message: 'Failed to create workspace' })
      workspaceId = workspace.id

      createdAgents = await db
        .insert(workspaceAgents)
        .values(
          parsed.agents.map((agent, index) => ({
            workspaceId: workspace.id,
            name: agent.name,
            role: agent.role,
            description: agent.description ?? '',
            systemPrompt: agent.systemPrompt,
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
    for (const [index, task] of parsed.tasks.entries()) {
      const agent = agentsByKey.get(task.agentKey)
      const [workspaceTask] = await db
        .insert(workspaceTasks)
        .values({
          id: task.id,
          workspaceId,
          agentId: agent?.id ?? null,
          title: task.title,
          description: task.description,
          status: 'pending',
          orderIdx: index,
          runId,
          dependencies: task.dependencies ?? [],
          parallelGroup: task.parallelGroup,
          maxRetries: task.maxRetries ?? 2,
        })
        .returning()

      const childSession = await ensureAgentChildSession(workspaceId, parsed.title, user.sub, agent ?? null, task.title)
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

    // 构建 ExecutionPlan 并启动 OrchestratorEngine
    const executionPlan: ExecutionPlan = {
      runId,
      title: parsed.title,
      goal: parsed.goal,
      agents: parsed.agents.map((a) => {
        const dbAgent = agentsByKey.get(a.key)
        return {
          id: dbAgent?.id ?? a.key,
          key: a.key,
          name: a.name,
          role: a.role,
          description: a.description,
          color: a.color,
          systemPrompt: a.systemPrompt,
          modelId: a.modelId,
          runtimeType: a.runtimeType ?? 'llm',
          codeAgentType: a.codeAgentType ?? undefined,
          capabilityTags: a.capabilityTags ?? [],
          toolPermissions: a.toolPermissions ?? [],
          sandboxPolicy: a.sandboxPolicy ?? 'workspace-write',
        }
      }),
      tasks: parsed.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        agentId: agentsByKey.get(t.agentKey)?.id ?? t.agentKey,
        dependencies: t.dependencies ?? [],
        parallelGroup: t.parallelGroup,
        maxRetries: t.maxRetries ?? 2,
        fallbackAgentId: t.fallbackAgentId,
      })),
    }

    await db.insert(orchestratorRuns).values({
      id: runId,
      workspaceId,
      groupSessionId,
      planMessageId: messageId,
      status: 'running',
      plan: executionPlan as unknown as Record<string, unknown>,
    })

    const engine = new OrchestratorEngine()
    engine.startRun({ runId, groupSessionId, workspaceId, plan: executionPlan, childSessions }).catch(() => {})

    const result: OrchestratorDispatchResult = { workspaceId, groupSessionId, tasks: taskResults }
    await updatePlanCardDispatchResult(messageId, card.metadata, parsed, result)
    return c.json(result)
  })

function buildDemoArtifacts(content: string): DemoArtifact[] {
  const lower = content.toLowerCase()
  const artifacts: DemoArtifact[] = []
  const wantsDeploy = /部署|发布|deploy|release/.test(lower)
  const wantsPreview = /预览|preview|网页|页面|web/.test(lower)
  const wantsDiff = /diff|补丁|变更|修改|应用/.test(lower)
  const wantsFile = /文件|附件|下载|打包|源码|zip|ppt|文档/.test(lower)
  const wantsWorkflow = /workflow|工作流|流程|编排|pipeline/.test(lower)

  if (wantsWorkflow) {
    artifacts.push({
      id: `workflow-${crypto.randomUUID()}`,
      type: 'workflow',
      title: 'Agent 协作 Workflow',
      description: '多 Agent 协作工作流定义，可在聊天流中可视化预览并一键执行。',
      nodes: [
        { id: 'input', label: '用户输入', type: 'input' },
        { id: 'architect', label: '架构师', type: 'agent', agentKey: 'architect', agentName: 'Architect', agentColor: '#6366f1' },
        { id: 'coder', label: '实现者', type: 'agent', agentKey: 'coder', agentName: 'Coder', agentColor: '#10b981' },
        { id: 'reviewer', label: '审查者', type: 'agent', agentKey: 'reviewer', agentName: 'Reviewer', agentColor: '#ef4444' },
        { id: 'output', label: '产出汇总', type: 'output' },
      ],
      edges: [
        { from: 'input', to: 'architect', label: '拆解' },
        { from: 'architect', to: 'coder', label: '实现' },
        { from: 'coder', to: 'reviewer', label: '审查' },
        { from: 'reviewer', to: 'output', label: '汇总' },
      ],
    })
  }

  if (wantsPreview || (!wantsDeploy && !wantsDiff && !wantsFile && !wantsWorkflow)) {
    artifacts.push({
      id: `web-${crypto.randomUUID()}`,
      type: 'preview',
      title: 'AgentHub Web Preview',
      description: '聊天流内联网页预览，可展开后接入 iframe、Sandpack 或真实预览 URL。',
      url: 'https://agenthub.local/preview/landing-page',
      previewKind: 'iframe',
      status: 'ready',
    })
  }

  if (wantsDiff) {
    artifacts.push({
      id: `diff-${crypto.randomUUID()}`,
      type: 'diff',
      title: 'UI 变更 Diff',
      description: '展示 Agent 产出的代码补丁，后续可接"一键应用 Diff"。',
      filePath: 'apps/web/src/components/chat/SessionList.tsx',
      language: 'tsx',
      diff: [
        'diff --git a/apps/web/src/components/chat/SessionList.tsx b/apps/web/src/components/chat/SessionList.tsx',
        'index 1234567..abcdefg 100644',
        '--- a/apps/web/src/components/chat/SessionList.tsx',
        '+++ b/apps/web/src/components/chat/SessionList.tsx',
        '@@ -42,7 +42,11 @@ export default function SessionList() {',
        '-  const sessionTree = useMemo(() => buildSessionTree(sessions), [sessions])',
        '+  const [query, setQuery] = useState(\”\”)',
        '+  const [showArchived, setShowArchived] = useState(false)',
        '+  const sessionTree = useMemo(',
        '+    () => filterSessionTree(buildSessionTree(sessions), query, showArchived),',
        '+    [query, sessions, showArchived]',
        '+  )',
      ].join('\n'),
    })
  }

  if (wantsDeploy) {
    artifacts.push({
      id: `deploy-${crypto.randomUUID()}`,
      type: 'deploy',
      title: '静态站点部署',
      description: '部署状态卡片先以 Demo 方式闭环，真实版本可接 Vercel、Netlify 或容器平台。',
      provider: 'static',
      status: 'ready',
      url: 'https://agenthub-preview.local/app',
      logs: ['Build queued', 'Install dependencies', 'Run production build', 'Upload static assets', 'Preview is ready'],
    })
  }

  if (wantsFile) {
    artifacts.push({
      id: `file-${crypto.randomUUID()}`,
      type: 'file',
      title: '源码打包附件',
      description: '用于展示 Agent 回复中的文件附件入口。',
      path: 'agenthub-preview-source.zip',
      mimeType: 'application/zip',
      size: 131072,
      url: '#',
    })
  }

  return artifacts.length ? artifacts : buildDemoArtifacts('预览')
}

function artifactSummary(artifacts: DemoArtifact[]) {
  const labels = artifacts.map((artifact) => {
    if (artifact.type === 'preview') return '网页预览'
    if (artifact.type === 'diff') return 'Diff 视图'
    if (artifact.type === 'deploy') return '部署状态'
    if (artifact.type === 'workflow') return 'Workflow'
    return '文件附件'
  })
  return `已生成 ${labels.join('、')} 卡片，可在聊天流中直接预览和操作。`
}

function buildAgentDraft(content: string): AgentDraft {
  const codeAgentType = inferCodeAgentType(content)
  const runtimeType = codeAgentType ? 'code-agent' : 'llm'
  const role = inferAgentRole(content)
  const name = inferAgentName(content, role, codeAgentType)
  const capabilityTags = inferCapabilityTags(content, role)
  const toolPermissions = inferToolPermissions(content)
  return {
    name,
    role,
    description: `${role} Agent，负责${capabilityTags.slice(0, 3).join('、') || '协作任务'}。`,
    avatar: null,
    systemPrompt: buildAgentSystemPrompt(role, capabilityTags),
    color: colorForRole(role),
    modelId: null,
    runtimeType,
    codeAgentType: codeAgentType ?? null,
    capabilityTags,
    toolPermissions,
    sandboxPolicy: toolPermissions.includes('workspace:write') ? 'workspace-write' : 'read-only',
    contextPolicy: 'workspace-aware',
    autoInvoke: true,
    approvalRequired: true,
  }
}

function inferCodeAgentType(content: string): AgentDraft['codeAgentType'] {
  const lower = content.toLowerCase()
  if (lower.includes('claude')) return 'claude-code'
  if (lower.includes('opencode') || lower.includes('open code')) return 'opencode'
  if (lower.includes('gemini')) return 'gemini'
  if (lower.includes('codex')) return 'codex'
  return null
}

function inferAgentRole(content: string) {
  const lower = content.toLowerCase()
  if (/review|审查|测试|质量/.test(lower)) return '审查'
  if (/research|研究|调研/.test(lower)) return '研究'
  if (/deploy|部署|发布|运维/.test(lower)) return '部署'
  if (/front|react|vue|页面|前端|ui/.test(lower)) return '前端实现'
  if (/backend|server|api|后端|接口/.test(lower)) return '后端实现'
  if (/architect|架构|规划/.test(lower)) return '规划'
  return /coder|code|实现|代码/.test(lower) ? '实现' : '协作'
}

function inferAgentName(content: string, role: string, codeAgentType: AgentDraft['codeAgentType']) {
  const explicit = /(?:创建|添加|新建)\s*(?:一个)?\s*([A-Za-z][A-Za-z0-9_-]{1,24})\s*(?:Agent|代理|助手)/i.exec(content)?.[1]
  if (explicit && !['agent', 'coder', 'code'].includes(explicit.toLowerCase())) return explicit
  const prefix = codeAgentType === 'claude-code' ? 'Claude' : codeAgentType === 'opencode' ? 'OpenCode' : codeAgentType === 'gemini' ? 'Gemini' : codeAgentType === 'codex' ? 'Codex' : ''
  const suffix = role.includes('前端') ? 'Frontend' : role.includes('后端') ? 'Backend' : role.includes('审查') ? 'Reviewer' : role.includes('部署') ? 'Deploy' : 'Coder'
  return [prefix, suffix].filter(Boolean).join(' ') || 'Custom Agent'
}

function inferCapabilityTags(content: string, role: string) {
  const tags = new Set<string>()
  const candidates: Array<[RegExp, string]> = [
    [/react|前端|页面|ui/i, '前端'],
    [/node|server|api|后端|接口/i, '后端'],
    [/test|测试|qa/i, '测试'],
    [/deploy|部署|发布/i, '部署'],
    [/review|审查|质量/i, '审查'],
    [/research|研究|调研/i, '研究'],
    [/workflow|流程|编排/i, '编排'],
  ]
  for (const [pattern, tag] of candidates) {
    if (pattern.test(content)) tags.add(tag)
  }
  if (role) tags.add(role)
  return [...tags].slice(0, 8)
}

function inferToolPermissions(content: string) {
  const lower = content.toLowerCase()
  const permissions = new Set<string>(['chat'])
  if (/读|读取|read|项目|workspace|文件/.test(lower)) permissions.add('workspace:read')
  if (/写|修改|实现|代码|write|workspace/.test(lower)) permissions.add('workspace:write')
  if (/预览|preview|shell/.test(lower)) permissions.add('shell:preview')
  if (/部署|发布|deploy/.test(lower)) permissions.add('deploy:preview')
  return [...permissions]
}

function buildAgentSystemPrompt(role: string, tags: string[]) {
  return [
    `你是 AgentHub 中的${role} Agent。`,
    tags.length ? `你的能力标签是：${tags.join('、')}。` : '',
    '请基于当前会话上下文给出可执行产出；涉及文件修改、命令执行、部署或密钥时先说明风险并等待用户确认。',
  ]
    .filter(Boolean)
    .join('\n')
}

function colorForRole(role: string) {
  if (role.includes('前端')) return '#2563eb'
  if (role.includes('后端')) return '#0f766e'
  if (role.includes('审查')) return '#ef4444'
  if (role.includes('部署')) return '#7c3aed'
  if (role.includes('研究')) return '#f59e0b'
  if (role.includes('规划')) return '#6366f1'
  return '#111827'
}

function parseAgentDraft(metadata: unknown) {
  const draft = (metadata as { agentDraft?: unknown } | null)?.agentDraft
  return normalizeAgentDraftInput(draft)
}

function normalizeAgentDraftInput(value: unknown): AgentDraft | null {
  if (!value || typeof value !== 'object') return null
  const parsed = confirmAgentDraftSchema.shape.draft.safeParse(value)
  if (!parsed.success || !parsed.data) return null
  const draft = parsed.data
  const runtimeType = draft.runtimeType ?? 'llm'
  const nativeReadOnly = runtimeType === 'mcp'
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    description: draft.description?.trim() ?? '',
    avatar: draft.avatar ?? null,
    systemPrompt: draft.systemPrompt?.trim() ?? '',
    color: draft.color ?? '#111827',
    modelId: draft.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (draft.codeAgentType ?? 'codex') : null,
    capabilityTags: draft.capabilityTags ?? [],
    toolPermissions: nativeReadOnly ? ['workspace:read', 'skills:read'] : draft.toolPermissions?.length ? draft.toolPermissions : ['chat'],
    sandboxPolicy: nativeReadOnly ? 'read-only' : (draft.sandboxPolicy ?? 'workspace-write'),
    contextPolicy: draft.contextPolicy ?? 'workspace-aware',
    autoInvoke: draft.autoInvoke ?? true,
    approvalRequired: nativeReadOnly ? true : (draft.approvalRequired ?? true),
  }
}

async function buildDynamicOrchestratorPlan(
  content: string,
  agents: Array<typeof workspaceAgents.$inferSelect>,
  workspaceId?: string | null
): Promise<OrchestratorPlan> {
  const goal = normalizeOrchestratorGoal(content)
  const planningAgents = agents.length ? agents.map(planAgentFromWorkspaceAgent) : fallbackPlanAgents()

  let specPhases: string | undefined
  if (workspaceId) {
    try {
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
      if (ws?.projectPath) {
        await harnessManager.loadFromWorkspace(ws.projectPath)
        const spec = harnessManager.findBestSpec(goal)
        if (spec) {
          specPhases = [
            `【协作规范：${spec.name}】`,
            spec.description,
            '',
            '请按以下阶段组织任务（每个阶段可映射为 1 个或多个 task）：',
            ...spec.phases.map((p, i) => {
              const deps = p.dependsOn?.length ? `（依赖：${p.dependsOn.join('、')}）` : ''
              return `${i + 1}. ${p.name}：${p.description} ${deps}`
            }),
            '【规范结束】',
          ].join('\n')
        }
      }
    } catch {
      // Best-effort spec loading; don't block plan generation.
    }
  }

  try {
    const generated = await generatePlanWithLlm(goal, planningAgents, specPhases)
    const normalized = normalizeGeneratedPlan(goal, generated, planningAgents)
    if (normalized) return normalized
  } catch {
    // Keep task card creation reliable when model credentials are missing or JSON generation fails.
  }

  return buildOrchestratorPlan(content, planningAgents)
}

function buildOrchestratorPlan(content: string, agents = fallbackPlanAgents()): OrchestratorPlan {
  const normalizedGoal = normalizeOrchestratorGoal(content)
  const title = titleFromGoal(normalizedGoal)
  const selectedAgents = agents.length ? agents.slice(0, Math.max(1, Math.min(agents.length, 4))) : fallbackPlanAgents()
  const leadAgent = pickAgent(selectedAgents, ['规划', '架构', 'architect', 'plan']) ?? selectedAgents[0]!
  const buildAgent =
    pickAgent(selectedAgents, ['实现', '代码', 'coder', 'code', 'build']) ?? selectedAgents[1] ?? selectedAgents[0]!
  const reviewAgent =
    pickAgent(selectedAgents, ['审查', 'review', 'test', '风险']) ?? selectedAgents[2] ?? selectedAgents[selectedAgents.length - 1]!

  return {
    kind: 'orchestrator_plan',
    title,
    goal: normalizedGoal,
    summary: `我已根据当前 Agent 团队把「${title}」拆成 3 个子任务。确认后会创建或复用 Agent Group 并分发执行。`,
    agents: selectedAgents,
    tasks: [
      {
        id: 'plan',
        title: '梳理目标与交付范围',
        description: `围绕「${normalizedGoal}」定义核心目标、交付物、边界、依赖和验收标准。`,
        agentKey: leadAgent.key,
        status: 'pending',
      },
      {
        id: 'build',
        title: '实现核心功能与界面',
        description: '基于拆解结果产出可执行实现方案，优先完成关键路径、组件接入和小步验证。',
        agentKey: buildAgent.key,
        status: 'pending',
      },
      {
        id: 'review',
        title: '审查风险与测试建议',
        description: '检查交互边界、异常状态、测试缺口和交付风险，并给出可直接执行的修复建议。',
        agentKey: reviewAgent.key,
        status: 'pending',
      },
    ],
  }
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
    description: agent.description,
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

function pickAgent(agents: PlanAgent[], keywords: string[]) {
  const lowered = keywords.map((keyword) => keyword.toLowerCase())
  return agents.find((agent) => {
    const text = [agent.name, agent.role, agent.description, agent.runtimeType, agent.codeAgentType, ...(agent.capabilityTags ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return lowered.some((keyword) => text.includes(keyword))
  })
}

async function generatePlanWithLlm(goal: string, agents: PlanAgent[], specPhases?: string) {
  const agentCatalog = agents.map((agent) => ({
    key: agent.key,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: agent.capabilityTags ?? [],
    toolPermissions: agent.toolPermissions ?? [],
    sandboxPolicy: agent.sandboxPolicy,
    systemPrompt: agent.systemPrompt,
  }))
  const system = [
    'You are AgentHub Orchestrator.',
    'Create a concise multi-agent execution plan using only the provided agent keys.',
    'Return strict JSON only. Do not include Markdown fences or explanations.',
    'Schema: {"title":string,"summary":string,"tasks":[{"id":string,"title":string,"description":string,"agentKey":string,"status":"pending"}]}',
    'Use 2-6 tasks. Pick the most suitable agent for each task based on role, capabilities, runtime, tools, sandbox, and system prompt.',
    specPhases || '',
  ].filter(Boolean).join('\n')
  const messagesForPlan = [
    {
      role: 'user' as const,
      content: JSON.stringify(
        {
          goal,
          agents: agentCatalog,
          language: 'zh-CN',
        },
        null,
        2
      ),
    },
  ]

  let output = ''
  for await (const delta of streamReply(messagesForPlan, system)) {
    output += delta
    if (output.length > 20_000) break
  }

  const jsonText = extractJsonObject(output)
  if (!jsonText) return null
  return JSON.parse(jsonText) as unknown
}

function normalizeGeneratedPlan(goal: string, generated: unknown, agents: PlanAgent[]): OrchestratorPlan | null {
  if (!generated || typeof generated !== 'object') return null
  const candidate = generated as {
    title?: unknown
    summary?: unknown
    tasks?: Array<{
      id?: unknown
      title?: unknown
      description?: unknown
      agentKey?: unknown
      status?: unknown
    }>
  }
  if (!Array.isArray(candidate.tasks) || candidate.tasks.length === 0) return null

  const agentKeys = new Set(agents.map((agent) => agent.key))
  const tasks = candidate.tasks
    .slice(0, 6)
    .map((task, index): PlanTask | null => {
      const title = cleanPlanText(task.title)
      const description = cleanPlanText(task.description)
      const agentKey = typeof task.agentKey === 'string' && agentKeys.has(task.agentKey) ? task.agentKey : agents[0]?.key
      if (!title || !description || !agentKey) return null
      return {
        id: slugifyTaskId(cleanPlanText(task.id) || title, index),
        title,
        description,
        agentKey,
        status: task.status === 'running' || task.status === 'done' || task.status === 'failed' ? task.status : 'pending',
      }
    })
    .filter((task): task is PlanTask => Boolean(task))

  if (!tasks.length) return null
  const title = cleanPlanText(candidate.title) || titleFromGoal(goal)

  return {
    kind: 'orchestrator_plan',
    title,
    goal,
    summary: cleanPlanText(candidate.summary) || `我已根据当前 Agent 团队把「${title}」拆成 ${tasks.length} 个子任务。`,
    agents,
    tasks,
  }
}

function extractJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}

function cleanPlanText(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 1200) : ''
}

function slugifyTaskId(value: string, index: number) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || `task-${index + 1}`
}

function titleFromGoal(goal: string) {
  const cleaned = goal.replace(/[。.!?？\n\r]/g, ' ').trim()
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}...` : cleaned || '多 Agent 协作任务'
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
    return lower.includes(`@${normalized}`) || new RegExp(`@\\s*${escapeRegExp(normalized)}\\b`, 'i').test(content)
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
  for (const profile of profiles) {
    await runAgentReply(sessionId, msg, profile)
  }
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
  if (!session) throw new HTTPException(500, { message: 'Failed to create group session' })

  await db.insert(sessionMembers).values([
    { sessionId: session.id, memberType: 'user', memberId: ownerId },
    { sessionId: session.id, memberType: 'agent', memberId: 'orchestrator' },
    ...agents.map((agent) => ({ sessionId: session.id, memberType: 'agent' as const, memberId: agent.id })),
  ])

  for (const agent of agents) {
    await ensureAgentChildSession(workspaceId, workspaceName, ownerId, agent)
  }

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
  if (!created) throw new HTTPException(500, { message: 'Failed to create agent child session' })
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
  if (!session.workspaceId) throw new HTTPException(400, { message: 'Session is not attached to a workspace' })

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId)).limit(1)
  if (!workspace || workspace.ownerId !== ownerId) {
    throw new HTTPException(404, { message: 'Workspace not found' })
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
        description: planAgent.description ?? '',
        systemPrompt: planAgent.systemPrompt,
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
