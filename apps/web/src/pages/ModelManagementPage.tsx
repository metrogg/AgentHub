import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, PanelLeft, Plus, SlidersHorizontal, X } from 'lucide-react'
import CollapsibleSessionSidebar from '../components/chat/CollapsibleSessionSidebar'
import { api } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { settingsUpdatedEvent } from '../lib/shortcuts'
import { cn } from '../lib/utils'

interface ModelConfig {
  id: string
  enabled: boolean
  name: string
  provider: string
  modelId: string
  apiEndpoint: string
  anthropicEndpoint: string
  apiKeyEnv: string
  apiKey: string
  temperature: string
  topP: string
  maxTokens: string
  tested: boolean
}

const defaultModels: ModelConfig[] = [
  model('claude', 'Anthropic Claude', 'anthropic', 'claude-sonnet-4-6', 'https://api.anthropic.com', '', 'ANTHROPIC_API_KEY'),
  model('openai', 'OpenAI', 'openai', 'gpt-4.1', 'https://api.openai.com/v1', '', 'OPENAI_API_KEY'),
  model('deepseek', 'deepseek', 'deepseek', 'deepseek-chat', 'https://api.deepseek.com', 'https://api.deepseek.com/anthropic', 'DEEPSEEK_API_KEY'),
]

const emptyDraft = model('', '', '', '', '', '', '')

function model(
  id: string,
  name: string,
  provider: string,
  modelId: string,
  apiEndpoint: string,
  anthropicEndpoint: string,
  apiKeyEnv: string,
): ModelConfig {
  return {
    id,
    enabled: true,
    name,
    provider,
    modelId,
    apiEndpoint,
    anthropicEndpoint,
    apiKeyEnv,
    apiKey: '',
    temperature: '0.7',
    topP: '0.9',
    maxTokens: '4096',
    tested: false,
  }
}

