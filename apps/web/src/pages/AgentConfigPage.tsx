import { FormEvent, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Bot,
  Check,
  Copy,
  MessageSquareText,
  PanelLeft,
  Plus,
  Save,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react'
import CollapsibleSessionSidebar from '../components/chat/CollapsibleSessionSidebar'
import {
  createSavedAgent,
  loadAgentLibrary,
  saveAgentLibrary,
  saveAgentToLibrary,
  toAgentConfigInput,
  type SavedAgentConfig,
} from '../lib/agentLibrary'
import { api, type AgentConfigInput, type ModelCatalogItem, type WorkspaceAgent } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'

const emptyDraft: AgentConfigInput = {
  name: '',
  role: '',
  description: '',
  avatar: null,
  systemPrompt: '',
  color: '#111827',
  modelId: null,
  runtimeType: 'llm',
  codeAgentType: null,
  capabilityTags: [],
  toolPermissions: ['chat'],
  sandboxPolicy: 'workspace-write',
  contextPolicy: 'workspace-aware',
  autoInvoke: true,
  approvalRequired: true,
}

export default function AgentConfigPage() {
  const { t } = useI18n()
  const [agents, setAgents] = useState<SavedAgentConfig[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentConfigInput>(emptyDraft)
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [assistantText, setAssistantText] = useState('')
  const [assistantReply, setAssistantReply] = useState('可以直接说：把当前 Agent 改成 Codex 实现者，关闭风险确认，标签加 frontend。')
  const [saved, setSaved] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    const loaded = loadAgentLibrary()
    setAgents(loaded)
    const first = loaded[0]
    if (first) {
      setSelectedId(first.id)
      setDraft(toAgentConfigInput(first))
    }
  }, [])

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

  const filteredAgents = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return agents
    return agents.filter((agent) => {
      const haystack = [agent.name, agent.role, agent.description, agent.systemPrompt, ...(agent.capabilityTags ?? [])].join(' ').toLowerCase()
      return haystack.includes(keyword)
    })
  }, [agents, query])

  const selectedAgent = agents.find((agent) => agent.id === selectedId) ?? null
  const runtimeType = draft.runtimeType ?? 'llm'

  function selectAgent(agent: SavedAgentConfig) {
    setSelectedId(agent.id)
    setDraft(toAgentConfigInput(agent))
  }

  function createAgent() {
    const next = createSavedAgent({
      name: 'New Agent',
      role: '协作',
      description: '描述这个 Agent 的职责、产出和适合处理的任务。',
      systemPrompt: '你是 AgentHub 中的协作 Agent。先理解目标，再给出清晰、可执行的结果。',
      color: '#111827',
    })
    const updated = [next, ...agents]
    setAgents(updated)
    saveAgentLibrary(updated)
    selectAgent(next)
    toastSaved()
  }

  function duplicateAgent() {
    if (!selectedAgent) return
    const next = createSavedAgent({
      ...toAgentConfigInput(selectedAgent),
      name: `${selectedAgent.name} Copy`,
    })
    const updated = [next, ...agents]
    setAgents(updated)
    saveAgentLibrary(updated)
    selectAgent(next)
    toastSaved()
  }

  function saveDraft(event?: FormEvent) {
    event?.preventDefault()
    const normalized = normalizeDraft(draft)
    if (!normalized.name || !normalized.role) return
    const updated = saveAgentToLibrary(agents, normalized, selectedId ?? undefined)
    setAgents(updated)
    const current = selectedId ? updated.find((agent) => agent.id === selectedId) : updated[0]
    if (current) {
      setSelectedId(current.id)
      setDraft(toAgentConfigInput(current))
    }
    toastSaved()
  }

  function deleteAgent() {
    if (!selectedAgent) return
    const confirmed = window.confirm(`删除 Agent「${selectedAgent.name}」？已加入工作区的成员不会被自动删除。`)
    if (!confirmed) return
    const updated = agents.filter((agent) => agent.id !== selectedAgent.id)
    setAgents(updated)
    saveAgentLibrary(updated)
    const next = updated[0] ?? null
    setSelectedId(next?.id ?? null)
    setDraft(next ? toAgentConfigInput(next) : emptyDraft)
    toastSaved()
  }

  function applyAssistantPatch(event: FormEvent) {
    event.preventDefault()
    const text = assistantText.trim()
    if (!text) return

    const { patch, reply } = patchFromInstruction(text, draft)
    const nextDraft = normalizeDraft({ ...draft, ...patch })
    setDraft(nextDraft)
    setAssistantText('')
    setAssistantReply(reply)
    const updated = saveAgentToLibrary(agents, nextDraft, selectedId ?? undefined)
    setAgents(updated)
    const current = selectedId ? updated.find((agent) => agent.id === selectedId) : updated[0]
    if (current) setSelectedId(current.id)
    toastSaved()
  }

  function toastSaved() {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1400)
  }

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#fbfbf9] text-neutral-950">
      <CollapsibleSessionSidebar collapsed={sidebarCollapsed} />
      <main className="flex min-w-0 flex-1 flex-col">
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

        <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-h-0 border-r border-neutral-200 bg-white p-4">
            <div className="flex items-center gap-2 rounded-xl border border-neutral-200 px-3">
              <Search className="h-4 w-4 text-neutral-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('搜索 Agent、角色、标签')}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-300"
              />
            </div>

            <div className="mt-4 flex items-center justify-between text-xs text-neutral-400">
              <span>{t('Agent 库')}</span>
              <span>{agents.length} {t('个配置')}</span>
            </div>

            <div className="mt-2 max-h-[calc(100vh-9rem)] space-y-2 overflow-y-auto pr-1">
              {filteredAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => selectAgent(agent)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition',
                    selectedId === agent.id ? 'border-neutral-900 bg-neutral-950 text-white shadow-sm' : 'border-neutral-200 bg-white hover:border-neutral-300'
                  )}
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white" style={{ background: agent.color ?? '#111827' }}>
                    <Bot className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{agent.name}</span>
                    <span className={cn('mt-1 block truncate text-xs', selectedId === agent.id ? 'text-white' : 'text-neutral-500')}>{agent.role}</span>
                    <span className={cn('mt-2 line-clamp-2 text-xs leading-5', selectedId === agent.id ? 'text-white' : 'text-neutral-400')}>
                      {agent.description || runtimeLabel(agent.runtimeType ?? 'llm')}
                    </span>
                  </span>
                </button>
              ))}
              {!filteredAgents.length && (
                <div className="rounded-2xl border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-400">
                  {t('没有匹配的 Agent')}
                </div>
              )}
            </div>
          </aside>

          <section className="min-w-0 overflow-y-auto px-8 py-7">
            <div className="mx-auto max-w-6xl">
              <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="inline-flex h-7 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs text-neutral-500">
                    <Settings2 className="h-3.5 w-3.5" />
                    {t('全局 Agent 配置库')}
                  </div>
                  <h1 className="mt-4 text-3xl font-semibold tracking-normal">{t('管理所有 Agent')}</h1>
                  <p className="mt-2 max-w-2xl text-sm leading-7 text-neutral-500">
                    {t('这里保存的是可复用 Agent 模板。保存后可以在 Agent Group 里直接套用，也可以通过下方对话指令快速调整当前 Agent。')}
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

              {selectedAgent ? (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <form onSubmit={saveDraft} className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
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
                        })
                      }}>
                        <option value="llm">{t('普通 LLM Agent')}</option>
                        <option value="code-agent">Coding Tools</option>
                        <option value="mcp">Native Read-only Agent</option>
                        <option value="a2a">A2A Agent</option>
                      </SelectField>
                      <SelectField label="Coding Tools" value={runtimeType === 'code-agent' ? (draft.codeAgentType ?? 'codex') : ''} disabled={runtimeType !== 'code-agent'} onChange={(value) => setDraft({ ...draft, codeAgentType: (value || null) as WorkspaceAgent['codeAgentType'] })}>
                        <option value="">{t('不绑定 CLI')}</option>
                        <option value="codex">Codex CLI</option>
                        <option value="claude-code">Claude Code</option>
                        <option value="opencode">OpenCode</option>
                        <option value="gemini">Gemini CLI</option>
                      </SelectField>
                      <SelectField label={t('默认模型')} value={draft.modelId ?? ''} onChange={(value) => setDraft({ ...draft, modelId: value || null })}>
                        <option value="">{t('自动模型')}</option>
                        {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.modelId}</option>)}
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

                    <div className="mt-5 flex justify-end">
                      <button type="submit" className="inline-flex h-10 items-center gap-2 rounded-xl bg-neutral-950 px-5 text-sm font-medium text-white hover:bg-neutral-800">
                        <Save className="h-4 w-4" />
                        {t('保存 Agent')}
                      </button>
                    </div>
                  </form>

                  <aside className="space-y-4">
                    <InfoPanel title={t('当前配置')}>
                      <InfoRow label={t('运行时')} value={runtimeLabel(runtimeType)} />
                      <InfoRow label={t('模型')} value={t(modelName(draft.modelId ?? null, models))} />
                      <InfoRow label={t('权限')} value={t(sandboxLabel(draft.sandboxPolicy ?? 'workspace-write'))} />
                      <InfoRow label={t('标签')} value={(draft.capabilityTags ?? []).join(', ') || t('未设置')} />
                    </InfoPanel>

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
  const runtimeType = draft.runtimeType ?? 'llm'
  const capabilityTags = draft.capabilityTags ?? []
  const nativeReadOnly = runtimeType === 'mcp'
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
    toolPermissions: nativeReadOnly ? ['workspace:read', 'skills:read'] : draft.toolPermissions?.length ? draft.toolPermissions : ['chat'],
    sandboxPolicy: nativeReadOnly ? 'read-only' : (draft.sandboxPolicy ?? 'workspace-write'),
    contextPolicy: draft.contextPolicy ?? 'workspace-aware',
    autoInvoke: draft.autoInvoke ?? true,
    approvalRequired: nativeReadOnly ? true : (draft.approvalRequired ?? true),
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

function runtimeLabel(value: WorkspaceAgent['runtimeType']) {
  if (value === 'code-agent') return 'Coding Tools'
  if (value === 'mcp') return 'Native Read-only'
  if (value === 'a2a') return 'A2A Agent'
  return 'LLM Agent'
}

function sandboxLabel(value: WorkspaceAgent['sandboxPolicy']) {
  if (value === 'read-only') return '只读'
  if (value === 'danger-full-access') return '完全访问'
  return '工作区写入'
}

function modelName(modelId: string | null, models: ModelCatalogItem[]) {
  if (!modelId) return '自动模型'
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
