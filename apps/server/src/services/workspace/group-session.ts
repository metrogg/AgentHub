import {
  db,
  sessions,
  sessionMembers,
  workspaceAgents,
  eq,
  and,
  asc,
  desc,
} from '@agenthub/db'
import { HTTPException } from 'hono/http-exception'
import { ensureWorkspace } from './workspace-queries'

async function findGroupSession(workspaceId: string) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.type, 'group')))
    .orderBy(desc(sessions.createdAt))
    .limit(1)
  return session ?? null
}

async function syncGroupMembers(sessionId: string, workspaceId: string, ownerId: string) {
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  const existing = await db.select().from(sessionMembers).where(eq(sessionMembers.sessionId, sessionId))
  const keys = new Set(existing.map((member) => `${member.memberType}:${member.memberId}`))
  const wanted = [
    { memberType: 'user' as const, memberId: ownerId },
    { memberType: 'agent' as const, memberId: 'orchestrator' },
    ...agents.map((agent) => ({ memberType: 'agent' as const, memberId: agent.id })),
  ]
  const missing = wanted.filter((member) => !keys.has(`${member.memberType}:${member.memberId}`))
  if (missing.length) {
    await db.insert(sessionMembers).values(missing.map((member) => ({ sessionId, ...member })))
  }
  // 修复 Bug 3: 删除已不在 workspace 中的幽灵成员
  const stale = existing.filter((member) => !wanted.some((w) => w.memberType === member.memberType && w.memberId === member.memberId))
  if (stale.length) {
    for (const member of stale) {
      await db.delete(sessionMembers).where(
        and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.memberType, member.memberType), eq(sessionMembers.memberId, member.memberId))
      )
    }
  }
}

export async function ensureGroupSession(workspaceId: string, ownerId: string) {
  const ws = await ensureWorkspace(workspaceId, ownerId)
  let session = await findGroupSession(workspaceId)
  if (!session) {
    const [created] = await db
      .insert(sessions)
      .values({
        title: `${ws.name} / Agent Group`,
        type: 'group',
        ownerId,
        workspaceId,
      })
      .returning()
    if (!created) throw new HTTPException(500, { message: 'Failed to create group session' })
    session = created
  }
  await syncGroupMembers(session.id, workspaceId, ownerId)
  return session
}