export default function ModelManagementPage() {
  const { t } = useI18n()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [models, setModels] = useState<ModelConfig[]>(defaultModels)
  const [activeModelId, setActiveModelId] = useState(defaultModels[0]!.id)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [draft, setDraft] = useState<ModelConfig>({ ...emptyDraft, id: crypto.randomUUID(), enabled: true })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testMessages, setTestMessages] = useState<Record<string, string>>({})

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => {
        let nextModels = defaultModels
        if (settings.MODEL_CATALOG) {
          try {
            const parsed = JSON.parse(settings.MODEL_CATALOG) as ModelConfig[]
            if (Array.isArray(parsed) && parsed.length) nextModels = parsed
          } catch {
            nextModels = defaultModels
          }
        }
        setModels(nextModels)
        setActiveModelId(resolveActiveModelId(nextModels, settings.ACTIVE_MODEL_ID ?? settings.MODEL_PROVIDER))
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (loading) return
    const timer = window.setTimeout(() => {
      const selected = models.find((item) => item.id === activeModelId) ?? models[0]
      setSaveState('saving')
      void api
        .saveSettings({
          MODEL_CATALOG: JSON.stringify(models),
          ACTIVE_MODEL_ID: selected?.id ?? '',
          MODEL_PROVIDER: selected?.provider ?? '',
          MODEL_API_KEY: selected?.apiKey ?? '',
          MODEL_BASE_URL: selected?.apiEndpoint ?? '',
          MODEL_NAME: selected?.modelId ?? '',
          ACTIVE_PROVIDER: selected?.provider ?? '',
          ACTIVE_API_KEY: selected?.apiKey ?? '',
          ACTIVE_BASE_URL: selected?.apiEndpoint ?? '',
          ACTIVE_MODEL: selected?.modelId ?? '',
          ANTHROPIC_API_KEY: selected?.provider === 'anthropic' ? selected.apiKey : '',
          ANTHROPIC_MODEL: selected?.provider === 'anthropic' ? selected.modelId : 'claude-sonnet-4-6',
        })
        .then(() => {
          window.dispatchEvent(new Event(settingsUpdatedEvent))
          setSaveState('saved')
          window.setTimeout(() => setSaveState('idle'), 2500)
        })
        .catch(() => setSaveState('error'))
    }, 650)
    return () => window.clearTimeout(timer)
  }, [activeModelId, loading, models])

  function updateModel(id: string, patch: Partial<ModelConfig>) {
    setModels((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function openCreate() {
    setEditingId(null)
    setDraft({ ...emptyDraft, id: crypto.randomUUID(), enabled: true })
    setShowEditor(true)
  }

  function openEdit(item: ModelConfig) {
    setEditingId(item.id)
    setDraft({ ...item })
    setShowEditor(true)
  }

  function saveDraft() {
    if (!draft.name || !draft.provider || !draft.modelId || !draft.apiEndpoint) return
    if (editingId) {
      setModels((current) => current.map((item) => (item.id === editingId ? draft : item)))
    } else {
      setModels((current) => [...current, draft])
      setActiveModelId(draft.id)
    }
    setShowEditor(false)
  }

  function deleteModel(id: string) {
    setModels((current) => {
      if (current.length <= 1) return current
      const next = current.filter((item) => item.id !== id)
      if (activeModelId === id) setActiveModelId(next[0]!.id)
      return next
    })
  }

  async function testModel(item: ModelConfig) {
    setTestingId(item.id)
    setTestMessages((current) => ({ ...current, [item.id]: '' }))
    try {
      const result = await api.testModel({
        provider: item.provider,
        apiEndpoint: item.apiEndpoint,
        anthropicEndpoint: item.anthropicEndpoint,
        apiKey: item.apiKey,
        apiKeyEnv: item.apiKeyEnv,
        modelId: item.modelId,
      })
      updateModel(item.id, { tested: result.ok })
      setTestMessages((current) => ({ ...current, [item.id]: result.ok ? t('连接成功') : result.message }))
    } catch (error: any) {
      updateModel(item.id, { tested: false })
      setTestMessages((current) => ({ ...current, [item.id]: error?.message || t('连接失败') }))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f7f5f1] text-neutral-950">
      <CollapsibleSessionSidebar collapsed={sidebarCollapsed} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100"
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            >
              <PanelLeft className={cn('h-4 w-4 transition-transform duration-300', sidebarCollapsed && 'rotate-180')} />
            </button>
            <span className="text-sm font-semibold">AgentHub</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">{t('模型管理')}</span>
          </div>
          <AutoSaveStatus state={saveState} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <section className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="inline-flex h-7 items-center gap-2 rounded-md border border-neutral-300 bg-white px-2.5 text-xs text-neutral-600">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t('默认模型')}
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-normal">{t('模型管理')}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
                {t('管理可用模型、API 端点、密钥变量和连接测试状态。')}
              </p>
            </div>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700"
            >
              <Plus className="h-4 w-4" />
              {t('添加模型')}
            </button>
          </section>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('加载中...')}
            </div>
          ) : (
            <ModelManagement
              models={models}
              activeModelId={activeModelId}
              setActiveModelId={setActiveModelId}
              updateModel={updateModel}
              openEdit={openEdit}
              deleteModel={deleteModel}
              testModel={testModel}
              testingId={testingId}
              testMessages={testMessages}
            />
          )}
        </div>
      </main>

      {showEditor && (
        <ModelEditor
          draft={draft}
          setDraft={setDraft}
          onClose={() => setShowEditor(false)}
          onSave={saveDraft}
          editing={Boolean(editingId)}
        />
      )}
    </div>
  )
}

