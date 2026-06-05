import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Brain,
  Blocks,
  Clock,
  ChevronRight,
  Code2,
  SlidersHorizontal,
  Folder,
  History,
  Loader2,
  MessageCircle,
  Pin,
  PinOff,
  Plus,
  QrCode,
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
import { api, friendlyErrorMessage, type MobileConnectivityStatus, type Session, type WorkspaceAgent } from '../../lib/api'
import {
  agentLibraryChangeEvent,
  loadAgentLibrary,
  type SavedAgentConfig,
} from '../../lib/agentLibrary'
import { startAgentConversation } from '../../lib/agentConversation'
import { useI18n } from '../../lib/i18n'
import {
  loadSessionListPrefs,
  normalizeSessionListPrefs,
  saveSessionListPrefs,
  sessionArchiveChangeEvent,
  type SessionListPrefs,
} from '../../lib/sessionArchive'
import { requestSettingsDialog } from '../../lib/settingsDialog'
import { settingsUpdatedEvent } from '../../lib/shortcuts'
import {
  buildSessionTree,
  filterSessionTree,
  isStableOrchestratorTaskSession,
} from '../../lib/sessionTree'
import {
  getCachedAccountProfile,
  loadAccountProfileFromSettings,
  sameAccountProfile,
  type AccountProfile,
} from '../../lib/accountProfile'
import { requestNewSessionDialog } from './GlobalNewSessionDialog'
import { GroupAvatar } from './GroupAvatar'
type SidebarTab = 'messages' | 'agents' | 'artifacts' | 'abilities' | 'me'

function activeTabFromPath(pathname: string): SidebarTab {
  if (pathname === '/agent-config') return 'agents'
  if (pathname === '/profile' || pathname === '/settings') return 'me'
  if (['/artifacts', '/orchestrator-runs', '/execution-logs'].includes(pathname))
    return 'artifacts'
  if (['/abilities', '/models', '/coding-tools', '/skills'].includes(pathname))
    return 'abilities'
  return 'messages'
}

