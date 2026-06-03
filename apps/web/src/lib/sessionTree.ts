import { type Session, SessionType } from './api'

export type AgentSessionKind = 'regular' | 'agent-direct' | 'orchestrator-task'

export type SessionGroup = {
  parent: Session
  children: Session[]
  latestUpdatedAt: string
}

export function buildSessionTree(
  sessions: Session[],
  pinnedIds = new Set<string>(),
): SessionGroup[] {
  const childrenByGroupSession = new Map<string, Session[]>()
  const hiddenIds = new Set<string>()
  const groupSessionIds = new Set(
    sessions.filter((session) => session.type === SessionType.Group).map((session) => session.id),
  )

  for (const session of sessions) {
    const visibility = agentSessionVisibility(session, groupSessionIds)
    if (visibility === 'child') {
      const groupSessionId = readGroupSessionId(session)
      if (!groupSessionId) continue
      hiddenIds.add(session.id)
      const children = childrenByGroupSession.get(groupSessionId) ?? []
      children.push(session)
      childrenByGroupSession.set(groupSessionId, children)
    } else if (visibility === 'hidden') {
      hiddenIds.add(session.id)
    }
  }

  return sessions
    .filter((session) => !hiddenIds.has(session.id))
    .map((parent) => {
      const children =
        parent.type === SessionType.Group
          ? [...(childrenByGroupSession.get(parent.id) ?? [])].sort(
              (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
            )
          : []
      const latestUpdatedAt = [parent, ...children].reduce(
        (latest, session) =>
          Date.parse(session.updatedAt) > Date.parse(latest) ? session.updatedAt : latest,
        parent.updatedAt,
      )
      return { parent, children, latestUpdatedAt }
    })
    .sort((a, b) => comparePinnedGroups(a, b, pinnedIds))
}

function agentSessionVisibility(
  session: Session,
  groupSessionIds: Set<string>,
): 'top' | 'child' | 'hidden' {
  if (session.type !== SessionType.Direct || !session.workspaceId) return 'top'
  if (isAgentDirectSession(session)) return 'top'
  if (isOrchestratorTaskSession(session))
    return groupSessionIds.has(readGroupSessionId(session) ?? '') ? 'child' : 'hidden'
  return 'hidden'
}

export function classifyAgentSession(session: Session | null | undefined): AgentSessionKind {
  if (isAgentDirectSession(session)) return 'agent-direct'
  if (isOrchestratorTaskSession(session)) return 'orchestrator-task'
  return 'regular'
}

export function isAgentDirectSession(session: Session | null | undefined) {
  if (session?.type !== SessionType.Direct || !session.workspaceId || !session.workspaceAgentId) {
    return false
  }
  return session.metadata?.kind === 'agent-direct'
}

export function isOrchestratorTaskSession(session: Session | null | undefined) {
  if (!session) return false
  return isStableOrchestratorTaskSession(session)
}

export function isStableOrchestratorTaskSession(
  session: Session,
  metadata: Record<string, unknown> = (session.metadata ?? {}) as Record<string, unknown>,
) {
  return (
    session.type === SessionType.Direct &&
    metadata.kind === 'orchestrator-task' &&
    typeof metadata.orchestratorTaskId === 'string' &&
    metadata.orchestratorTaskId.length > 0 &&
    typeof metadata.orchestratorRunId === 'string' &&
    metadata.orchestratorRunId.length > 0 &&
    typeof metadata.groupSessionId === 'string' &&
    metadata.groupSessionId.length > 0 &&
    Boolean(session.workspaceId)
  )
}

function readGroupSessionId(session: Session) {
  const value = session.metadata?.groupSessionId
  return typeof value === 'string' && value.trim() ? value : null
}

export function filterSessionTree(
  groups: SessionGroup[],
  query: string,
  showArchived: boolean,
  archivedIds: Set<string>,
) {
  const keyword = query.trim().toLowerCase()
  return groups
    .map((group) => {
      const parentArchived = archivedIds.has(group.parent.id)
      const children = group.children.filter(
        (child) =>
          archivedIds.has(child.id) === showArchived &&
          sessionMatchesQuery(child, keyword, group.parent),
      )
      const parentVisible =
        parentArchived === showArchived && sessionMatchesQuery(group.parent, keyword)
      if (!parentVisible && !children.length) return null
      return {
        ...group,
        children,
        latestUpdatedAt: [parentVisible ? group.parent : null, ...children]
          .filter((item): item is Session => Boolean(item))
          .reduce(
            (latest, session) =>
              Date.parse(session.updatedAt) > Date.parse(latest) ? session.updatedAt : latest,
            group.latestUpdatedAt,
          ),
      }
    })
    .filter((group): group is SessionGroup => Boolean(group))
}

function sessionMatchesQuery(session: Session, query: string, parent?: Session) {
  if (!query) return true
  return [
    session.title,
    session.type,
    session.workspaceId ?? '',
    session.workspaceAgentId ?? '',
    parent?.title ?? '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function comparePinnedGroups(a: SessionGroup, b: SessionGroup, pinnedIds: Set<string>) {
  const aPinned = pinnedIds.has(a.parent.id)
  const bPinned = pinnedIds.has(b.parent.id)
  if (aPinned !== bPinned) return aPinned ? -1 : 1
  return Date.parse(b.latestUpdatedAt) - Date.parse(a.latestUpdatedAt)
}
