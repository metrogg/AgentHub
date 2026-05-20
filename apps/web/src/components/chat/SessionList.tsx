import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Bot,
  Code2,
  Folder,
  History,
  MessageCircle,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { cn, relativeTime } from '../../lib/utils'

export default function SessionList() {
  const navigate = useNavigate()
  const { sessionId } = useParams()
  const { sessions, fetchSessions, createSession, deleteSession } = useChatStore()

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  async function handleNew() {
    const session = await createSession('新会话')
    navigate(`/chat/${session.id}`)
  }

  async function handleDelete(event: React.MouseEvent, id: string) {
    event.stopPropagation()
    event.preventDefault()
    if (!confirm('删除这个会话?')) return
    await deleteSession(id)
    if (sessionId === id) navigate('/', { replace: true })
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-[#f7f7f4]">
      <div className="flex h-14 items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-neutral-950 text-white">
            <MessageCircle className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold text-neutral-950">AgentHub</span>
        </div>
      </div>

      <div className="px-2">
        <button
          onClick={handleNew}
          className="mb-3 flex w-full items-center gap-3 rounded-2xl border border-neutral-200 bg-white p-3 text-left shadow-sm transition hover:border-neutral-300"
        >
          <div className="grid h-10 w-10 place-items-center rounded-full bg-[#eef8f6] text-[#8ba9a4]">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-neutral-950">新建会话</div>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-neutral-500">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              空闲中
            </div>
          </div>
          <Plus className="h-4 w-4 text-neutral-400" />
        </button>
      </div>

      <nav className="space-y-1 px-3">
        <NavItem icon={Code2} label="扣子编程" />
        <NavItem icon={MessageCircle} label="Agent World" strong />
      </nav>

      <div className="my-3 border-t border-neutral-200" />

      <div className="flex-1 overflow-y-auto px-2">
        <div className="mb-1 px-2 text-xs text-neutral-400">历史话题</div>
        {sessions.length === 0 ? (
          <div className="px-2 py-4 text-xs text-neutral-400">还没有会话</div>
        ) : (
          <ul className="space-y-1">
            {sessions.map((session) => {
              const active = sessionId === session.id
              return (
                <li key={session.id} className="group flex items-center gap-1">
                  <button
                    onClick={() => navigate(`/chat/${session.id}`)}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition',
                      active ? 'bg-white text-neutral-950 shadow-sm' : 'text-neutral-600 hover:bg-white/70'
                    )}
                  >
                    <History className="h-4 w-4 shrink-0 text-neutral-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{session.title}</span>
                      <span className="block truncate text-[11px] text-neutral-400">
                        {relativeTime(session.updatedAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={(event) => handleDelete(event, session.id)}
                    className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                    title="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-neutral-200 p-2">
        <button
          onClick={() => navigate('/settings')}
          className="flex h-10 w-full items-center gap-3 rounded-lg px-2 text-sm text-neutral-700 transition hover:bg-white/70"
        >
          <Settings2 className="h-4 w-4 text-neutral-500" />
          设置
        </button>
      </div>
    </aside>
  )
}

function NavItem({ icon: Icon, label, strong = false }: { icon: typeof Folder; label: string; strong?: boolean }) {
  return (
    <button
      className={cn(
        'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-sm text-neutral-700 transition hover:bg-white/70',
        strong && 'font-semibold text-neutral-950'
      )}
    >
      <Icon className="h-4 w-4 text-neutral-500" />
      {label}
    </button>
  )
}
