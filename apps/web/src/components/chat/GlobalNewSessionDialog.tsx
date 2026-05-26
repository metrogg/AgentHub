import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Bot,
  Check,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  Settings2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import {
  agentLibraryChangeEvent,
  loadAgentLibrary,
  type SavedAgentConfig,
} from '../../lib/agentLibrary'
import { defaultConversationTitle, startAgentConversation } from '../../lib/agentConversation'
import { useI18n } from '../../lib/i18n'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../stores/chatStore'

export const openNewSessionDialogEvent = 'agenthub:open-new-session-dialog'

export function requestNewSessionDialog() {
  window.dispatchEvent(new Event(openNewSessionDialogEvent))
}

export function GlobalNewSessionDialog() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const createSession = useChatStore((state) => state.createSession)
  const selectSession = useChatStore((state) => state.selectSession)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const [open, setOpen] = useState(false)
  const [agents, setAgents] = useState<SavedAgentConfig[]>([])
  const [creatingChoice, setCreatingChoice] = useState<string | null>(null)

  function openDialog() {
    setAgents(loadAgentLibrary())
    setOpen(true)
  }

  useEffect(() => {
    function handleOpenDialog() {
      openDialog()
    }

    function handleLibraryChange() {
      if (open) setAgents(loadAgentLibrary())
    }

    window.addEventListener(openNewSessionDialogEvent, handleOpenDialog)
    window.addEventListener(agentLibraryChangeEvent, handleLibraryChange)
    window.addEventListener('storage', handleLibraryChange)
    return () => {
      window.removeEventListener(openNewSessionDialogEvent, handleOpenDialog)
      window.removeEventListener(agentLibraryChangeEvent, handleLibraryChange)
      window.removeEventListener('storage', handleLibraryChange)
    }
  }, [open])

  useEffect(() => {
    const state = location.state as { openNewSessionDialog?: boolean } | null
    if (!state?.openNewSessionDialog) return
    navigate(location.pathname, { replace: true, state: null })
    openDialog()
  }, [location.pathname, location.state, navigate])

  async function createPlainSession() {
    setCreatingChoice('plain')
    try {
      const session = await createSession(t('新建会话'))
      await selectSession(session.id)
      setOpen(false)
      navigate(`/chat/${session.id}`)
    } finally {
      setCreatingChoice(null)
    }
  }

  async function createAgentSession(selectedAgents: SavedAgentConfig[], title?: string) {
    const key = selectedAgents.length === 1 ? selectedAgents[0]!.id : 'group'
    setCreatingChoice(key)
    try {
      const session = await startAgentConversation({ agents: selectedAgents, title })
      await fetchSessions()
      await selectSession(session.id)
      setOpen(false)
      navigate(`/chat/${session.id}`)
    } finally {
      setCreatingChoice(null)
    }
  }

  if (!open) return null

  return (
    <NewSessionDialog
      agents={agents}
      creatingChoice={creatingChoice}
      onClose={() => !creatingChoice && setOpen(false)}
      onCreatePlain={createPlainSession}
      onCreateAgent={createAgentSession}
      onManageAgents={() => {
        setOpen(false)
        navigate('/agent-config')
      }}
    />
  )
}

