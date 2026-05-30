import { db, sessions, sessionMembers, workspaceAgents, eq, and, asc, desc } from '@agenthub/db'
import { AppError, AppErrorCodes } from '../../lib/error'
import { ensureWorkspace } from './workspace-queries'

// ─── Group Session ────────────────────────────────────────────────────────────

/**
 * 查找或创建工作区的群组会话，并同步成员。
 *
 * 替代：
 * - workspace/group-session.ts:ensureGroupSession
 * - messages.ts:createWorkspaceGroupSession
 */
export async function ensureGroupSession(
  workspaceId: string,
  ownerId: string,
  selectedAgentIds?: string[],
) {
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
    if (!created) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '群组会话创建失败')
    session = created
  }
  await syncGroupMembers(session.id, workspaceId, ownerId, selectedAgentIds)
  const [refreshed] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
  return refreshed ?? session
}

/**
 * 创建新的工作区群组会话（不复用已有）。
 * 用于 orchestrator dispatch 场景。
 *
 * 替代 messages.ts:createWorkspaceGroupSession。
 */
export async function createWorkspaceGroupSession(
  workspaceId: string,
  workspaceName: string,
  ownerId: string,
  agents: Array<{ id: string }>,
) {
  const [session] = await db
    .insert(sessions)
    .values({
      title: `${workspaceName} / Agent Group`,
      type: 'group',
      ownerId,
      workspaceId,
      metadata: { kind: 'workspace-agent-group' },
    })
    .returning()
  if (!session) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, '群组会话创建失败')

  await db.insert(sessionMembers).values([
    { sessionId: session.id, memberType: 'user' as const, memberId: ownerId },
    ...agents.map((agent) => ({
      sessionId: session.id,
      memberType: 'agent' as const,
      memberId: agent.id,
    })),
  ])

  return session
}

// ─── Direct (Child) Session ───────────────────────────────────────────────────

/**
 * 查找或创建 Agent 的直接会话。
 * 会复用已有的非 orchestrator-task 会话。
 *
 * 替代 messages.ts:ensureAgentChildSession。
 */
export async function ensureAgentChildSession(
  workspaceId: string,
  workspaceName: string,
  ownerId: string,
  agent: { id: string; name: string } | null,
  taskTitle?: string,
) {
  if (agent) {
    const existingSessions = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.ownerId, ownerId),
          eq(sessions.type, 'direct'),
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.workspaceAgentId, agent.id),
        ),
      )
      .orderBy(desc(sessions.updatedAt))
    const fixedSession = existingSessions.find(
      (session) => !isOrchestratorTaskSession(session.metadata),
    )
    if (fixedSession) return fixedSession
  }

  const [created] = await db
    .insert(sessions)
    .values({
      title: agent
        ? `${workspaceName} / ${agent.name}`
        : `${workspaceName} / ${taskTitle?.slice(0, 24) || 'Agent'}`,
      type: 'direct',
      ownerId,
      workspaceId,
      workspaceAgentId: agent?.id ?? null,
      metadata: { kind: 'workspace-agent-child' },
    })
    .returning()
  if (!created) throw AppError.fromCode(AppErrorCodes.SESSION_CREATE_FAILED, 'Agent 子会话创建失败')
  return created
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

function isOrchestratorTaskSession(metadata: Record<string, unknown> | null) {
  return Boolean(
    metadata?.orchestratorTaskId ||
    metadata?.orchestratorRunId ||
    metadata?.hiddenFromSessionTree ||
    metadata?.kind === 'orchestrator-task',
  )
}
