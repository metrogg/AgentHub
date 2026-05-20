import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Plus, MessageSquare, Trash2, Settings, LogOut, User } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { useAuthStore } from '../../stores/authStore'
import { cn, relativeTime } from '../../lib/utils'

export default function SessionList() {
  const navigate = useNavigate()
  const { sessionId } = useParams()
  const { sessions, fetchSessions, createSession, deleteSession } = useChatStore()
  const { user, logout } = useAuthStore()

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  async function handleNew() {
    const session = await createSession('新会话')
    navigate(`/chat/${session.id}`)
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    e.preventDefault()
    if (!confirm('删除这个会话?')) return
    await deleteSession(id)
    if (sessionId === id) navigate('/', { replace: true })
  }

  function handleLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <aside className="w-64 shrink-0 flex flex-col bg-bg-elevated border-r border-border">
      {/* Header */}
      <div className="p-3">
        <button onClick={handleNew} className="btn-primary w-full">
          <Plus className="w-4 h-4" />
          新建会话
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <div className="text-xs text-zinc-500 text-center py-8 px-3">
            还没有会话<br />点击上方按钮开始
          </div>
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => navigate(`/chat/${s.id}`)}
                  className={cn(
                    'group w-full flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                    sessionId === s.id
                      ? 'bg-bg-hover text-zinc-100'
                      : 'text-zinc-400 hover:bg-bg-hover hover:text-zinc-200'
                  )}
                >
                  <MessageSquare className="w-4 h-4 shrink-0 opacity-60" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{s.title}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">{relativeTime(s.updatedAt)}</div>
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, s.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-400 p-1"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-border p-2 space-y-0.5">
        <button
          onClick={() => navigate('/settings')}
          className="w-full flex items-center gap-2 rounded-md px-2 py-2 text-sm text-zinc-400 hover:bg-bg-hover hover:text-zinc-200 transition-colors"
        >
          <Settings className="w-4 h-4" />
          设置
        </button>
        <div className="flex items-center gap-2 rounded-md px-2 py-2">
          <div className="w-7 h-7 rounded-full bg-accent/20 ring-1 ring-accent/30 flex items-center justify-center shrink-0">
            <User className="w-3.5 h-3.5 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-zinc-200 truncate">{user?.username}</div>
            <div className="text-[10px] text-zinc-500 truncate">{user?.email}</div>
          </div>
          <button
            onClick={handleLogout}
            className="text-zinc-500 hover:text-zinc-200 transition-colors p-1"
            title="登出"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}
