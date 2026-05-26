import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { Check, ChevronDown, ChevronRight, Loader2, Mic, Search, X } from 'lucide-react'
import {
  agentLibraryChangeEvent,
  loadAgentLibrary,
  type SavedAgentConfig,
} from '../../lib/agentLibrary'
import { defaultConversationTitle, startAgentConversation } from '../../lib/agentConversation'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../stores/chatStore'

export const openNewSessionDialogEvent = 'agenthub:open-new-session-dialog'

export function requestNewSessionDialog() {
  window.dispatchEvent(new Event(openNewSessionDialogEvent))
}

export function GlobalNewSessionDialog() {
  const navigate = useNavigate()
  const location = useLocation()
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
  onCreateAgent,
  onManageAgents,
}: {
  agents: SavedAgentConfig[]
  creatingChoice: string | null
  onClose: () => void
  onCreateAgent: (agents: SavedAgentConfig[], title?: string) => void
  onManageAgents: () => void
}) {
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
      if (!keyword) return true
      return [agent.name, agent.role, agent.description, ...(agent.capabilityTags ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    })
  }, [agents, query])

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/20 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={onClose}
    >
      <div
        className="agenthub-portal-theme flex h-[76vh] max-h-[620px] min-h-[500px] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-neutral-200 bg-[#f7f7f5] shadow-[0_18px_70px_rgba(15,23,42,0.22)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="relative flex h-14 shrink-0 items-center justify-center border-b border-neutral-200 bg-[#f7f7f5]">
          <h2 className="text-sm font-medium text-neutral-950">发起群聊</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={Boolean(creatingChoice)}
            className="absolute right-4 top-3 grid h-8 w-8 place-items-center rounded-md text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[306px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col border-r border-neutral-200 bg-[#f7f7f5] px-6 py-4">
            <div className="flex h-9 items-center gap-2 rounded-md border border-emerald-400 bg-white px-2.5 text-neutral-400 shadow-sm">
              <Search className="h-4 w-4 shrink-0" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索"
                className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
              />
              <Mic className="h-4 w-4 shrink-0 text-neutral-500" />
            </div>

            <button type="button" className="mt-5 flex h-10 items-center gap-2 border-b border-neutral-200 text-left text-sm text-neutral-900">
              <ChevronRight className="h-4 w-4 text-neutral-500" />
              选择一个已有群
            </button>

            <button type="button" className="mt-2 flex h-9 items-center gap-2 text-left text-sm text-neutral-900">
              <ChevronDown className="h-4 w-4 text-neutral-500" />
              Agent 通讯录
            </button>

            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {filteredAgents.map((agent) => {
                const selected = selectedIds.has(agent.id)
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleAgent(agent)}
                    disabled={Boolean(creatingChoice)}
                    className="flex min-h-12 w-full items-center gap-3 rounded-md px-0 py-1.5 text-left transition hover:bg-neutral-100 disabled:opacity-60"
                  >
                    <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded-full border', selected ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-neutral-300 bg-white text-transparent')}>
                      <Check className="h-3 w-3" />
                    </span>
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm text-sm font-semibold text-white" style={{ background: agent.color ?? '#111827' }}>
                      {agent.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-neutral-900">{agent.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-neutral-500">{agent.role}</span>
                    </span>
                  </button>
                )
              })}
              {!filteredAgents.length && (
                <div className="px-3 py-8 text-center text-sm text-neutral-400">
                  {agents.length ? '没有匹配的 Agent' : '还没有全局 Agent'}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col bg-white">
            <div className="min-h-0 flex-1 px-14 py-10">
              <div className="text-sm font-medium text-neutral-900">发起群聊</div>
              <div className="mt-8 flex flex-wrap gap-3">
                {selectedAgents.map((agent) => (
                  <button key={agent.id} type="button" onClick={() => toggleAgent(agent)} className="group flex w-16 flex-col items-center gap-2">
                    <span className="grid h-11 w-11 place-items-center rounded-sm text-sm font-semibold text-white" style={{ background: agent.color ?? '#111827' }}>
                      {agent.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="max-w-full truncate text-xs text-neutral-500 group-hover:text-neutral-900">{agent.name}</span>
                  </button>
                ))}
              </div>
              {!selectedAgents.length && (
                <div className="mt-8 text-xs text-neutral-400">请选择左侧 Agent 作为群聊成员</div>
              )}
            </div>

            <div className="flex h-20 shrink-0 items-center justify-end gap-16 border-t border-neutral-100 bg-white px-8">
              <button
                type="button"
                onClick={() => onCreateAgent(selectedAgents, groupTitle)}
                disabled={!selectedAgents.length || Boolean(creatingChoice)}
                className="inline-flex h-9 min-w-[122px] items-center justify-center rounded-md bg-neutral-100 px-5 text-sm text-neutral-400 transition enabled:bg-emerald-500 enabled:text-white enabled:hover:bg-emerald-600"
              >
                {submittingSelected ? <Loader2 className="h-4 w-4 animate-spin" /> : '完成'}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={Boolean(creatingChoice)}
                className="inline-flex h-9 min-w-[122px] items-center justify-center rounded-md bg-neutral-100 px-5 text-sm text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onManageAgents}
          className="absolute bottom-3 left-6 text-xs text-neutral-400 hover:text-neutral-700"
        >
          管理 Agent
        </button>
              </div>
    </div>,
    document.body,
  )
}
