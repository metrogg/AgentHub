import { FormEvent, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Bot,
  Check,
  Copy,
  MessageSquareText,
  PanelLeft,
  Plus,
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
import { agentRolePresets, presetForRole } from '../lib/agentRolePresets'
import { api, type AgentConfigInput, type ModelCatalogItem, type SkillSummary, type WorkspaceAgent } from '../lib/api'
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
  const [availableSkills, setAvailableSkills] = useState<SkillSummary[]>([])
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
  const runtimeType = draft.runtimeType ?? 'code-agent'
  const modelCompatibilityMessage = (() => {
    const modelId = draft.modelId ?? null
    const codeAgentType = draft.codeAgentType ?? null
    const model = modelId ? models.find((item) => item.id === modelId || item.modelId === modelId) : null
    if (!modelId) return '留空时跟随 Coding Tools 页面里的默认模型、Base URL 和 API Key。'
    if (!model) return '将优先使用当前 Agent 保存的模型覆盖；若模型目录缺失该项，会回退到 Coding Tools 默认配置。'
    if (codeAgentType === 'claude-code' && !/claude|sonnet|opus|haiku|anthropic/i.test(`${model.provider} ${model.modelId} ${model.apiEndpoint ?? ''} ${model.anthropicEndpoint ?? ''}`)) {
      return 'Claude Code 需要 Anthropic/Claude 兼容模型；当前选择可能会被运行时回退。'
    }
    if (codeAgentType === 'gemini' && !/gemini|google/i.test(`${model.provider} ${model.modelId}`)) {
      return 'Gemini CLI 需要 Gemini/Google 兼容模型；当前选择可能会被运行时回退。'
    }
    return 'Code Agent 会优先使用这个模型覆盖，并把对应 Base URL / API Key 注入到 Coding Tools。'
  })()

  function selectAgent(agent: SavedAgentConfig, replaceUrl = false) {
    setSelectedId(agent.id)
    setDraft(toAgentConfigInput(agent))
    setSearchParams({ agentId: agent.id }, { replace: replaceUrl })
  }

  function createAgent() {
    navigate('/agent-config?newAgent=1')
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

  function applyRolePreset(roleType: string) {
    const preset = presetForRole(roleType as WorkspaceAgent['roleType'])
    if (!preset) {
      setDraft({ ...draft, roleType: 'custom' })
      return
    }
    setDraft({
      ...draft,
      ...preset,
      name: preset.name,
      role: preset.role,
      codeAgentType: preset.runtimeType === 'code-agent' ? (preset.codeAgentType ?? 'claude-code') : null,
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
            <div className="mx-auto max-w-6xl">
              <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="inline-flex h-7 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs text-neutral-500">
                    <Settings2 className="h-3.5 w-3.5" />
                    {t('全局 Agent 配置库')}
                  </div>
                  <h1 className="mt-4 text-3xl font-semibold tracking-normal">{t('管理所有 Agent')}</h1>
                  <p className="mt-2 max-w-2xl text-sm leading-7 text-neutral-500">
                    {t('这里保存的是唯一的全局 Agent 通讯录。新建群聊时像微信拉群一样邀请这些 Agent，无需再维护另一套群组配置。')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
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

              {showEditor ? (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <form onSubmit={saveDraft} className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                    <div className="mb-4">
                      <SelectField label="角色模板" value={draft.roleType ?? 'custom'} onChange={applyRolePreset}>
                        <option value="custom">自定义</option>
                        {agentRolePresets.map((preset) => (
                          <option key={preset.roleType} value={preset.roleType}>{preset.label}</option>
                        ))}
                      </SelectField>
                    </div>
                    <div className="flex items-start gap-4">
                      <div className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl text-white shadow-sm" style={{ background: draft.color ?? '#111827' }}>
                        <Bot className="h-7 w-7" />
                      </div>
                      <div className="grid min-w-0 flex-1 gap-3 md:grid-cols-2">
                        <Field label={t('名称')} value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
                        <Field label={t('角色')} value={draft.role} onChange={(role) => setDraft({ ...draft, role })} />
                      </div>
                    </div>

                    <TextField label={t('简介')} rows={3} value={draft.description ?? ''} onChange={(description) => setDraft({ ...draft, description })} />
                    <TextField label={t('系统提示词')} rows={6} value={draft.systemPrompt ?? ''} onChange={(systemPrompt) => setDraft({ ...draft, systemPrompt })} />

                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <SelectField label={t('运行时')} value={runtimeType} onChange={(value) => {
                        const nextRuntime = value as WorkspaceAgent['runtimeType']
                        setDraft({
                          ...draft,
                          runtimeType: nextRuntime,
                          codeAgentType: nextRuntime === 'code-agent' ? (draft.codeAgentType ?? 'codex') : null,
                          approvalRequired: nextRuntime === 'code-agent' ? false : (draft.approvalRequired ?? true),
                        })
                      }}>
                        <option value="code-agent">Coding Tools</option>
                        <option value="llm">{t('普通 LLM Agent')}</option>
                      </SelectField>
                      <SelectField label="Coding Tools" value={draft.codeAgentType ?? 'codex'} disabled={runtimeType !== 'code-agent'} onChange={(value) => setDraft({ ...draft, codeAgentType: (value || null) as WorkspaceAgent['codeAgentType'] })}>
                        <option value="">{t('不绑定 CLI')}</option>
                        <option value="codex">Codex CLI</option>
                        <option value="claude-code">Claude Code</option>
                        <option value="opencode">OpenCode</option>
                        <option value="gemini">Gemini CLI</option>
                      </SelectField>
                      <SelectField label="Agent 模型覆盖" value={draft.modelId ?? ''} onChange={(value) => setDraft({ ...draft, modelId: value || null })}>
                        <option value="">{runtimeType === 'code-agent' ? '跟随 Coding Tools 默认模型' : '使用默认模型'}</option>
                        {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.modelId} / {model.provider}</option>)}
                      </SelectField>
                      <SelectField label={t('沙箱策略')} value={draft.sandboxPolicy ?? 'workspace-write'} onChange={(value) => setDraft({ ...draft, sandboxPolicy: value as WorkspaceAgent['sandboxPolicy'] })}>
                        <option value="read-only">{t('只读')}</option>
                        <option value="workspace-write">{t('工作区写入')}</option>
                        <option value="danger-full-access">{t('完全访问')}</option>
                      </SelectField>
                      <SelectField label={t('上下文策略')} value={draft.contextPolicy ?? 'workspace-aware'} onChange={(value) => setDraft({ ...draft, contextPolicy: value as WorkspaceAgent['contextPolicy'] })}>
                        <option value="recent-only">{t('仅最近上下文')}</option>
                        <option value="pinned-recent">{t('固定与最近上下文')}</option>
                        <option value="workspace-aware">{t('工作区上下文')}</option>
                      </SelectField>
                      <Field label={t('颜色')} value={draft.color ?? '#111827'} onChange={(color) => setDraft({ ...draft, color })} />
                      <Field label={t('能力标签')} value={(draft.capabilityTags ?? []).join(', ')} onChange={(value) => setDraft({ ...draft, capabilityTags: splitList(value) })} />
                      <Field label={t('工具权限')} value={(draft.toolPermissions ?? []).join(', ')} onChange={(value) => setDraft({ ...draft, toolPermissions: splitList(value) })} />
                    </div>

                    {runtimeType === 'code-agent' && (
                      <div className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs leading-5 text-neutral-500">
                        {modelCompatibilityMessage}
                      </div>
                    )}

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

                    {/* 专属工具箱 */}
                    <div className="mt-5 rounded-xl border border-neutral-200 bg-white">
                      <div className="flex h-11 items-center gap-2 border-b border-neutral-100 px-4">
                        <Wrench className="h-4 w-4 text-amber-600" />
                        <span className="text-sm font-medium text-neutral-800">专属工具箱</span>
                        <span className="ml-auto text-xs text-neutral-400">
                          已绑定 {(draft.skillIds ?? []).length} 个
                        </span>
                      </div>
                      {availableSkills.length === 0 ? (
                        <div className="px-4 py-3 text-xs text-neutral-400">
                          暂无已安装的 Skills，可前往技能市场安装。
                        </div>
                      ) : (
                        <div className="max-h-48 space-y-0.5 overflow-auto p-2">
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
                      <div className="border-t border-neutral-50 px-4 py-2 text-[11px] text-neutral-400">
                        对话时优先加载已绑定的 Skills，再按匹配度自动补充。
                      </div>
                    </div>

                    <div className="mt-5 flex justify-end">
                      <button type="submit" className="inline-flex h-10 items-center gap-2 rounded-xl bg-neutral-950 px-5 text-sm font-medium text-white hover:bg-neutral-800">
                        <Save className="h-4 w-4" />
                        {selectedAgent ? t('保存 Agent') : t('创建 Agent')}
                      </button>
                    </div>
                  </form>

                  <aside className="space-y-4">
                    <InfoPanel title="能力卡">
                      <InfoRow label={t('运行时')} value={runtimeLabel(runtimeType)} />
                      <InfoRow
                        label={t('模型')}
                        value={t(modelName(draft.modelId ?? null, models))}
                      />
                      <InfoRow label={t('权限')} value={t(sandboxLabel(draft.sandboxPolicy ?? 'workspace-write'))} />
                      <InfoRow label="可接任务" value={presetForRole(draft.roleType)?.acceptsTaskTypes.join(', ') || '自定义'} />
                      <InfoRow label="主要产出" value={presetForRole(draft.roleType)?.produces.join(', ') || '自定义'} />
                      <InfoRow label={t('标签')} value={(draft.capabilityTags ?? []).join(', ') || t('未设置')} />
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
                          className="h-28 w-full resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm leading-6 outline-none placeholder:text-neutral-300 focus:border-neutral-400"
                        />
                        <button type="submit" className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium shadow-sm hover:bg-neutral-50">
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

  if (lower.includes('只读')) {
    patch.sandboxPolicy = 'read-only'
    notes.push('沙箱改为只读')
  } else if (lower.includes('完全访问') || lower.includes('danger')) {
    patch.sandboxPolicy = 'danger-full-access'
    notes.push('沙箱改为完全访问')
  } else if (lower.includes('工作区写入')) {
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
