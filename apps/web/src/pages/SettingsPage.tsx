import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Loader2, KeyRound, CheckCircle2 } from 'lucide-react'
import { api } from '../lib/api'

export default function SettingsPage() {
  const navigate = useNavigate()
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    api.getSettings().then((s) => {
      setApiKey(s.ANTHROPIC_API_KEY ?? '')
      setModel(s.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6')
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
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
    <div className="min-h-screen bg-bg">
      <div className="max-w-xl mx-auto px-4 py-10">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-200 transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          返回
        </button>

        <h1 className="text-2xl font-semibold tracking-tight mb-1">设置</h1>
        <p className="text-sm text-zinc-500 mb-8">配置 LLM API Key,数据保存在本地数据库</p>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            加载中…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5 bg-bg-elevated border border-border rounded-xl p-5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="w-4 h-4 text-accent" />
              Anthropic Claude
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="input font-mono"
                placeholder="sk-ant-api03-..."
              />
              <p className="text-[10px] text-zinc-600 mt-1.5">
                获取地址:console.anthropic.com
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Model</label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="input font-mono"
                placeholder="claude-sonnet-4-6"
              />
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button type="submit" disabled={saving} className="btn-primary">
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                保存
              </button>
              {savedAt && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  已保存
                </span>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
