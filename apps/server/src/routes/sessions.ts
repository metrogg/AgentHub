import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { createSessionSchema, updateSessionSchema } from '@agenthub/shared'
import { db, sessions, sessionMembers, workspaceAgents, workspaces, eq, desc, and } from '@agenthub/db'
import { inArray } from 'drizzle-orm'
import { authMiddleware, type AuthVariables } from '../middleware/auth'

export const sessionRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const user = c.get('user')
    const workspaceId = c.req.query('workspaceId')
    const conditions = workspaceId
      ? and(eq(sessions.ownerId, user.sub), eq(sessions.workspaceId, workspaceId))
      : eq(sessions.ownerId, user.sub)
    const list = await db.select().from(sessions).where(conditions).orderBy(desc(sessions.updatedAt))
    return c.json({ items: list })
  })
  .post('/', zValidator('json', createSessionSchema), async (c) => {
    const user = c.get('user')
    const input = c.req.valid('json')
    if (input.workspaceId) {
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1)
      if (!workspace || workspace.ownerId !== user.sub) throw new HTTPException(404, { message: 'Workspace not found' })
      if (input.workspaceAgentId) {
        const [agent] = await db
          .select()
          .from(workspaceAgents)
          .where(and(eq(workspaceAgents.id, input.workspaceAgentId), eq(workspaceAgents.workspaceId, input.workspaceId)))
          .limit(1)
        if (!agent) throw new HTTPException(404, { message: 'Agent not found' })
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
    if (!session) throw new HTTPException(500, { message: 'Failed to create session' })
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
      throw new HTTPException(404, { message: 'Session not found' })
    }
    return c.json(session)
  })
  .patch('/:id', zValidator('json', updateSessionSchema), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const input = c.req.valid('json')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw new HTTPException(404, { message: 'Session not found' })
    }

    if (input.workspaceId) {
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1)
      if (!workspace || workspace.ownerId !== user.sub) throw new HTTPException(404, { message: 'Workspace not found' })
      if (session.type === 'group' && input.workspaceId !== session.workspaceId) {
        await ensureGroupSessionCanMoveToWorkspace(session.id, input.workspaceId)
      }
      if (input.workspaceAgentId) {
        const [agent] = await db
          .select()
          .from(workspaceAgents)
          .where(and(eq(workspaceAgents.id, input.workspaceAgentId), eq(workspaceAgents.workspaceId, input.workspaceId)))
          .limit(1)
        if (!agent) throw new HTTPException(404, { message: 'Agent not found' })
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
    if (!updated) throw new HTTPException(500, { message: 'Failed to update session' })
    return c.json(updated)
  })
  .delete('/:id', async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1)
    if (!session || session.ownerId !== user.sub) {
      throw new HTTPException(404, { message: 'Session not found' })
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
    return c.body(null, 204)
  })
  .delete('/all', async (c) => {
    const user = c.get('user')
    await db.delete(sessions).where(eq(sessions.ownerId, user.sub))
    return c.json({ deleted: true })
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
    throw new HTTPException(400, {
      message:
        'Cannot move a group session to a workspace that does not contain its agent members.',
    })
  }
}
