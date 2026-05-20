import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bot, Loader2 } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'

export default function LoginPage() {
  const navigate = useNavigate()
  const { login, register, loading, error } = useAuthStore()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    try {
      if (mode === 'login') {
        await login(email, password)
      } else {
        await register(email, username || email.split('@')[0], password)
      }
      navigate('/', { replace: true })
    } catch {
      // error already in store
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-accent/10 ring-1 ring-accent/20 flex items-center justify-center mb-3">
            <Bot className="w-6 h-6 text-accent" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">AgentHub</h1>
          <p className="text-sm text-zinc-500 mt-1">多 Agent 协作平台</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 bg-bg-elevated border border-border rounded-xl p-5">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">邮箱</label>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@example.com"
            />
          </div>

          {mode === 'register' && (
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">用户名</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input"
                placeholder="可选,默认为邮箱前缀"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">密码</label>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="至少 6 位"
            />
          </div>

          {error && <div className="text-xs text-red-400 px-1">{error}</div>}

          <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === 'login' ? '登录' : '创建账号'}
          </button>

          <button
            type="button"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="w-full text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {mode === 'login' ? '没有账号? 注册一个' : '已有账号? 去登录'}
          </button>
        </form>
      </div>
    </div>
  )
}
