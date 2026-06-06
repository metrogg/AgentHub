import { FormEvent, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  PanelLeft,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Wand2,
  Wrench,
  X,
} from 'lucide-react'
import CollapsibleSessionSidebar from '../components/chat/CollapsibleSessionSidebar'
import {
  agentLibraryChangeEvent,
  createSavedAgent,
  flushAgentLibraryServerSync,
  loadAgentLibraryState,
  saveAgentLibraryState,
  saveAgentToLibrary,
  toAgentConfigInput,
  type SavedAgentRelation,
  type SavedAgentConfig,
} from '../lib/agentLibrary'
import { syncSavedAgentDirectSessions } from '../lib/agentConversation'
import {
  api,
  type AgentConfigEditResult,
  type AgentConfigInput,
  type ModelCatalogItem,
  type SkillSummary,
  type WorkspaceAgent,
} from '../lib/api'
import {
  expertCategoryLabels,
  expertProfileForId,
  expertProfileIdFromDraft,
  allExpertProfiles,
  allExpertTeamProfiles,
  expertProfileToAgentConfig,
} from '../lib/expertProfiles'
import { useI18n } from '../lib/i18n'
import { runtimeLabel } from '../lib/agentDisplay'
import { cn } from '../lib/utils'
import { useChatStore } from '../stores/chatStore'

const WORKER_BASE_OPTIONS = [
  { value: '', label: '未选择 Worker 基座' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'gemini', label: 'Gemini CLI' },
] as const

const MANAGER_BASE_OPTIONS = [
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'qwenpaw', label: 'QwenPaw' },
] as const

type WorkerRuntimeBase = (typeof WORKER_BASE_OPTIONS)[number]['value']
type ManagerRuntimeBase = (typeof MANAGER_BASE_OPTIONS)[number]['value']
type CliWorkerBase = NonNullable<WorkspaceAgent['codeAgentType']>

const emptyDraft: AgentConfigInput = {
  name: '',
  role: '',
  description: '',
  avatar: null,
  systemPrompt: '',
  color: '#111827',
  modelId: null,
  runtimeType: 'code-agent',
  codeAgentType: null,
  capabilityTags: [],
  skillIds: [],
  toolPermissions: ['chat'],
  sandboxPolicy: 'workspace-write',
  contextPolicy: 'workspace-aware',
  autoInvoke: true,
  approvalRequired: false,
  roleType: 'custom',
  roleProfile: null,
}