export default function SessionList({
  collapsed = false,
  onCollapse,
}: {
  collapsed?: boolean
  onCollapse?: () => void
}) {
  const navigate = useNavigate()
  const { t, language } = useI18n()
  const location = useLocation()
  const { sessionId } = useParams()
  const sessions = useChatStore((state) => state.sessions)
  const currentSession = useChatStore((state) => state.currentSession)
  const taskBoard = useChatStore((state) => state.taskBoard)
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
  const [mobilePairingOpen, setMobilePairingOpen] = useState(false)
  const [tabOverride, setTabOverride] = useState<SidebarTab | null>(null)
  const [openingAgentId, setOpeningAgentId] = useState<string | null>(null)
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null)
  const [hint, setHint] = useState('')
  const [groupMemberCounts, setGroupMemberCounts] = useState<Record<string, number>>({})
  const [groupWorkspaceAgents, setGroupWorkspaceAgents] = useState<
    Record<string, WorkspaceAgent[]>
  >({})
  const pinnedIds = useMemo(() => new Set(prefs.pinned), [prefs.pinned])
  const archivedIds = useMemo(() => new Set(prefs.archived), [prefs.archived])
  const groupWorkspaceIds = useMemo(
    () =>
      new Set(
        sessions
          .filter((session) => session.type === 'group' && session.workspaceId)
          .map((session) => session.workspaceId!),
      ),
    [sessions],
  )
  const groupWorkspaceKey = useMemo(
    () => Array.from(groupWorkspaceIds).sort().join('|'),
    [groupWorkspaceIds],
  )
  const messageSessions = useMemo(
    () =>
      sessions.filter((session) => !isPrivateAgentSession(session)),
    [sessions],
  )
  const baseSessionTree = useMemo(
    () => buildSessionTree(messageSessions, pinnedIds),
    [messageSessions, pinnedIds],
  )
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
  const activeSession =
    sessions.find((session) => session.id === sessionId) ??
    (currentSession && currentSession.id === sessionId ? currentSession : undefined)
  const routeTab = activeTabFromPath(location.pathname)
  const activeTab = tabOverride ?? routeTab
  const isAgentConfigRoute = location.pathname === '/agent-config'
  const activeAgentConfigId = new URLSearchParams(location.search).get('agentId')
  const savedAgentIds = useMemo(
    () => new Set(libraryAgents.map((agent) => agent.id)),
    [libraryAgents],
  )
  const savedAgentById = useMemo(
    () => new Map(libraryAgents.map((agent) => [agent.id, agent] as const)),
    [libraryAgents],
  )
  const agentDirectSessionsBySavedId = useMemo(() => {
    const byAgentId = new Map<string, Session>()
    for (const session of sessions) {
      if (!isPrivateAgentSession(session)) continue
      const savedAgentId = readSavedAgentId(session)
      if (!savedAgentId || !savedAgentIds.has(savedAgentId)) continue
      if (byAgentId.has(savedAgentId)) continue
      byAgentId.set(savedAgentId, session)
    }
    return byAgentId
  }, [savedAgentIds, sessions])
  const filteredLibraryAgents = useMemo(
    () => filterAgents(libraryAgents, agentQuery),
    [agentQuery, libraryAgents],
  )
  const privateAgentSessions = useMemo(
    () =>
      sessions
        .filter((session) => {
          if (!isPrivateAgentSession(session)) return false
          const savedAgentId = readSavedAgentId(session)
          if (!savedAgentId || !savedAgentIds.has(savedAgentId)) return false
          if (!query.trim()) return true
          const savedAgent = libraryAgents.find((agent) => agent.id === savedAgentId) ?? null
          return [
            session.title,
            savedAgent?.name ?? '',
            savedAgent?.role ?? '',
            savedAgent?.description ?? '',
          ]
            .join(' ')
            .toLowerCase()
            .includes(query.trim().toLowerCase())
        })
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [libraryAgents, query, savedAgentIds, sessions],
  )
  const managerPrivateSessions = useMemo(
    () =>
      privateAgentSessions.filter((session) => {
        const savedAgentId = readSavedAgentId(session)
        const savedAgent = savedAgentId ? savedAgentById.get(savedAgentId) : null
        return isManagerSavedAgent(savedAgent)
      }),
    [privateAgentSessions, savedAgentById],
  )
  const workerPrivateSessions = useMemo(
    () =>
      privateAgentSessions.filter((session) => {
        const savedAgentId = readSavedAgentId(session)
        const savedAgent = savedAgentId ? savedAgentById.get(savedAgentId) : null
        return !isManagerSavedAgent(savedAgent)
      }),
    [privateAgentSessions, savedAgentById],
  )

  useEffect(() => {
    if (sessionsBootstrapped || loadingSessions) return
    fetchSessions()
  }, [fetchSessions, loadingSessions, sessionsBootstrapped])

  useEffect(() => {
    const workspaceIds = groupWorkspaceKey
      .split('|')
      .map((id) => id.trim())
      .filter(
        (id) => id && groupMemberCounts[id] === undefined && groupWorkspaceAgents[id] === undefined,
      )
    if (!workspaceIds.length) return

    let cancelled = false
    void Promise.allSettled(
      workspaceIds.map(async (workspaceId) => {
        const full = await api.getWorkspace(workspaceId)
        return [workspaceId, full.agents] as const
      }),
    ).then((results) => {
      if (cancelled) return
      setGroupMemberCounts((current) => {
        const next = { ...current }
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]
          const workspaceId = workspaceIds[index]
          if (!workspaceId) continue
          next[workspaceId] = result?.status === 'fulfilled' ? result.value[1].length + 1 : -1
        }
        return next
      })
      setGroupWorkspaceAgents((current) => {
        const next = { ...current }
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]
          const workspaceId = workspaceIds[index]
          if (!workspaceId) continue
          next[workspaceId] = result?.status === 'fulfilled' ? result.value[1] : []
        }
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [groupMemberCounts, groupWorkspaceAgents, groupWorkspaceKey])

  useEffect(() => {
    setTabOverride(null)
  }, [location.pathname, location.search])

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
    if (
      !activeSession?.workspaceId ||
      activeSession.type !== 'direct' ||
      (!activeSession.workspaceAgentId && !isStableOrchestratorTaskSession(activeSession))
    )
      return
    setExpandedWorkspaces((current) => {
      if (current.has(activeSession.workspaceId!)) return current
      const next = new Set(current)
      next.add(activeSession.workspaceId!)
      return next
    })
  }, [
    activeSession?.id,
    activeSession?.type,
    activeSession?.workspaceAgentId,
    activeSession?.workspaceId,
  ])

  useEffect(() => {
    if (!activeSession?.workspaceId) return
    const group = sessionTree.find(
      (item) => item.parent.workspaceId === activeSession.workspaceId && item.children.length > 0,
    )
    if (!group) return
    setExpandedWorkspaces((current) => {
      if (current.has(activeSession.workspaceId!)) return current
      const next = new Set(current)
      next.add(activeSession.workspaceId!)
      return next
    })
  }, [activeSession?.workspaceId, sessionTree])

  useEffect(() => {
    if (!taskBoard?.sessionId) return
    const groupSession =
      sessions.find((session) => session.id === taskBoard.sessionId) ??
      (currentSession?.id === taskBoard.sessionId ? currentSession : null)
    if (!groupSession?.workspaceId) return
    setExpandedWorkspaces((current) => {
      if (current.has(groupSession.workspaceId!)) return current
      const next = new Set(current)
      next.add(groupSession.workspaceId!)
      return next
    })
  }, [currentSession, sessions, taskBoard?.sessionId])

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

  function toggleArchive(
    event: React.MouseEvent,
    session: Session,
    relatedSessionIds: string[] = [],
  ) {
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

  function openExistingSession(session: Session) {
    if (openingSessionId === session.id) return
    navigate(`/chat/${session.id}`)
    if (currentSessionId === session.id) return
    setOpeningSessionId(session.id)
    void selectSession(session.id)
      .catch((error) => {
        navigate('/', { replace: true })
        showHint(friendlyErrorMessage(error, '打开会话失败'))
      })
      .finally(() => {
        setOpeningSessionId((current) => (current === session.id ? null : current))
      })
  }

  async function openAgentSession(agent: SavedAgentConfig) {
    if (openingAgentId) return
    setOpeningAgentId(agent.id)
    try {
      const session = await startAgentConversation({ agents: [agent] })
      await fetchSessions()
      openExistingSession(session)
    } catch (error) {
      showHint(friendlyErrorMessage(error, `打开 ${agent.name} 失败`))
    } finally {
      setOpeningAgentId(null)
    }
  }

  return (
    <>
      <aside className="agenthub-session-sidebar flex h-full min-h-0 w-[340px] shrink-0 overflow-hidden bg-[#FBFBFB]">
      <div className="flex h-full w-[68px] shrink-0 flex-col items-center justify-between bg-[#f2f2ee] py-3">
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
              if (collapsed) {
                setTabOverride('messages')
                navigate(sessionId ? `/chat/${sessionId}` : '/')
                onCollapse?.()
                return
              }
              if (activeTab === 'messages' && onCollapse) {
                onCollapse()
                return
              }
              setTabOverride('messages')
              navigate(sessionId ? `/chat/${sessionId}` : '/')
            }}
          />
          <DockButton
            active={activeTab === 'agents'}
            icon={Users}
            label="Agent"
            onClick={() => setTabOverride('agents')}
          />
          <DockButton
            active={activeTab === 'artifacts'}
            icon={Archive}
            label="产物"
            onClick={() => {
              navigate('/artifacts')
            }}
          />
          <DockButton
            active={activeTab === 'abilities'}
            icon={Blocks}
            label="能力"
            onClick={() => {
              navigate('/abilities')
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
            <DockButton icon={QrCode} label="扫码连接" onClick={() => setMobilePairingOpen(true)} />
            <DockButton icon={Settings2} label="Settings" onClick={requestSettingsDialog} />
          </div>
      </div>

      <div
        aria-hidden={collapsed}
        className={cn(
          'flex min-w-0 flex-1 flex-col bg-[#FBFBFB] transition-opacity duration-300',
          collapsed && 'pointer-events-none opacity-0',
        )}
      >
        <div className="agenthub-session-panel-header flex h-14 items-center justify-start px-4">
          <div className="agenthub-session-panel-brand flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-neutral-950 text-white">
              <MessageCircle className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold text-neutral-950">AgentHub</span>
          </div>
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
              aria-label="创建协作空间"
              title="创建协作空间"
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
                  创建房间
                </button>
                <button
                  type="button"
                  onClick={addAgent}
                  className="relative flex h-9 w-full items-center gap-2 px-3 text-left text-neutral-800 hover:bg-[#F7F7F7]"
                >
                  <UserPlus className="h-4 w-4 text-neutral-600" />
                  添加专家
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            className={cn(
              'mb-3 flex h-8 w-full items-center justify-between rounded-lg px-2 text-xs transition',
              showArchived
                ? 'bg-[#F7F7F7] text-neutral-950 shadow-sm'
                : 'text-neutral-500 hover:bg-[#F7F7F7]',
            )}
          >
            <span className="inline-flex items-center gap-2">
              {showArchived ? (
                <ArchiveRestore className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
              {showArchived ? t('查看归档') : t('当前会话')}
            </span>
            <span className="rounded-full bg-[#F7F7F7] px-2 py-0.5 text-[11px] text-neutral-500">
              {showArchived ? archivedSessionCount : activeSessionCount}
            </span>
          </button>
        </div>
        {activeTab === 'artifacts' && (
          <div className="px-3 pt-3">
            <div className="px-1 text-sm font-medium text-neutral-900">产物</div>
          </div>
        )}

        <nav className={cn('space-y-1 px-3 pt-3', activeTab !== 'artifacts' && 'hidden')}>
          <NavItem
            icon={Archive}
            label="产物资产库"
            strong
            active={location.pathname === '/artifacts'}
            onClick={() => navigate('/artifacts')}
          />
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
        </nav>

        {activeTab === 'abilities' && (
          <div className="px-3 pt-3">
            <div className="px-1 text-sm font-medium text-neutral-900">能力</div>
          </div>
        )}

        <nav className={cn('space-y-1 px-3 pt-3', activeTab !== 'abilities' && 'hidden')}>
          <NavItem
            icon={Blocks}
            label="能力中心"
            strong
            active={location.pathname === '/abilities'}
            onClick={() => navigate('/abilities')}
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
        </nav>

        <div className={cn('my-3', activeTab !== 'messages' && 'hidden')} />

        <div
          className={cn('flex-1 overflow-y-auto px-2 pb-4', activeTab !== 'messages' && 'hidden')}
        >
          {hint && (
            <div className="mb-2 px-2">
              <div className="rounded-full bg-neutral-900 px-3 py-1 text-xs text-white shadow">
                {hint}
              </div>
            </div>
          )}
          {!showArchived && (
            <div className="mb-3">
              <div className="mb-1 flex items-center justify-between px-2 text-xs text-neutral-400">
                <span>Manager 私聊</span>
                <button
                  type="button"
                  onClick={() => setTabOverride('agents')}
                  className="rounded-md px-1.5 py-0.5 text-neutral-500 transition hover:bg-[#F7F7F7] hover:text-neutral-900"
                >
                  全部
                </button>
              </div>
              {managerPrivateSessions.length > 0 ? (
                <div className="space-y-0.5 px-2">
                  {managerPrivateSessions.map((session) => {
                    const savedAgentId = readSavedAgentId(session)
                    const savedAgent = savedAgentId ? savedAgentById.get(savedAgentId) : null
                    const active = session.id === sessionId
                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => void openExistingSession(session)}
                        className={cn(
                          'flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left transition disabled:opacity-60',
                          active
                            ? 'bg-[#F7F7F7] text-neutral-950 shadow-sm'
                            : 'text-neutral-700 hover:bg-[#F7F7F7]',
                        )}
                        title={sessionDisplayTitle(savedAgent?.name ?? session.title, t)}
                      >
                        <span
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                          style={{ background: savedAgent?.color ?? '#111827' }}
                        >
                          {(savedAgent?.name ?? session.title).slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {savedAgent?.name ?? sessionDisplayTitle(session.title, t)}
                          </span>
                          <span className="block truncate text-[10px] text-neutral-400">
                            {session.lastMessage?.content
                              ? session.lastMessage.content
                              : relativeTime(session.updatedAt, language)}
                          </span>
                        </span>
                        <MessageCircle
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            active ? 'text-neutral-700' : 'text-neutral-300',
                          )}
                        />
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="mx-2 rounded-xl border border-dashed border-neutral-200 bg-white px-3 py-3 text-xs text-neutral-400">
                  还没有 Manager 私聊，先创建或选择一个指挥型专家。
                </div>
              )}
            </div>
          )}
          {!showArchived && (
            <div className="mb-3">
              <div className="mb-1 px-2 text-xs text-neutral-400">Worker 私聊</div>
              {workerPrivateSessions.length > 0 ? (
                <div className="space-y-0.5 px-2">
                  {workerPrivateSessions.map((session) => {
                    const savedAgentId = readSavedAgentId(session)
                    const savedAgent = savedAgentId ? savedAgentById.get(savedAgentId) : null
                    const active = session.id === sessionId
                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => void openExistingSession(session)}
                        className={cn(
                          'flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left transition disabled:opacity-60',
                          active
                            ? 'bg-[#F7F7F7] text-neutral-950 shadow-sm'
                            : 'text-neutral-700 hover:bg-[#F7F7F7]',
                        )}
                        title={sessionDisplayTitle(savedAgent?.name ?? session.title, t)}
                      >
                        <span
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                          style={{ background: savedAgent?.color ?? '#111827' }}
                        >
                          {(savedAgent?.name ?? session.title).slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {savedAgent?.name ?? sessionDisplayTitle(session.title, t)}
                          </span>
                          <span className="block truncate text-[10px] text-neutral-400">
                            {session.lastMessage?.content
                              ? session.lastMessage.content
                              : relativeTime(session.updatedAt, language)}
                          </span>
                        </span>
                        <MessageCircle
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            active ? 'text-neutral-700' : 'text-neutral-300',
                          )}
                        />
                      </button>
                    )
                  })}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setTabOverride('agents')}
                  className="mx-2 flex h-10 w-[calc(100%-1rem)] items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 bg-white text-xs text-neutral-500 transition hover:bg-[#F7F7F7] hover:text-neutral-900"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  去添加 Worker
                </button>
              )}
            </div>
          )}
          <div className="mb-1 px-2 text-xs text-neutral-400">Project 群聊</div>
          {sessionTree.length === 0 ? (
            <div className="px-2 py-4 text-xs text-neutral-400">
              {query.trim()
                ? t('没有匹配的会话')
                : showArchived
                  ? t('还没有归档会话')
                  : t('还没有会话')}
            </div>
          ) : (
            <ul className="space-y-1">
              {sessionTree.map((item) => {
                const workspaceId = item.parent.workspaceId
                const isGroupParent = item.parent.type === 'group' && Boolean(workspaceId)
                const workspaceAgents =
                  isGroupParent && workspaceId
                    ? groupSessionAgents(item.parent, groupWorkspaceAgents[workspaceId] ?? [])
                    : []
                const visibleChildren = item.children.filter(isStableAgentChildSession)
                const visibleChildIds = new Set(visibleChildren.map((child) => child.id))
                const previewChildren =
                  isGroupParent && taskBoard?.sessionId === item.parent.id
                    ? taskBoard.tasks.filter(
                        (task) =>
                          task.agentId &&
                          task.agentName &&
                          (!task.childSessionId || !visibleChildIds.has(task.childSessionId)),
                      )
                    : []
                const hasChildren = visibleChildren.length > 0 || previewChildren.length > 0
                const expanded = Boolean(workspaceId && expandedWorkspaces.has(workspaceId))
                const childActive =
                  visibleChildren.some((child) => child.id === sessionId) ||
                  previewChildren.some((task) => task.childSessionId === sessionId)
                const active = sessionId === item.parent.id
                const pinned = pinnedIds.has(item.parent.id)
                const archived = archivedIds.has(item.parent.id)
                const groupTitle = isGroupParent ? groupSessionDisplayTitle(item.parent.title) : ''
                const memberCount = isGroupParent
                  ? groupMemberCount(
                      item.parent,
                      visibleChildren.length + previewChildren.length,
                      groupMemberCounts[workspaceId ?? ''],
                    )
                  : 0
                const childCount = visibleChildren.length + previewChildren.length
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
                        {pinned && (
                          <Pin className="h-3.5 w-3.5 shrink-0 fill-neutral-900 text-neutral-900" />
                        )}
                        {isGroupParent ? (
                          <>
                            <GroupAvatar
                              agents={workspaceAgents}
                              className="shrink-0"
                              size="sm"
                              title={groupTitle}
                            />
                            <span className="flex min-w-0 flex-1 items-center">
                              <span className="truncate font-medium">{groupTitle}</span>
                              <span className="ml-1 shrink-0 font-normal text-neutral-400">
                                ({memberCount})
                              </span>
                            </span>
                            {hasChildren && (
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
                                <ChevronRight
                                  className={cn(
                                    'h-4 w-4 transition-transform',
                                    expanded && 'rotate-90',
                                  )}
                                />
                              </span>
                            )}
                          </>
                        ) : (
                          <>
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
                                <ChevronRight
                                  className={cn(
                                    'h-4 w-4 transition-transform',
                                    expanded && 'rotate-90',
                                  )}
                                />
                              </span>
                            ) : (
                              <History className="h-4 w-4 shrink-0 text-neutral-400" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">
                                {sessionDisplayTitle(item.parent.title, t)}
                              </span>
                              <span className="block truncate text-[11px] text-neutral-400">
                                {hasChildren
                                  ? `${formatSubtopicCount(childCount, language, t)} · ${relativeTime(item.latestUpdatedAt, language)}`
                                  : item.parent.lastMessage?.content
                                    ? item.parent.lastMessage.content
                                    : relativeTime(item.latestUpdatedAt, language)}
                              </span>
                            </span>
                          </>
                        )}
                        {openingSessionId === item.parent.id && (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-300" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => togglePin(event, item.parent)}
                        className={cn(
                          'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-[#F7F7F7] hover:text-neutral-900',
                          active || childActive
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100',
                        )}
                        title={pinned ? t('取消置顶') : t('置顶')}
                      >
                        {pinned ? (
                          <PinOff className="h-3.5 w-3.5" />
                        ) : (
                          <Pin className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(event) =>
                          toggleArchive(
                            event,
                            item.parent,
                            visibleChildren.map((child) => child.id),
                          )
                        }
                        className={cn(
                          'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-[#F7F7F7] hover:text-neutral-900',
                          active || childActive
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100',
                        )}
                        title={archived ? t('移出归档') : t('归档')}
                      >
                        {archived ? (
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        ) : (
                          <Archive className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => requestDelete(event, item.parent)}
                        className={cn(
                          'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-500',
                          active || childActive
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100',
                        )}
                        title={t('删除')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {hasChildren && expanded && (
                      <ul className="ml-4 space-y-1 border-l border-neutral-200 pl-2">
                        {visibleChildren.map((child) => {
                          const childAgent = workspaceAgents.find(
                            (agent) => agent.id === child.workspaceAgentId,
                          )
                          const childTitle =
                            childAgent?.name ?? childSessionTitle(child, item.parent)
                          return (
                            <li
                              key={child.id}
                              onClick={() => void openExistingSession(child)}
                              className={cn(
                                'group/child flex cursor-pointer items-center gap-1 rounded-lg transition',
                                sessionId === child.id
                                  ? 'bg-[#F7F7F7] shadow-sm'
                                  : 'hover:bg-[#F7F7F7]',
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
                                  sessionId === child.id
                                    ? 'text-neutral-950'
                                    : 'text-neutral-500 hover:text-neutral-800',
                                )}
                              >
                                {childAgent ? (
                                  <span className="relative h-5 w-5 shrink-0">
                                    <span
                                      className="grid h-5 w-5 place-items-center overflow-hidden rounded-full text-[10px] font-semibold text-white"
                                      style={{ background: childAgent.color }}
                                    >
                                      {childAgent.avatar ? (
                                        <img
                                          src={childAgent.avatar}
                                          alt={childAgent.name}
                                          className="h-full w-full bg-white object-contain"
                                          decoding="async"
                                          draggable={false}
                                        />
                                      ) : (
                                        childAgent.name.slice(0, 1).toUpperCase()
                                      )}
                                    </span>
                                    {pinnedIds.has(child.id) && (
                                      <Pin className="absolute -right-1 -top-1 h-2.5 w-2.5 fill-neutral-700 text-neutral-700" />
                                    )}
                                  </span>
                                ) : pinnedIds.has(child.id) ? (
                                  <Pin className="h-3 w-3 shrink-0 fill-neutral-700 text-neutral-700" />
                                ) : (
                                  <History className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                                )}
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate">
                                    {sessionDisplayTitle(childTitle, t)}
                                  </span>
                                  <span className="block truncate text-[10px] text-neutral-400">
                                    {relativeTime(child.updatedAt, language)}
                                  </span>
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
                                  sessionId === child.id
                                    ? 'opacity-100'
                                    : 'opacity-0 group-hover/child:opacity-100',
                                )}
                                title={pinnedIds.has(child.id) ? t('取消置顶') : t('置顶')}
                              >
                                {pinnedIds.has(child.id) ? (
                                  <PinOff className="h-3 w-3" />
                                ) : (
                                  <Pin className="h-3 w-3" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={(event) => toggleArchive(event, child)}
                                className={cn(
                                  'grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-[#F7F7F7] hover:text-neutral-900',
                                  sessionId === child.id
                                    ? 'opacity-100'
                                    : 'opacity-0 group-hover/child:opacity-100',
                                )}
                                title={archivedIds.has(child.id) ? t('移出归档') : t('归档')}
                              >
                                {archivedIds.has(child.id) ? (
                                  <ArchiveRestore className="h-3 w-3" />
                                ) : (
                                  <Archive className="h-3 w-3" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={(event) => requestDelete(event, child)}
                                className={cn(
                                  'grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-500',
                                  sessionId === child.id
                                    ? 'opacity-100'
                                    : 'opacity-0 group-hover/child:opacity-100',
                                )}
                                title={t('删除')}
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </li>
                          )
                        })}
                        {previewChildren.map((task) => {
                          const childAgent = workspaceAgents.find(
                            (agent) => agent.id === task.agentId,
                          )
                          const childSessionId = task.childSessionId ?? null
                          const canOpenChild = Boolean(childSessionId)
                          const opening = childSessionId ? openingSessionId === childSessionId : false
                          const taskStateText = canOpenChild
                            ? childTaskStatusText(task.status)
                            : '待建线程'
                          const openTaskChild = () => {
                            if (!childSessionId) {
                              showHint('线程记录尚未创建，Manager 分发后会自动出现')
                              return
                            }
                            if (openingSessionId === childSessionId) return
                            navigate(`/chat/${childSessionId}`)
                            if (currentSessionId === childSessionId) return
                            setOpeningSessionId(childSessionId)
                            void selectSession(childSessionId)
                              .catch((error) => {
                                navigate(`/chat/${item.parent.id}`, { replace: true })
                                showHint(friendlyErrorMessage(error, '打开子对话失败'))
                              })
                              .finally(() => {
                                setOpeningSessionId((current) =>
                                  current === childSessionId ? null : current,
                                )
                              })
                          }
                          return (
                            <li
                              key={`planned-${task.id}`}
                              onClick={() => void openTaskChild()}
                              className={cn(
                                'flex items-center gap-1 rounded-lg transition',
                                childSessionId === sessionId
                                  ? 'bg-[#F7F7F7] shadow-sm'
                                  : canOpenChild
                                    ? 'cursor-pointer hover:bg-[#F7F7F7]'
                                    : 'cursor-default opacity-80',
                              )}
                            >
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void openTaskChild()
                                }}
                                className={cn(
                                  'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition',
                                  canOpenChild
                                    ? childSessionId === sessionId
                                      ? 'text-neutral-950'
                                      : 'text-neutral-500 hover:text-neutral-800'
                                    : 'text-neutral-400',
                                )}
                                title={
                                  canOpenChild
                                    ? '打开任务子对话'
                                    : '任务已在房间中出现，线程记录创建后即可打开'
                                }
                              >
                                <span className="relative h-5 w-5 shrink-0">
                                  <span className="grid h-5 w-5 place-items-center overflow-hidden rounded-full bg-neutral-200 text-[10px] font-semibold text-neutral-500">
                                    {childAgent ? (
                                      childAgent.avatar ? (
                                        <img
                                          src={childAgent.avatar}
                                          alt={childAgent.name}
                                          className="h-full w-full bg-white object-contain"
                                          decoding="async"
                                          draggable={false}
                                        />
                                      ) : (
                                        childAgent.name.slice(0, 1).toUpperCase()
                                      )
                                    ) : (
                                      task.agentName.slice(0, 1).toUpperCase()
                                    )}
                                  </span>
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate">{task.agentName}</span>
                                  <span className="block truncate text-[10px] text-neutral-400">
                                    {task.title} · {taskStateText}
                                  </span>
                                </span>
                                {opening ? (
                                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-300" />
                                ) : canOpenChild ? (
                                  <MessageCircle className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                                ) : (
                                  <Clock className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                                )}
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
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
              onClick={() => navigate('/agent-config?newAgent=1')}
              className="mb-3 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#F7F7F7] text-sm font-medium text-neutral-800 shadow-sm transition hover:bg-neutral-100"
            >
              <UserPlus className="h-4 w-4 text-neutral-500" />
              添加专家
            </button>

            <div className="mb-2 flex items-center justify-between px-1 text-xs text-neutral-500">
              <span>{isAgentConfigRoute ? '专家配置' : '专家私聊'}</span>
              <span>{filteredLibraryAgents.length}</span>
            </div>

            <div className="space-y-1">
              {filteredLibraryAgents.map((agent) => {
                const agentSession = agentDirectSessionsBySavedId.get(agent.id)
                const active = agentSession?.id === sessionId
                const configActive =
                  location.pathname === '/agent-config' && activeAgentConfigId === agent.id
                const opening = openingAgentId === agent.id
                return (
                  <div
                    key={agent.id}
                    className={cn(
                      'group/agent flex min-h-14 items-center gap-1 rounded-lg transition',
                      active || configActive ? 'bg-[#F7F7F7] shadow-sm' : 'hover:bg-[#F7F7F7]',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (isAgentConfigRoute) {
                          navigate(`/agent-config?agentId=${encodeURIComponent(agent.id)}`)
                          return
                        }
                        void openAgentSession(agent)
                      }}
                      disabled={!isAgentConfigRoute && opening}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 text-left disabled:opacity-60"
                    >
                      <div
                        className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full text-sm font-semibold text-white"
                        style={{ background: agent.color }}
                      >
                        {agent.avatar ? (
                          <img
                            src={agent.avatar}
                            alt={agent.name}
                            className="h-full w-full bg-white object-contain"
                            decoding="async"
                            draggable={false}
                          />
                        ) : (
                          agent.name.slice(0, 1).toUpperCase()
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-neutral-950">
                          {agent.name}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-neutral-500">
                          {isAgentConfigRoute
                            ? agent.role || agent.description || '未设置角色'
                            : agentSession
                              ? relativeTime(agentSession.updatedAt, language)
                              : agent.role || '未开始私聊'}
                        </div>
                      </div>
                      {isAgentConfigRoute ? (
                        <Settings2
                          className={cn(
                            'h-4 w-4 shrink-0',
                            configActive ? 'text-neutral-700' : 'text-neutral-300',
                          )}
                        />
                      ) : opening ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" />
                      ) : (
                        <MessageCircle
                          className={cn(
                            'h-4 w-4 shrink-0',
                            active ? 'text-neutral-700' : 'text-neutral-300',
                          )}
                        />
                      )}
                    </button>
                    {!isAgentConfigRoute && (
                      <button
                        type="button"
                        onClick={() =>
                          navigate(`/agent-config?agentId=${encodeURIComponent(agent.id)}`)
                        }
                        className={cn(
                          'mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-white hover:text-neutral-900',
                          configActive || active
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/agent:opacity-100',
                        )}
                        title="专家配置"
                        aria-label="专家配置"
                      >
                        <Settings2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                )
              })}
              {!filteredLibraryAgents.length && (
                <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400">
                  {agentQuery.trim() ? '没有匹配的专家' : '还没有可用专家，请先新建一个。'}
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
                  <div className="truncate text-sm font-semibold text-neutral-950">
                    {accountProfile.name}
                  </div>
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
              <button
                type="button"
                onClick={() => navigate('/profile?section=memory')}
                className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 hover:text-neutral-950"
              >
                <Brain className="h-4 w-4" />
                Agent 记忆管理
              </button>
            </div>
          </div>
        )}

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
      <MobilePairingDialog open={mobilePairingOpen} onClose={() => setMobilePairingOpen(false)} />
    </>
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
          <div className="truncate text-sm font-medium text-neutral-900">
            {sessionDisplayTitle(session.title, t) || t('未命名会话')}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            {relativeTime(session.updatedAt, language)}
          </div>
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
    document.body,
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
        active && 'bg-[#F7F7F7] text-neutral-950 shadow-sm',
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
        active
          ? 'bg-neutral-950 text-white shadow-sm'
          : 'text-neutral-500 hover:bg-[#F7F7F7] hover:text-neutral-900',
      )}
      title={label}
      aria-label={label}
    >
      <Icon className="h-5 w-5" />
    </button>
  )
}

function MobilePairingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [connectivity, setConnectivity] = useState<MobileConnectivityStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [pairingStartedAt, setPairingStartedAt] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  const latestEvent = connectivity?.recentEvents?.[0]
  const connected = Boolean(
    latestEvent?.type === 'pairing.confirmed' &&
      pairingStartedAt !== null &&
      Date.parse(latestEvent.at) >= pairingStartedAt,
  )
  const statusLabel = connected ? '已连接' : failed ? '生成失败' : qrDataUrl ? '等待扫码' : loading ? '生成中' : '准备生成'

  async function refreshConnectivity() {
    try {
      const result = await api.getMobileConnectivity()
      setConnectivity(result)
    } catch {
      // 保持安静，只在状态上体现结果
    }
  }

  async function createPairingCode() {
    if (loading) return
    const startedAt = Date.now()
    setLoading(true)
    setFailed(false)
    setPairingStartedAt(startedAt)
    try {
      const result = await api.startMobilePairing()
      const dataUrl = await QRCode.toDataURL(result.qrPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 7,
        color: {
          dark: '#171717',
          light: '#ffffff',
        },
      })
      setQrDataUrl(dataUrl)
      await refreshConnectivity()
    } catch {
      setFailed(true)
      setQrDataUrl('')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setQrDataUrl('')
    setConnectivity(null)
    setFailed(false)
    setPairingStartedAt(null)
    void createPairingCode()
    void refreshConnectivity()
    const timer = window.setInterval(() => {
      void refreshConnectivity()
    }, 2500)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/20 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-pairing-title"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-[420px] max-h-[calc(100vh-3rem)] overflow-y-auto rounded-[24px] border border-neutral-200 bg-[#FBFBFB] p-4 shadow-[0_28px_90px_rgba(15,23,42,0.18)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-neutral-950">
            <QrCode className="h-4 w-4 text-neutral-500" />
            <span id="mobile-pairing-title">手机扫码连接</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-[#F7F7F7] hover:text-neutral-900"
            aria-label="关闭"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 rounded-2xl border border-neutral-200 bg-white p-4">
          <div className="grid place-items-center rounded-2xl border border-dashed border-neutral-200 bg-[#F7F7F7] p-4">
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="移动端配对二维码" className="h-56 w-56 rounded-xl bg-white p-2" />
            ) : (
              <div className="grid h-56 w-56 place-items-center rounded-xl text-neutral-400">
                {loading ? <Loader2 className="h-10 w-10 animate-spin" /> : <QrCode className="h-10 w-10" />}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-center">
            <span
              className={cn(
                'inline-flex h-7 items-center rounded-full px-3 text-xs font-medium',
                connected
                  ? 'bg-emerald-50 text-emerald-700'
                  : failed
                    ? 'bg-rose-50 text-rose-700'
                    : 'bg-neutral-100 text-neutral-600',
              )}
            >
              {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              {statusLabel}
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function AccountAvatar({ name, avatar }: AccountProfile) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name || 'Account avatar'}
        className="h-full w-full bg-white object-contain"
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

function filterAgents(agents: SavedAgentConfig[], query: string) {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return agents
  return agents.filter((agent) =>
    [agent.name, agent.role, agent.description, ...(agent.capabilityTags ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(keyword),
  )
}

function isStableAgentChildSession(session: Session) {
  if (session.type !== 'direct' || !session.workspaceId) return false
  return isStableOrchestratorTaskSession(session)
}

function isPrivateAgentSession(session: Session | null | undefined) {
  if (session?.type !== 'direct' || !session.workspaceId || !session.workspaceAgentId) return false
  const metadata = session.metadata ?? {}
  return metadata.kind === 'agent-direct'
}

function isManagerSavedAgent(agent: SavedAgentConfig | null | undefined) {
  if (!agent) return false
  if (agent.roleType === 'orchestrator') return true
  const name = agent.name.trim().toLowerCase()
  const role = agent.role.trim().toLowerCase()
  return (
    name.includes('manager') ||
    name.includes('orchestrator') ||
    role.includes('manager') ||
    role.includes('orchestrator') ||
    role.includes('协调') ||
    role.includes('总指挥')
  )
}

function readSavedAgentId(session: Session) {
  const savedAgentId = session.metadata?.savedAgentId
  return typeof savedAgentId === 'string' ? savedAgentId : null
}

function childSessionTitle(session: Session, parent: Session) {
  const withoutParent = parent.title
    ? session.title.replace(parent.title, '').replace(/^(\s*\/\s*)+/, '')
    : session.title
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

function groupSessionDisplayTitle(title: string | undefined) {
  const normalized = title?.trim() || 'Project 群聊'
  const withoutSuffix = normalized.replace(/\s*\/\s*Agent Group\s*$/i, '').trim()
  return withoutSuffix || 'Project 群聊'
}

function groupMemberCount(session: Session, childCount: number, loadedCount?: number) {
  const metadata = session.metadata ?? {}
  const explicitMemberCount = readPositiveNumber(metadata.memberCount)
  if (explicitMemberCount) return explicitMemberCount
  const explicitAgentCount = readNonNegativeNumber(metadata.agentCount)
  if (explicitAgentCount !== null) return explicitAgentCount + 1
  const explicitAgentIds = readAgentIds(metadata.agentIds)
  if (explicitAgentIds.length) return explicitAgentIds.length + 1
  if (loadedCount && loadedCount > 0) return loadedCount
  return Math.max(1, childCount + 1)
}

function childTaskStatusText(status?: string) {
  switch (status) {
    case 'assigned':
      return '已分配'
    case 'running':
      return '执行中'
    case 'done':
      return '已完成'
    case 'failed':
    case 'blocked':
      return '异常'
    case 'cancelled':
      return '已取消'
    case 'pending':
      return '准备中'
    default:
      return '等待执行'
  }
}

function groupSessionAgents(session: Session, agents: WorkspaceAgent[]) {
  const agentIds = readAgentIds(session.metadata?.agentIds)
  if (!agentIds.length) return agents
  const allowed = new Set(agentIds)
  return agents.filter((agent) => allowed.has(agent.id))
}

function readAgentIds(value: unknown) {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function readPositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function readNonNegativeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function formatSubtopicCount(count: number, language: 'zh' | 'en', t: (text: string) => string) {
  if (language === 'en') return `${count} ${count === 1 ? 'subtopic' : 'subtopics'}`
  return `${count} 个${t('子话题')}`
}
