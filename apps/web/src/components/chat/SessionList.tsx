import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  BriefcaseBusiness,
  Clock,
  ChevronRight,
  Code2,
  Building2,
  SlidersHorizontal,
  Folder,
  History,
  Loader2,
  MessageCircle,
  PanelLeft,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  Trash2,
  UserPlus,
  UserCircle,
  Users,
  Wand2,
  X,
} from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { cn, relativeTime } from '../../lib/utils'
import { friendlyErrorMessage, type Session } from '../../lib/api'
import {
  agentLibraryChangeEvent,
  loadAgentLibrary,
  type SavedAgentConfig,
} from '../../lib/agentLibrary'
import { startAgentConversation } from '../../lib/agentConversation'
import { useI18n } from '../../lib/i18n'
import { loadSessionListPrefs, normalizeSessionListPrefs, saveSessionListPrefs, sessionArchiveChangeEvent, type SessionListPrefs } from '../../lib/sessionArchive'
import { requestSettingsDialog } from '../../lib/settingsDialog'
import { settingsUpdatedEvent } from '../../lib/shortcuts'
import { buildSessionTree, filterSessionTree } from '../../lib/sessionTree'
import {
  getCachedAccountProfile,
  loadAccountProfileFromSettings,
  sameAccountProfile,
  type AccountProfile,
} from '../../lib/accountProfile'
import { requestNewSessionDialog } from './GlobalNewSessionDialog'

type SidebarTab = 'messages' | 'agents' | 'workspace' | 'me'

function activeTabFromPath(pathname: string): SidebarTab {
  if (pathname === '/agent-config') return 'agents'
  if (pathname === '/profile' || pathname === '/settings') return 'me'
  if (['/models', '/coding-tools', '/skills', '/office', '/orchestrator-runs', '/execution-logs'].includes(pathname)) return 'workspace'
  return 'messages'
}

