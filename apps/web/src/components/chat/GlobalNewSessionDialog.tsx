import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { FolderOpen, Loader2, MessageCircle, Plus, X } from 'lucide-react'
import { api, type WorkspaceFull } from '../../lib/api'
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
  const [workspaceChoices, setWorkspaceChoices] = useState<WorkspaceFull[]>([])
  const [loadingChoices, setLoadingChoices] = useState(false)
  const [creatingChoice, setCreatingChoice] = useState<string | null>(null)

  async function openDialog() {
    setOpen(true)
    setLoadingChoices(true)
    try {
      const { items } = await api.listWorkspaces()
      const full = await Promise.all(items.map((workspace) => api.getWorkspace(workspace.id).catch(() => null)))
      setWorkspaceChoices(full.filter((item): item is WorkspaceFull => Boolean(item)))
    } finally {
      setLoadingChoices(false)
    }
  }

  useEffect(() => {
    function handleOpenDialog() {
      void openDialog()
    }

    window.addEventListener(openNewSessionDialogEvent, handleOpenDialog)
    return () => window.removeEventListener(openNewSessionDialogEvent, handleOpenDialog)
  }, [])

  useEffect(() => {
    const state = location.state as { openNewSessionDialog?: boolean } | null
    if (!state?.openNewSessionDialog) return
    navigate(location.pathname, { replace: true, state: null })
    void openDialog()
  }, [location.pathname, location.state, navigate])

  async function createPlainSession() {
    setCreatingChoice('plain')
    try {
      const session = await createSession(t('新会话'))
      await selectSession(session.id)
      setOpen(false)
      navigate(`/chat/${session.id}`)
    } finally {
      setCreatingChoice(null)
    }
  }

  async function createAgentSession(workspace: WorkspaceFull, agentId: string) {
    const agent = workspace.agents.find((item) => item.id === agentId)
    setCreatingChoice(agentId)
    try {
      const session = await createSession(`${workspace.workspace.name} / ${agent?.name ?? 'Agent'}`, {
        workspaceId: workspace.workspace.id,
        workspaceAgentId: agentId,
      })
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
      creatingChoice={creatingChoice}
      loading={loadingChoices}
      workspaces={workspaceChoices}
      onClose={() => !creatingChoice && setOpen(false)}
      onCreatePlain={createPlainSession}
      onCreateAgent={createAgentSession}
      onOpenAgentWorld={() => {
        setOpen(false)
        navigate('/agent-world')
      }}
    />
  )
}

function NewSessionDialog({
  creatingChoice,
  loading,
  workspaces,
  onClose,
  onCreatePlain,
  onCreateAgent,
  onOpenAgentWorld,
}: {
  creatingChoice: string | null
  loading: boolean
  workspaces: WorkspaceFull[]
  onClose: () => void
  onCreatePlain: () => void
  onCreateAgent: (workspace: WorkspaceFull, agentId: string) => void
  onOpenAgentWorld: () => void
}) {
  const { t } = useI18n()
  const [runtimeFilter, setRuntimeFilter] = useState<'all' | 'llm' | 'codex' | 'claude-code' | 'opencode' | 'gemini'>('all')
  const filteredWorkspaces = useMemo(
    () =>
      workspaces
        .map((workspace) => ({
          ...workspace,
          agents: workspace.agents.filter((agent) => {
            if (runtimeFilter === 'all') return true
            if (runtimeFilter === 'llm') return agent.runtimeType === 'llm'
            return agent.codeAgentType === runtimeFilter
          }),
        }))
        .filter((workspace) => workspace.agents.length > 0),
    [runtimeFilter, workspaces],
  )

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/30 px-4 backdrop-blur-md" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="agenthub-portal-theme max-h-[78vh] w-full max-w-lg overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-neutral-950">{t('新建对话')}</h2>
            <p className="mt-1 text-xs text-neutral-500">{t('选择一个聊天对象，或开启普通会话。')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={Boolean(creatingChoice)} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[calc(78vh-8rem)] overflow-y-auto p-4">
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
              <div className="mt-1 text-xs text-neutral-500">{t('不绑定特定 Agent，使用默认模型回复。')}</div>
            </div>
          </button>

          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs font-medium text-neutral-400">{t('工作区 Agent')}</div>
            <button type="button" onClick={onOpenAgentWorld} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-neutral-50">
              <Plus className="h-3.5 w-3.5" />
              {t('管理 Agent')}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[
              ['all', t('全部')],
              ['llm', 'LLM'],
              ['codex', 'Codex'],
              ['claude-code', 'Claude Code'],
              ['opencode', 'OpenCode'],
              ['gemini', 'Gemini'],
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

          {loading ? (
            <div className="grid h-32 place-items-center text-sm text-neutral-400">
              <Loader2 className="mb-2 h-5 w-5 animate-spin" />
              {t('正在读取工作区')}
            </div>
          ) : filteredWorkspaces.length ? (
            <div className="mt-2 space-y-3">
              {filteredWorkspaces.map((workspace) => (
                <section key={workspace.workspace.id} className="rounded-xl border border-neutral-200 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <FolderOpen className="h-4 w-4 text-neutral-400" />
                    <div className="truncate text-sm font-medium text-neutral-900">{workspace.workspace.name}</div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {workspace.agents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => onCreateAgent(workspace, agent.id)}
                        disabled={Boolean(creatingChoice)}
                        className="rounded-lg border border-neutral-200 bg-white p-3 text-left transition hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-60"
                      >
                        <div className="flex items-center gap-2">
                          <span className="grid h-7 w-7 place-items-center rounded-lg text-xs font-semibold text-white" style={{ background: agent.color }}>
                            {creatingChoice === agent.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : agent.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium text-neutral-900">{agent.name}</span>
                            <span className="block truncate text-[11px] text-neutral-400">
                              {agent.runtimeType}
                              {agent.codeAgentType ? ` / ${agent.codeAgentType}` : ''}
                            </span>
                          </span>
                        </div>
                      </button>
                    ))}
                    {!workspace.agents.length && <div className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-xs text-neutral-400">{t('暂无 Agent')}</div>}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="mt-2 rounded-xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-400">
              {t('还没有工作区 Agent')}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
