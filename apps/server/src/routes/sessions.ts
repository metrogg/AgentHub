import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { AppError, AppErrorCodes } from '../lib/error'
import { createSessionSchema, updateSessionSchema } from '@agenthub/shared'
import { db, sessions, sessionMembers, workspaceAgents, workspaces, eq, desc, and } from '@agenthub/db'
import { inArray } from 'drizzle-orm'
import { authMiddleware, type AuthVariables } from '../middleware/auth'
import { controllerReconcileQueue, resourceRef } from '../services/controller-plane'
import { listRoomLastMessagePreviews } from '../services/rooms/room-last-message'

export const sessionRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const user = c.get('user')
    const workspaceId = c.req.query('workspaceId')
    const conditions = workspaceId
      ? and(eq(sessions.ownerId, user.sub), eq(sessions.workspaceId, workspaceId))
      : eq(sessions.ownerId, user.sub)
    const list = await db.select().from(sessions).where(conditions).orderBy(desc(sessions.updatedAt))

    const selectedSessionIds = list.map((s) => s.id)
    const lastMessages = await listRoomLastMessagePreviews(selectedSessionIds)

    return c.json({
      items: list.map((s) => ({
        ...s,
        lastMessage: lastMessages[s.id] ?? null,
      })),
    })
  })
  .post('/', zValidator('json', createSessionSchema), async (c) => {
    const user = c.get('user')
    const input = c.req.valid('json')
    if (input.workspaceId) {
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1)
      if (!workspace || workspace.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
      if (input.workspaceAgentId) {
        const [agent] = await db
          .select()
          .from(workspaceAgents)
          .where(and(eq(workspaceAgents.id, input.workspaceAgentId), eq(workspaceAgents.workspaceId, input.workspaceId)))
          .limit(1)
        if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')
      }
    }
    const [session] = await db
      .insert(sessions)
      .values({
        title: input.title,
        type: input.type,
        ownerId: user.sub,
        workspaceId: input.workspaceId ?? null,
        workspaceAgentId: input.workspaceAgentId ?? null,
        metadata: input.metadata ?? null,
      })
      .returning()
    if (!session) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '会话创建失败')
    controllerReconcileQueue.enqueue({
      ref: resourceRef('Room', session.id, session.workspaceId),
      reason: 'session-created',
      payload: {
        sessionId: session.id,
        ownerId: user.sub,
      },
    })
    return c.json(session)
  })
  .get('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    }
    return c.json(session)
  })
  .patch('/:id', zValidator('json', updateSessionSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const input = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    }

    if (input.workspaceId) {
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1)
      if (!workspace || workspace.ownerId !== user.sub) throw AppError.fromCode(AppErrorCodes.WORKSPACE_NOT_FOUND, '工作区不存在')
      if (session.type === 'group' && input.workspaceId !== session.workspaceId) {
        await ensureGroupSessionCanMoveToWorkspace(session.id, input.workspaceId)
      }
      if (input.workspaceAgentId) {
        const [agent] = await db
          .select()
          .from(workspaceAgents)
          .where(and(eq(workspaceAgents.id, input.workspaceAgentId), eq(workspaceAgents.workspaceId, input.workspaceId)))
          .limit(1)
        if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')
      }
    }

    const patch = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId, workspaceAgentId: input.workspaceAgentId ?? null } : {}),
      ...(input.workspaceAgentId !== undefined && input.workspaceId === undefined ? { workspaceAgentId: input.workspaceAgentId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updatedAt: new Date(),
    }
    const [updated] = await db.update(sessions).set(patch).where(eq(sessions.id, id)).returning()
    if (!updated) throw AppError.internal(AppErrorCodes.INTERNAL_ERROR, '会话更新失败')
    return c.json(updated)
  })
  .delete('/all', async (c) => {
    const user = c.get('user')
    await db.delete(sessions).where(eq(sessions.ownerId, user.sub))
    return c.json({ deleted: true })
  })
  .delete('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')
    }
    // 删除群聊时级联删除 workspace 下的所有子会话（direct sessions）
    // 避免删除群聊后旧子话题仍残留在 sidebar 中
    if (session.type === 'group' && session.workspaceId) {
      await db.delete(sessions).where(
        and(
          eq(sessions.workspaceId, session.workspaceId),
          eq(sessions.type, 'direct'),
          eq(sessions.ownerId, user.sub)
        )
      )
    }
    await db.delete(sessions).where(eq(sessions.id, id))
    return c.json({ success: true })
  })

async function ensureGroupSessionCanMoveToWorkspace(sessionId: string, targetWorkspaceId: string) {
  const members = await db
    .select()
    .from(sessionMembers)
    .where(eq(sessionMembers.sessionId, sessionId))
  const memberAgentIds = members
    .filter((member) => member.memberType === 'agent')
    .map((member) => member.memberId)
  if (!memberAgentIds.length) return

  const agents = await db
    .select({ id: workspaceAgents.id, workspaceId: workspaceAgents.workspaceId })
    .from(workspaceAgents)
    .where(inArray(workspaceAgents.id, memberAgentIds))
  const invalidAgentIds = agents
    .filter((agent) => agent.workspaceId !== targetWorkspaceId)
    .map((agent) => agent.id)

  if (invalidAgentIds.length > 0) {
    throw AppError.fromCode(
      AppErrorCodes.VALIDATION_FAILED,
      '不能把群聊移动到不包含其成员 Agent 的工作区',
      { invalidAgentIds, targetWorkspaceId },
    )
  }
}
