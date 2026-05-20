import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Archive,
  Bot,
  CheckCircle2,
  CircleGauge,
  Cpu,
  Database,
  FolderGit2,
  Globe,
  Keyboard,
  KeyRound,
  Loader2,
  Monitor,
  Palette,
  Settings,
  Shield,
  TerminalSquare,
  Unplug,
  Workflow,
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

export default function SettingsPage() {
  const navigate = useNavigate()
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    api
      .getSettings()
      .then((settings) => {
        setApiKey(settings.ANTHROPIC_API_KEY ?? '')
        setModel(settings.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6')
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      await api.saveSettings({
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_MODEL: model,
      })
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 2500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex min-h-screen bg-white text-neutral-950">
      <aside className="w-[300px] border-r border-neutral-200 bg-[#f7f3ec] p-2">
        <button
          onClick={() => navigate(-1)}
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

      <main className="flex-1 px-10 py-9">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-normal">常规</h1>
          <p className="mt-1 text-sm text-neutral-500">配置 AgentHub 的默认模型和本地运行参数。</p>

          {loading ? (
            <div className="mt-8 flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-8 space-y-6">
              <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <div className="mb-5 flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="h-4 w-4 text-neutral-500" />
                  Anthropic Claude
                </div>

                <label className="block text-sm font-medium text-neutral-800">API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-mono outline-none focus:border-neutral-400"
                  placeholder="sk-ant-api03-..."
                />
                <p className="mt-1.5 text-xs text-neutral-400">获取地址：console.anthropic.com</p>

                <label className="mt-5 block text-sm font-medium text-neutral-800">Model</label>
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm font-mono outline-none focus:border-neutral-400"
                  placeholder="claude-sonnet-4-6"
                />
              </section>

              <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <Database className="h-4 w-4 text-neutral-500" />
                  本地数据
                </div>
                <p className="text-sm text-neutral-500">API Key 和模型配置会保存在本地数据库中。</p>
              </section>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50"
                >
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
            </form>
          )}
        </div>
      </main>
    </div>
  )
}
