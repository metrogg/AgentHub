import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  Code2,
  Folder,
  History,
  Loader2,
  MessageCircle,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { cn, relativeTime } from '../../lib/utils'
import type { Session } from '../../lib/api'

type SessionGroup = {
  parent: Session
  children: Session[]
  latestUpdatedAt: string
}

export default function SessionList() {
  const navigate = useNavigate()
  const location = useLocation()
  const { sessionId } = useParams()
  const sessions = useChatStore((state) => state.sessions)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const createSession = useChatStore((state) => state.createSession)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const selectSession = useChatStore((state) => state.selectSession)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set())
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const sessionTree = useMemo(() => buildSessionTree(sessions), [sessions])
  const activeSession = sessions.find((session) => session.id === sessionId)

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  useEffect(() => {
    if (!activeSession?.workspaceId || activeSession.type !== 'direct' || !activeSession.workspaceAgentId) return
    setExpandedWorkspaces((current) => {
      if (current.has(activeSession.workspaceId!)) return current
      const next = new Set(current)
      next.add(activeSession.workspaceId!)
      return next
    })
  }, [activeSession?.id, activeSession?.type, activeSession?.workspaceAgentId, activeSession?.workspaceId])

  async function handleNew() {
    const session = await createSession('新会话')
    await selectSession(session.id)
    navigate(`/chat/${session.id}`)
  }

  function requestDelete(event: React.MouseEvent, session: Session) {
    event.stopPropagation()
    event.preventDefault()
    setDeleteTarget(session)
  }

  async function confirmDeleteSession() {
    if (!deleteTarget || deletingSessionId) return
    setDeletingSessionId(deleteTarget.id)
    try {
      await deleteSession(deleteTarget.id)
      if (sessionId === deleteTarget.id) navigate('/', { replace: true })
      setDeleteTarget(null)
    } finally {
      setDeletingSessionId(null)
    }
  }

  function closeDeleteDialog() {
    if (deletingSessionId) return
    setDeleteTarget(null)
  }

  return (
    <aside className="flex h-full min-h-0 w-64 shrink-0 flex-col border-r border-neutral-200 bg-[#f7f7f4]">
      <div className="flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-neutral-950 text-white">
            <MessageCircle className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold text-neutral-950">AgentHub</span>
        </div>
      </div>

      <div className="px-2">
        <div className="mb-3 flex w-full items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-3 text-left shadow-sm transition hover:border-neutral-300">
          <button
            type="button"
            onClick={handleNew}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#eef8f6] text-[#8ba9a4] transition hover:bg-[#e3f2ef]"
            aria-label="新建会话"
          >
            <Bot className="h-5 w-5" />
          </button>
          <button type="button" onClick={handleNew} className="min-w-0 flex-1 text-left">
            <div className="truncate text-sm font-medium text-neutral-950">新建会话</div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-neutral-500">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              空闲中
            </div>
          </button>
          <button
            type="button"
            onClick={() => navigate('/agent-config')}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
            aria-label="Agent 配置"
            title="Agent 配置"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <nav className="space-y-1 px-3">
        <NavItem
          icon={Code2}
          label="Code Agent"
          active={location.pathname === '/coding-tools'}
          onClick={() => navigate('/coding-tools')}
        />
        <NavItem
          icon={MessageCircle}
          label="Agent Group"
          active={location.pathname === '/agent-world'}
          strong
          onClick={() => navigate('/agent-world')}
        />
      </nav>

      <div className="my-3 border-t border-neutral-200" />

      <div className="flex-1 overflow-y-auto px-2">
        <div className="mb-1 px-2 text-xs text-neutral-400">历史话题</div>
        {sessions.length === 0 ? (
          <div className="px-2 py-4 text-xs text-neutral-400">还没有会话</div>
        ) : (
          <ul className="space-y-1">
            {sessionTree.map((item) => {
              const hasChildren = item.children.length > 0
              const workspaceId = item.parent.workspaceId
              const expanded = Boolean(workspaceId && expandedWorkspaces.has(workspaceId))
              const childActive = item.children.some((child) => child.id === sessionId)
              const active = sessionId === item.parent.id
              return (
                <li key={item.parent.id} className="space-y-1">
                  <div className="group flex items-center gap-1">
                    <button
                      onClick={() => {
                        if (hasChildren && workspaceId) {
                          setExpandedWorkspaces((current) => {
                            const next = new Set(current)
                            if (next.has(workspaceId)) next.delete(workspaceId)
                            else next.add(workspaceId)
                            return next
                          })
                        }
                        navigate(`/chat/${item.parent.id}`)
                      }}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition',
                        active || childActive ? 'bg-white text-neutral-950 shadow-sm' : 'text-neutral-600 hover:bg-white/70'
                      )}
                    >
                      {hasChildren ? (
                        <ChevronRight className={cn('h-4 w-4 shrink-0 text-neutral-400 transition-transform', expanded && 'rotate-90')} />
                      ) : (
                        <History className="h-4 w-4 shrink-0 text-neutral-400" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{item.parent.title}</span>
                        <span className="block truncate text-[11px] text-neutral-400">
                          {hasChildren ? `${item.children.length} 个子话题 · ${relativeTime(item.latestUpdatedAt)}` : relativeTime(item.latestUpdatedAt)}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={(event) => requestDelete(event, item.parent)}
                      className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {hasChildren && expanded && (
                    <ul className="ml-4 space-y-1 border-l border-neutral-200 pl-2">
                      {item.children.map((child) => (
                        <li key={child.id} className="group/child flex items-center gap-1">
                          <button
                            onClick={() => navigate(`/chat/${child.id}`)}
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition',
                              sessionId === child.id ? 'bg-white text-neutral-950 shadow-sm' : 'text-neutral-500 hover:bg-white/70 hover:text-neutral-800'
                            )}
                          >
                            <History className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{childSessionTitle(child, item.parent)}</span>
                              <span className="block truncate text-[10px] text-neutral-400">{relativeTime(child.updatedAt)}</span>
                            </span>
                          </button>
                          <button
                            onClick={(event) => requestDelete(event, child)}
                            className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover/child:opacity-100"
                            title="删除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-neutral-200 p-2">
        <button
          onClick={() => navigate('/settings')}
          className="flex h-10 w-full items-center gap-3 rounded-lg px-2 text-sm text-neutral-700 transition hover:bg-white/70"
        >
          <Settings2 className="h-4 w-4 text-neutral-500" />
          设置
        </button>
      </div>

      {deleteTarget && (
        <DeleteSessionDialog
          session={deleteTarget}
          deleting={deletingSessionId === deleteTarget.id}
          onClose={closeDeleteDialog}
          onConfirm={confirmDeleteSession}
        />
      )}
    </aside>
  )
}

function DeleteSessionDialog({
  session,
  deleting,
  onClose,
  onConfirm,
}: {
  session: Session
  deleting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/30 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-session-title"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-4 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-500">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="delete-session-title" className="text-sm font-semibold text-neutral-950">
              删除会话
            </h2>
            <p className="mt-1 text-xs leading-5 text-neutral-500">
              这个会话和其中的消息会被移除，此操作不可撤销。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40"
            aria-label="关闭"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2">
          <div className="truncate text-sm font-medium text-neutral-900">{session.title || '未命名会话'}</div>
          <div className="mt-0.5 text-xs text-neutral-400">{relativeTime(session.updatedAt)}</div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-medium text-white transition hover:bg-red-500 disabled:bg-red-200"
          >
            {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
            删除
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function NavItem({
  icon: Icon,
  label,
  strong = false,
  active = false,
  onClick,
}: {
  icon: typeof Folder
  label: string
  strong?: boolean
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-sm text-neutral-700 transition hover:bg-white/70',
        strong && 'font-semibold text-neutral-950',
        active && 'bg-white text-neutral-950 shadow-sm'
      )}
    >
      <Icon className="h-4 w-4 text-neutral-500" />
      {label}
    </button>
  )
}

function buildSessionTree(sessions: Session[]): SessionGroup[] {
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
      const children = parent.workspaceId
        ? [...(childrenByWorkspace.get(parent.workspaceId) ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        : []
      const latestUpdatedAt = [parent, ...children].reduce(
        (latest, session) => (Date.parse(session.updatedAt) > Date.parse(latest) ? session.updatedAt : latest),
        parent.updatedAt
      )
      return { parent, children, latestUpdatedAt }
    })
    .sort((a, b) => Date.parse(b.latestUpdatedAt) - Date.parse(a.latestUpdatedAt))
}

function childSessionTitle(session: Session, parent: Session) {
  const withoutParent = parent.title ? session.title.replace(parent.title, '').replace(/^(\s*\/\s*)+/, '') : session.title
  const parts = withoutParent
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length ? parts.join(' / ') : session.title
}
