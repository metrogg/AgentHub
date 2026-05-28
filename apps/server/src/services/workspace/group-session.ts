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

async function syncGroupMembers(sessionId: string, workspaceId: string, ownerId: string, selectedAgentIds?: string[]) {
  const allAgents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))

  // 确定哪些 agents 应该作为群聊成员
  let wantedAgents = allAgents
  if (selectedAgentIds && selectedAgentIds.length > 0) {
    wantedAgents = allAgents.filter((a) => selectedAgentIds.includes(a.id))
  }

  const existing = await db.select().from(sessionMembers).where(eq(sessionMembers.sessionId, sessionId))
  const keys = new Set(existing.map((member) => `${member.memberType}:${member.memberId}`))
  const wanted = [
    { memberType: 'user' as const, memberId: ownerId },
    ...wantedAgents.map((agent) => ({ memberType: 'agent' as const, memberId: agent.id })),
  ]

  // 添加缺失的成员
  const missing = wanted.filter((member) => !keys.has(`${member.memberType}:${member.memberId}`))
  if (missing.length) {
    await db.insert(sessionMembers).values(missing.map((member) => ({ sessionId, ...member })))
  }

  // 删除已不在 wanted 列表中的成员（幽灵成员清理）
  const stale = existing.filter((member) => !wanted.some((w) => w.memberType === member.memberType && w.memberId === member.memberId))
  if (stale.length) {
    for (const member of stale) {
      await db.delete(sessionMembers).where(
        and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.memberType, member.memberType), eq(sessionMembers.memberId, member.memberId))
      )
    }
  }
}

export async function ensureGroupSession(workspaceId: string, ownerId: string, selectedAgentIds?: string[]) {
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
        metadata: { kind: 'workspace-agent-group' },
      })
      .returning()
    if (!created) throw new HTTPException(500, { message: 'Failed to create group session' })
    session = created
  }
  await syncGroupMembers(session.id, workspaceId, ownerId, selectedAgentIds)
  return session
}
