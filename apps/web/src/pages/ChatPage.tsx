import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { workspaceNameFromPath } from '@agenthub/shared'
import {
  ArrowUp,
  AtSign,
  Check,
  CircleHelp,
  FolderOpen,
  FolderPlus,
  Loader2,
  PanelLeft,
  Paperclip,
  Search,
  Trash2,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { TypewriterHeading } from '../components/chat/TypewriterHeading'
import {
  readMentionCommand,
  readSlashCommand,
  SkillCommandPanel,
  Thread,
} from '../components/assistant-ui/Thread'
import { api, friendlyErrorMessage, type SkillSummary, type Workspace, type WelcomeQuickPrompt } from '../lib/api'
import {
  agentLibraryChangeEvent,
  loadAgentLibrary,
  type SavedAgentConfig,
} from '../lib/agentLibrary'
import { useI18n } from '../lib/i18n'
import { requestSettingsDialog } from '../lib/settingsDialog'
import { isDesktopApp, pickWorkspaceFolder } from '../lib/native'
import {
  QuickPromptBubbles,
  createQuickPromptSeed,
  rotateQuickPrompts,
} from '../components/chat/QuickPromptBubbles'
import { AgentHubRuntimeProvider } from '../lib/runtime'
import { sendModeShouldSubmit, useShortcutSettings } from '../lib/shortcuts'
import { isProjectWorkspace, workspaceSearchText, workspaceSubtitle } from '../lib/workspaceFilters'
import { useChatStore } from '../stores/chatStore'

export default function ChatPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const selectSession = useChatStore((state) => state.selectSession)
  const sessions = useChatStore((state) => state.sessions)
  const sessionsBootstrapped = useChatStore((state) => state.sessionsBootstrapped)
  const initWebSocket = useChatStore((state) => state.initWebSocket)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const desktop = isDesktopApp()
  const threadReady = Boolean(sessionId && currentSessionId === sessionId)

  function toggleSidebar() {
    setSidebarCollapsed((current) => !current)
  }

  useEffect(() => {
    const off = initWebSocket()
    return off
  }, [initWebSocket])

  useEffect(() => {
    if (!sessionId) return
    if (sessionId === currentSessionId) return
    if (!sessionsBootstrapped) return
    const exists = sessions.some((s) => s.id === sessionId)
    if (!exists) {
      navigate('/', { replace: true })
      return
    }
    void selectSession(sessionId).catch(() => navigate('/', { replace: true }))
  }, [sessionId, currentSessionId, navigate, selectSession, sessions, sessionsBootstrapped])

  return (
    <div className="agenthub-chat-shell flex h-screen overflow-hidden bg-[#F7F7F7] text-neutral-950">
      <div
        aria-hidden={sidebarCollapsed}
        className="h-full shrink-0 overflow-hidden"
        style={{
          width: sidebarCollapsed ? 0 : 340,
          transition: 'width 300ms cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        <div
          className={[
            'h-full w-[340px] transform-gpu will-change-transform',
            sidebarCollapsed
              ? 'pointer-events-none -translate-x-full opacity-0'
              : 'translate-x-0 opacity-100',
          ].join(' ')}
          style={{
            transition:
              'opacity 300ms cubic-bezier(0.4,0,0.2,1), transform 300ms cubic-bezier(0.4,0,0.2,1)',
          }}
        >
          <SessionList onCollapse={desktop ? undefined : toggleSidebar} />
        </div>
      </div>
      <main
        className="relative min-w-0 flex-1"
        style={{
          ['--agenthub-thread-header-left-offset' as string]:
            desktop || sidebarCollapsed ? '3rem' : '0rem',
        }}
      >
        {(desktop || sidebarCollapsed) && (
          <button
            type="button"
            onClick={toggleSidebar}
            className="absolute left-3 top-3 z-10 grid h-8 w-8 place-items-center rounded-md border border-neutral-200 bg-white text-neutral-500 shadow-sm transition hover:bg-neutral-50 hover:text-neutral-900"
            aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          >
            <PanelLeft
              className={[
                'h-4 w-4 transition-transform',
                sidebarCollapsed ? 'rotate-180' : '',
              ].join(' ')}
            />
          </button>
        )}
        {sessionId && threadReady ? (
          <AgentHubRuntimeProvider key={sessionId}>
            <Thread key={sessionId} />
          </AgentHubRuntimeProvider>
        ) : sessionId ? (
          <ThreadSwitching />
        ) : (
          <Welcome />
        )}
      </main>
    </div>
  )
}

function ThreadSwitching() {
  return (
    <div className="flex h-full items-center justify-center bg-white text-sm text-neutral-400">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      正在切换会话...
    </div>
  )
}

function Welcome() {
  const { t } = useI18n()
  const { sendMode } = useShortcutSettings()
  const navigate = useNavigate()
  const messageInputRef = useRef<HTMLTextAreaElement>(null)
  const createSession = useChatStore((state) => state.createSession)
  const selectSession = useChatStore((state) => state.selectSession)
  const sendMessageToSession = useChatStore((state) => state.sendMessageToSession)
  const [message, setMessage] = useState('')
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillPanelOpen, setSkillPanelOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [skillCommandRange, setSkillCommandRange] = useState<{ start: number; end: number } | null>(
    null,
  )
  const [mentionPanelOpen, setMentionPanelOpen] = useState(false)
  const [mentionRange, setMentionRange] = useState<{
    start: number
    end: number
    query: string
  } | null>(null)
  const [libraryAgents, setLibraryAgents] = useState<SavedAgentConfig[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [openingWorkspaceId, setOpeningWorkspaceId] = useState<string | null>(null)
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [hint, setHint] = useState('')
  const [quickPrompts, setQuickPrompts] = useState<WelcomeQuickPrompt[]>([])
  const [quickPromptsLoading, setQuickPromptsLoading] = useState(true)
  const filteredWorkspaces = workspaces.filter((workspace) => {
    const query = workspaceQuery.trim().toLowerCase()
    if (!query) return true
    return workspaceSearchText(workspace).includes(query)
  })

  useEffect(() => {
    const syncAgents = () => setLibraryAgents(loadAgentLibrary())
    syncAgents()
    window.addEventListener(agentLibraryChangeEvent, syncAgents)
    return () => window.removeEventListener(agentLibraryChangeEvent, syncAgents)
  }, [])

  useEffect(() => {
    let cancelled = false
    const seed = createQuickPromptSeed('home')
    setQuickPromptsLoading(true)
    api
      .getWelcomeQuickPrompts(seed)
      .then(({ items }) => {
        if (!cancelled) {
          setQuickPrompts(items.length ? rotateQuickPrompts(items, seed, 10) : [])
        }
      })
      .catch(() => {
        if (!cancelled) setQuickPrompts([])
      })
      .finally(() => {
        if (!cancelled) setQuickPromptsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!projectMenuOpen) return
    let cancelled = false
    setWorkspaceBusy(true)
    api
      .listWorkspaces()
      .then(({ items }) => {
        if (!cancelled) setWorkspaces(items.filter(isProjectWorkspace))
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([])
      })
      .finally(() => {
        if (!cancelled) setWorkspaceBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectMenuOpen])

  useEffect(() => {
    if (!skillPanelOpen || skills.length) return
    let cancelled = false
    setSkillsLoading(true)
    api
      .listSkills()
      .then(({ items }) => {
        if (!cancelled) setSkills(items)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [skillPanelOpen, skills.length])

  function showHint(text: string) {
    setHint(text)
    window.setTimeout(() => setHint(''), 1800)
  }

  function closeSkillPanel() {
    setSkillPanelOpen(false)
    setSkillCommandRange(null)
    setSkillQuery('')
  }

  function closeMentionPanel() {
    setMentionPanelOpen(false)
    setMentionRange(null)
  }

  function handleMessageChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const input = event.currentTarget
    const nextMessage = input.value
    const cursor = input.selectionStart ?? nextMessage.length
    const command = readSlashCommand(nextMessage, cursor)
    const mention = readMentionCommand(nextMessage, cursor)
    setMessage(nextMessage)
    if (command) {
      setProjectMenuOpen(false)
      closeMentionPanel()
      setSkillQuery(command.query)
      setSkillCommandRange({ start: command.start, end: command.end })
      setSkillPanelOpen(true)
    } else if (mention) {
      closeSkillPanel()
      setProjectMenuOpen(false)
      setMentionRange(mention)
      setMentionPanelOpen(true)
    } else {
      closeSkillPanel()
      closeMentionPanel()
    }
  }

  function insertSkillReference(skill: SkillSummary) {
    const input = messageInputRef.current
    const reference = `$${skill.id || skill.name} `
    const cursor = input?.selectionStart ?? message.length
    const liveCommand = input ? readSlashCommand(input.value, cursor) : null
    const range = liveCommand ?? skillCommandRange ?? { start: message.length, end: message.length }
    const nextMessage = `${message.slice(0, range.start)}${reference}${message.slice(range.end)}`
    setMessage(nextMessage)
    closeSkillPanel()
    showHint(`已选择 Skill：${skill.name || skill.id}`)
    window.requestAnimationFrame(() => {
      const nextCursor = range.start + reference.length
      messageInputRef.current?.focus()
      messageInputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  function insertMentionReference(value: string) {
    const input = messageInputRef.current
    const range = mentionRange ?? { start: message.length, end: message.length }
    const source = input?.value ?? message
    const reference = `${value} `
    const nextMessage = `${source.slice(0, range.start)}${reference}${source.slice(range.end)}`
    setMessage(nextMessage)
    closeMentionPanel()
    showHint(`已插入 ${value}`)
    window.requestAnimationFrame(() => {
      const nextCursor = range.start + reference.length
      messageInputRef.current?.focus()
      messageInputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  function insertAtSign() {
    const input = messageInputRef.current
    if (!input) {
      setMessage((current) => (current.includes('@') ? current : `${current}@`))
      setMentionPanelOpen(true)
      setMentionRange({ start: message.length, end: message.length + 1, query: '' })
      return
    }
    const start = input.selectionStart ?? message.length
    const end = input.selectionEnd ?? message.length
    const nextMessage = `${message.slice(0, start)}@${message.slice(end)}`
    setMessage(nextMessage)
    setMentionRange({ start, end: start + 1, query: '' })
    setMentionPanelOpen(true)
    setProjectMenuOpen(false)
    closeSkillPanel()
    window.requestAnimationFrame(() => {
      const nextCursor = start + 1
      messageInputRef.current?.focus()
      messageInputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  async function startThread(content: string) {
    const trimmed = content.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    try {
      const workspaceAgentId = selectedWorkspace
        ? await defaultWorkspaceAgentId(selectedWorkspace.id)
        : null
      const session = await createSession(titleFromMessage(trimmed), {
        workspaceId: selectedWorkspace?.id ?? null,
        workspaceAgentId,
      })
      await selectSession(session.id)
      navigate(`/chat/${session.id}`)
      await sendMessageToSession(session.id, trimmed)
      setMessage('')
    } finally {
      setSubmitting(false)
    }
  }

  async function defaultWorkspaceAgentId(workspaceId: string) {
    const full = await api.getWorkspace(workspaceId)
    return full.agents.length === 1 ? full.agents[0]!.id : null
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    await startThread(message)
  }

  async function selectWorkspace(workspaceId: string) {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    setOpeningWorkspaceId(workspaceId)
    showHint('正在选择工作区...')
    try {
      const workspace =
        workspaces.find((item) => item.id === workspaceId) ??
        (await api.getWorkspace(workspaceId)).workspace
      setSelectedWorkspace(workspace)
      setProjectMenuOpen(false)
      showHint(`已选择工作区：${workspace.name}`)
    } catch (err) {
      showHint(friendlyErrorMessage(err, '选择工作区失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  async function handleDeleteWorkspace(workspaceId: string, event: React.MouseEvent) {
    event.stopPropagation()
    if (workspaceBusy) return
    const name = workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId
    if (!window.confirm(`确定要删除工作区「${name}」吗？此操作不可撤销。`)) return
    setWorkspaceBusy(true)
    try {
      await api.deleteWorkspace(workspaceId)
      setWorkspaces((items) => items.filter((w) => w.id !== workspaceId))
      if (selectedWorkspace?.id === workspaceId) {
        setSelectedWorkspace(null)
      }
      showHint(`已删除工作区：${name}`)
    } catch (err) {
      showHint(friendlyErrorMessage(err, '删除工作区失败'))
    } finally {
      setWorkspaceBusy(false)
    }
  }

  async function openFolderWorkspace() {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    showHint('正在打开工作区文件夹选择器...')
    try {
      const nativePath = await pickWorkspaceFolder().catch(() => null)
      const result = await api.openWorkspaceFolder(nativePath)
      if (result.cancelled || !result.projectPath) {
        showHint('已取消选择文件夹')
        return
      }
      showHint('已选择文件夹，正在处理工作区...')
      const workspace =
        result.workspace ??
        (
          await api.createWorkspace({
            name: workspaceNameFromPath(result.projectPath),
            goal: '',
            projectPath: result.projectPath,
          })
        ).workspace
      setWorkspaces((items) => [workspace, ...items.filter((item) => item.id !== workspace.id)])
      setOpeningWorkspaceId(workspace.id)
      setSelectedWorkspace(workspace)
      setProjectMenuOpen(false)
      showHint('工作区已选中')
    } catch (err) {
      showHint(friendlyErrorMessage(err, '处理工作区失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  function startNewWorkspace() {
    setProjectMenuOpen(false)
    setSelectedWorkspace(null)
    showHint('将从新工作空间开始')
  }

  return (
    <div className="agenthub-welcome-root flex h-full flex-col bg-[#F7F7F7]">
      <div className="flex flex-1 flex-col items-center px-8">
        <section className="mt-[16vh] w-full max-w-[960px] text-center">
          <h2 className="text-2xl font-semibold tracking-normal text-neutral-950">
            <TypewriterHeading text={t('有什么可以帮忙的？')} />
          </h2>
          <QuickPromptBubbles
            className="mt-8"
            loading={quickPromptsLoading}
            prompts={quickPrompts}
            onPick={(prompt: string) => void startThread(prompt)}
          />
        </section>

        <div className="agenthub-welcome-composer-dock mt-auto w-full max-w-[704px] pb-5">
          <form
            onSubmit={handleSubmit}
            className="relative rounded-[22px] border border-neutral-200 bg-white p-3"
          >
            {hint && (
              <div className="absolute -top-9 left-4 rounded-full bg-neutral-900 px-3 py-1 text-xs text-white shadow">
                {hint}
              </div>
            )}
            {skillPanelOpen && (
              <SkillCommandPanel
                query={skillQuery}
                skills={skills}
                loading={skillsLoading}
                onPick={insertSkillReference}
                onClose={closeSkillPanel}
              />
            )}
            {mentionPanelOpen && (
              <WelcomeMentionPanel
                agents={libraryAgents}
                query={mentionRange?.query ?? ''}
                onPick={insertMentionReference}
                onClose={closeMentionPanel}
              />
            )}
            {projectMenuOpen && (
              <div className="absolute bottom-[4.5rem] left-3 z-20 w-80 rounded-2xl border border-neutral-200 bg-white p-1.5 text-sm shadow-xl">
                <div className="flex h-9 items-center gap-2 px-2 text-neutral-400">
                  <Search className="h-4 w-4 shrink-0" />
                  <input
                    value={workspaceQuery}
                    onChange={(event) => setWorkspaceQuery(event.target.value)}
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
                    placeholder={t('搜索工作区')}
                  />
                </div>
                <div className="max-h-44 space-y-1 overflow-y-auto py-1">
                  {filteredWorkspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => void selectWorkspace(workspace.id)}
                      disabled={workspaceBusy}
                      className={[
                        'group/ws flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-neutral-50 disabled:opacity-60',
                        workspace.id === selectedWorkspace?.id ||
                        workspace.id === openingWorkspaceId
                          ? 'bg-neutral-100'
                          : '',
                      ].join(' ')}
                    >
                      <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-neutral-900">{workspace.name}</span>
                        <span className="block truncate text-[11px] text-neutral-400">
                          {workspaceSubtitle(workspace)}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={(event) => void handleDeleteWorkspace(workspace.id, event)}
                        disabled={workspaceBusy}
                        className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-red-500 group-hover/ws:inline-flex"
                        title="删除工作区"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      {workspace.id === openingWorkspaceId && (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />
                      )}
                    </button>
                  ))}
                  {!workspaceBusy && filteredWorkspaces.length === 0 && (
                    <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-5 text-center text-xs text-neutral-400">
                      {t('没有匹配的工作区')}
                    </div>
                  )}
                  {workspaceBusy && (
                    <div className="px-2.5 py-2 text-xs text-neutral-400">
                      {t('正在处理工作区...')}
                    </div>
                  )}
                </div>
                <div className="mt-1 border-t border-neutral-200 pt-1.5">
                  <div
                    className={[
                      'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-neutral-50',
                      selectedWorkspace === null ? 'bg-neutral-100' : '',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      onClick={startNewWorkspace}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <FolderPlus className="h-4 w-4 shrink-0 text-neutral-600" />
                      <span className="min-w-0 flex-1 truncate text-neutral-900">
                        从新工作空间开始
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        requestSettingsDialog()
                      }}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-neutral-900"
                      aria-label="前往系统设置"
                      title="可前往「系统设置」设置默认工作空间存储路径"
                    >
                      <CircleHelp className="h-4 w-4" />
                    </button>
                    {selectedWorkspace === null && (
                      <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void openFolderWorkspace()}
                    disabled={workspaceBusy}
                    className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-50 disabled:opacity-60"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                    <span className="min-w-0 flex-1 truncate">{t('打开本地工作空间')}</span>
                  </button>
                </div>
              </div>
            )}
            <textarea
              ref={messageInputRef}
              value={message}
              onChange={handleMessageChange}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && skillPanelOpen) {
                  event.preventDefault()
                  closeSkillPanel()
                  return
                }
                if (event.key === 'Escape' && mentionPanelOpen) {
                  event.preventDefault()
                  closeMentionPanel()
                  return
                }
                if (mentionPanelOpen && event.key === 'Enter') {
                  event.preventDefault()
                  return
                }
                if (skillPanelOpen && event.key === 'Enter') {
                  event.preventDefault()
                  return
                }
                if (sendModeShouldSubmit(sendMode, event)) {
                  event.preventDefault()
                  void startThread(message)
                }
              }}
              className="h-14 w-full resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
              placeholder={t('发消息给 AgentHub，@ 可提及 Agent')}
            />
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setProjectMenuOpen((open) => !open)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 text-xs text-neutral-700 shadow-sm hover:bg-neutral-50"
                  aria-label={t('选择工作区')}
                  title={
                    selectedWorkspace
                      ? `${selectedWorkspace.name} · ${selectedWorkspace.projectPath ?? '本地工作空间'}`
                      : '选择工作空间 · 默认从新工作空间开始'
                  }
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="max-w-[12rem] truncate">
                    {selectedWorkspace ? selectedWorkspace.name : '选择工作空间'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    requestSettingsDialog()
                  }}
                  className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100"
                  aria-label="前往系统设置"
                  title="可前往「系统设置」设置默认工作空间存储路径"
                >
                  <CircleHelp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled
                  title="暂未实现"
                  className="grid h-8 w-8 place-items-center rounded-full text-neutral-300"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={insertAtSign}
                  className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100"
                >
                  <AtSign className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={!message.trim() || submitting}
                  className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white disabled:bg-neutral-200"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

function WelcomeMentionPanel({
  agents,
  onClose,
  onPick,
  query,
}: {
  agents: SavedAgentConfig[]
  onClose: () => void
  onPick: (value: string) => void
  query: string
}) {
  const normalizedQuery = query.trim().toLowerCase()
  const rows = agents.map((agent) => ({
    color: agent.color ?? '#111827',
    desc: [agent.role, agent.description].filter(Boolean).join(' · ') || 'Agent',
    name: agent.name,
    value: `@${agent.name}`,
  }))
  const filteredRows = normalizedQuery
    ? rows.filter((row) =>
        `${row.value} ${row.name} ${row.desc}`.toLowerCase().includes(normalizedQuery),
      )
    : rows

  return (
    <div
      className="absolute bottom-[4.5rem] left-3 z-30 w-72 overflow-hidden rounded-2xl border border-neutral-200 bg-white p-1.5 text-sm shadow-xl"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <div className="text-xs text-neutral-400">{query ? `匹配：${query}` : '提及 Agent'}</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
        >
          关闭
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {filteredRows.map((row) => (
          <button
            key={row.value}
            type="button"
            onClick={() => onPick(row.value)}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left hover:bg-neutral-50"
          >
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
              style={{ background: row.color }}
            >
              {row.name.slice(0, 1).toUpperCase() || '@'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-neutral-900">{row.value}</span>
              <span className="block truncate text-xs text-neutral-500">{row.desc}</span>
            </span>
          </button>
        ))}
        {filteredRows.length === 0 && (
          <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400">
            没有匹配的 Agent
          </div>
        )}
      </div>
    </div>
  )
}

function titleFromMessage(message: string) {
  return message.length > 18 ? `${message.slice(0, 18)}...` : message
}
