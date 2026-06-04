import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { Check, CircleHelp, FolderOpen, FolderPlus, Loader2, Search, Sparkles, X } from 'lucide-react'
import { workspaceNameFromPath } from '@agenthub/shared'
import {
  agentLibraryChangeEvent,
  createSavedAgent,
  loadAgentLibrary,
  loadAgentLibraryState,
  saveAgentLibraryState,
  syncOpenClawAgentsIntoLibrary,
  type SavedAgentConfig,
} from '../../lib/agentLibrary'
import { defaultConversationTitle, startAgentConversation } from '../../lib/agentConversation'
import { api, friendlyErrorMessage, type Workspace } from '../../lib/api'
import {
  expertProfileForId,
  expertProfileToAgentConfig,
  allExpertTeamProfiles,
} from '../../lib/expertProfiles'
import { pickWorkspaceFolder } from '../../lib/native'
import { requestSettingsDialog } from '../../lib/settingsDialog'
import { cn } from '../../lib/utils'
import { isProjectWorkspace, workspaceSearchText, workspaceSubtitle } from '../../lib/workspaceFilters'
import { useChatStore } from '../../stores/chatStore'

export const openNewSessionDialogEvent = 'agenthub:open-new-session-dialog'
const orchestratorExpertProfileId = 'orchestrator-team-builder'

export function requestNewSessionDialog() {
  window.dispatchEvent(new Event(openNewSessionDialogEvent))
}

type WorkspaceChoice =
  | { mode: 'new' }
  | { mode: 'workspace'; workspace: Workspace }
  | { mode: 'local'; projectPath: string; workspace?: Workspace | null }

export function GlobalNewSessionDialog() {
  const navigate = useNavigate()
  const location = useLocation()
  const selectSession = useChatStore((state) => state.selectSession)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const [open, setOpen] = useState(false)
  const [agents, setAgents] = useState<SavedAgentConfig[]>([])
  const [creatingChoice, setCreatingChoice] = useState<string | null>(null)
  const [createError, setCreateError] = useState('')

  function openDialog() {
    setAgents(loadAgentLibrary())
    setCreatingChoice(null)
    setCreateError('')
    setOpen(true)
    void syncOpenClawAgentsIntoLibrary().catch(() => undefined)
  }

  useEffect(() => {
    function handleOpenDialog() {
      openDialog()
    }

    function handleLibraryChange() {
      if (open) setAgents(loadAgentLibrary())
    }

    window.addEventListener(openNewSessionDialogEvent, handleOpenDialog)
    window.addEventListener(agentLibraryChangeEvent, handleLibraryChange)
    window.addEventListener('storage', handleLibraryChange)
    return () => {
      window.removeEventListener(openNewSessionDialogEvent, handleOpenDialog)
      window.removeEventListener(agentLibraryChangeEvent, handleLibraryChange)
      window.removeEventListener('storage', handleLibraryChange)
    }
  }, [open])

  useEffect(() => {
    const state = location.state as { openNewSessionDialog?: boolean } | null
    if (!state?.openNewSessionDialog) return
    navigate(location.pathname, { replace: true, state: null })
    openDialog()
  }, [location.pathname, location.state, navigate])

  async function createAgentSession(
    selectedAgents: SavedAgentConfig[],
    title?: string,
    workspaceChoice: WorkspaceChoice = { mode: 'new' },
    goal?: string,
  ) {
    const key = selectedAgents.length === 1 ? selectedAgents[0]!.id : 'group'
    setCreatingChoice(key)
    setCreateError('')
    try {
      const workspaceOptions =
        workspaceChoice.mode === 'workspace'
          ? { workspaceId: workspaceChoice.workspace.id }
          : workspaceChoice.mode === 'local'
            ? workspaceChoice.workspace
              ? { workspaceId: workspaceChoice.workspace.id }
              : { projectPath: workspaceChoice.projectPath }
            : {}
      const session = await startAgentConversation({ agents: selectedAgents, title, goal, ...workspaceOptions })
      await fetchSessions()
      await selectSession(session.id)
      setOpen(false)
      navigate(`/chat/${session.id}`)
    } catch (error) {
      setCreateError(friendlyErrorMessage(error, '创建失败'))
    } finally {
      setCreatingChoice(null)
    }
  }

  if (!open) return null

  return (
    <NewSessionDialog
      agents={agents}
      creatingChoice={creatingChoice}
      createError={createError}
      onClose={() => !creatingChoice && setOpen(false)}
      onCreateAgent={createAgentSession}
      onManageAgents={() => {
        setOpen(false)
        navigate('/agent-config')
      }}
    />
  )
}