function NewSessionDialog({
  agents,
  creatingChoice,
  onClose,
  onCreatePlain,
  onCreateAgent,
  onManageAgents,
}: {
  agents: SavedAgentConfig[]
  creatingChoice: string | null
  onClose: () => void
  onCreatePlain: () => void
  onCreateAgent: (agents: SavedAgentConfig[], title?: string) => void
  onManageAgents: () => void
}) {
  const { t } = useI18n()
  const [runtimeFilter, setRuntimeFilter] = useState<'all' | 'llm' | 'code-agent' | 'mcp' | 'a2a'>('all')
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedIds.has(agent.id)),
    [agents, selectedIds],
  )
  const groupTitle = defaultConversationTitle(selectedAgents)
  const filteredAgents = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return agents.filter((agent) => {
      const matchesRuntime = runtimeFilter === 'all' || (agent.runtimeType ?? 'llm') === runtimeFilter
      if (!matchesRuntime) return false
      if (!keyword) return true
      return [agent.name, agent.role, agent.description, ...(agent.capabilityTags ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    })
  }, [agents, query, runtimeFilter])

  function toggleAgent(agent: SavedAgentConfig) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(agent.id)) next.delete(agent.id)
      else next.add(agent.id)
      return next
    })
  }

  const submittingSelected = creatingChoice === 'group' || selectedAgents.some((agent) => creatingChoice === agent.id)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/30 px-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      onMouseDown={onClose}
    >
      <div
        className="agenthub-portal-theme flex max-h-[82vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-white/70 bg-white/90 shadow-[0_24px_80px_rgba(15,23,42,0.18)] backdrop-blur-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-neutral-200/80 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-neutral-950">{t('新建会话')}</h2>
            <p className="mt-1 text-xs text-neutral-500">
              {t('从全局 Agent 通讯录选择成员，单选发起单聊，多选创建群聊。')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={Boolean(creatingChoice)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40"
            aria-label={t('关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <button
            type="button"
            onClick={onCreatePlain}
            disabled={Boolean(creatingChoice)}
            className="flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-[#fbfbf8] p-3 text-left transition hover:border-neutral-300 disabled:opacity-60"
          >
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-neutral-950 text-white">
              {creatingChoice === 'plain' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-neutral-950">{t('普通对话')}</div>
              <div className="mt-1 text-xs text-neutral-500">{t('不邀请固定 Agent，直接进入空白聊天。')}</div>
            </div>
          </button>

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="text-xs font-medium text-neutral-400">{t('Agent 通讯录')}</div>
            <button
              type="button"
              onClick={onManageAgents}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2 text-xs text-neutral-600 transition hover:bg-neutral-50"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t('管理 Agent')}
            </button>
          </div>

          <div className="mt-2 flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3">
            <Search className="h-4 w-4 text-neutral-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('搜索 Agent、角色、标签')}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-300"
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {[
              ['all', t('全部')],
              ['llm', 'LLM'],
              ['code-agent', 'Coding Tools'],
              ['mcp', 'MCP'],
              ['a2a', 'A2A'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setRuntimeFilter(value as typeof runtimeFilter)}
                className={cn(
                  'h-7 rounded-full border px-2.5 text-xs transition',
                  runtimeFilter === value
                    ? 'border-neutral-900 bg-neutral-950 text-white'
                    : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-900',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-3 space-y-2">
            {filteredAgents.map((agent) => {
              const selected = selectedIds.has(agent.id)
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => toggleAgent(agent)}
                  disabled={Boolean(creatingChoice)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-60',
                    selected ? 'border-neutral-900 bg-neutral-950 text-white shadow-sm' : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-[#fbfbf8]',
                  )}
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: agent.color ?? '#111827' }}>
                    {agent.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{agent.name}</span>
                    <span className={cn('mt-0.5 block truncate text-xs', selected ? 'text-white/75' : 'text-neutral-500')}>
                      {agent.role} · {agent.runtimeType ?? 'llm'}
                      {agent.codeAgentType ? `/${agent.codeAgentType}` : ''}
                    </span>
                  </span>
                  <span className={cn('grid h-6 w-6 place-items-center rounded-full border', selected ? 'border-white/30 bg-white text-neutral-950' : 'border-neutral-200 text-transparent')}>
                    <Check className="h-3.5 w-3.5" />
                  </span>
                </button>
              )
            })}
            {!filteredAgents.length && (
              <div className="rounded-xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">
                {agents.length ? t('没有匹配的 Agent') : t('还没有全局 Agent，先去管理 Agent 创建一个。')}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-neutral-200/80 bg-white/80 px-4 py-3">
          <div className="min-w-0 flex-1 text-xs text-neutral-500">
            {selectedAgents.length ? (
              <span className="inline-flex min-w-0 items-center gap-2">
                {selectedAgents.length === 1 ? <UserPlus className="h-4 w-4 shrink-0" /> : <Users className="h-4 w-4 shrink-0" />}
                <span className="truncate">{groupTitle}</span>
              </span>
            ) : (
              t('请选择要邀请的 Agent')
            )}
          </div>
          <button
            type="button"
            onClick={() => onCreateAgent(selectedAgents, groupTitle)}
            disabled={!selectedAgents.length || Boolean(creatingChoice)}
            className="inline-flex h-10 min-w-[116px] items-center justify-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-300"
          >
            {submittingSelected ? <Loader2 className="h-4 w-4 animate-spin" /> : selectedAgents.length > 1 ? <Users className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {selectedAgents.length > 1 ? t('创建群聊') : t('发起单聊')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