export default function AgentConfigPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const isCreatingNewAgent = searchParams.get('newAgent') === '1'
  const [agents, setAgents] = useState<SavedAgentConfig[]>([])
  const [relations, setRelations] = useState<SavedAgentRelation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentConfigInput>(emptyDraft)
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [saved, setSaved] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showImportPanel, setShowImportPanel] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([])
  const [assistantDialogOpen, setAssistantDialogOpen] = useState(false)
  const [assistantInstruction, setAssistantInstruction] = useState('')
  const [assistantStreaming, setAssistantStreaming] = useState(false)
  const [assistantOutput, setAssistantOutput] = useState('')
  const [assistantError, setAssistantError] = useState<string | null>(null)
  const [assistantResult, setAssistantResult] = useState<AgentConfigEditResult | null>(null)
  const selectedExpertProfile = expertProfileForId(expertProfileIdFromDraft(draft))
  const currentSession = useChatStore((state) => state.currentSession)
  const selectSession = useChatStore((state) => state.selectSession)

  useEffect(() => {
    const syncLibrary = () => {
      const library = loadAgentLibraryState()
      const loaded = library.agents
      setRelations(library.relations)
      setAgents(loaded)
      if (isCreatingNewAgent) {
        setSelectedId(null)
        setDraft(emptyDraft)
        return
      }
      const requestedId = searchParams.get('agentId')
      const current = selectedId ? loaded.find((agent) => agent.id === selectedId) ?? null : null
      const first = loaded.find((agent) => agent.id === requestedId) ?? current ?? loaded[0] ?? null
      if (first) {
        setSelectedId(first.id)
        setDraft(toAgentConfigInput(first))
        if (!requestedId) setSearchParams({ agentId: first.id }, { replace: true })
      } else {
        setSelectedId(null)
        setDraft(emptyDraft)
      }
    }

    syncLibrary()

    window.addEventListener(agentLibraryChangeEvent, syncLibrary)
    return () => window.removeEventListener(agentLibraryChangeEvent, syncLibrary)
  }, [isCreatingNewAgent, searchParams, selectedId])

  useEffect(() => {
    const requestedId = searchParams.get('agentId')
    if (isCreatingNewAgent || !requestedId || requestedId === selectedId) return
    const agent = agents.find((item) => item.id === requestedId)
    if (agent) selectAgent(agent, true)
  }, [agents, isCreatingNewAgent, searchParams, selectedId])

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => {
        if (!settings.MODEL_CATALOG) return
        const parsed = JSON.parse(settings.MODEL_CATALOG) as ModelCatalogItem[]
        setModels(parsed.filter((item) => item.enabled))
      })
      .catch(() => setModels([]))
  }, [])

  useEffect(() => {
    api
      .listSkills()
      .then((result) => setAvailableSkills(result.items))
      .catch(() => setAvailableSkills([]))
  }, [])

  const selectedAgent = agents.find((agent) => agent.id === selectedId) ?? null
  const showEditor = Boolean(selectedAgent) || isCreatingNewAgent
  const savedExpertProfileIds = new Set(
    agents
      .map((agent) => agent.roleProfile?.expertProfileId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
  const runtimeType = draft.runtimeType ?? 'code-agent'
  const workerRuntimeBase = getWorkerRuntimeBaseFromDraft(draft)
  const managerRuntimeBase = getManagerRuntimeBaseFromDraft(draft)
  const managerAgent = isManagerDraft(draft, selectedExpertProfile)
  const selectedModel = draft.modelId ? models.find((item) => item.id === draft.modelId || item.modelId === draft.modelId) ?? null : null
  const assistantChanges = assistantResult ? changedFieldsFromPatch(draft, assistantResult.patch) : []
  const modelCompatibilityMessage = (() => {
    const modelId = draft.modelId ?? null
    if (managerAgent) {
      return 'Orchestrator 是群聊 Manager / Team Leader；这里选择 Manager 基座，模型和运行状态由设置页的 Manager Runtime 接管。'
    }
    const codeAgentType = cliWorkerBaseFromRuntimeBase(workerRuntimeBase)
    const model = selectedModel
    if (workerRuntimeBase === 'openclaw') {
      if (!modelId) return 'OpenClaw Worker 需要绑定模型，并通过 OpenClaw resident runtime / Matrix 接单。'
      return 'OpenClaw Worker 会使用独立 openclaw.json 和 resident backend；模型从当前 Agent 绑定生成。'
    }
    if (!modelId) return '未绑定模型不会使用内部 LLM 默认模型；Worker 执行前需要显式绑定或匹配到兼容模型。'
    if (!model) return '当前绑定的模型不在模型目录中，运行前需要先补齐模型条目。'
    if (codeAgentType === 'claude-code' && !/claude|sonnet|opus|haiku|anthropic/i.test(`${model.provider} ${model.modelId} ${model.apiEndpoint ?? ''} ${model.anthropicEndpoint ?? ''}`)) {
      return '建议 Claude Code 绑定 Claude/Anthropic 兼容模型。'
    }
    if (codeAgentType === 'gemini' && !/gemini|google/i.test(`${model.provider} ${model.modelId}`)) {
      return '建议 Gemini CLI 绑定 Gemini/Google 兼容模型。'
    }
    if (codeAgentType === 'claude-code') {
      return '已绑定独立模型，运行时会注入 Claude Code。'
    }
    if (codeAgentType === 'codex') {
      return 'Codex 仍走官方 auth/config 体系。'
    }
    return '已绑定独立模型，运行时会随当前 CLI 注入。'
  })()
  const runtimeHint = managerAgent
    ? 'Orchestrator 是 Manager / Team Leader，不作为普通 Worker 接单；它通过 OpenClaw / QwenPaw 常驻监听 Matrix Room。'
    : '执行成员选择 Worker 基座。Agent Runtime 页面只做安装、认证和原生诊断，不决定具体 Agent 用哪个模型。'

  function selectAgent(agent: SavedAgentConfig, replaceUrl = false) {
    setSelectedId(agent.id)
    setDraft(toAgentConfigInput(agent))
    setSearchParams({ agentId: agent.id }, { replace: replaceUrl })
  }

  function createAgent() {
    navigate('/agent-config?newAgent=1')
  }

  async function importExpertProfile(profileId: string) {
    const profile = expertProfileForId(profileId)
    if (!profile) return
    const existing = agents.find(
      (agent) =>
        agent.roleProfile?.expertProfileId === profile.id ||
        (normalizeAgentText(agent.name) === normalizeAgentText(profile.name) &&
          normalizeAgentText(agent.role) === normalizeAgentText(profile.role)),
    )
    if (existing) {
      selectAgent(existing)
      return
    }

    const next = createSavedAgent(expertProfileToAgentConfig(profile))
    const updated = [next, ...agents]
    setAgents(updated)
    setRelations((current) => saveLibrary(updated, current))
    selectAgent(next)
    try {
      await flushAgentLibraryServerSync()
      toastSaved()
    } catch (error) {
      toastSaveFailed(error)
    }
  }

  async function importExpertTeam(teamId: string) {
    const team = allExpertTeamProfiles.find((item) => item.id === teamId)
    if (!team) return

    let nextAgents = [...agents]
    for (const expertId of team.memberExpertIds) {
      const profile = expertProfileForId(expertId)
      if (!profile) continue
      const existing = nextAgents.find(
        (agent) =>
          agent.roleProfile?.expertProfileId === profile.id ||
          (normalizeAgentText(agent.name) === normalizeAgentText(profile.name) &&
            normalizeAgentText(agent.role) === normalizeAgentText(profile.role)),
      )
      if (!existing) nextAgents = [createSavedAgent(expertProfileToAgentConfig(profile)), ...nextAgents]
    }

    setAgents(nextAgents)
    setRelations((current) => saveLibrary(nextAgents, current))
    const firstMember = team.memberExpertIds
      .map((expertId) =>
        nextAgents.find((agent) => agent.roleProfile?.expertProfileId === expertId),
      )
      .find(Boolean)
    if (firstMember) selectAgent(firstMember)
    try {
      await flushAgentLibraryServerSync()
      toastSaved()
    } catch (error) {
      toastSaveFailed(error)
    }
  }

  async function duplicateAgent() {
    if (!selectedAgent) return
    try {
      const next = createSavedAgent({
        ...toAgentConfigInput(selectedAgent),
        name: `${selectedAgent.name} Copy`,
      })
      const updated = [next, ...agents]
      setAgents(updated)
      saveAgentLibraryState({ schemaVersion: 2, agents: updated, relations })
      selectAgent(next)
      await flushAgentLibraryServerSync()
      toastSaved()
    } catch (error) {
      toastSaveFailed(error)
    }
  }

  async function saveDraft(event?: FormEvent) {
    event?.preventDefault()
    const normalized = normalizeDraft(draft)
    if (!normalized.name || !normalized.role) return
    const previousAgent = selectedAgent
    const updated = saveAgentToLibrary(agents, normalized, selectedId ?? undefined)
    setAgents(updated)
    setRelations((current) => saveLibrary(updated, current))
    const current = selectedId ? updated.find((agent) => agent.id === selectedId) : updated[0]
    if (current) {
      setSelectedId(current.id)
      setDraft(toAgentConfigInput(current))
      setSearchParams({ agentId: current.id }, { replace: true })
    }
    try {
      await flushAgentLibraryServerSync()
      if (current) await syncSavedAgentDirectSessions(current, previousAgent)
      await syncCurrentWorkspaceAgent(normalized)
      toastSaved()
    } catch (error) {
      toastSaveFailed(error)
    }
  }

  async function deleteAgent() {
    if (!selectedAgent) return
    const confirmed = window.confirm(`删除 Agent「${selectedAgent.name}」？已加入工作区的成员不会被自动删除。`)
    if (!confirmed) return
    try {
      const updated = agents.filter((agent) => agent.id !== selectedAgent.id)
      const nextRelations = relations.filter((relation) => relation.sourceAgentId !== selectedAgent.id && relation.targetAgentId !== selectedAgent.id)
      setAgents(updated)
      setRelations(nextRelations)
      saveAgentLibraryState({ schemaVersion: 2, agents: updated, relations: nextRelations })
      const next = updated[0] ?? null
      setSelectedId(next?.id ?? null)
      setDraft(next ? toAgentConfigInput(next) : emptyDraft)
      await flushAgentLibraryServerSync()
      toastSaved()
    } catch (error) {
      toastSaveFailed(error)
    }
  }

  async function syncCurrentWorkspaceAgent(nextDraft: AgentConfigInput) {
    if (!currentSession?.workspaceId) return
    try {
      const full = await api.getWorkspace(currentSession.workspaceId)
      const metadata = currentSession.metadata ?? {}
      const sessionAgent = currentSession.workspaceAgentId
        ? full.agents.find((agent) => agent.id === currentSession.workspaceAgentId)
        : null
      const hasMatchingSavedAgentId =
        metadata.kind === 'agent-direct' && metadata.savedAgentId === selectedId
      if (
        currentSession.type === 'direct' &&
        metadata.kind === 'agent-direct' &&
        metadata.savedAgentId &&
        metadata.savedAgentId !== selectedId
      ) {
        return
      }
      if (
        currentSession.type === 'direct' &&
        !hasMatchingSavedAgentId &&
        sessionAgent &&
        selectedAgent &&
        (sessionAgent.name !== selectedAgent.name || sessionAgent.role !== selectedAgent.role)
      ) {
        return
      }
      const matched =
        sessionAgent ??
        full.agents.find((agent) => agent.name === nextDraft.name && agent.role === nextDraft.role)
      if (!matched) return

      const updated = await api.updateWorkspaceAgent(full.workspace.id, matched.id, nextDraft)
      const isDedicatedAgentSession =
        currentSession.type === 'direct' &&
        currentSession.workspaceAgentId === matched.id &&
        (metadata.kind === 'agent-direct' || full.agents.length === 1)

      if (isDedicatedAgentSession && nextDraft.name) {
        const workspaceName = nextDraft.name.slice(0, 80)
        if (full.workspace.name !== workspaceName) {
          await api.updateWorkspace(full.workspace.id, { name: workspaceName })
        }
        await api.updateSession(currentSession.id, {
          title: nextDraft.name,
          workspaceId: full.workspace.id,
          workspaceAgentId: updated.id,
          metadata: {
            ...metadata,
            kind: 'agent-direct',
            ...(selectedId ? { savedAgentId: selectedId } : {}),
          },
        })
      }
      if (currentSession.id) await selectSession(currentSession.id)
    } catch {
      // 本地模板保存成功即可；工作区实例可能已被删除。
    }
  }

  function toastSaved() {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1400)
  }

  function toastSaveFailed(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    window.alert(`Agent 配置保存到服务端失败，请检查后端/客户端连接后重试。${message ? `\n${message}` : ''}`)
  }

  function applyExpertProfile(profileId: string) {
    const profile = expertProfileForId(profileId)
    if (!profile) {
      setDraft({
        ...draft,
        roleType: 'custom',
        roleProfile: {
          ...(draft.roleProfile ?? {}),
          expertProfileId: undefined,
        },
      })
      return
    }
    const preset = expertProfileToAgentConfig(profile)
    const nextIsManager = preset.roleType === 'orchestrator'
    setDraft({
      ...draft,
      ...preset,
      name: preset.name,
      role: preset.role,
      codeAgentType: nextIsManager ? null : (preset.runtimeType === 'code-agent' ? (preset.codeAgentType ?? null) : null),
      roleProfile: withAgentRuntimeBases(
        preset.roleProfile ?? null,
        getWorkerRuntimeBaseFromDraft(preset),
        preset.roleProfile?.managerRuntimeType === 'qwenpaw' ? 'qwenpaw' : 'openclaw',
        nextIsManager,
      ),
    })
  }

  function openAssistantDialog() {
    setAssistantDialogOpen(true)
    setAssistantError(null)
    setAssistantOutput('')
    setAssistantResult(null)
  }

  async function runAssistantEdit(event?: FormEvent) {
    event?.preventDefault()
    const instruction = assistantInstruction.trim()
    if (!instruction || assistantStreaming) return

    setAssistantStreaming(true)
    setAssistantOutput('')
    setAssistantError(null)
    setAssistantResult(null)
    try {
      for await (const item of api.editAgentConfig(normalizeDraft(draft), instruction)) {
        if (item.type === 'chunk') {
          setAssistantOutput((current) => `${current}${item.text}`)
        } else if (item.type === 'result') {
          setAssistantResult(item.result)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '生成失败')
      setAssistantError(message)
    } finally {
      setAssistantStreaming(false)
    }
  }

  function applyAssistantResult() {
    if (!assistantResult) return
    const nextDraft = normalizeDraft({
      ...draft,
      ...compactAgentConfigPatch(assistantResult.patch),
    })
    setDraft(nextDraft)
    setAssistantDialogOpen(false)
    setAssistantResult(null)
    setAssistantOutput('')
  }

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#fbfbf9] text-neutral-950">
      <CollapsibleSessionSidebar collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed} />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100"
              aria-label={sidebarCollapsed ? t('展开侧栏') : t('收起侧栏')}
              title={sidebarCollapsed ? t('展开侧栏') : t('收起侧栏')}
            >
              <PanelLeft className={cn('h-4 w-4 transition-transform duration-300', sidebarCollapsed && 'rotate-180')} />
            </button>
            <span className="text-sm font-semibold">AgentHub</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">{t('Agent 配置')}</span>
          </div>
          <button
            type="button"
            onClick={createAgent}
            className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800"
          >
            <Plus className="h-4 w-4" />
            {t('新建 Agent')}
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          <section className="h-full min-w-0 overflow-y-auto px-8 py-7">
            <div className="w-full max-w-[1400px]">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-xl font-semibold tracking-normal">{t('Agent 配置')}</h1>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={openAssistantDialog}
                    disabled={!showEditor}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 text-sm font-medium text-blue-700 transition hover:bg-blue-100 disabled:border-neutral-200 disabled:bg-white disabled:text-neutral-300"
                  >
                    <Wand2 className="h-4 w-4" />
                    {t('AI 修改')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowImportPanel((open) => !open)}
                    className={cn(
                      'inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition',
                      showImportPanel
                        ? 'border-teal-200 bg-teal-50 text-teal-700'
                        : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50',
                    )}
                  >
                    <Sparkles className="h-4 w-4" />
                    {showImportPanel ? t('收起导入') : t('导入专家')}
                  </button>
                  <button type="button" onClick={duplicateAgent} disabled={!selectedAgent} className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium hover:bg-neutral-50 disabled:text-neutral-300">
                    <Copy className="h-4 w-4" />
                    {t('复制')}
                  </button>
                  <button type="button" onClick={deleteAgent} disabled={!selectedAgent} className="inline-flex h-9 items-center gap-2 rounded-xl border border-red-100 bg-white px-3 text-sm font-medium text-red-500 hover:bg-red-50 disabled:text-neutral-300">
                    <Trash2 className="h-4 w-4" />
                    {t('删除')}
                  </button>
                </div>
              </div>

              {showImportPanel && (
                <section className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-neutral-900">专家模板</div>
                      <div className="text-xs text-neutral-400">
                        {allExpertProfiles.length} 个可导入 · {savedExpertProfileIds.size} 个已导入
                      </div>
                    </div>
                    <div className="mt-3 grid max-h-56 gap-2 overflow-y-auto pr-1 md:grid-cols-2">
                      {allExpertProfiles.map((profile) => {
                        const imported = savedExpertProfileIds.has(profile.id)
                        return (
                          <button
                            key={profile.id}
                            type="button"
                            onClick={() => void importExpertProfile(profile.id)}
                            className={cn(
                              'rounded-xl border px-3 py-2.5 text-left transition',
                              imported
                                ? 'border-emerald-100 bg-emerald-50/40'
                                : 'border-neutral-200 bg-neutral-50 hover:border-neutral-300 hover:bg-white',
                            )}
                          >
                            <span className="flex items-center gap-2">
                              <span
                                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-semibold text-white"
                                style={{ background: profile.color }}
                              >
                                {profile.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-neutral-900">
                                  {profile.name}
                                </span>
                                <span className="block truncate text-[11px] text-neutral-400">
                                  {expertCategoryLabels[profile.category]} · {runtimeLabel(profile.runtimeType)}
                                </span>
                              </span>
                              <span className={cn('shrink-0 text-[11px]', imported ? 'text-emerald-600' : 'text-neutral-400')}>
                                {imported ? '已导入' : '导入'}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                    <div className="text-sm font-semibold text-neutral-900">专家团</div>
                    <div className="mt-3 space-y-2">
                      {allExpertTeamProfiles.map((team) => (
                        <button
                          key={team.id}
                          type="button"
                          onClick={() => void importExpertTeam(team.id)}
                          className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2.5 text-left transition hover:border-neutral-300 hover:bg-white"
                        >
                          <span className="flex items-center justify-between gap-3">
                            <span className="truncate text-sm font-medium text-neutral-900">{team.name}</span>
                            <span className="shrink-0 text-[11px] text-emerald-600">导入成员</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {showEditor ? (
                <div className="grid gap-5">
                  <form onSubmit={saveDraft}>
                    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-white shadow-sm"
                            style={{ background: draft.color ?? '#111827' }}
                          >
                            <Bot className="h-5 w-5" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-lg font-semibold text-neutral-950">
                              {draft.name || '未命名 Agent'}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                              <span className="truncate">{draft.role || '未设置角色'}</span>
                              <span className="text-neutral-300">·</span>
                              <span>{managerAgent ? `Manager / ${labelForManagerRuntimeBase(managerRuntimeBase)}` : labelForWorkerRuntimeBase(workerRuntimeBase)}</span>
                              <span className="text-neutral-300">·</span>
                              <span>{modelName(draft.modelId ?? null, models)}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={openAssistantDialog}
                            className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                          >
                            <Wand2 className="h-4 w-4 text-blue-600" />
                            {t('对话式修改')}
                          </button>
                          <button
                            type="submit"
                            className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800"
                          >
                            <Save className="h-4 w-4" />
                            {selectedAgent ? t('保存 Agent') : t('创建 Agent')}
                          </button>
                        </div>
                      </div>

                      <div className="border-t border-neutral-100 px-5 py-5">
                        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                          <div className="space-y-4">
                            <div className="grid gap-3 md:grid-cols-3">
                              <SelectField
                                label="专家模板"
                                value={expertProfileIdFromDraft(draft)}
                                onChange={applyExpertProfile}
                              >
                                <option value="">自定义专家</option>
                                {allExpertProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {expertCategoryLabels[profile.category]} / {profile.name}
                                  </option>
                                ))}
                              </SelectField>
                              <Field label={t('名称')} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
                              <Field label={t('角色')} value={draft.role} onChange={(role) => setDraft({ ...draft, role })} />
                            </div>

                            <TextField
                              label={t('简介')}
                              rows={2}
                              value={draft.description ?? ''}
                              onChange={(description) => setDraft({ ...draft, description })}
                            />
                            <TextField
                              label={t('系统提示词')}
                              rows={8}
                              value={draft.systemPrompt ?? ''}
                              onChange={(systemPrompt) => setDraft({ ...draft, systemPrompt })}
                            />
                          </div>

                          <div className="space-y-4">
                            <div>
                              <div className="mb-3 text-sm font-semibold text-neutral-950">{managerAgent ? 'Manager 基座' : 'Agent 基座'}</div>
                              <div className="space-y-3">
                                {managerAgent ? (
                                  <SelectField
                                    label="Manager 基座"
                                    value={managerRuntimeBase}
                                    onChange={(value) => {
                                      setDraft({
                                        ...draft,
                                        roleProfile: {
                                          ...(draft.roleProfile ?? {}),
                                          managerRuntimeType: (value === 'qwenpaw' ? 'qwenpaw' : 'openclaw') as ManagerRuntimeBase,
                                        },
                                      })
                                    }}
                                  >
                                    <option value="openclaw">OpenClaw</option>
                                    <option value="qwenpaw">QwenPaw</option>
                                  </SelectField>
                                ) : (
                                  <>
                                    <SelectField label="Agent 基座类型" value={runtimeType} onChange={(value) => {
                                      const nextRuntime = value as WorkspaceAgent['runtimeType']
                                      setDraft({
                                        ...draft,
                                        runtimeType: nextRuntime,
                                        codeAgentType: draft.codeAgentType ?? null,
                                        approvalRequired: false,
                                      })
                                    }}>
                                      <option value="code-agent">Worker Runtime / CLI 基座</option>
                                    </SelectField>
                                    <SelectField label="Worker 基座" value={workerRuntimeBase} onChange={(value) => setDraft(applyWorkerRuntimeBase(draft, value as WorkerRuntimeBase))}>
                                      {WORKER_BASE_OPTIONS.map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </SelectField>
                                  </>
                                )}
                                {!managerAgent && <SelectField label="模型绑定" value={draft.modelId ?? ''} onChange={(value) => setDraft({ ...draft, modelId: value || null })}>
                                  <option value="">未绑定模型，运行前需补齐</option>
                                  {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.modelId} / {model.provider}</option>)}
                                </SelectField>}
                                {!managerAgent && <SelectField label={t('沙箱策略')} value={draft.sandboxPolicy ?? 'workspace-write'} onChange={(value) => setDraft({ ...draft, sandboxPolicy: value as WorkspaceAgent['sandboxPolicy'] })}>
                                  <option value="workspace-write">{t('工作区写入')}</option>
                                  <option value="danger-full-access">{t('完全访问')}</option>
                                </SelectField>}
                              </div>
                              <p className="mt-3 text-xs leading-5 text-neutral-500">{runtimeHint}</p>
                              <p className="mt-3 text-xs leading-5 text-neutral-500">{modelCompatibilityMessage}</p>
                            </div>

                            {selectedExpertProfile && (
                              <div className="border-l-2 border-blue-200 pl-3 text-xs leading-5 text-blue-800">
                                <div className="font-medium">
                                  {expertCategoryLabels[selectedExpertProfile.category]} · {selectedExpertProfile.riskLevel === 'high' ? '高风险专家' : '标准专家'}
                                </div>
                                <div className="mt-1 text-blue-700">{selectedExpertProfile.background}</div>
                              </div>
                            )}
                          </div>
                        </div>

                        <AdvancedPanel
                          title="更多设置"
                          summary={`${(draft.skillIds ?? []).length} Skills · ${contextPolicyLabel(draft.contextPolicy)} · ${draft.autoInvoke ? '自动调用' : '手动调用'}`}
                          open={moreOpen}
                          onToggle={() => setMoreOpen((open) => !open)}
                        >
                          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
                            <div className="space-y-4">
                              <div className="grid gap-3 md:grid-cols-2">
                                <SelectField label={t('上下文策略')} value={draft.contextPolicy ?? 'workspace-aware'} onChange={(value) => setDraft({ ...draft, contextPolicy: value as WorkspaceAgent['contextPolicy'] })}>
                                  <option value="recent-only">{t('仅最近上下文')}</option>
                                  <option value="pinned-recent">{t('固定与最近上下文')}</option>
                                  <option value="workspace-aware">{t('工作区上下文')}</option>
                                </SelectField>
                                <Field label={t('颜色')} value={draft.color ?? '#111827'} onChange={(color) => setDraft({ ...draft, color })} />
                                <Field label={t('能力标签')} value={(draft.capabilityTags ?? []).join(', ')} onChange={(value) => setDraft({ ...draft, capabilityTags: splitList(value) })} />
                                <Field label={t('工具权限')} value={(draft.toolPermissions ?? []).join(', ')} onChange={(value) => setDraft({ ...draft, toolPermissions: splitList(value) })} />
                              </div>
                              <div className="grid gap-3 md:grid-cols-2">
                                <label className="flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm text-neutral-600">
                                  <input type="checkbox" checked={draft.autoInvoke ?? true} onChange={(event) => setDraft({ ...draft, autoInvoke: event.target.checked })} />
                                  {t('允许 Orchestrator 自动调用')}
                                </label>
                                <label className="flex h-10 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm text-neutral-600">
                                  <input type="checkbox" checked={draft.approvalRequired ?? true} onChange={(event) => setDraft({ ...draft, approvalRequired: event.target.checked })} />
                                  {t('高风险操作需要确认')}
                                </label>
                              </div>
                            </div>

                            <div>
                              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-neutral-800">
                                <Wrench className="h-4 w-4 text-amber-600" />
                                <span>Skills</span>
                                <span className="ml-auto text-xs text-neutral-400">已绑定 {(draft.skillIds ?? []).length} 个</span>
                              </div>
                              {availableSkills.length === 0 ? (
                                <div className="text-xs text-neutral-400">
                                  暂无已安装的 Skills，可前往技能市场安装。
                                </div>
                              ) : (
                                <div className="max-h-56 space-y-0.5 overflow-auto rounded-xl border border-neutral-200 p-2">
                                  {availableSkills.map((skill) => {
                                    const checked = (draft.skillIds ?? []).includes(skill.id)
                                    return (
                                      <label
                                        key={skill.id}
                                        className={cn(
                                          'flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 text-sm transition hover:bg-neutral-50',
                                          checked && 'bg-blue-50/50',
                                        )}
                                      >
                                        <input
                                          type="checkbox"
                                          className="mt-0.5 shrink-0"
                                          checked={checked}
                                          onChange={() => {
                                            const current = draft.skillIds ?? []
                                            setDraft({
                                              ...draft,
                                              skillIds: checked
                                                ? current.filter((id) => id !== skill.id)
                                                : [...current, skill.id],
                                            })
                                          }}
                                        />
                                        <span className="min-w-0 flex-1">
                                          <span className="block truncate text-[13px] font-medium text-neutral-800">
                                            {skill.name}
                                          </span>
                                          {skill.description && (
                                            <span className="mt-0.5 block truncate text-xs text-neutral-400">
                                              {skill.description}
                                            </span>
                                          )}
                                        </span>
                                        <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-400">
                                          {skill.source}
                                        </span>
                                      </label>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        </AdvancedPanel>
                      </div>
                    </section>
                  </form>
                </div>
              ) : (
                <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-neutral-200 bg-white">
                  <div className="text-center">
                    <Bot className="mx-auto h-10 w-10 text-neutral-300" />
                    <div className="mt-4 text-base font-semibold">{t('还没有 Agent')}</div>
                    <button type="button" onClick={createAgent} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white">
                      <Plus className="h-4 w-4" />
                      {t('新建 Agent')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {assistantDialogOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-neutral-950/10 px-4 py-8 backdrop-blur-[1px]">
          <div className="flex max-h-[min(760px,calc(100vh-64px))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-100 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-50 text-blue-700">
                  <Wand2 className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold text-neutral-950">对话式修改 Agent</div>
                  <div className="mt-0.5 text-xs text-neutral-400">全局默认 LLM · 字段补丁</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAssistantDialogOpen(false)}
                disabled={assistantStreaming}
                className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                <form onSubmit={runAssistantEdit} className="space-y-4">
                  <label className="block text-sm">
                    <span className="mb-2 block font-medium text-neutral-700">修改要求</span>
                    <textarea
                      value={assistantInstruction}
                      onChange={(event) => setAssistantInstruction(event.target.value)}
                      rows={6}
                      placeholder="例如：改成偏技术写作 Reviewer，补充 docs/review 标签，系统提示词强调先审查结构再改正文。"
                      className="w-full resize-none rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm leading-6 outline-none transition focus:border-blue-300 focus:bg-white"
                    />
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      disabled={!assistantInstruction.trim() || assistantStreaming}
                      className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-400"
                    >
                      {assistantStreaming ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Wand2 className="h-4 w-4" />
                      )}
                      {assistantStreaming ? '生成中' : '生成修改'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAssistantInstruction('')
                        setAssistantOutput('')
                        setAssistantError(null)
                        setAssistantResult(null)
                      }}
                      disabled={assistantStreaming}
                      className="inline-flex h-9 items-center rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-50 disabled:text-neutral-300"
                    >
                      清空
                    </button>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-950">
                    <div className="flex h-10 items-center justify-between border-b border-white/10 px-4">
                      <span className="text-xs font-medium text-neutral-300">流式输出</span>
                      {assistantStreaming && (
                        <span className="inline-flex items-center gap-1.5 text-xs text-blue-200">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          streaming
                        </span>
                      )}
                    </div>
                    <pre className="max-h-64 min-h-40 overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-xs leading-5 text-neutral-100">
                      {assistantOutput || '等待模型输出字段补丁。'}
                    </pre>
                  </div>

                  {assistantError && (
                    <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {assistantError}
                    </div>
                  )}
                </form>

                <aside className="flex min-h-0 flex-col rounded-2xl border border-neutral-200 bg-neutral-50">
                  <div className="shrink-0 border-b border-neutral-200 px-4 py-3">
                    <div className="text-sm font-semibold text-neutral-950">字段预览</div>
                    <div className="mt-1 text-xs text-neutral-400">
                      {assistantResult ? assistantResult.summary : '生成后在这里确认变更'}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
                    {!assistantResult && (
                      <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-neutral-200 bg-white text-sm text-neutral-400">
                        暂无补丁
                      </div>
                    )}
                    {assistantResult && assistantChanges.length === 0 && (
                      <div className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-3 text-sm text-amber-700">
                        模型没有给出有效字段变化。
                      </div>
                    )}
                    {assistantChanges.map((change) => (
                      <div key={change.key} className="rounded-xl border border-neutral-200 bg-white p-3">
                        <div className="mb-2 text-sm font-medium text-neutral-900">{change.label}</div>
                        <div className="grid gap-2 text-xs">
                          <div>
                            <div className="mb-1 text-neutral-400">当前</div>
                            <div className="max-h-24 overflow-auto rounded-lg bg-neutral-50 px-2.5 py-2 text-neutral-500">
                              {change.beforeValue}
                            </div>
                          </div>
                          <div>
                            <div className="mb-1 text-blue-500">修改后</div>
                            <div className="max-h-24 overflow-auto rounded-lg bg-blue-50 px-2.5 py-2 text-blue-800">
                              {change.afterValue}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex shrink-0 justify-end gap-2 border-t border-neutral-200 p-3">
                    <button
                      type="button"
                      onClick={() => setAssistantDialogOpen(false)}
                      disabled={assistantStreaming}
                      className="inline-flex h-9 items-center rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-50 disabled:text-neutral-300"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={applyAssistantResult}
                      disabled={!assistantResult || assistantChanges.length === 0 || assistantStreaming}
                      className="inline-flex h-9 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-500 disabled:bg-neutral-200 disabled:text-neutral-400"
                    >
                      <Check className="h-4 w-4" />
                      应用到草稿
                    </button>
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </div>
      )}

      {saved && (
        <div className="fixed bottom-5 left-1/2 z-50 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          <Check className="h-4 w-4" />
          {t('已保存')}
        </div>
      )}
    </div>
  )
}
function normalizeDraft(draft: AgentConfigInput): AgentConfigInput {
  const capabilityTags = draft.capabilityTags ?? []
  const workerRuntimeBase = getWorkerRuntimeBaseFromDraft(draft)
  const managerAgent = isManagerDraft(draft)
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    description: draft.description?.trim() ?? '',
    avatar: draft.avatar ?? null,
    systemPrompt: draft.systemPrompt?.trim() ?? '',
    skillIds: draft.skillIds ?? [],
    color: draft.color || '#111827',
    modelId: managerAgent ? null : (draft.modelId ?? null),
    runtimeType: 'code-agent' as const,
    codeAgentType: managerAgent ? null : (cliWorkerBaseFromRuntimeBase(workerRuntimeBase) ?? draft.codeAgentType ?? null),
    capabilityTags,
    toolPermissions: draft.toolPermissions?.length ? draft.toolPermissions : ['chat'],
    sandboxPolicy: draft.sandboxPolicy ?? 'workspace-write',
    contextPolicy: draft.contextPolicy ?? 'workspace-aware',
    autoInvoke: draft.autoInvoke ?? true,
    approvalRequired: false,
    roleType: draft.roleType ?? 'custom',
    roleProfile: withAgentRuntimeBases(
      draft.roleProfile ?? null,
      workerRuntimeBase,
      getManagerRuntimeBaseFromDraft(draft),
      managerAgent,
    ),
  }
}

function splitList(value: string) {
  return value
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeAgentText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function saveLibrary(agents: SavedAgentConfig[], relations: SavedAgentRelation[]) {
  const agentIds = new Set(agents.map((agent) => agent.id))
  const pruned = relations.filter(
    (relation) =>
      agentIds.has(relation.sourceAgentId) &&
      agentIds.has(relation.targetAgentId) &&
      relation.sourceAgentId !== relation.targetAgentId,
  )
  saveAgentLibraryState({ schemaVersion: 2, agents, relations: pruned })
  return pruned
}

function modelName(modelId: string | null, models: ModelCatalogItem[]) {
  if (!modelId) return '未绑定模型'
  const model = models.find((item) => item.id === modelId || item.modelId === modelId)
  return model?.name || model?.modelId || modelId
}

function labelForCodeAgentType(type: WorkspaceAgent['codeAgentType'] | null | undefined) {
  if (type === 'claude-code') return 'Claude Code'
  if (type === 'opencode') return 'OpenCode'
  if (type === 'gemini') return 'Gemini CLI'
  if (type === 'codex') return 'Codex CLI'
  return '未选择 Worker 基座'
}

function labelForWorkerRuntimeBase(type: WorkerRuntimeBase | null | undefined) {
  if (type === 'openclaw') return 'OpenClaw'
  if (!type) return '未选择 Worker 基座'
  return labelForCodeAgentType(type as WorkspaceAgent['codeAgentType'])
}

function labelForManagerRuntimeBase(type: ManagerRuntimeBase | null | undefined) {
  if (type === 'qwenpaw') return 'QwenPaw'
  return 'OpenClaw'
}

function isManagerDraft(
  draft: Pick<AgentConfigInput, 'roleType' | 'roleProfile'>,
  selectedExpertProfile?: { roleType?: string | null } | null,
) {
  return draft.roleType === 'orchestrator' || selectedExpertProfile?.roleType === 'orchestrator'
}

function getManagerRuntimeBaseFromDraft(draft: AgentConfigInput): ManagerRuntimeBase {
  const value = draft.roleProfile?.managerRuntimeType
  return value === 'qwenpaw' ? 'qwenpaw' : 'openclaw'
}

function getWorkerRuntimeBaseFromDraft(draft: AgentConfigInput): WorkerRuntimeBase {
  const value = draft.roleProfile?.workerRuntimeBase
  if (value === 'openclaw' || value === 'claude-code' || value === 'opencode' || value === 'gemini' || value === 'codex') {
    return value
  }
  return draft.codeAgentType ?? ''
}

function cliWorkerBaseFromRuntimeBase(value: WorkerRuntimeBase | null | undefined): CliWorkerBase | null {
  if (value === 'codex' || value === 'claude-code' || value === 'opencode' || value === 'gemini') return value
  return null
}

function withAgentRuntimeBases(
  roleProfile: AgentConfigInput['roleProfile'],
  workerRuntimeBase: WorkerRuntimeBase,
  managerRuntimeBase: ManagerRuntimeBase,
  managerAgent = false,
): AgentConfigInput['roleProfile'] {
  const { workerRuntimeBase: _workerRuntimeBase, ...rest } = roleProfile ?? {}
  return {
    ...rest,
    ...(managerAgent || !workerRuntimeBase ? {} : { workerRuntimeBase }),
    managerRuntimeType: managerRuntimeBase,
  }
}

function applyWorkerRuntimeBase(draft: AgentConfigInput, workerRuntimeBase: WorkerRuntimeBase): AgentConfigInput {
  const codeAgentType = workerRuntimeBase === 'openclaw' || !workerRuntimeBase
    ? null
    : cliWorkerBaseFromRuntimeBase(workerRuntimeBase)
  return {
    ...draft,
    codeAgentType,
    roleProfile: withAgentRuntimeBases(
      draft.roleProfile ?? null,
      workerRuntimeBase,
      getManagerRuntimeBaseFromDraft(draft),
      isManagerDraft(draft),
    ),
  }
}

function contextPolicyLabel(policy: WorkspaceAgent['contextPolicy'] | null | undefined) {
  if (policy === 'recent-only') return '最近上下文'
  if (policy === 'pinned-recent') return '固定上下文'
  return '工作区上下文'
}

function compactAgentConfigPatch(patch: Partial<AgentConfigInput>): Partial<AgentConfigInput> {
  const next: Partial<AgentConfigInput> = {}
  for (const key of Object.keys(patch) as Array<keyof AgentConfigInput>) {
    const value = patch[key]
    if (value !== undefined) {
      ;(next as Record<string, unknown>)[key] = value
    }
  }
  return next
}

function changedFieldsFromPatch(current: AgentConfigInput, patch: Partial<AgentConfigInput>) {
  const compact = compactAgentConfigPatch(patch)
  return (Object.keys(compact) as Array<keyof AgentConfigInput>)
    .filter((key) => !isSameConfigValue(current[key], compact[key]))
    .map((key) => ({
      key,
      label: agentConfigFieldLabel(key),
      beforeValue: formatConfigValue(current[key]),
      afterValue: formatConfigValue(compact[key]),
    }))
}

function isSameConfigValue(left: unknown, right: unknown) {
  return stableConfigString(left) === stableConfigString(right)
}

function stableConfigString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return JSON.stringify(
      Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key]
          return acc
        }, {}),
    )
  }
  return String(value)
}

function formatConfigValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '空'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '空'
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function agentConfigFieldLabel(key: keyof AgentConfigInput) {
  const labels: Record<keyof AgentConfigInput, string> = {
    name: '名称',
    role: '角色',
    roleType: '角色类型',
    description: '简介',
    avatar: '头像',
    systemPrompt: '系统提示词',
    roleProfile: '角色画像',
    color: '颜色',
    modelId: '模型绑定',
    runtimeType: 'Agent 基座类型',
    codeAgentType: 'Worker 基座',
    capabilityTags: '能力标签',
    skillIds: 'Skills',
    toolPermissions: '工具权限',
    sandboxPolicy: '沙箱策略',
    contextPolicy: '上下文策略',
    autoInvoke: '自动调用',
    approvalRequired: '审批确认',
  }
  return labels[key] ?? key
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-2 block text-neutral-600">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-xl border border-neutral-200 px-3 outline-none focus:border-neutral-400" />
    </label>
  )
}

function TextField({ label, value, rows, onChange }: { label: string; value: string; rows: number; onChange: (value: string) => void }) {
  return (
    <label className="mt-4 block text-sm">
      <span className="mb-2 block text-neutral-600">{label}</span>
      <textarea value={value} rows={rows} onChange={(event) => onChange(event.target.value)} className="w-full resize-none rounded-xl border border-neutral-200 px-3 py-2 leading-6 outline-none focus:border-neutral-400" />
    </label>
  )
}

function SelectField({ label, value, disabled, onChange, children }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-2 block text-neutral-600">{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-xl border border-neutral-200 bg-white px-3 outline-none focus:border-neutral-400 disabled:bg-neutral-50 disabled:text-neutral-300">
        {children}
      </select>
    </label>
  )
}

function AdvancedPanel({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-neutral-50"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-neutral-950">{title}</span>
          <span className="mt-1 block truncate text-xs text-neutral-400">{summary}</span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-neutral-400 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && <div className="border-t border-neutral-100 px-5 pb-5 pt-1">{children}</div>}
    </section>
  )
}