function NewSessionDialog({
  agents,
  creatingChoice,
  createError,
  onClose,
  onCreateAgent,
  onManageAgents,
}: {
  agents: SavedAgentConfig[]
  creatingChoice: string | null
  createError: string
  onClose: () => void
  onCreateAgent: (
    agents: SavedAgentConfig[],
    title?: string,
    workspaceChoice?: WorkspaceChoice,
    goal?: string,
  ) => Promise<void>
  onManageAgents: () => void
}) {
  const [query, setQuery] = useState('')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [libraryAgents, setLibraryAgents] = useState<SavedAgentConfig[]>(agents)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [workspaceChoice, setWorkspaceChoice] = useState<WorkspaceChoice>({ mode: 'new' })
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const selectedAgents = useMemo(() => libraryAgents.filter((agent) => selectedIds.has(agent.id)), [libraryAgents, selectedIds])
  const selectedOrchestrators = useMemo(
    () => selectedAgents.filter(isOrchestratorAgent),
    [selectedAgents],
  )
  const selectedWorkers = useMemo(
    () => selectedAgents.filter((agent) => !isOrchestratorAgent(agent)),
    [selectedAgents],
  )
  const groupValidationMessage =
    selectedAgents.length > 1 && selectedOrchestrators.length === 0
      ? '协作房间需要 1 位 Manager / Orchestrator 负责统筹。'
      : selectedOrchestrators.length > 1
        ? '一个协作房间只保留 1 位 Manager / Orchestrator。'
        : ''
  const groupTitle = defaultConversationTitle(selectedAgents)
  const filteredWorkspaces = useMemo(() => {
    const keyword = workspaceQuery.trim().toLowerCase()
    if (!keyword) return workspaces
    return workspaces.filter((workspace) => workspaceSearchText(workspace).includes(keyword))
  }, [workspaceQuery, workspaces])
  const filteredAgents = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return libraryAgents.filter((agent) => {
      if (!keyword) return true
      return [agent.name, agent.role, agent.description, ...(agent.capabilityTags ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    })
  }, [libraryAgents, query])

  function toggleAgent(agent: SavedAgentConfig) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(agent.id)) next.delete(agent.id)
      else next.add(agent.id)
      return next
    })
  }

  function handleCreate() {
    if (!selectedAgents.length || creatingChoice || groupValidationMessage) return
    void onCreateAgent(
      selectedAgents,
      title.trim() || groupTitle || undefined,
      workspaceChoice,
      goal.trim() || undefined,
    )
  }

  function handleClose() {
    if (!creatingChoice) onClose()
  }

  const submittingSelected = Boolean(creatingChoice)

  useEffect(() => {
    setLibraryAgents(agents)
  }, [agents])

  useEffect(() => {
    setQuery('')
    setTitle('')
    setGoal('')
    setSelectedIds(new Set())
    setWorkspaceChoice({ mode: 'new' })
  }, [])

  function applyTeamSuggestion(teamId: string) {
    const team = allExpertTeamProfiles.find((item) => item.id === teamId)
    if (!team) return

    const library = loadAgentLibraryState()
    const nextAgents = [...library.agents]
    const nextSelectedIds = new Set(selectedIds)

    for (const expertId of uniqueExpertIds([orchestratorExpertProfileId, ...team.memberExpertIds])) {
      const profile = expertProfileForId(expertId)
      if (!profile) continue
      const existing = nextAgents.find(
        (agent) =>
          agent.roleProfile?.expertProfileId === profile.id ||
          (normalizeAgentText(agent.name) === normalizeAgentText(profile.name) &&
            normalizeAgentText(agent.role) === normalizeAgentText(profile.role)),
      )
      const agent = existing ?? createSavedAgent(expertProfileToAgentConfig(profile))
      if (!existing) nextAgents.unshift(agent)
      nextSelectedIds.add(agent.id)
    }

    saveAgentLibraryState({
      schemaVersion: 2,
      agents: nextAgents,
      relations: library.relations,
    })
    setLibraryAgents(nextAgents)
    setSelectedIds(nextSelectedIds)
    if (!title.trim()) setTitle(team.name)
  }

  function addOrchestratorToSelection() {
    const existing = libraryAgents.find(isOrchestratorAgent)
    if (existing) {
      setSelectedIds((current) => new Set([...current, existing.id]))
      return
    }

    const profile = expertProfileForId(orchestratorExpertProfileId)
    if (!profile) return
    const library = loadAgentLibraryState()
    const next = createSavedAgent(expertProfileToAgentConfig(profile))
    const nextAgents = [next, ...library.agents]
    saveAgentLibraryState({
      schemaVersion: 2,
      agents: nextAgents,
      relations: library.relations,
    })
    setLibraryAgents(nextAgents)
    setSelectedIds((current) => new Set([...current, next.id]))
  }

  useEffect(() => {
    let cancelled = false
    setWorkspaceBusy(true)
    api
      .listWorkspaces()
      .then(({ items }) => {
        if (!cancelled) setWorkspaces(items.filter(isProjectWorkspace))
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([])
      })
      .finally(() => {
        if (!cancelled) setWorkspaceBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function openFolderWorkspace() {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    try {
      const nativePath = await pickWorkspaceFolder().catch(() => null)
      const result = await api.openWorkspaceFolder(nativePath)
      if (result.cancelled || !result.projectPath) return
      if (result.workspace) {
        setWorkspaceChoice({ mode: 'workspace', workspace: result.workspace })
        setWorkspaces((items) => [
          result.workspace!,
          ...items.filter((workspace) => workspace.id !== result.workspace!.id),
        ])
      } else {
        setWorkspaceChoice({ mode: 'local', projectPath: result.projectPath, workspace: null })
      }
    } finally {
      setWorkspaceBusy(false)
    }
  }

  function workspaceChoiceLabel() {
    if (workspaceChoice.mode === 'workspace') return workspaceChoice.workspace.name
    if (workspaceChoice.mode === 'local') return workspaceNameFromPath(workspaceChoice.projectPath)
    return '从新工作空间开始'
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      onMouseDown={handleClose}
    >
      <div
        className="agenthub-portal-theme agenthub-new-session-dialog flex h-[calc(100vh-2rem)] min-h-0 w-[calc(100vw-2rem)] max-w-[960px] flex-col overflow-hidden rounded-[24px] border border-neutral-200/80 bg-[#f7f7f5] shadow-[0_28px_100px_rgba(15,23,42,0.28)] sm:h-[82vh] sm:max-h-[760px] sm:min-h-[520px]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="relative flex h-16 shrink-0 items-center justify-center border-b border-neutral-200/80 bg-[#f7f7f5]/95">
          <h2 className="text-sm font-semibold tracking-wide text-neutral-950">创建协作房间</h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={Boolean(creatingChoice)}
            className="absolute right-4 top-3 grid h-9 w-9 place-items-center rounded-full text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(240px,320px)_minmax(0,1fr)] overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-col border-r border-neutral-200/80 bg-[#f7f7f5] px-5 py-4">
            <div className="flex h-10 items-center gap-2 rounded-2xl border border-emerald-400/40 bg-white px-3 text-neutral-400 shadow-sm">
              <Search className="h-4 w-4 shrink-0" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索专家 / 成员"
                className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
              />
            </div>

            <div className="mt-4 flex items-center justify-between px-1 text-xs text-neutral-500">
              <span>选择 Manager 与 Worker</span>
              <span>
                {selectedAgents.length}/{libraryAgents.length}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-2 pr-1">
              {filteredAgents.map((agent) => {
                const selected = selectedIds.has(agent.id)
                const roleBadge = isOrchestratorAgent(agent) ? 'Manager' : 'Worker'
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleAgent(agent)}
                    disabled={Boolean(creatingChoice)}
                    className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition hover:bg-white/80 disabled:opacity-60"
                  >
                    <span
                      className={cn(
                        'grid h-4 w-4 shrink-0 place-items-center rounded-full border',
                        selected
                          ? 'border-emerald-500 bg-emerald-500 text-white'
                          : 'border-neutral-300 bg-white text-transparent',
                      )}
                    >
                      <Check className="h-3 w-3" />
                    </span>
                    <span
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-sm font-semibold text-white shadow-sm"
                      style={{ background: agent.color ?? '#111827' }}
                    >
                      {agent.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="block truncate text-sm text-neutral-900">{agent.name}</span>
                        <span
                          className={cn(
                            'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-medium',
                            isOrchestratorAgent(agent)
                              ? 'bg-blue-50 text-blue-700'
                              : 'bg-neutral-100 text-neutral-600',
                          )}
                        >
                          {roleBadge}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-neutral-500">{agent.role}</span>
                    </span>
                  </button>
                )
              })}
              {!filteredAgents.length && (
                <div className="px-3 py-8 text-center text-sm text-neutral-400">
                  {libraryAgents.length ? '没有匹配的专家' : '还没有可用专家'}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-neutral-200/70 pt-3">
              <button
                type="button"
                onClick={onManageAgents}
                className="text-xs text-neutral-400 transition hover:text-neutral-700"
              >
                管理专家配置
              </button>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="text-sm font-semibold text-neutral-950">房间设置</div>
              <div className="mt-1 text-xs text-neutral-500">先确定项目目标和成员关系，再创建这个协作房间。</div>
              <div className="mt-4 grid gap-3 rounded-2xl border border-neutral-200 bg-[#fafafa] p-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-white px-3 py-3">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Manager</div>
                  <div className="mt-1 text-lg font-semibold text-neutral-950">{selectedOrchestrators.length}</div>
                  <div className="mt-1 text-xs leading-5 text-neutral-500">负责理解目标、协调成员、推进协作。</div>
                </div>
                <div className="rounded-2xl bg-white px-3 py-3">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Workers</div>
                  <div className="mt-1 text-lg font-semibold text-neutral-950">{selectedWorkers.length}</div>
                  <div className="mt-1 text-xs leading-5 text-neutral-500">负责具体执行、产出文件和阶段汇报。</div>
                </div>
                <div className="rounded-2xl bg-white px-3 py-3">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Workspace</div>
                  <div className="mt-1 text-sm font-semibold text-neutral-950">{workspaceChoiceLabel()}</div>
                  <div className="mt-1 text-xs leading-5 text-neutral-500">房间运行时的默认项目目录与协作空间。</div>
                </div>
              </div>
              <label className="mt-4 block">
                <span className="mb-2 block text-xs font-medium text-neutral-500">房间名称</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={groupTitle || '未命名协作房间'}
                  className="h-11 w-full rounded-2xl border border-neutral-200 bg-[#fafafa] px-4 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-emerald-400"
                />
              </label>
              <label className="mt-4 block">
                <span className="mb-2 block text-xs font-medium text-neutral-500">项目目标</span>
                <textarea
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="比如：调研全球主流 AI 编程工具，输出 PDF 和 HTML 网页报告。Manager 会基于这个目标理解需求、组织协作并安排执行。"
                  rows={3}
                  className="w-full resize-none rounded-2xl border border-neutral-200 bg-[#fafafa] px-4 py-3 text-sm leading-6 text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-emerald-400"
                />
              </label>
              <div className="mt-4 rounded-2xl border border-neutral-200 bg-[#fafafa] p-2">
                <div className="flex items-center gap-2 px-1 pb-2 text-xs font-medium text-neutral-500">
                  <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
                  轻量组队建议
                </div>
                <div className="grid gap-2">
                  {allExpertTeamProfiles.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => applyTeamSuggestion(team.id)}
                      disabled={Boolean(creatingChoice)}
                      className="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-left transition hover:border-emerald-300 hover:bg-emerald-50/40 disabled:opacity-60"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-neutral-900">{team.name}</span>
                        <span className="text-[11px] text-emerald-600">加入建议成员</span>
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-neutral-500">{team.description}</span>
                      <span className="mt-1 block truncate text-[11px] text-neutral-400">
                        {team.memberExpertIds
                          .map((id) => expertProfileForId(id)?.name)
                          .filter(Boolean)
                          .join(' / ')}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mt-2 px-1 text-[11px] leading-5 text-neutral-400">
                  这里只是帮你挑出一组比较合适的专家，不会替 Manager 预先写死分工。
                </div>
              </div>
              <div className="mt-4 min-w-0 rounded-2xl border border-neutral-200 bg-[#fafafa] p-2">
                <div className="mb-2 flex items-center justify-between gap-2 px-1">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-neutral-500">工作空间</div>
                    <div className="mt-0.5 truncate text-xs text-neutral-400">
                      {workspaceChoiceLabel()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={requestSettingsDialog}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-neutral-900"
                    aria-label="前往系统设置"
                    title="可前往「系统设置」设置默认工作空间存储路径"
                  >
                    <CircleHelp className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex h-8 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-2 text-neutral-400">
                  <Search className="h-3.5 w-3.5 shrink-0" />
                  <input
                    value={workspaceQuery}
                    onChange={(event) => setWorkspaceQuery(event.target.value)}
                    placeholder="搜索历史项目空间"
                    className="min-w-0 flex-1 bg-transparent text-xs text-neutral-900 outline-none placeholder:text-neutral-400"
                  />
                </div>
                <div className="mt-2 max-h-28 overflow-y-auto pr-1">
                  <button
                    type="button"
                    onClick={() => setWorkspaceChoice({ mode: 'new' })}
                    className={cn(
                      'flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-sm hover:bg-white',
                      workspaceChoice.mode === 'new' && 'bg-white',
                    )}
                  >
                    <FolderPlus className="h-4 w-4 shrink-0 text-neutral-600" />
                    <span className="min-w-0 flex-1 truncate text-neutral-900">从新工作空间开始</span>
                    {workspaceChoice.mode === 'new' && <Check className="h-4 w-4 text-emerald-500" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => void openFolderWorkspace()}
                    disabled={workspaceBusy}
                    className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-sm text-neutral-900 hover:bg-white disabled:opacity-60"
                  >
                    {workspaceBusy ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" />
                    ) : (
                      <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                    )}
                    <span className="min-w-0 flex-1 truncate">打开本地工作空间</span>
                  </button>
                  {filteredWorkspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => setWorkspaceChoice({ mode: 'workspace', workspace })}
                      className={cn(
                        'flex min-h-10 w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-white',
                        workspaceChoice.mode === 'workspace' &&
                          workspaceChoice.workspace.id === workspace.id &&
                          'bg-white',
                      )}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-neutral-900">{workspace.name}</span>
                        <span className="block truncate text-[11px] text-neutral-400">
                          {workspaceSubtitle(workspace)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-5 rounded-2xl border border-neutral-200 bg-[#fafafa] p-3">
                <div className="mb-3 flex items-center justify-between gap-3 px-1">
                  <div>
                    <div className="text-xs font-medium text-neutral-500">房间成员预览</div>
                    <div className="mt-0.5 text-[11px] text-neutral-400">
                      这里展示创建后会进入房间的 Manager 与 Worker。
                    </div>
                  </div>
                  <div className="text-[11px] text-neutral-400">
                    {selectedAgents.length}/{libraryAgents.length}
                  </div>
                </div>
                {selectedAgents.length ? (
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
                    {selectedAgents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => toggleAgent(agent)}
                        className="group flex min-w-0 items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-3 py-3 text-left transition hover:border-neutral-300 hover:bg-neutral-50"
                      >
                        <span
                          className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-sm font-semibold text-white shadow-sm"
                          style={{ background: agent.color ?? '#111827' }}
                        >
                          {agent.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="block truncate text-sm text-neutral-950">{agent.name}</span>
                            <span
                              className={cn(
                                'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-medium',
                                isOrchestratorAgent(agent)
                                  ? 'bg-blue-50 text-blue-700'
                                  : 'bg-neutral-100 text-neutral-600',
                              )}
                            >
                              {isOrchestratorAgent(agent) ? 'Manager' : 'Worker'}
                            </span>
                          </span>
                          <span className="block truncate text-xs text-neutral-500">{agent.role}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="flex min-h-24 items-center justify-center rounded-2xl border border-dashed border-neutral-200 bg-white px-6 text-center text-sm text-neutral-400">
                    从左侧选择专家，先组出一个像样的小团队。
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-h-20 shrink-0 flex-wrap items-center justify-end gap-3 border-t border-neutral-200/80 bg-white px-5 py-4">
              {createError && <div className="mr-auto max-w-full truncate text-xs text-red-500">{createError}</div>}
              {groupValidationMessage && (
                <div className="mr-auto flex min-w-0 flex-wrap items-center gap-2 text-xs text-amber-600">
                  <span className="max-w-[360px] truncate">{groupValidationMessage}</span>
                  {selectedOrchestrators.length === 0 && (
                    <button
                      type="button"
                      onClick={addOrchestratorToSelection}
                      className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 font-medium text-amber-700 transition hover:bg-amber-100"
                    >
                      添加 Manager
                    </button>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={handleCreate}
                disabled={!selectedAgents.length || Boolean(creatingChoice) || Boolean(groupValidationMessage)}
                className="inline-flex h-11 min-w-[120px] items-center justify-center rounded-2xl bg-neutral-100 px-5 text-sm font-medium text-neutral-400 transition enabled:bg-emerald-500 enabled:text-white enabled:hover:bg-emerald-600 disabled:cursor-not-allowed"
              >
                {submittingSelected ? <Loader2 className="h-4 w-4 animate-spin" /> : '创建房间'}
              </button>
              <button
                type="button"
                onClick={handleClose}
                disabled={Boolean(creatingChoice)}
                className="inline-flex h-11 min-w-[120px] items-center justify-center rounded-2xl border border-neutral-200 bg-white px-5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function normalizeAgentText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function uniqueExpertIds(ids: string[]) {
  return Array.from(new Set(ids))
}

function isOrchestratorAgent(agent: SavedAgentConfig) {
  return agent.roleType === 'orchestrator'
}
