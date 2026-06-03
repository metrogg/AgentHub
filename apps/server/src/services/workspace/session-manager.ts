import { db, sessions, sessionMembers, workspaceAgents, eq, and, asc, desc } from '@agenthub/db'
import { AppError, AppErrorCodes } from '../../lib/error'
import { ensureWorkspace } from './workspace-queries'

// ─── Group Session ────────────────────────────────────────────────────────────

/**
 * 查找或创建工作区的群组会话，并同步成员。
 */
export async function ensureGroupSession(
  workspaceId: string,
  ownerId: string,
  selectedAgentIds?: string[],
) {
  const ws = await ensureWorkspace(workspaceId, ownerId)
  await ensureValidGroupOrchestrator(workspaceId, selectedAgentIds)
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
    if (!created) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '群组会话创建失败')
    session = created
  }
  await syncGroupMembers(session.id, workspaceId, ownerId, selectedAgentIds)
  const [refreshed] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
  return refreshed ?? session
}

async function ensureValidGroupOrchestrator(workspaceId: string, selectedAgentIds?: string[]) {
  const allAgents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))

  const selectedAgentIdSet =
    selectedAgentIds && selectedAgentIds.length > 0 ? new Set(selectedAgentIds) : null
  const agents = selectedAgentIdSet
    ? allAgents.filter((agent) => selectedAgentIdSet.has(agent.id))
    : allAgents

  if (agents.length <= 1) return

  const orchestrators = agents.filter((agent) => agent.roleType === 'orchestrator')
  if (orchestrators.length === 1) return
  if (orchestrators.length === 0) {
    throw AppError.fromCode(
      AppErrorCodes.VALIDATION_FAILED,
      '多成员群聊必须包含 1 个 Orchestrator 作为总指挥。',
    )
  }
  throw AppError.fromCode(
    AppErrorCodes.VALIDATION_FAILED,
    '一个群聊只能包含 1 个 Orchestrator，请移除重复的总指挥。',
  )
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function findGroupSession(workspaceId: string) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.type, 'group')))
    .orderBy(desc(sessions.createdAt))
    .limit(1)
  return session ?? null
}

async function syncGroupMembers(
  sessionId: string,
  workspaceId: string,
  ownerId: string,
  selectedAgentIds?: string[],
) {
  const allAgents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))

  const selectedAgentIdSet =
    selectedAgentIds && selectedAgentIds.length > 0 ? new Set(selectedAgentIds) : null
  const agents = selectedAgentIdSet
    ? allAgents.filter((agent) => selectedAgentIdSet.has(agent.id))
    : allAgents

  const existing = await db
    .select()
    .from(sessionMembers)
    .where(eq(sessionMembers.sessionId, sessionId))
  const keys = new Set(existing.map((member) => `${member.memberType}:${member.memberId}`))
  const wanted = [
    { memberType: 'user' as const, memberId: ownerId },
    ...agents.map((agent) => ({ memberType: 'agent' as const, memberId: agent.id })),
  ]

  const missing = wanted.filter((member) => !keys.has(`${member.memberType}:${member.memberId}`))
  if (missing.length) {
    await db.insert(sessionMembers).values(missing.map((member) => ({ sessionId, ...member })))
  }

  const wantedKeys = new Set(wanted.map((member) => `${member.memberType}:${member.memberId}`))
  const seenKeys = new Set<string>()
  const stale = existing.filter((member) => {
    const key = `${member.memberType}:${member.memberId}`
    if (!wantedKeys.has(key)) return true
    if (seenKeys.has(key)) return true
    seenKeys.add(key)
    return false
  })
  if (stale.length) {
    for (const member of stale) {
      await db.delete(sessionMembers).where(eq(sessionMembers.id, member.id))
    }
  }

  await db
    .update(sessions)
    .set({
      metadata: {
        kind: 'workspace-agent-group',
        agentIds: agents.map((agent) => agent.id),
        agentCount: agents.length,
        memberCount: agents.length + 1,
      },
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
}
