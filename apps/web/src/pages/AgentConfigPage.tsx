import { FormEvent, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  MessageSquareText,
  PanelLeft,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Wand2,
  Wrench,
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
  type AgentConfigInput,
  type CodingToolStatus,
  type ModelCatalogItem,
  type SettingsGeneralInfo,
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
  readProfileStringArray,
} from '../lib/expertProfiles'
import { useI18n } from '../lib/i18n'
import { runtimeLabel, sandboxLabel } from '../lib/agentDisplay'
import { cn } from '../lib/utils'
import { useChatStore } from '../stores/chatStore'

const emptyDraft: AgentConfigInput = {
  name: '',
  role: '',
  description: '',
  avatar: null,
  systemPrompt: '',
  color: '#111827',
  modelId: null,
  runtimeType: 'code-agent',
  codeAgentType: 'codex',
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

type HealthState = 'idle' | 'checking' | 'ready' | 'error'
type AdvancedSectionKey = 'prompt' | 'capabilities' | 'policies'

interface AgentComboHealth {
  state: HealthState
  checkedAt?: string
  error?: string
  cli?: {
    ok: boolean
    label: string
    message: string
    status?: CodingToolStatus | null
  }
  model?: {
    ok: boolean
    label: string
    message: string
  }
  sandbox?: {
    ok: boolean
    label: string
    message: string
    provider?: string
  }
  isolation?: {
    ok: boolean
    label: string
    message: string
  }
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
  const [assistantText, setAssistantText] = useState('')
  const [assistantReply, setAssistantReply] = useState('可以直接说：把当前 Agent 改成 Codex 实现者，关闭风险确认，标签加 frontend。')
  const [saved, setSaved] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showImportPanel, setShowImportPanel] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState<Record<AdvancedSectionKey, boolean>>({
    prompt: false,
    capabilities: false,
    policies: false,
  })
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([])
  const [comboHealth, setComboHealth] = useState<AgentComboHealth>({ state: 'idle' })
  const selectedExpertProfile = expertProfileForId(expertProfileIdFromDraft(draft))
  const draftOutputContract = readProfileStringArray(draft.roleProfile, 'outputContract')
  const draftQualityGates = readProfileStringArray(draft.roleProfile, 'qualityGates')
  const draftRecommendedMcpServers = readProfileStringArray(draft.roleProfile, 'recommendedMcpServers')
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
  const selectedModel = draft.modelId ? models.find((item) => item.id === draft.modelId || item.modelId === draft.modelId) ?? null : null
  const selectedSkills = draft.skillIds ?? []
  const runtimeComboLabel =
    runtimeType === 'code-agent'
      ? `${labelForCodeAgentType(draft.codeAgentType ?? 'codex')} × ${modelName(draft.modelId ?? null, models)} × ${selectedSkills.length} 个 Skills`
      : `LLM × ${modelName(draft.modelId ?? null, models)} × ${selectedSkills.length} 个 Skills`
  const modelCompatibilityMessage = (() => {
    const modelId = draft.modelId ?? null
    const codeAgentType = draft.codeAgentType ?? null
    const model = selectedModel
    if (!modelId) return '留空时会按当前 CLI 基底，从模型管理中挑选兼容的默认模型；填入后该 Agent 绑定独立模型，不会和其他 Agent 共用。'
    if (!model) return '这个 Agent 绑定了独立模型，但模型目录里暂时找不到对应条目；运行时会直接报错，不再偷偷回退到旧工具配置。'
    if (codeAgentType === 'claude-code' && !/claude|sonnet|opus|haiku|anthropic/i.test(`${model.provider} ${model.modelId} ${model.apiEndpoint ?? ''} ${model.anthropicEndpoint ?? ''}`)) {
      return 'Claude Code 更适合 Anthropic/Claude 兼容模型；建议为它绑定带 Anthropic 端点的模型条目。'
    }
    if (codeAgentType === 'gemini' && !/gemini|google/i.test(`${model.provider} ${model.modelId}`)) {
      return 'Gemini CLI 更适合 Gemini/Google 兼容模型；建议为它绑定 Gemini/Google 兼容条目。'
    }
    if (codeAgentType === 'claude-code') {
      return '这个 Agent 会优先使用独立模型，并把该模型的 Anthropic 端点和密钥注入 Claude Code。'
    }
    if (codeAgentType === 'codex') {
      return '这个 Agent 会优先使用独立模型；Codex 仍走官方 auth/config 体系，不使用通用 Base URL 选择器。'
    }
    return '这个 Agent 会优先使用独立模型，并把对应模型端点与密钥注入当前 CLI 运行器。'
  })()

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

  async function refreshComboHealth() {
    setComboHealth({ state: 'checking' })
    try {
      const codeAgentType = draft.codeAgentType ?? 'codex'
      const model = selectedModel
      const [toolStatus, generalInfo, modelResult] = await Promise.all([
        runtimeType === 'code-agent'
          ? api.getCodingToolStatus([{ id: codeAgentType, command: commandForCodeAgentType(codeAgentType) }])
          : Promise.resolve(null),
        api.getSettingsGeneralInfo(),
        model
          ? api.testModel({
              provider: model.provider,
              apiEndpoint: model.apiEndpoint,
              anthropicEndpoint: model.anthropicEndpoint,
              apiKey: model.apiKey,
              apiKeyEnv: model.apiKeyEnv,
              modelId: model.modelId,
            })
          : Promise.resolve(null),
      ])
      const cliStatus = toolStatus?.items?.find((item) => item.id === codeAgentType) ?? toolStatus?.items?.[0] ?? null
      setComboHealth({
        state: 'ready',
        checkedAt: new Date().toLocaleTimeString(),
        cli: buildCliHealth(runtimeType, codeAgentType, cliStatus),
        model: buildModelHealth(model, modelResult),
        sandbox: buildSandboxHealth(generalInfo),
        isolation: buildIsolationHealth(generalInfo),
      })
    } catch (error) {
      setComboHealth({
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
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

  async function applyAssistantPatch(event: FormEvent) {
    event.preventDefault()
    const text = assistantText.trim()
    if (!text) return

    const { patch, reply } = patchFromInstruction(text, draft)
    const nextDraft = normalizeDraft({ ...draft, ...patch })
    setDraft(nextDraft)
    setAssistantText('')
    setAssistantReply(reply)
    if (!nextDraft.name || !nextDraft.role) {
      setAssistantReply(`${reply} 请补齐名称和角色后再保存。`)
      return
    }
    const updated = saveAgentToLibrary(agents, nextDraft, selectedId ?? undefined)
    setAgents(updated)
    setRelations((current) => saveLibrary(updated, current))
    const current = selectedId ? updated.find((agent) => agent.id === selectedId) : updated[0]
    if (current) {
      setSelectedId(current.id)
      setSearchParams({ agentId: current.id }, { replace: true })
    }
    try {
      await flushAgentLibraryServerSync()
      if (current) await syncSavedAgentDirectSessions(current, selectedAgent)
      await syncCurrentWorkspaceAgent(nextDraft)
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
    setDraft({
      ...draft,
      ...preset,
      name: preset.name,
      role: preset.role,
      codeAgentType: preset.runtimeType === 'code-agent' ? (preset.codeAgentType ?? 'codex') : null,
    })
  }

  async function updateSelectedRelation(relationType: SavedAgentRelation['relationType'], targetAgentId: string) {
    if (!selectedAgent) return
    const next = relations.filter((relation) => !(relation.sourceAgentId === selectedAgent.id && relation.relationType === relationType))
    if (targetAgentId && targetAgentId !== selectedAgent.id) {
      const now = new Date().toISOString()
      next.push({
        id: `${selectedAgent.id}-${relationType}-${targetAgentId}`,
        sourceAgentId: selectedAgent.id,
        targetAgentId,
        relationType,
        note: relationLabel(relationType),
        createdAt: now,
        updatedAt: now,
      })
    }
    setRelations(next)
    saveAgentLibraryState({ schemaVersion: 2, agents, relations: next })
    try {
      await flushAgentLibraryServerSync()
      toastSaved()
    } catch (error) {
      toastSaveFailed(error)
    }
  }

  function toggleAdvancedSection(section: AdvancedSectionKey) {
    setAdvancedOpen((current) => ({ ...current, [section]: !current[section] }))
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
              <div className="mb-5 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="inline-flex h-7 items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 text-xs text-neutral-500">
                      <Settings2 className="h-3.5 w-3.5" />
                      {t('全局 Agent 配置库')}
                    </div>
                    <h1 className="mt-3 text-2xl font-semibold tracking-normal">{t('Agent 通讯录')}</h1>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-neutral-600">
                        {agents.length} 个 Agent
                      </span>
                      <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-neutral-600">
                        {agents.filter((agent) => agent.runtimeType === 'code-agent').length} 个 Coding Tools
                      </span>
                      <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">
                        {savedExpertProfileIds.size} 个模板已导入
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowImportPanel((open) => !open)}
                      className={cn(
                        'inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-sm font-medium shadow-sm transition',
                        showImportPanel
                          ? 'border-teal-200 bg-teal-50 text-teal-700'
                          : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50',
                      )}
                    >
                      <Sparkles className="h-4 w-4" />
                      {showImportPanel ? t('收起导入') : t('导入专家')}
                    </button>
                    <button type="button" onClick={duplicateAgent} disabled={!selectedAgent} className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm hover:bg-neutral-50 disabled:text-neutral-300">
                      <Copy className="h-4 w-4" />
                      {t('复制')}
                    </button>
                    <button type="button" onClick={deleteAgent} disabled={!selectedAgent} className="inline-flex h-9 items-center gap-2 rounded-xl border border-red-100 bg-white px-3 text-sm font-medium text-red-500 shadow-sm hover:bg-red-50 disabled:text-neutral-300">
                      <Trash2 className="h-4 w-4" />
                      {t('删除')}
                    </button>
                  </div>
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
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
                  <form onSubmit={saveDraft} className="space-y-4">
                    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
                      <div className="border-b border-neutral-100 px-5 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <div
                              className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-white shadow-sm"
                              style={{ background: draft.color ?? '#111827' }}
                            >
                              <Bot className="h-6 w-6" />
                            </div>
                            <div className="min-w-0">
                              <div className="truncate text-lg font-semibold text-neutral-950">
                                {draft.name || '未命名 Agent'}
                              </div>
                              <div className="mt-1 truncate text-sm text-neutral-500">
                                {draft.role || '设置角色后可保存'}
                              </div>
                            </div>
                          </div>
                          <button
                            type="submit"
                            className="inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800"
                          >
                            <Save className="h-4 w-4" />
                            {selectedAgent ? t('保存 Agent') : t('创建 Agent')}
                          </button>
                        </div>
                      </div>

                      <div className="space-y-4 px-5 py-5">
                        <SelectField
                          label="预装专家模板"
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

                        <div className="grid gap-3 md:grid-cols-2">
                          <Field label={t('名称')} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
                          <Field label={t('角色')} value={draft.role} onChange={(role) => setDraft({ ...draft, role })} />
                        </div>

                        <TextField
                          label={t('简介')}
                          rows={3}
                          value={draft.description ?? ''}
                          onChange={(description) => setDraft({ ...draft, description })}
                        />

                        {selectedExpertProfile && (
                          <div className="rounded-xl border border-blue-100 bg-blue-50/50 px-3 py-2 text-xs leading-5 text-blue-800">
                            <div className="font-medium">
                              {expertCategoryLabels[selectedExpertProfile.category]} · {selectedExpertProfile.riskLevel === 'high' ? '高风险专家' : '标准专家'}
                            </div>
                            <div className="mt-1 text-blue-700">{selectedExpertProfile.background}</div>
                          </div>
                        )}
                      </div>
                    </section>

                    <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h2 className="text-base font-semibold text-neutral-950">执行配置</h2>
                          <p className="mt-1 text-xs text-neutral-400">选择运行器、模型和执行边界。</p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs">
                          <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-neutral-600">
                            {runtimeType === 'code-agent' ? labelForCodeAgentType(draft.codeAgentType ?? 'codex') : 'LLM'}
                          </span>
                          <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-neutral-600">
                            {modelName(draft.modelId ?? null, models)}
                          </span>
                          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">
                            {(draft.skillIds ?? []).length} Skills
                          </span>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <SelectField label="Agent 基底" value={runtimeType} onChange={(value) => {
                          const nextRuntime = value as WorkspaceAgent['runtimeType']
                          setDraft({
                            ...draft,
                            runtimeType: nextRuntime,
                            codeAgentType: nextRuntime === 'code-agent' ? (draft.codeAgentType ?? 'codex') : null,
                            approvalRequired: nextRuntime === 'code-agent' ? false : (draft.approvalRequired ?? true),
                          })
                        }}>
                          <option value="code-agent">Coding Tools / CLI 运行器</option>
                          <option value="llm">{t('普通 LLM Agent')}</option>
                        </SelectField>
                        <SelectField label="CLI 运行器" value={draft.codeAgentType ?? 'codex'} disabled={runtimeType !== 'code-agent'} onChange={(value) => setDraft({ ...draft, codeAgentType: (value || null) as WorkspaceAgent['codeAgentType'] })}>
                          <option value="">{t('不绑定 CLI')}</option>
                          <option value="codex">Codex CLI</option>
                          <option value="claude-code">Claude Code</option>
                          <option value="opencode">OpenCode</option>
                          <option value="gemini">Gemini CLI</option>
                        </SelectField>
                        <SelectField label="模型绑定" value={draft.modelId ?? ''} onChange={(value) => setDraft({ ...draft, modelId: value || null })}>
                          <option value="">{runtimeType === 'code-agent' ? '沿用模型管理默认' : '使用默认模型'}</option>
                          {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.modelId} / {model.provider}</option>)}
                        </SelectField>
                        <SelectField label={t('沙箱策略')} value={draft.sandboxPolicy ?? 'workspace-write'} onChange={(value) => setDraft({ ...draft, sandboxPolicy: value as WorkspaceAgent['sandboxPolicy'] })}>
                          <option value="read-only">{t('只读')}</option>
                          <option value="workspace-write">{t('工作区写入')}</option>
                          <option value="danger-full-access">{t('完全访问')}</option>
                        </SelectField>
                      </div>

                      {runtimeType === 'code-agent' && (
                        <div className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs leading-5 text-neutral-500">
                          {modelCompatibilityMessage}
                        </div>
                      )}
                    </section>

                    <AdvancedPanel
                      title="提示词"
                      summary={draft.systemPrompt ? '已配置系统提示词' : '未配置系统提示词'}
                      open={advancedOpen.prompt}
                      onToggle={() => toggleAdvancedSection('prompt')}
                    >
                      <TextField
                        label={t('系统提示词')}
                        rows={7}
                        value={draft.systemPrompt ?? ''}
                        onChange={(systemPrompt) => setDraft({ ...draft, systemPrompt })}
                      />
                    </AdvancedPanel>

                    <AdvancedPanel
                      title="能力与上下文"
                      summary={`${(draft.skillIds ?? []).length} 个 Skills · ${(draft.capabilityTags ?? []).length || 0} 个标签`}
                      open={advancedOpen.capabilities}
                      onToggle={() => toggleAdvancedSection('capabilities')}
                    >
                      <div className="grid gap-3 md:grid-cols-2">
                        <SelectField label={t('上下文策略')} value={draft.contextPolicy ?? 'workspace-aware'} onChange={(value) => setDraft({ ...draft, contextPolicy: value as WorkspaceAgent['contextPolicy'] })}>
                          <option value="recent-only">{t('仅最近上下文')}</option>
                          <option value="pinned-recent">{t('固定与最近上下文')}</option>
                          <option value="workspace-aware">{t('工作区上下文')}</option>
                        </SelectField>
                        <Field label={t('能力标签')} value={(draft.capabilityTags ?? []).join(', ')} onChange={(value) => setDraft({ ...draft, capabilityTags: splitList(value) })} />
                      </div>

                      <div className="mt-4 rounded-xl border border-neutral-200 bg-white">
                        <div className="flex h-11 items-center gap-2 border-b border-neutral-100 px-4">
                          <Wrench className="h-4 w-4 text-amber-600" />
                          <span className="text-sm font-medium text-neutral-800">能力包 / Skills</span>
                          <span className="ml-auto text-xs text-neutral-400">
                            已绑定 {(draft.skillIds ?? []).length} 个
                          </span>
                        </div>
                        {availableSkills.length === 0 ? (
                          <div className="px-4 py-3 text-xs text-neutral-400">
                            暂无已安装的 Skills，可前往技能市场安装。
                          </div>
                        ) : (
                          <div className="max-h-52 space-y-0.5 overflow-auto p-2">
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
                    </AdvancedPanel>

                    <AdvancedPanel
                      title="策略"
                      summary={`${draft.autoInvoke ? '自动调用' : '手动调用'} · ${draft.approvalRequired ? '需要确认' : '无需确认'}`}
                      open={advancedOpen.policies}
                      onToggle={() => toggleAdvancedSection('policies')}
                    >
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label={t('颜色')} value={draft.color ?? '#111827'} onChange={(color) => setDraft({ ...draft, color })} />
                        <Field label={t('工具权限')} value={(draft.toolPermissions ?? []).join(', ')} onChange={(value) => setDraft({ ...draft, toolPermissions: splitList(value) })} />
                      </div>
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <label className="flex h-11 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm text-neutral-600">
                          <input type="checkbox" checked={draft.autoInvoke ?? true} onChange={(event) => setDraft({ ...draft, autoInvoke: event.target.checked })} />
                          {t('允许 Orchestrator 自动调用')}
                        </label>
                        <label className="flex h-11 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm text-neutral-600">
                          <input type="checkbox" checked={draft.approvalRequired ?? true} onChange={(event) => setDraft({ ...draft, approvalRequired: event.target.checked })} />
                          {t('高风险操作需要确认')}
                        </label>
                      </div>
                    </AdvancedPanel>
                  </form>

                  <aside className="space-y-4">
                    <InfoPanel title="状态概览">
                      <InfoRow label={t('运行时')} value={runtimeLabel(runtimeType)} />
                      <InfoRow label="组合" value={runtimeComboLabel} />
                      <InfoRow label={t('权限')} value={t(sandboxLabel(draft.sandboxPolicy ?? 'workspace-write'))} />
                      <InfoRow label="主要产出" value={draftOutputContract.join(', ') || '自定义'} />
                    </InfoPanel>

                    <InfoPanel title="组合健康检查">
                      <button
                        type="button"
                        onClick={() => void refreshComboHealth()}
                        disabled={comboHealth.state === 'checking'}
                        className="mb-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <RefreshCw className={cn('h-4 w-4', comboHealth.state === 'checking' && 'animate-spin')} />
                        {comboHealth.state === 'checking' ? '检查中' : '刷新当前组合'}
                      </button>
                      {comboHealth.state === 'idle' ? (
                        <div className="text-sm leading-6 text-neutral-500">
                          检查 CLI、模型连通性、Docker Sandboxes 和执行隔离是否匹配当前组合。
                        </div>
                      ) : comboHealth.state === 'error' ? (
                        <HealthRow ok={false} label="检查失败" message={comboHealth.error ?? '健康检查请求失败'} />
                      ) : (
                        <div className="space-y-2">
                          {comboHealth.cli && (
                            <HealthRow ok={comboHealth.cli.ok} label={comboHealth.cli.label} message={comboHealth.cli.message} />
                          )}
                          {comboHealth.model && (
                            <HealthRow ok={comboHealth.model.ok} label={comboHealth.model.label} message={comboHealth.model.message} />
                          )}
                          {comboHealth.sandbox && (
                            <HealthRow ok={comboHealth.sandbox.ok} label={comboHealth.sandbox.label} message={comboHealth.sandbox.message} />
                          )}
                          {comboHealth.isolation && (
                            <HealthRow ok={comboHealth.isolation.ok} label={comboHealth.isolation.label} message={comboHealth.isolation.message} />
                          )}
                          {comboHealth.checkedAt && (
                            <div className="pt-1 text-[11px] text-neutral-400">检查时间 {comboHealth.checkedAt}</div>
                          )}
                        </div>
                      )}
                    </InfoPanel>

                    <InfoPanel title="模板能力">
                      <InfoRow label="模板分类" value={selectedExpertProfile ? expertCategoryLabels[selectedExpertProfile.category] : '自定义'} />
                      <InfoRow label="可接任务" value={readProfileStringArray(draft.roleProfile, 'acceptsTaskTypes').join(', ') || '自定义'} />
                      <InfoRow label="默认 Skills" value={(draft.skillIds ?? []).join(', ') || '未绑定'} />
                      <InfoRow label="推荐 MCP" value={draftRecommendedMcpServers.join(', ') || '未设置'} />
                      <InfoRow label="质量门" value={draftQualityGates.join(' / ') || '未设置'} />
                    </InfoPanel>

                    {selectedAgent ? (
                      <InfoPanel title="协作关系">
                        <RelationSelect
                          label="下游交接"
                          value={relationTarget(relations, selectedAgent.id, 'handoff_to')}
                          agents={agents}
                          currentId={selectedAgent.id}
                          onChange={(targetId) => updateSelectedRelation('handoff_to', targetId)}
                        />
                        <RelationSelect
                          label="审查者"
                          value={relationTarget(relations, selectedAgent.id, 'reviewed_by')}
                          agents={agents}
                          currentId={selectedAgent.id}
                          onChange={(targetId) => updateSelectedRelation('reviewed_by', targetId)}
                        />
                        <RelationSelect
                          label="失败降级"
                          value={relationTarget(relations, selectedAgent.id, 'fallback_to')}
                          agents={agents}
                          currentId={selectedAgent.id}
                          onChange={(targetId) => updateSelectedRelation('fallback_to', targetId)}
                        />
                      </InfoPanel>
                    ) : (
                      <InfoPanel title="协作关系">
                        <div className="text-sm leading-6 text-neutral-500">
                          保存后才可以设置协作关系。
                        </div>
                      </InfoPanel>
                    )}

                    <InfoPanel title={t('对话式修改')}>
                      <div className="rounded-2xl bg-neutral-50 p-3 text-sm leading-6 text-neutral-600">
                        <MessageSquareText className="mb-2 h-4 w-4 text-neutral-400" />
                        {t(assistantReply)}
                      </div>
                      <form onSubmit={applyAssistantPatch} className="mt-3 space-y-2">
                        <textarea
                          value={assistantText}
                          onChange={(event) => setAssistantText(event.target.value)}
                          placeholder={t('例如：改成 Claude Code 审查员，沙箱只读，标签加 review、安全')}
                          className="h-24 w-full resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm leading-6 outline-none placeholder:text-neutral-300 focus:border-neutral-400"
                        />
                        <button type="submit" className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium shadow-sm hover:bg-neutral-50">
                          <Wand2 className="h-4 w-4" />
                          {t('应用并保存')}
                        </button>
                      </form>
                    </InfoPanel>
                  </aside>
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
  const runtimeType = draft.runtimeType ?? 'code-agent'
  const capabilityTags = draft.capabilityTags ?? []
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    description: draft.description?.trim() ?? '',
    avatar: draft.avatar ?? null,
    systemPrompt: draft.systemPrompt?.trim() ?? '',
    skillIds: draft.skillIds ?? [],
    color: draft.color || '#111827',
    modelId: draft.modelId ?? null,
    runtimeType,
    codeAgentType: runtimeType === 'code-agent' ? (draft.codeAgentType ?? 'codex') : null,
    capabilityTags,
    toolPermissions: draft.toolPermissions?.length ? draft.toolPermissions : ['chat'],
    sandboxPolicy: draft.sandboxPolicy ?? 'workspace-write',
    contextPolicy: draft.contextPolicy ?? 'workspace-aware',
    autoInvoke: draft.autoInvoke ?? true,
    approvalRequired: runtimeType === 'code-agent' ? false : (draft.approvalRequired ?? true),
    roleType: draft.roleType ?? 'custom',
    roleProfile: draft.roleProfile ?? null,
  }
}

function patchFromInstruction(text: string, current: AgentConfigInput) {
  const lower = text.toLowerCase()
  const patch: Partial<AgentConfigInput> = {}
  const notes: string[] = []

  const name = matchAfter(text, ['名字改为', '名称改为', '叫做', '命名为'])
  if (name) {
    patch.name = name
    notes.push(`名称改为「${name}」`)
  }

  const role = matchAfter(text, ['角色改为', '定位改为', '职责改为'])
  if (role) {
    patch.role = role
    notes.push(`角色改为「${role}」`)
  } else if (lower.includes('审查') || lower.includes('review')) {
    patch.role = '审查'
    notes.push('角色改为审查')
  } else if (lower.includes('研究') || lower.includes('research')) {
    patch.role = '研究'
    notes.push('角色改为研究')
  } else if (lower.includes('实现') || lower.includes('coder') || lower.includes('code')) {
    patch.role = '实现'
    notes.push('角色改为实现')
  }

  if (lower.includes('codex')) {
    patch.runtimeType = 'code-agent'
    patch.codeAgentType = 'codex'
    notes.push('运行时切换为 Codex')
  } else if (lower.includes('claude')) {
    patch.runtimeType = 'code-agent'
    patch.codeAgentType = 'claude-code'
    notes.push('运行时切换为 Claude Code')
  } else if (lower.includes('opencode')) {
    patch.runtimeType = 'code-agent'
    patch.codeAgentType = 'opencode'
    notes.push('运行时切换为 OpenCode')
  } else if (lower.includes('gemini')) {
    patch.runtimeType = 'code-agent'
    patch.codeAgentType = 'gemini'
    notes.push('运行时切换为 Gemini CLI')
  } else if (lower.includes('普通') || lower.includes('llm')) {
    patch.runtimeType = 'llm'
    patch.codeAgentType = null
    notes.push('运行时切换为普通 LLM')
  }

  if (lower.includes('完全访问') || lower.includes('danger')) {
    patch.sandboxPolicy = 'danger-full-access'
    notes.push('沙箱改为完全访问')
  } else if (lower.includes('工作区写入') || lower.includes('写入')) {
    patch.sandboxPolicy = 'workspace-write'
    notes.push('沙箱改为工作区写入')
  }

  if (lower.includes('关闭自动') || lower.includes('不要自动')) {
    patch.autoInvoke = false
    notes.push('关闭自动调用')
  } else if (lower.includes('自动调用')) {
    patch.autoInvoke = true
    notes.push('开启自动调用')
  }

  if (lower.includes('关闭风险') || lower.includes('不需要确认')) {
    patch.approvalRequired = false
    notes.push('关闭高风险确认')
  } else if (lower.includes('需要确认')) {
    patch.approvalRequired = true
    notes.push('开启高风险确认')
  }

  const color = text.match(/#[0-9a-fA-F]{6}/)?.[0]
  if (color) {
    patch.color = color
    notes.push(`颜色改为 ${color}`)
  }

  const tags = matchAfter(text, ['标签加', '增加标签', '能力加'])
  if (tags) {
    patch.capabilityTags = Array.from(new Set([...(current.capabilityTags ?? []), ...splitList(tags)]))
    notes.push(`追加标签：${splitList(tags).join('、')}`)
  }

  const prompt = matchAfter(text, ['系统提示改为', '提示词改为'])
  if (prompt) {
    patch.systemPrompt = prompt
    notes.push('已更新系统提示词')
  }

  return {
    patch,
    reply: notes.length ? `已根据你的指令更新：${notes.join('，')}。` : '这条指令我没识别出明确字段，试试说“角色改为… / 使用 Codex / 标签加… / 沙箱只读”。',
  }
}

function matchAfter(text: string, markers: string[]) {
  for (const marker of markers) {
    const index = text.indexOf(marker)
    if (index < 0) continue
    return text.slice(index + marker.length).replace(/[。；;，,].*$/, '').replace(/[“”"']/g, '').trim()
  }
  return ''
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

function relationTarget(
  relations: SavedAgentRelation[],
  sourceAgentId: string,
  relationType: SavedAgentRelation['relationType'],
) {
  return (
    relations.find(
      (relation) =>
        relation.sourceAgentId === sourceAgentId && relation.relationType === relationType,
    )?.targetAgentId ?? ''
  )
}

function relationLabel(relationType: SavedAgentRelation['relationType']) {
  if (relationType === 'handoff_to') return 'handoff'
  if (relationType === 'reviewed_by') return 'review'
  if (relationType === 'fallback_to') return 'fallback'
  if (relationType === 'reports_to') return 'report'
  return 'blocks'
}


function modelName(modelId: string | null, models: ModelCatalogItem[]) {
  if (!modelId) return '默认模型'
  const model = models.find((item) => item.id === modelId || item.modelId === modelId)
  return model?.name || model?.modelId || modelId
}

function buildCliHealth(
  runtimeType: WorkspaceAgent['runtimeType'],
  codeAgentType: WorkspaceAgent['codeAgentType'] | null | undefined,
  status?: CodingToolStatus | null,
): NonNullable<AgentComboHealth['cli']> {
  if (runtimeType !== 'code-agent') {
    return {
      ok: true,
      label: 'CLI 运行器',
      message: '当前是 LLM fallback，不需要本地 Coding Tools CLI。',
      status,
    }
  }
  const label = labelForCodeAgentType(codeAgentType ?? 'codex')
  if (!status) {
    return {
      ok: false,
      label,
      message: '没有拿到 CLI 探测结果，请检查服务端是否正常。',
      status,
    }
  }
  const ok = Boolean(status.installed && status.configured !== false)
  const parts = [
    status.installed ? '已安装' : '未安装',
    status.configured === false ? '配置不可用' : '配置可用',
    status.version ? `版本 ${status.version}` : '',
  ].filter(Boolean)
  return {
    ok,
    label,
    message: status.configMessage || parts.join('，'),
    status,
  }
}

function buildModelHealth(
  model: ModelCatalogItem | null,
  result: { ok: boolean; status?: number; message: string } | null,
): NonNullable<AgentComboHealth['model']> {
  if (!model) {
    return {
      ok: true,
      label: '模型绑定',
      message: '未绑定专属模型，将沿用模型管理默认配置。',
    }
  }
  if (!result) {
    return {
      ok: false,
      label: model.name || model.modelId,
      message: '模型未完成测试。',
    }
  }
  return {
    ok: result.ok,
    label: model.name || model.modelId,
    message: result.message || (result.ok ? '模型连接可用。' : '模型连接失败。'),
  }
}

function buildSandboxHealth(info: SettingsGeneralInfo): NonNullable<AgentComboHealth['sandbox']> {
  const provider = info.sandbox.configuredProvider
  if (provider === 'local-workdir') {
    return {
      ok: true,
      label: 'Local Workdir',
      provider,
      message: '当前默认使用本地 workdir 兼容隔离。开发阶段可正常用于单聊和群聊，多 Agent 会各自使用独立 workdir 与运行时目录。',
    }
  }
  if (provider !== 'docker-sandbox') {
    return {
      ok: false,
      label: 'Sandbox Provider',
      provider,
      message: `当前 provider 是 ${provider}。`,
    }
  }
  const docker = info.sandbox.dockerSandbox
  const policy = docker.policy
  const ok = Boolean(info.sandbox.sandboxRunnable)
  const blockers = [
    info.sandbox.sbxInstalled ? '' : 'sbx CLI 未安装',
    info.sandbox.daemonReady ? '' : 'daemon 未运行',
    info.sandbox.dockerLoggedIn ? '' : 'Docker 未登录',
    info.sandbox.policyConfigured ? '' : '默认网络策略未配置',
  ].filter(Boolean)
  return {
    ok,
    label: 'Docker Sandboxes',
    provider,
    message: ok
      ? `已就绪，agent=${docker.agent || 'auto'}。`
      : blockers.join('，') || docker.probe.message || policy?.message || 'Docker Sandboxes 不可用。',
  }
}

function buildIsolationHealth(info: SettingsGeneralInfo): NonNullable<AgentComboHealth['isolation']> {
  const cleanup = info.sandbox.cleanupMode
  const ok =
    info.sandbox.configuredProvider === 'local-workdir'
      ? true
      : Boolean(info.sandbox.supportsPerAgentIsolation)
  return {
    ok,
    label: '配置隔离',
    message: ok
      ? info.sandbox.configuredProvider === 'local-workdir'
        ? `每次任务使用独立 sandbox root/home/cache/config/tmp；当前为本地兼容隔离，清理策略 ${cleanup}。`
        : `每次任务使用独立 sandbox root/home/cache/config/tmp；清理策略 ${cleanup}。`
      : '当前无法确认 microVM 级隔离；可能退化为本地 workdir 兼容隔离。',
  }
}

function labelForCodeAgentType(type: WorkspaceAgent['codeAgentType'] | null | undefined) {
  if (type === 'claude-code') return 'Claude Code'
  if (type === 'opencode') return 'OpenCode'
  if (type === 'gemini') return 'Gemini CLI'
  return 'Codex CLI'
}

function commandForCodeAgentType(type: WorkspaceAgent['codeAgentType'] | null | undefined) {
  if (type === 'claude-code') return 'claude'
  if (type === 'opencode') return 'opencode'
  if (type === 'gemini') return 'gemini'
  return 'codex'
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

function RelationSelect({
  label,
  value,
  agents,
  currentId,
  onChange,
}: {
  label: string
  value: string
  agents: SavedAgentConfig[]
  currentId: string
  onChange: (value: string) => void
}) {
  return (
    <label className="block border-t border-neutral-100 py-2 text-sm first:border-t-0">
      <span className="mb-2 block text-neutral-400">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-2 text-sm outline-none focus:border-neutral-400"
      >
        <option value="">未设置</option>
        {agents
          .filter((agent) => agent.id !== currentId)
          .map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} / {agent.role}
            </option>
          ))}
      </select>
    </label>
  )
}

function InfoPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-neutral-400" />
        {title}
      </div>
      {children}
    </section>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-neutral-100 py-2 text-sm first:border-t-0">
      <span className="text-neutral-400">{label}</span>
      <span className="min-w-0 truncate text-neutral-700">{value}</span>
    </div>
  )
}

function HealthRow({ ok, label, message }: { ok: boolean; label: string; message: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white px-3 py-2.5">
      <div className="flex items-start gap-2">
        {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}
        <div className="min-w-0">
          <div className="text-sm font-medium text-neutral-800">{label}</div>
          <div className="mt-0.5 text-xs leading-5 text-neutral-500">{message}</div>
        </div>
      </div>
    </div>
  )
}
