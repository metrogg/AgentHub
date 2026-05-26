import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Bot,
  BriefcaseBusiness,
  ChevronRight,
  Code2,
  Building2,
  Folder,
  History,
  Loader2,
  Menu,
  MessageCircle,
  PanelLeft,
  Pin,
  PinOff,
  Search,
  Settings2,
  Trash2,
  UserCircle,
  Users,
  X,
} from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { cn, relativeTime } from '../../lib/utils'
import { api, type Session, type WorkspaceAgent, type WorkspaceFull } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { loadSessionListPrefs, normalizeSessionListPrefs, saveSessionListPrefs, sessionArchiveChangeEvent, type SessionListPrefs } from '../../lib/sessionArchive'
import { settingsUpdatedEvent } from '../../lib/shortcuts'
import { requestNewSessionDialog } from './GlobalNewSessionDialog'

type SessionGroup = {
  parent: Session
  children: Session[]
  latestUpdatedAt: string
}

type SidebarTab = 'messages' | 'agents' | 'workspace' | 'me'

type AccountProfile = {
  name: string
  avatar: string
}

const defaultAccountProfile: AccountProfile = {
  name: 'You',
  avatar: '',
}

export default function SessionList({ onCollapse }: { onCollapse?: () => void }) {
  const navigate = useNavigate()
  const { t, language } = useI18n()
  const location = useLocation()
  const { sessionId } = useParams()
  const sessions = useChatStore((state) => state.sessions)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set())
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [prefs, setPrefs] = useState<SessionListPrefs>(loadSessionListPrefs)
  const [activeTab, setActiveTab] = useState<SidebarTab>('messages')
  const [accountProfile, setAccountProfile] = useState<AccountProfile>(defaultAccountProfile)
  const [workspaceFulls, setWorkspaceFulls] = useState<WorkspaceFull[]>([])
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [openingAgentId, setOpeningAgentId] = useState<string | null>(null)
  const pinnedIds = useMemo(() => new Set(prefs.pinned), [prefs.pinned])
  const archivedIds = useMemo(() => new Set(prefs.archived), [prefs.archived])
  const archivedSessionCount = useMemo(() => prefs.archived.length, [prefs.archived])
  const activeSessionCount = useMemo(() => sessions.length - prefs.archived.length, [sessions.length, prefs.archived])
  const sessionTree = useMemo(
    () => filterSessionTree(buildSessionTree(sessions, pinnedIds), query, showArchived, archivedIds),
    [archivedIds, pinnedIds, query, sessions, showArchived]
  )
  const activeSession = sessions.find((session) => session.id === sessionId)

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  useEffect(() => {
    let cancelled = false
    async function loadAccountProfile() {
      const settings = await api.getSettings().catch((): Record<string, string> => ({}))
      if (cancelled) return
      setAccountProfile(readAccountProfile(settings.APP_SETTINGS))
    }
    void loadAccountProfile()
    window.addEventListener(settingsUpdatedEvent, loadAccountProfile)
    return () => {
      cancelled = true
      window.removeEventListener(settingsUpdatedEvent, loadAccountProfile)
    }
  }, [])

  useEffect(() => {
    if (['/agent-world', '/coding-tools', '/office'].includes(location.pathname)) {
      setActiveTab('workspace')
    } else if (location.pathname === '/settings') {
      setActiveTab('me')
    }
  }, [location.pathname])

  useEffect(() => {
    if (activeTab !== 'agents') return
    let cancelled = false
    setWorkspaceLoading(true)
    api
      .listWorkspaces()
      .then(({ items }) => Promise.all(items.map((workspace) => api.getWorkspace(workspace.id))))
      .then((items) => {
        if (!cancelled) setWorkspaceFulls(items)
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFulls([])
      })
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeTab])

  useEffect(() => {
    const syncPrefs = () => setPrefs(loadSessionListPrefs())
    window.addEventListener('storage', syncPrefs)
    window.addEventListener(sessionArchiveChangeEvent, syncPrefs)
    return () => {
      window.removeEventListener('storage', syncPrefs)
      window.removeEventListener(sessionArchiveChangeEvent, syncPrefs)
    }
  }, [])

  useEffect(() => {
    if (!activeSession?.workspaceId || activeSession.type !== 'direct' || !activeSession.workspaceAgentId) return
    setExpandedWorkspaces((current) => {
      if (current.has(activeSession.workspaceId!)) return current
      const next = new Set(current)
      next.add(activeSession.workspaceId!)
      return next
    })
  }, [activeSession?.id, activeSession?.type, activeSession?.workspaceAgentId, activeSession?.workspaceId])

  useEffect(() => {
    if (!activeSession?.workspaceId) return
    const group = sessionTree.find((item) => item.parent.workspaceId === activeSession.workspaceId && item.children.length > 0)
    if (!group) return
    setExpandedWorkspaces((current) => {
      if (current.has(activeSession.workspaceId!)) return current
      const next = new Set(current)
      next.add(activeSession.workspaceId!)
      return next
    })
  }, [activeSession?.workspaceId, sessionTree])

  function requestDelete(event: React.MouseEvent, session: Session) {
    event.stopPropagation()
    event.preventDefault()
    setDeleteTarget(session)
  }

  function updatePrefs(updater: (current: SessionListPrefs) => SessionListPrefs) {
    setPrefs((current) => {
      const next = normalizeSessionListPrefs(updater(current))
      saveSessionListPrefs(next)
      return next
    })
  }

  function togglePin(event: React.MouseEvent, session: Session) {
    event.stopPropagation()
    event.preventDefault()
    updatePrefs((current) => {
      const pinned = new Set(current.pinned)
      if (pinned.has(session.id)) pinned.delete(session.id)
      else pinned.add(session.id)
      return { ...current, pinned: [...pinned] }
    })
  }

  function toggleArchive(event: React.MouseEvent, session: Session, relatedSessionIds: string[] = []) {
    event.stopPropagation()
    event.preventDefault()
    const ids = [session.id, ...relatedSessionIds]
    const archiving = !archivedIds.has(session.id)
    updatePrefs((current) => {
      const archived = new Set(current.archived)
      const pinned = new Set(current.pinned)
      for (const id of ids) {
        if (archiving) {
          archived.add(id)
          pinned.delete(id)
        } else {
          archived.delete(id)
        }
      }
      return { pinned: [...pinned], archived: [...archived] }
    })
    if (archiving && ids.includes(sessionId ?? '')) {
      navigate('/', { replace: true })
    }
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

  async function openAgentSession(workspaceId: string, agent: WorkspaceAgent) {
    if (openingAgentId) return
    setOpeningAgentId(agent.id)
    try {
      const { session } = await api.openWorkspaceAgentSession(workspaceId, agent.id)
      await fetchSessions()
      navigate(`/chat/${session.id}`)
    } finally {
      setOpeningAgentId(null)
    }
  }

  return (
    <aside className="flex h-full min-h-0 w-[340px] shrink-0 overflow-hidden border-r border-neutral-200 bg-[#f7f7f4]">
      <div className="flex h-full w-[68px] shrink-0 flex-col items-center justify-between border-r border-neutral-200 bg-[#f7f7f4] py-3">
        <button
          type="button"
          onClick={() => {
            setActiveTab('me')
            navigate('/settings')
          }}
          className="grid h-10 w-10 place-items-center overflow-hidden rounded-xl bg-white shadow-sm"
          aria-label={accountProfile.name}
          title={accountProfile.name}
        >
          <AccountAvatar name={accountProfile.name} avatar={accountProfile.avatar} />
        </button>

        <div className="flex flex-1 flex-col items-center gap-2 pt-2">
          <DockButton active={activeTab === 'messages'} icon={MessageCircle} label="Messages" onClick={() => setActiveTab('messages')} />
          <DockButton active={activeTab === 'agents'} icon={Users} label="Agent" onClick={() => setActiveTab('agents')} />
          <DockButton active={activeTab === 'workspace'} icon={BriefcaseBusiness} label="Workspace" onClick={() => setActiveTab('workspace')} />
          <DockButton active={activeTab === 'me'} icon={UserCircle} label="Me" onClick={() => setActiveTab('me')} />
        </div>

        <div className="flex flex-col items-center gap-2">
          <DockButton icon={Settings2} label="Settings" onClick={() => navigate('/settings')} />
          <DockButton icon={Menu} label="Menu" onClick={() => setActiveTab('messages')} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-[#f7f7f4]">
      <div className="agenthub-session-panel-header flex h-14 items-center justify-between px-4">
        <div className="agenthub-session-panel-brand flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-neutral-950 text-white">
            <MessageCircle className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold text-neutral-950">AgentHub</span>
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="grid h-8 w-8 place-items-center rounded-md text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-900"
            aria-label="收起侧栏"
            title="收起侧栏"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className={cn('px-2 pt-3', activeTab !== 'messages' && 'hidden')}>
        <div className="mb-3 flex w-full items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-3 text-left shadow-sm transition hover:border-neutral-300">
          <button
            type="button"
            onClick={requestNewSessionDialog}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#eef8f6] text-[#8ba9a4] transition hover:bg-[#e3f2ef]"
            aria-label={t('新建会话')}
          >
            <Bot className="h-5 w-5" />
          </button>
          <button type="button" onClick={requestNewSessionDialog} className="min-w-0 flex-1 text-left">
            <div className="truncate text-sm font-medium text-neutral-950">{t('新建会话')}</div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-neutral-500">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              {t('空闲中')}
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

        <div className="mb-2 flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-2.5 text-neutral-400 shadow-sm">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
            placeholder={t('搜索会话')}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowArchived((value) => !value)}
          className={cn(
            'mb-3 flex h-8 w-full items-center justify-between rounded-lg px-2 text-xs transition',
            showArchived ? 'bg-white text-neutral-950 shadow-sm' : 'text-neutral-500 hover:bg-white/70'
          )}
        >
          <span className="inline-flex items-center gap-2">
            {showArchived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            {showArchived ? t('查看归档') : t('当前会话')}
          </span>
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-500">
            {showArchived ? archivedSessionCount : activeSessionCount}
          </span>
        </button>
      </div>

      <nav className={cn('space-y-1 px-3 pt-3', activeTab !== 'workspace' && 'hidden')}>
        <NavItem
          icon={Code2}
          label="Coding Tools"
          active={location.pathname === '/coding-tools'}
          onClick={() => navigate('/coding-tools')}
        />
        <NavItem
          icon={MessageCircle}
          label="Agent Group"
          active={location.pathname === '/agent-world'}
          onClick={() => navigate('/agent-world')}
        />
        <NavItem
          icon={Building2}
          label={t('办公室')}
          active={location.pathname === '/office'}
          onClick={() => navigate('/office')}
        />
      </nav>

      {activeTab === 'workspace' && (
        <div className="px-3 pt-3 text-xs leading-5 text-neutral-500">
          <div className="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
            <div className="font-medium text-neutral-900">工作台</div>
            <div className="mt-1">项目、Agent Group 和本地工具入口统一放在这里。</div>
          </div>
        </div>
      )}

      <div className={cn('my-3 border-t border-neutral-200', activeTab !== 'messages' && 'hidden')} />

      <div className={cn('flex-1 overflow-y-auto px-2', activeTab !== 'messages' && 'hidden')}>
        <div className="mb-1 px-2 text-xs text-neutral-400">{t('历史话题')}</div>
        {sessionTree.length === 0 ? (
          <div className="px-2 py-4 text-xs text-neutral-400">
            {query.trim() ? t('没有匹配的会话') : showArchived ? t('还没有归档会话') : t('还没有会话')}
          </div>
        ) : (
          <ul className="space-y-1">
            {sessionTree.map((item) => {
              const hasChildren = item.children.length > 0
              const workspaceId = item.parent.workspaceId
              const expanded = Boolean(workspaceId && expandedWorkspaces.has(workspaceId))
              const childActive = item.children.some((child) => child.id === sessionId)
              const active = sessionId === item.parent.id
              const pinned = pinnedIds.has(item.parent.id)
              const archived = archivedIds.has(item.parent.id)
              return (
                <li key={item.parent.id} className="space-y-1">
                  <div
                    className={cn(
                      'group flex items-center gap-1 rounded-xl transition',
                      active || childActive ? 'bg-white shadow-sm' : 'hover:bg-white/70',
                    )}
                  >
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
                        active || childActive ? 'text-neutral-950' : 'text-neutral-600',
                      )}
                    >
                      {pinned && <Pin className="h-3.5 w-3.5 shrink-0 fill-neutral-900 text-neutral-900" />}
                      {hasChildren ? (
                        <ChevronRight className={cn('h-4 w-4 shrink-0 text-neutral-400 transition-transform', expanded && 'rotate-90')} />
                      ) : (
                        <History className="h-4 w-4 shrink-0 text-neutral-400" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{sessionDisplayTitle(item.parent.title, t)}</span>
                        <span className="block truncate text-[11px] text-neutral-400">
                          {hasChildren
                            ? `${formatSubtopicCount(item.children.length, language, t)} · ${relativeTime(item.latestUpdatedAt, language)}`
                            : relativeTime(item.latestUpdatedAt, language)}
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={(event) => togglePin(event, item.parent)}
                      className={cn(
                        'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900',
                        active || childActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                      title={pinned ? t('取消置顶') : t('置顶')}
                    >
                      {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      onClick={(event) => toggleArchive(event, item.parent, item.children.map((child) => child.id))}
                      className={cn(
                        'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900',
                        active || childActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                      title={archived ? t('移出归档') : t('归档')}
                    >
                      {archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      onClick={(event) => requestDelete(event, item.parent)}
                      className={cn(
                        'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-500',
                        active || childActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                      title={t('删除')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {hasChildren && expanded && (
                    <ul className="ml-4 space-y-1 border-l border-neutral-200 pl-2">
                      {item.children.map((child) => (
                        <li
                          key={child.id}
                          className={cn(
                            'group/child flex items-center gap-1 rounded-lg transition',
                            sessionId === child.id ? 'bg-white shadow-sm' : 'hover:bg-white/70',
                          )}
                        >
                          <button
                            onClick={() => navigate(`/chat/${child.id}`)}
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition',
                              sessionId === child.id ? 'text-neutral-950' : 'text-neutral-500 hover:text-neutral-800'
                            )}
                          >
                            {pinnedIds.has(child.id) ? (
                              <Pin className="h-3 w-3 shrink-0 fill-neutral-700 text-neutral-700" />
                            ) : (
                              <History className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{sessionDisplayTitle(childSessionTitle(child, item.parent), t)}</span>
                              <span className="block truncate text-[10px] text-neutral-400">{relativeTime(child.updatedAt, language)}</span>
                            </span>
                          </button>
                          <button
                            onClick={(event) => togglePin(event, child)}
                            className={cn(
                              'grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900',
                              sessionId === child.id ? 'opacity-100' : 'opacity-0 group-hover/child:opacity-100',
                            )}
                            title={pinnedIds.has(child.id) ? t('取消置顶') : t('置顶')}
                          >
                            {pinnedIds.has(child.id) ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                          </button>
                          <button
                            onClick={(event) => toggleArchive(event, child)}
                            className={cn(
                              'grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900',
                              sessionId === child.id ? 'opacity-100' : 'opacity-0 group-hover/child:opacity-100',
                            )}
                            title={archivedIds.has(child.id) ? t('移出归档') : t('归档')}
                          >
                            {archivedIds.has(child.id) ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
                          </button>
                          <button
                            onClick={(event) => requestDelete(event, child)}
                            className={cn(
                              'grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-500',
                              sessionId === child.id ? 'opacity-100' : 'opacity-0 group-hover/child:opacity-100',
                            )}
                            title={t('删除')}
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

      {activeTab === 'agents' && (
        <div className="flex-1 overflow-y-auto px-2 pt-3">
          <div className="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-neutral-950">Agent 联系人</div>
                <div className="mt-1 truncate text-xs text-neutral-500">
                  {workspaceLoading ? '正在加载工作区...' : '点击 Agent 直接打开独立会话'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigate('/agent-world')}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900"
                aria-label="管理 Agent"
                title="管理 Agent"
              >
                <Settings2 className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-3 space-y-2">
              {workspaceFulls.flatMap((entry) =>
                entry.agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => openAgentSession(entry.workspace.id, agent)}
                    disabled={openingAgentId === agent.id}
                    className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-[#fbfbf9] px-3 py-2.5 text-left transition hover:border-neutral-300 hover:bg-white disabled:opacity-60"
                  >
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: agent.color }}>
                      {agent.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-neutral-950">{agent.name}</div>
                      <div className="mt-0.5 truncate text-xs text-neutral-500">{agent.role}</div>
                    </div>
                    <div className="max-w-16 truncate text-[11px] text-neutral-400">
                      {openingAgentId === agent.id ? '打开中...' : entry.workspace.name}
                    </div>
                  </button>
                ))
              )}
              {!workspaceLoading && workspaceFulls.every((entry) => entry.agents.length === 0) && (
                <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400">
                  还没有可用的 Agent
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'me' && (
        <div className="flex-1 px-2 pt-3 text-xs leading-5 text-neutral-500">
          <div className="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-2xl border border-neutral-200 bg-white">
                <AccountAvatar name={accountProfile.name} avatar={accountProfile.avatar} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-neutral-950">{accountProfile.name}</div>
                <div className="mt-1 truncate text-xs text-neutral-500">Local account</div>
              </div>
            </div>
            <div className="mt-3">快捷键、主题、归档会话和客户端设置都在这里。</div>
          </div>
        </div>
      )}

      <div className={cn('border-t border-neutral-200 p-2', activeTab !== 'me' && 'hidden')}>
        <button
          onClick={() => navigate('/settings')}
          className="flex h-10 w-full items-center gap-3 rounded-lg px-2 text-sm text-neutral-700 transition hover:bg-white/70"
        >
          <Settings2 className="h-4 w-4 text-neutral-500" />
          {t('设置')}
        </button>
      </div>
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
  const { t, language } = useI18n()

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/30 px-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-session-title"
      onMouseDown={onClose}
    >
      <div
        className="agenthub-portal-theme w-full max-w-[382px] rounded-2xl border border-neutral-200 bg-white p-4 shadow-[0_24px_80px_rgba(15,23,42,0.16)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-500">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="delete-session-title" className="text-sm font-semibold text-neutral-950">
              {t('删除会话')}
            </h2>
            <p className="mt-1 text-xs leading-5 text-neutral-500">
              {t('这个会话和其中的消息会被移除，此操作不可撤销。')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40"
            aria-label={t('关闭')}
            title={t('关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-neutral-200 bg-[#f7f7f4] px-3 py-2">
          <div className="truncate text-sm font-medium text-neutral-900">{sessionDisplayTitle(session.title, t) || t('未命名会话')}</div>
          <div className="mt-0.5 text-xs text-neutral-500">{relativeTime(session.updatedAt, language)}</div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
          >
            {t('取消')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-medium text-white transition hover:bg-red-500 disabled:bg-red-200"
          >
            {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('删除')}
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

function DockButton({
  icon: Icon,
  label,
  active = false,
  onClick,
}: {
  icon: typeof Folder
  label: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative grid h-10 w-10 place-items-center rounded-xl transition',
        active ? 'bg-neutral-950 text-white shadow-sm' : 'text-neutral-500 hover:bg-white/80 hover:text-neutral-900',
      )}
      title={label}
      aria-label={label}
    >
      <Icon className="h-5 w-5" />
    </button>
  )
}

function AccountAvatar({ name, avatar }: AccountProfile) {
  if (avatar) {
    return <img src={avatar} alt={name || 'Account avatar'} className="h-full w-full object-cover" />
  }
  return (
    <span className="text-sm font-semibold text-neutral-950">
      {(name.trim().slice(0, 1) || 'Y').toUpperCase()}
    </span>
  )
}

function readAccountProfile(value?: string): AccountProfile {
  if (!value) return defaultAccountProfile
  try {
    const parsed = JSON.parse(value) as Partial<{ accountName: string; accountAvatar: string }>
    return {
      name: typeof parsed.accountName === 'string' && parsed.accountName.trim() ? parsed.accountName.trim() : defaultAccountProfile.name,
      avatar: typeof parsed.accountAvatar === 'string' ? parsed.accountAvatar : '',
    }
  } catch {
    return defaultAccountProfile
  }
}

function buildSessionTree(sessions: Session[], pinnedIds = new Set<string>()): SessionGroup[] {
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
          ? [...(childrenByWorkspace.get(parent.workspaceId) ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          : []
      const latestUpdatedAt = [parent, ...children].reduce(
        (latest, session) => (Date.parse(session.updatedAt) > Date.parse(latest) ? session.updatedAt : latest),
        parent.updatedAt
      )
      return { parent, children, latestUpdatedAt }
    })
    .sort((a, b) => comparePinnedGroups(a, b, pinnedIds))
}

function childSessionTitle(session: Session, parent: Session) {
  const withoutParent = parent.title ? session.title.replace(parent.title, '').replace(/^(\s*\/\s*)+/, '') : session.title
  const parts = withoutParent
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length ? parts.join(' / ') : session.title
}

function sessionDisplayTitle(title: string | undefined, t: (text: string) => string) {
  const normalized = title?.trim() ?? ''
  if (normalized === '新会话' || normalized === 'New Chat') return t('新会话')
  if (normalized === '快速对话' || normalized === 'Quick Chat') return t('快速对话')
  return normalized
}

function formatSubtopicCount(count: number, language: 'zh' | 'en', t: (text: string) => string) {
  if (language === 'en') return `${count} ${count === 1 ? 'subtopic' : 'subtopics'}`
  return `${count} 个${t('子话题')}`
}

function filterSessionTree(groups: SessionGroup[], query: string, showArchived: boolean, archivedIds: Set<string>) {
  const keyword = query.trim().toLowerCase()
  return groups
    .map((group) => {
      const parentArchived = archivedIds.has(group.parent.id)
      const children = group.children.filter((child) => archivedIds.has(child.id) === showArchived && sessionMatchesQuery(child, keyword, group.parent))
      const parentVisible = parentArchived === showArchived && sessionMatchesQuery(group.parent, keyword)
      if (!parentVisible && !children.length) return null
      return {
        ...group,
        children,
        latestUpdatedAt: [parentVisible ? group.parent : null, ...children]
          .filter((item): item is Session => Boolean(item))
          .reduce((latest, session) => (Date.parse(session.updatedAt) > Date.parse(latest) ? session.updatedAt : latest), group.latestUpdatedAt),
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
