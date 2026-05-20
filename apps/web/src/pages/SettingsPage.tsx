import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Archive,
  Bot,
  CheckCircle2,
  CircleGauge,
  Cpu,
  FolderGit2,
  Globe,
  Keyboard,
  Loader2,
  Monitor,
  Palette,
  Plus,
  Settings,
  Shield,
  TerminalSquare,
  Unplug,
  Workflow,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { cn } from '../lib/utils'

const sections = [
  { icon: Settings, label: '常规', active: true },
  { icon: Palette, label: '外观' },
  { icon: Shield, label: '配置' },
  { icon: CircleGauge, label: '个性化' },
  { icon: Keyboard, label: '键盘快捷键' },
  { icon: Unplug, label: 'MCP 服务器' },
  { icon: Bot, label: '钩子' },
  { icon: Globe, label: '连接' },
  { icon: FolderGit2, label: 'Git' },
  { icon: TerminalSquare, label: '环境' },
  { icon: Workflow, label: '工作树' },
  { icon: Monitor, label: '浏览器' },
  { icon: Cpu, label: '电脑操控' },
  { icon: Archive, label: '已归档对话' },
]

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

function model(
  id: string,
  name: string,
  provider: string,
  modelId: string,
  apiEndpoint: string,
  anthropicEndpoint: string,
  apiKeyEnv: string
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

const emptyDraft = model('', '', '', '', '', '', '')

export default function SettingsPage() {
  const navigate = useNavigate()
  const [models, setModels] = useState<ModelConfig[]>(defaultModels)
  const [activeModelId, setActiveModelId] = useState(defaultModels[0].id)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [draft, setDraft] = useState<ModelConfig>({ ...emptyDraft, id: crypto.randomUUID(), enabled: true })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testMessages, setTestMessages] = useState<Record<string, string>>({})

  const activeModel = useMemo(
    () => models.find((item) => item.id === activeModelId) ?? models[0],
    [activeModelId, models]
  )
  const configuredCount = models.filter((item) => item.apiKey || item.apiKeyEnv).length
  const enabledCount = models.filter((item) => item.enabled).length
  const testedCount = models.filter((item) => item.tested).length

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => {
        if (settings.MODEL_CATALOG) {
          try {
            const parsed = JSON.parse(settings.MODEL_CATALOG) as ModelConfig[]
            if (Array.isArray(parsed) && parsed.length) setModels(parsed)
          } catch {
            setModels(defaultModels)
          }
        }
        setActiveModelId(settings.ACTIVE_MODEL_ID ?? settings.MODEL_PROVIDER ?? defaultModels[0].id)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      await api.saveSettings({
        MODEL_CATALOG: JSON.stringify(models),
        ACTIVE_MODEL_ID: activeModel?.id ?? '',
        MODEL_PROVIDER: activeModel?.provider ?? '',
        MODEL_API_KEY: activeModel?.apiKey ?? '',
        MODEL_BASE_URL: activeModel?.apiEndpoint ?? '',
        MODEL_NAME: activeModel?.modelId ?? '',
        ACTIVE_PROVIDER: activeModel?.provider ?? '',
        ACTIVE_API_KEY: activeModel?.apiKey ?? '',
        ACTIVE_BASE_URL: activeModel?.apiEndpoint ?? '',
        ACTIVE_MODEL: activeModel?.modelId ?? '',
        ANTHROPIC_API_KEY: activeModel?.provider === 'anthropic' ? activeModel.apiKey : '',
        ANTHROPIC_MODEL: activeModel?.provider === 'anthropic' ? activeModel.modelId : 'claude-sonnet-4-6',
      })
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 2500)
    } finally {
      setSaving(false)
    }
  }

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
      if (activeModelId === id) setActiveModelId(next[0].id)
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
      })
      updateModel(item.id, { tested: result.ok })
      setTestMessages((current) => ({
        ...current,
        [item.id]: result.ok ? '连接成功' : result.message,
      }))
    } catch (error: any) {
      updateModel(item.id, { tested: false })
      setTestMessages((current) => ({
        ...current,
        [item.id]: error?.message || '连接失败',
      }))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="flex min-h-screen bg-white text-neutral-950">
      <SettingsSidebar navigateBack={() => navigate(-1)} />

      <main className="flex-1 px-10 py-9">
        <form onSubmit={handleSubmit} className="max-w-6xl">
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-normal">模型管理</h1>
              <p className="mt-1 text-sm text-neutral-500">管理可用模型、API 端点、密钥变量和连接测试状态。</p>
            </div>
            <button type="button" onClick={openCreate} className="inline-flex h-9 items-center gap-2 rounded-lg bg-neutral-900 px-3 text-sm font-medium text-white hover:bg-neutral-700">
              <Plus className="h-4 w-4" />
              添加模型
            </button>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : (
            <>
              <div className="mb-6 flex w-full overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
                <Stat value={models.length} label="模型总数" />
                <Stat value={enabledCount} label="已启用" />
                <Stat value={configuredCount} label="API Key 已配置" />
                <Stat value={testedCount} label="已测试连接" />
              </div>

              <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="border-b border-neutral-200 bg-neutral-50 text-xs font-medium text-neutral-500">
                    <tr>
                      <th className="w-20 px-4 py-3">启用</th>
                      <th className="px-4 py-3">名称</th>
                      <th className="px-4 py-3">提供商</th>
                      <th className="px-4 py-3">模型 ID</th>
                      <th className="px-4 py-3">API 端点</th>
                      <th className="px-4 py-3">API Key</th>
                      <th className="px-4 py-3">连接</th>
                      <th className="px-4 py-3">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {models.map((item) => (
                      <tr key={item.id} className={cn(activeModelId === item.id && 'bg-neutral-50')}>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => updateModel(item.id, { enabled: !item.enabled })}
                            className={cn('relative h-6 w-10 rounded-full transition', item.enabled ? 'bg-sky-500' : 'bg-neutral-300')}
                            aria-label="启用模型"
                          >
                            <span className={cn('absolute top-1 h-4 w-4 rounded-full bg-white transition', item.enabled ? 'left-5' : 'left-1')} />
                          </button>
                        </td>
                        <td className="px-4 py-3 font-medium text-neutral-800">
                          <label className="flex items-center gap-2">
                            <input
                              type="radio"
                              checked={activeModelId === item.id}
                              onChange={() => setActiveModelId(item.id)}
                            />
                            {item.name}
                          </label>
                        </td>
                        <td className="px-4 py-3 text-neutral-500">{item.provider}</td>
                        <td className="px-4 py-3 font-mono text-xs text-neutral-800">{item.modelId}</td>
                        <td className="px-4 py-3 font-mono text-xs text-neutral-600">
                          <div>{item.apiEndpoint}</div>
                          {item.anthropicEndpoint && (
                            <div className="mt-1 text-sky-600">Anthropic: {item.anthropicEndpoint}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-mono text-xs text-neutral-600">{item.apiKeyEnv || '自动生成'}</div>
                          {(item.apiKey || item.apiKeyEnv) && (
                            <span className="mt-1 inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-600">
                              已设置
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => testModel(item)}
                            disabled={testingId === item.id}
                            className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50"
                          >
                            {testingId === item.id ? '测试中' : '测试'}
                          </button>
                          {testMessages[item.id] && (
                            <div
                              className={cn(
                                'mt-1 max-w-[160px] truncate text-xs',
                                item.tested ? 'text-emerald-600' : 'text-red-500'
                              )}
                              title={testMessages[item.id]}
                            >
                              {testMessages[item.id]}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3 text-xs">
                            <button type="button" onClick={() => openEdit(item)} className="text-sky-600 hover:underline">
                              编辑
                            </button>
                            <button type="button" onClick={() => deleteModel(item.id)} className="text-red-500 hover:underline">
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-xs text-neutral-400">
                提示：API Key 可写入当前进程环境变量，也可保存在本地设置中。当前激活模型会同步到聊天后端。
              </p>

              <div className="mt-6 flex items-center gap-3">
                <button type="submit" disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  保存
                </button>
                {savedAt && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    已保存
                  </span>
                )}
              </div>
            </>
          )}
        </form>
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

function SettingsSidebar({ navigateBack }: { navigateBack: () => void }) {
  return (
    <aside className="w-[300px] border-r border-neutral-200 bg-[#f7f3ec] p-2">
      <button
        onClick={navigateBack}
        className="mb-2 flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-neutral-700 hover:bg-black/5"
      >
        <Settings className="h-4 w-4" />
        设置
      </button>
      <nav className="space-y-1">
        {sections.map((section) => (
          <button
            key={section.label}
            className={cn(
              'flex h-8 w-full items-center gap-3 rounded-lg px-3 text-sm text-neutral-800 transition hover:bg-black/5',
              section.active && 'bg-black/5'
            )}
          >
            <section.icon className="h-4 w-4 text-neutral-700" />
            {section.label}
          </button>
        ))}
      </nav>
    </aside>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 border-r border-neutral-200 px-4 py-3 last:border-r-0">
      <span className="text-xl font-medium text-neutral-900">{value}</span>
      <span className="text-xs text-neutral-500">{label}</span>
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
  const patch = (value: Partial<ModelConfig>) => setDraft({ ...draft, ...value })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6">
      <div className="w-full max-w-4xl rounded-2xl border border-neutral-200 bg-white p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{editing ? '编辑模型' : '添加模型'}</h2>
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
          启用此模型
        </label>

        <div className="mt-7 flex justify-end gap-3">
          <button onClick={onClose} className="h-9 rounded-lg border border-neutral-200 px-4 text-sm text-neutral-700 hover:bg-neutral-50">
            取消
          </button>
          <button onClick={onSave} className="h-9 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white hover:bg-neutral-700">
            {editing ? '保存' : '添加'}
          </button>
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
  return (
    <label className={cn('block', wide && 'md:col-span-2')}>
      <span className="mb-1.5 block text-xs font-medium text-neutral-500">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="settings-input font-mono"
        placeholder={placeholder}
      />
    </label>
  )
}
