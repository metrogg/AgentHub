import type { Session } from './api'

export type SessionGroup = {
  parent: Session
  children: Session[]
  latestUpdatedAt: string
}

export function buildSessionTree(sessions: Session[], pinnedIds = new Set<string>()): SessionGroup[] {
  const childrenByWorkspace = new Map<string, Session[]>()
  const childIds = new Set<string>()

  for (const session of sessions) {
    if (session.type === 'direct' && session.workspaceId && session.workspaceAgentId) {
      childIds.add(session.id)
      const children = childrenByWorkspace.get(session.workspaceId) ?? []
      children.push(session)
      childrenByWorkspace.set(session.workspaceId, children)
    }
  }

  return sessions
    .filter((session) => !childIds.has(session.id))
    .map((parent) => {
      const children =
        parent.type === 'group' && parent.workspaceId
          ? [...(childrenByWorkspace.get(parent.workspaceId) ?? [])].sort(
              (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
            )
          : []
      const latestUpdatedAt = [parent, ...children].reduce(
        (latest, session) => (Date.parse(session.updatedAt) > Date.parse(latest) ? session.updatedAt : latest),
        parent.updatedAt,
      )
      return { parent, children, latestUpdatedAt }
    })
    .sort((a, b) => comparePinnedGroups(a, b, pinnedIds))
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
        (child) => archivedIds.has(child.id) === showArchived && sessionMatchesQuery(child, keyword, group.parent),
      )
      const parentVisible = parentArchived === showArchived && sessionMatchesQuery(group.parent, keyword)
      if (!parentVisible && !children.length) return null
      return {
        ...group,
        children,
        latestUpdatedAt: [parentVisible ? group.parent : null, ...children]
          .filter((item): item is Session => Boolean(item))
          .reduce(
            (latest, session) => (Date.parse(session.updatedAt) > Date.parse(latest) ? session.updatedAt : latest),
            group.latestUpdatedAt,
          ),
      }
    })
    .filter((group): group is SessionGroup => Boolean(group))
}

function sessionMatchesQuery(session: Session, query: string, parent?: Session) {
  if (!query) return true
  return [session.title, session.type, session.workspaceId ?? '', session.workspaceAgentId ?? '', parent?.title ?? '']
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