function ModelManagement({
  models,
  activeModelId,
  setActiveModelId,
  updateModel,
  openEdit,
  deleteModel,
  testModel,
  testingId,
  testMessages,
}: {
  models: ModelConfig[]
  activeModelId: string
  setActiveModelId: (id: string) => void
  updateModel: (id: string, patch: Partial<ModelConfig>) => void
  openEdit: (item: ModelConfig) => void
  deleteModel: (id: string) => void
  testModel: (item: ModelConfig) => void
  testingId: string | null
  testMessages: Record<string, string>
}) {
  const { t } = useI18n()
  const configuredCount = models.filter((item) => item.apiKey || item.apiKeyEnv).length
  const enabledCount = models.filter((item) => item.enabled).length
  const testedCount = models.filter((item) => item.tested).length

  return (
    <div>
      <div className="mb-6 flex w-full overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
        <Stat value={models.length} label="模型总数" />
        <Stat value={enabledCount} label="已启用" />
        <Stat value={configuredCount} label="API Key 已配置" />
        <Stat value={testedCount} label="已测试连接" />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-xs font-medium text-neutral-500">
            <tr>
              <th className="w-20 px-4 py-3">{t('启用')}</th>
              <th className="px-4 py-3">{t('名称')}</th>
              <th className="px-4 py-3">{t('提供商')}</th>
              <th className="px-4 py-3">{t('模型 ID')}</th>
              <th className="px-4 py-3">{t('API 端点')}</th>
              <th className="px-4 py-3">API Key</th>
              <th className="px-4 py-3">{t('连接')}</th>
              <th className="px-4 py-3">{t('操作')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {models.map((item) => (
              <tr key={item.id} className={cn(activeModelId === item.id && 'bg-neutral-50')}>
                <td className="px-4 py-3">
                  <SmallToggle checked={item.enabled} onChange={(enabled) => updateModel(item.id, { enabled })} />
                </td>
                <td className="px-4 py-3 font-medium text-neutral-800">
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={activeModelId === item.id} onChange={() => setActiveModelId(item.id)} />
                    {item.name}
                  </label>
                </td>
                <td className="px-4 py-3 text-neutral-500">{item.provider}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-800">{item.modelId}</td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-600">
                  <div>{item.apiEndpoint}</div>
                  {item.anthropicEndpoint && <div className="mt-1 text-sky-600">Anthropic: {item.anthropicEndpoint}</div>}
                </td>
                <td className="px-4 py-3">
                  <div className="font-mono text-xs text-neutral-600">{item.apiKeyEnv || t('自动生成')}</div>
                  {(item.apiKey || item.apiKeyEnv) && <span className="mt-1 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">{t('已设置')}</span>}
                </td>
                <td className="px-4 py-3">
                  <button type="button" onClick={() => testModel(item)} disabled={testingId === item.id} className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50">
                    {testingId === item.id ? t('测试中') : t('测试')}
                  </button>
                  {testMessages[item.id] && (
                    <div className={cn('mt-1 max-w-[160px] truncate text-xs', item.tested ? 'text-emerald-600' : 'text-red-500')} title={testMessages[item.id]}>
                      {testMessages[item.id]}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3 text-xs">
                    <button type="button" onClick={() => openEdit(item)} className="text-sky-600 hover:underline">{t('编辑')}</button>
                    <button type="button" onClick={() => deleteModel(item.id)} className="text-red-500 hover:underline">{t('删除')}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-neutral-400">
        {t('提示：模型变更会自动保存并同步到聊天后端。不同 API 协议的 CLI 工具配置在“Coding Tools”页面管理。')}
      </p>
    </div>
  )
}

function AutoSaveStatus({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  const { t } = useI18n()
  const label =
    state === 'saving'
      ? '自动保存中'
      : state === 'saved'
        ? '已自动保存'
        : state === 'error'
          ? '自动保存失败'
          : '自动保存已开启'

  return (
    <div
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium',
        state === 'error'
          ? 'border-red-200 bg-red-50 text-red-600'
          : state === 'saved'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-neutral-200 bg-white text-neutral-500',
      )}
    >
      {state === 'saving' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === 'saved' ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <span className={cn('h-2 w-2 rounded-full', state === 'error' ? 'bg-red-500' : 'bg-neutral-300')} />
      )}
      {t(label)}
    </div>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  const { t } = useI18n()
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 border-r border-neutral-200 px-4 py-3 last:border-r-0">
      <span className="text-xl font-medium text-neutral-900">{value}</span>
      <span className="text-xs text-neutral-500">{t(label)}</span>
    </div>
  )
}

function ModelEditor({
  draft,
  setDraft,
  onClose,
  onSave,
  editing,
}: {
  draft: ModelConfig
  setDraft: (draft: ModelConfig) => void
  onClose: () => void
  onSave: () => void
  editing: boolean
}) {
  const { t } = useI18n()
  const patch = (value: Partial<ModelConfig>) => setDraft({ ...draft, ...value })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6 backdrop-blur-sm">
      <div className="w-full max-w-4xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{editing ? t('编辑模型') : t('添加模型')}</h2>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <Field label="名称（唯一标识）*" value={draft.name} onChange={(name) => patch({ name })} placeholder="例如：qwen-max" />
          <Field label="提供商 *" value={draft.provider} onChange={(provider) => patch({ provider })} placeholder="例如：dashscope / openai / deepseek" />
          <Field label="模型 ID *" value={draft.modelId} onChange={(modelId) => patch({ modelId })} placeholder="例如：qwen-max-2026-04-01" />
          <Field label="API Key 环境变量名" value={draft.apiKeyEnv} onChange={(apiKeyEnv) => patch({ apiKeyEnv })} placeholder="留空自动生成" />
          <Field label="API 端点（OpenAI 兼容）*" value={draft.apiEndpoint} onChange={(apiEndpoint) => patch({ apiEndpoint })} placeholder="https://api.example.com/v1" wide />
          <Field label="Anthropic 端点（Claude Code 使用，可选）" value={draft.anthropicEndpoint} onChange={(anthropicEndpoint) => patch({ anthropicEndpoint })} placeholder="例如：https://api.deepseek.com/anthropic" wide />
          <Field label="API Key（同步到本地设置）" value={draft.apiKey} onChange={(apiKey) => patch({ apiKey })} placeholder="输入 API Key" type="password" />
          <Field label="temperature" value={draft.temperature} onChange={(temperature) => patch({ temperature })} placeholder="0.7" />
          <Field label="top_p" value={draft.topP} onChange={(topP) => patch({ topP })} placeholder="0.9" />
          <Field label="max_tokens" value={draft.maxTokens} onChange={(maxTokens) => patch({ maxTokens })} placeholder="4096" />
        </div>

        <label className="mt-5 flex items-center gap-2 text-sm text-neutral-700">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
          {t('启用此模型')}
        </label>

        <div className="mt-7 flex justify-end gap-3">
          <button onClick={onClose} className="h-9 rounded-lg border border-neutral-200 px-4 text-sm text-neutral-700 hover:bg-neutral-50">{t('取消')}</button>
          <button onClick={onSave} className="h-9 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-700">{editing ? t('保存') : t('添加')}</button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  wide = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  wide?: boolean
}) {
  const { t } = useI18n()
  const inputType = label.toLowerCase().includes('api key') ? 'password' : type
  return (
    <label className={cn('block', wide && 'md:col-span-2')}>
      <span className="mb-1.5 block text-xs font-medium text-neutral-500">{t(label)}</span>
      <input
        type={inputType}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none transition focus:border-neutral-400 font-mono"
        placeholder={placeholder ? t(placeholder) : undefined}
      />
    </label>
  )
}

function SmallToggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn('relative h-6 w-11 rounded-full transition', checked ? 'bg-neutral-900' : 'bg-neutral-200')}
      aria-pressed={checked}
    >
      <span className={cn('absolute top-1 h-4 w-4 rounded-full bg-white transition', checked ? 'left-6' : 'left-1')} />
    </button>
  )
}

function resolveActiveModelId(models: ModelConfig[], value: string | undefined) {
  if (value && models.some((item) => item.id === value)) return value
  const byProvider = models.find((item) => item.provider === value)
  return byProvider?.id ?? models[0]?.id ?? defaultModels[0]!.id
}