export default function SessionList({ onCollapse }: { onCollapse?: () => void }) {
  const navigate = useNavigate()
  const { t, language } = useI18n()
  const location = useLocation()
  const { sessionId } = useParams()
  const sessions = useChatStore((state) => state.sessions)
  const sessionsBootstrapped = useChatStore((state) => state.sessionsBootstrapped)
  const loadingSessions = useChatStore((state) => state.loadingSessions)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const selectSession = useChatStore((state) => state.selectSession)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set())
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [prefs, setPrefs] = useState<SessionListPrefs>(loadSessionListPrefs)
  const [accountProfile, setAccountProfile] = useState<AccountProfile>(getCachedAccountProfile)
  const [libraryAgents, setLibraryAgents] = useState<SavedAgentConfig[]>([])
  const [agentQuery, setAgentQuery] = useState('')
  const [quickCreateOpen, setQuickCreateOpen] = useState(false)
  const [openingAgentId, setOpeningAgentId] = useState<string | null>(null)
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null)
  const [hint, setHint] = useState('')
  const pinnedIds = useMemo(() => new Set(prefs.pinned), [prefs.pinned])
  const archivedIds = useMemo(() => new Set(prefs.archived), [prefs.archived])
  const baseSessionTree = useMemo(() => buildSessionTree(sessions, pinnedIds), [pinnedIds, sessions])
  const archivedSessionCount = useMemo(
    () => filterSessionTree(baseSessionTree, '', true, archivedIds).length,
    [archivedIds, baseSessionTree],
  )
  const activeSessionCount = useMemo(
    () => filterSessionTree(baseSessionTree, '', false, archivedIds).length,
    [archivedIds, baseSessionTree],
  )
  const sessionTree = useMemo(
    () => filterSessionTree(baseSessionTree, query, showArchived, archivedIds),
    [archivedIds, baseSessionTree, query, showArchived],
  )
  const activeSession = sessions.find((session) => session.id === sessionId)
  const activeTab = activeTabFromPath(location.pathname)
  const activeAgentConfigId = new URLSearchParams(location.search).get('agentId')
  const filteredLibraryAgents = useMemo(() => {
    const keyword = agentQuery.trim().toLowerCase()
    if (!keyword) return libraryAgents
    return libraryAgents.filter((agent) =>
      [agent.name, agent.role, agent.description, ...(agent.capabilityTags ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    )
  }, [agentQuery, libraryAgents])

  useEffect(() => {
    if (sessionsBootstrapped || loadingSessions) return
    fetchSessions()
  }, [fetchSessions, loadingSessions, sessionsBootstrapped])

  useEffect(() => {
    let cancelled = false
    function applyAccountProfile(profile: AccountProfile) {
      if (cancelled) return
      setAccountProfile((current) => (sameAccountProfile(current, profile) ? current : profile))
    }
    function syncAccountProfile() {
      applyAccountProfile(getCachedAccountProfile())
      void loadAccountProfileFromSettings().then(applyAccountProfile)
    }
    syncAccountProfile()
    window.addEventListener(settingsUpdatedEvent, syncAccountProfile)
    return () => {
      cancelled = true
      window.removeEventListener(settingsUpdatedEvent, syncAccountProfile)
    }
  }, [])

  useEffect(() => {
    const syncAgents = () => setLibraryAgents(loadAgentLibrary())
    syncAgents()
    window.addEventListener(agentLibraryChangeEvent, syncAgents)
    window.addEventListener('storage', syncAgents)
    return () => {
      window.removeEventListener(agentLibraryChangeEvent, syncAgents)
      window.removeEventListener('storage', syncAgents)
    }
  }, [])

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

  function showHint(text: string) {
    setHint(text)
    window.setTimeout(() => setHint(''), 1800)
  }

  function openNewSessionDialog() {
    setQuickCreateOpen(false)
    requestNewSessionDialog()
  }

  function addAgent() {
    setQuickCreateOpen(false)
    navigate('/agent-config?newAgent=1')
  }

  function toggleWorkspaceExpanded(workspaceId?: string | null) {
    if (!workspaceId) return
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }

  async function openExistingSession(session: Session) {
    if (openingSessionId === session.id) return
    setOpeningSessionId(session.id)
    try {
      navigate(`/chat/${session.id}`)
      if (currentSessionId !== session.id) {
        await selectSession(session.id)
      }
    } catch (error) {
      showHint(friendlyErrorMessage(error, '打开会话失败'))
    } finally {
      setOpeningSessionId(null)
    }
  }

  async function openAgentSession(agent: SavedAgentConfig) {
    if (openingAgentId) return
    setOpeningAgentId(agent.id)
    try {
      const existing = findExistingAgentSession(sessions, agent)
      if (existing) {
        await openExistingSession(existing)
        return
      }
      const session = await startAgentConversation({ agents: [agent] })
      await fetchSessions()
      await openExistingSession(session)
    } catch (error) {
      showHint(friendlyErrorMessage(error, `打开 ${agent.name} 失败`))
    } finally {
      setOpeningAgentId(null)
    }
  }

  return (
    <aside className="agenthub-session-sidebar flex h-full min-h-0 w-[340px] shrink-0 overflow-hidden border-r border-neutral-200 bg-[#FBFBFB]">
      <div className="flex h-full w-[68px] shrink-0 flex-col items-center justify-between border-r border-neutral-200 bg-[#FBFBFB] py-3">
        <button
          type="button"
          onClick={() => navigate('/profile')}
          className="grid h-10 w-10 place-items-center overflow-hidden rounded-xl bg-[#F7F7F7] shadow-sm"
          aria-label={accountProfile.name}
          title={accountProfile.name}
        >
          <AccountAvatar name={accountProfile.name} avatar={accountProfile.avatar} />
        </button>

        <div className="flex flex-1 flex-col items-center gap-2 pt-2">
          <DockButton
            active={activeTab === 'messages'}
            icon={MessageCircle}
            label="Messages"
            onClick={() => {
              navigate(sessionId ? `/chat/${sessionId}` : '/')
            }}
          />
          <DockButton
            active={activeTab === 'agents'}
            icon={Users}
            label="Agent"
            onClick={() => {
              navigate('/agent-config')
            }}
          />
          <DockButton
            active={activeTab === 'workspace'}
            icon={BriefcaseBusiness}
            label="Workspace"
            onClick={() => {
              navigate('/coding-tools')
            }}
          />
          <DockButton
            active={activeTab === 'me'}
            icon={UserCircle}
            label="Me"
            onClick={() => navigate('/profile')}
          />
        </div>

        <div className="flex flex-col items-center gap-2">
          <DockButton icon={Settings2} label="Settings" onClick={requestSettingsDialog} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-[#FBFBFB]">
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
          <div className="relative mb-2 flex h-9 items-center gap-2">
            <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border border-neutral-200 bg-[#F7F7F7] px-2.5 text-neutral-400 shadow-sm">
              <Search className="h-4 w-4 shrink-0" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
                placeholder={t('搜索')}
              />
            </div>
            <button
              type="button"
              onClick={() => setQuickCreateOpen((open) => !open)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-neutral-600 transition hover:bg-[#F7F7F7] hover:text-neutral-950"
              aria-label="新建"
              title="新建"
            >
              <Plus className="h-4 w-4" />
            </button>
            {quickCreateOpen && (
              <div className="absolute right-0 top-10 z-30 w-36 rounded-lg border border-neutral-200 bg-[#FBFBFB] py-1.5 text-sm shadow-xl">
                <span className="absolute -top-1.5 right-3 h-3 w-3 rotate-45 border-l border-t border-neutral-200 bg-[#FBFBFB]" />
                <button
                  type="button"
                  onClick={openNewSessionDialog}
                  className="relative flex h-9 w-full items-center gap-2 px-3 text-left text-neutral-800 hover:bg-[#F7F7F7]"
                >
                  <MessageCircle className="h-4 w-4 text-neutral-600" />
                  新建群聊
                </button>
                <button
                  type="button"
                  onClick={addAgent}
                  className="relative flex h-9 w-full items-center gap-2 px-3 text-left text-neutral-800 hover:bg-[#F7F7F7]"
                >
                  <UserPlus className="h-4 w-4 text-neutral-600" />
                  添加 Agent
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            className={cn(
              'mb-3 flex h-8 w-full items-center justify-between rounded-lg px-2 text-xs transition',
              showArchived ? 'bg-[#F7F7F7] text-neutral-950 shadow-sm' : 'text-neutral-500 hover:bg-[#F7F7F7]',
            )}
          >
            <span className="inline-flex items-center gap-2">
              {showArchived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
              {showArchived ? t('查看归档') : t('当前会话')}
            </span>
            <span className="rounded-full bg-[#F7F7F7] px-2 py-0.5 text-[11px] text-neutral-500">
              {showArchived ? archivedSessionCount : activeSessionCount}
            </span>
          </button>
        </div>
      {activeTab === 'workspace' && (
        <div className="px-3 pt-3">
          <div className="px-1 text-sm font-medium text-neutral-900">&gt;工作区</div>
        </div>
      )}

      <nav className={cn('space-y-1 px-3 pt-3', activeTab !== 'workspace' && 'hidden')}>
        <NavItem
          icon={History}
          label="运行历史"
          active={location.pathname === '/orchestrator-runs'}
          onClick={() => navigate('/orchestrator-runs')}
        />
        <NavItem
          icon={Clock}
          label="执行日志"
          active={location.pathname === '/execution-logs'}
          onClick={() => navigate('/execution-logs')}
        />
        <NavItem
          icon={SlidersHorizontal}
          label="模型管理"
          active={location.pathname === '/models'}
          onClick={() => navigate('/models')}
        />
        <NavItem
          icon={Code2}
          label="Coding Tools"
          active={location.pathname === '/coding-tools'}
          onClick={() => navigate('/coding-tools')}
        />
        <NavItem
          icon={Wand2}
          label="Skills 市场"
          active={location.pathname === '/skills'}
          onClick={() => navigate('/skills')}
        />
        <NavItem
          icon={Building2}
          label={t('办公室')}
          active={location.pathname === '/office'}
          onClick={() => navigate('/office')}
        />
      </nav>

      <div className={cn('my-3 border-t border-neutral-200', activeTab !== 'messages' && 'hidden')} />

      <div className={cn('flex-1 overflow-y-auto px-2 pb-4', activeTab !== 'messages' && 'hidden')}>
        {hint && (
          <div className="mb-2 px-2">
            <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-white shadow">
              {hint}
            </div>
          </div>
        )}
        <div className="mb-1 px-2 text-xs text-neutral-400">{t('群聊')}</div>
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
                    onClick={() => void openExistingSession(item.parent)}
                    className={cn(
                      'group cursor-pointer flex items-center gap-1 rounded-xl transition',
                      active || childActive ? 'bg-[#F7F7F7] shadow-sm' : 'hover:bg-[#F7F7F7]',
                    )}
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        void openExistingSession(item.parent)
                      }}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition',
                        active || childActive ? 'text-neutral-950' : 'text-neutral-600',
                      )}
                    >
                      {pinned && <Pin className="h-3.5 w-3.5 shrink-0 fill-neutral-900 text-neutral-900" />}
                      {hasChildren ? (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation()
                            event.preventDefault()
                            toggleWorkspaceExpanded(workspaceId)
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return
                            event.stopPropagation()
                            event.preventDefault()
                            toggleWorkspaceExpanded(workspaceId)
                          }}
                          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 transition hover:bg-[#F7F7F7] hover:text-neutral-900"
                          aria-label={expanded ? '收起群聊' : '展开群聊'}
                          title={expanded ? '收起群聊' : '展开群聊'}
                        >
                          <ChevronRight className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')} />
                        </span>
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
                      {openingSessionId === item.parent.id && (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-300" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => togglePin(event, item.parent)}
                      className={cn(
                        'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-[#F7F7F7] hover:text-neutral-900',
                        active || childActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                      title={pinned ? t('取消置顶') : t('置顶')}
                    >
                      {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => toggleArchive(event, item.parent, item.children.map((child) => child.id))}
                      className={cn(
                        'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-[#F7F7F7] hover:text-neutral-900',
                        active || childActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                      title={archived ? t('移出归档') : t('归档')}
                    >
                      {archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
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
                          onClick={() => void openExistingSession(child)}
                          className={cn(
                            'group/child flex cursor-pointer items-center gap-1 rounded-lg transition',
                            sessionId === child.id ? 'bg-[#F7F7F7] shadow-sm' : 'hover:bg-[#F7F7F7]',
                          )}
                        >
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              void openExistingSession(child)
                            }}
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
                            {openingSessionId === child.id && (
                              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-300" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => togglePin(event, child)}
                            className={cn(
                              'grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-[#F7F7F7] hover:text-neutral-900',
                              sessionId === child.id ? 'opacity-100' : 'opacity-0 group-hover/child:opacity-100',
                            )}
                            title={pinnedIds.has(child.id) ? t('取消置顶') : t('置顶')}
                          >
                            {pinnedIds.has(child.id) ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => toggleArchive(event, child)}
                            className={cn(
                              'grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-[#F7F7F7] hover:text-neutral-900',
                              sessionId === child.id ? 'opacity-100' : 'opacity-0 group-hover/child:opacity-100',
                            )}
                            title={archivedIds.has(child.id) ? t('移出归档') : t('归档')}
                          >
                            {archivedIds.has(child.id) ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
                          </button>
                          <button
                            type="button"
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

        <div className="my-4 border-t border-neutral-200" />
        <div className="mb-1 flex items-center justify-between px-2 text-xs text-neutral-400">
          <span>Agent</span>
          <span>{libraryAgents.length}</span>
        </div>
        <div className="space-y-1">
          {libraryAgents.map((agent) => {
            const opening = openingAgentId === agent.id
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => void openAgentSession(agent)}
                disabled={opening}
                className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-[#F7F7F7] disabled:opacity-60"
              >
                <div
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-sm font-semibold text-white shadow-sm"
                  style={{ background: agent.color ?? '#111827' }}
                >
                  {agent.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-950">{agent.name}</div>
                  <div className="mt-0.5 truncate text-xs text-neutral-500">{agent.role}</div>
                </div>
                {opening ? (
                  <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
                ) : (
                  <MessageCircle className="h-4 w-4 text-neutral-300" />
                )}
              </button>
            )
          })}
          {!libraryAgents.length && (
            <div className="px-2 py-4 text-xs text-neutral-400">
              还没有 Agent，先去配置页创建一个
            </div>
          )}
        </div>
      </div>

      {activeTab === 'agents' && (
        <div className="flex-1 overflow-y-auto px-4 pt-3">
          <div className="mb-3 flex h-9 items-center gap-2 rounded-lg bg-[#F7F7F7] px-3 text-neutral-400 shadow-sm">
            <Search className="h-4 w-4 shrink-0" />
            <input
              value={agentQuery}
              onChange={(event) => setAgentQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
              placeholder="搜索"
            />
          </div>

          <button
            type="button"
            onClick={requestNewSessionDialog}
            className="mb-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#F7F7F7] text-sm font-medium text-neutral-800 shadow-sm transition hover:bg-neutral-100"
          >
            <Users className="h-4 w-4 text-neutral-500" />
            新建 Agent 群聊
          </button>

          <div className="mb-2 flex items-center justify-between px-1 text-xs text-neutral-500">
            <span>Agent 通讯录</span>
            <span>{filteredLibraryAgents.length}</span>
          </div>

          <div className="space-y-1">
            {filteredLibraryAgents.map((agent) => {
              const active = location.pathname === '/agent-config' && activeAgentConfigId === agent.id
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => navigate(`/agent-config?agentId=${encodeURIComponent(agent.id)}`)}
                  className={cn(
                    'flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition',
                    active ? 'bg-[#F7F7F7]' : 'hover:bg-[#F7F7F7]',
                  )}
                >
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: agent.color }}>
                    {agent.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-neutral-950">{agent.name}</div>
                    <div className="mt-0.5 truncate text-xs text-neutral-500">{agent.role}</div>
                  </div>
                  <div className="text-xs text-neutral-400">全局</div>
                </button>
              )
            })}
            {!filteredLibraryAgents.length && (
              <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400">
                {agentQuery.trim() ? '没有匹配的 Agent' : '还没有可用 Agent，请先新建一个。'}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'me' && (
        <div className="flex-1 px-2 pt-3 text-xs leading-5 text-neutral-500">
          <div className="rounded-2xl border border-neutral-200 bg-[#F7F7F7] p-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-2xl border border-neutral-200 bg-[#FBFBFB]">
                <AccountAvatar name={accountProfile.name} avatar={accountProfile.avatar} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-neutral-950">{accountProfile.name}</div>
                <div className="mt-1 truncate text-xs text-neutral-500">Local account</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate('/profile')}
              className="mt-3 flex h-9 w-full items-center justify-center rounded-lg bg-neutral-950 text-sm font-medium text-white transition hover:bg-neutral-800"
            >
              编辑个人资料
            </button>
          </div>
        </div>
      )}

      <div className={cn('border-t border-neutral-200 p-2', activeTab !== 'me' && 'hidden')}>
        <button
          onClick={requestSettingsDialog}
          className="flex h-10 w-full items-center gap-3 rounded-lg px-2 text-sm text-neutral-700 transition hover:bg-[#F7F7F7]"
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
        'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-sm text-neutral-700 transition hover:bg-[#F7F7F7]',
        strong && 'font-semibold text-neutral-950',
        active && 'bg-[#F7F7F7] text-neutral-950 shadow-sm'
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
        active ? 'bg-neutral-950 text-white shadow-sm' : 'text-neutral-500 hover:bg-[#F7F7F7] hover:text-neutral-900',
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
    return (
      <img
        src={avatar}
        alt={name || 'Account avatar'}
        className="h-full w-full object-cover"
        decoding="async"
        draggable={false}
      />
    )
  }
  return (
    <span className="text-sm font-semibold text-neutral-950">
      {(name.trim().slice(0, 1) || 'Y').toUpperCase()}
    </span>
  )
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

function findExistingAgentSession(sessions: Session[], agent: SavedAgentConfig) {
  const agentName = normalizeMatchText(agent.name)
  const agentRole = normalizeMatchText(agent.role)
  if (!agentName) return null
  const groupWorkspaceIds = new Set(
    sessions
      .filter((session) => session.type === 'group' && session.workspaceId)
      .map((session) => session.workspaceId!),
  )

  const directAgentSessions = sessions.filter((session) => {
    if (session.type !== 'direct' || !session.workspaceAgentId || !session.workspaceId) return false
    const metadata = session.metadata ?? {}
    if (metadata.kind === 'workspace-agent-child' || metadata.kind === 'orchestrator-task') return false
    if (metadata.orchestratorTaskId || metadata.orchestratorRunId || metadata.hiddenFromSessionTree) return false
    if (metadata.kind === 'agent-direct') return metadata.savedAgentId === agent.id
    return !groupWorkspaceIds.has(session.workspaceId)
  })

  return directAgentSessions.find((session) => {
    const title = normalizeMatchText(session.title)
    const titleParts = session.title.split('/').map((part) => normalizeMatchText(part))
    if (titleParts.some((part) => part === agentName)) return true
    return title.includes(agentName) && (!agentRole || title.includes(agentRole))
  }) ?? null
}

function normalizeMatchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}
