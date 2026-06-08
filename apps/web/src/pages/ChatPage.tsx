import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { workspaceNameFromPath } from '@agenthub/shared'
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  CircleHelp,
  FileText,
  FolderOpen,
  FolderPlus,
  Loader2,
  Paperclip,
  Plus,
  Presentation,
  Search,
  Sparkles,
  Table2,
  Trash2,
  UsersRound,
  type LucideIcon,
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
import { pickWorkspaceFolder } from '../lib/native'
import {
  QuickPromptBubbles,
  createQuickPromptSeed,
  rotateQuickPrompts,
} from '../components/chat/QuickPromptBubbles'
import { AgentHubRuntimeProvider } from '../lib/runtime'
import { sendModeShouldSubmit, useShortcutSettings } from '../lib/shortcuts'
import { isProjectWorkspace, workspaceSearchText, workspaceSubtitle } from '../lib/workspaceFilters'
import { useChatStore } from '../stores/chatStore'

type WelcomeStarterAction = {
  label: string
  prompt: string
  icon: LucideIcon
  iconClassName: string
}

type MultiAgentMode = {
  id: string
  label: string
  desc: string
  prompt: string
  icon: LucideIcon
  iconClassName: string
}

const welcomeStarterActions: WelcomeStarterAction[] = [
  {
    label: '创建 Team',
    prompt: '请帮我为当前目标设计一个协作 Team，说明需要哪些 Agent、各自负责什么，并先向我确认关键目标。',
    icon: UsersRound,
    iconClassName: 'bg-[#EAF4EF] text-[#237A57]',
  },
  {
    label: '幻灯片',
    prompt: '请帮我制作一份演示文稿，先确认主题、受众、页数和输出风格。',
    icon: Presentation,
    iconClassName: 'bg-[#FFF1D8] text-[#9A5D00]',
  },
  {
    label: 'PDF',
    prompt: '请帮我分析一份 PDF，先告诉我需要提供哪些文件和你会如何提取重点。',
    icon: FileText,
    iconClassName: 'bg-[#FFE9E7] text-[#B53A2F]',
  },
  {
    label: '文档',
    prompt: '请帮我起草一份文档，先确认主题、结构、读者和语气。',
    icon: FileText,
    iconClassName: 'bg-[#EAF0FF] text-[#3159B7]',
  },
  {
    label: '表格',
    prompt: '请帮我整理一张表格，先确认字段、数据来源和最终输出格式。',
    icon: Table2,
    iconClassName: 'bg-[#ECE8FF] text-[#5B49B6]',
  },
]

const multiAgentModes: MultiAgentMode[] = [
  {
    id: 'manager',
    label: '智能编排',
    desc: 'Manager 判断目标复杂度，必要时提出补员和分工。',
    prompt:
      '请以多 Agent Manager 方式处理这个目标：先判断是否需要补员或分工，必要时提出成员建议并等待我确认。',
    icon: Sparkles,
    iconClassName: 'bg-neutral-950 text-white',
  },
  {
    id: 'team',
    label: '先组队',
    desc: '先给出成员、职责和任务边界，确认后再执行。',
    prompt:
      '请先创建协作 Team 方案：列出建议 Agent、职责、任务边界和需要我确认的问题，暂不开始执行。',
    icon: UsersRound,
    iconClassName: 'bg-[#EAF4EF] text-[#237A57]',
  },
  {
    id: 'dispatch',
    label: '直接派活',
    desc: '拆成并行任务，分配给合适 Agent，并持续同步进度。',
    prompt:
      '请把目标拆成并行任务，分配给合适 Agent，在主群聊同步计划、进度、产物和最终汇总。',
    icon: FolderPlus,
    iconClassName: 'bg-[#EAF0FF] text-[#3159B7]',
  },
  {
    id: 'review',
    label: '复盘检查',
    desc: '让成员做交叉检查，输出风险、证据和最终结论。',
    prompt:
      '请组织成员做交叉检查：实现者说明产物，另一个 Agent 做风险复盘，最后给出可执行结论。',
    icon: Check,
    iconClassName: 'bg-[#FFF1D8] text-[#9A5D00]',
  },
]

export default function ChatPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const selectSession = useChatStore((state) => state.selectSession)
  const sessions = useChatStore((state) => state.sessions)
  const sessionsBootstrapped = useChatStore((state) => state.sessionsBootstrapped)
  const initWebSocket = useChatStore((state) => state.initWebSocket)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [narrowViewport, setNarrowViewport] = useState(false)
  const threadReady = Boolean(sessionId && currentSessionId === sessionId)
  const effectiveSidebarCollapsed = sidebarCollapsed || narrowViewport

  function toggleSidebar() {
    setSidebarCollapsed((current) => !current)
  }

  useEffect(() => {
    function syncViewport() {
      setNarrowViewport(window.innerWidth < 720)
    }

    syncViewport()
    window.addEventListener('resize', syncViewport)
    return () => window.removeEventListener('resize', syncViewport)
  }, [])

  useEffect(() => {
    const off = initWebSocket()
    return off
  }, [initWebSocket])

  useEffect(() => {
    if (!sessionId) return
    if (sessionId === currentSessionId) return
    // If sessions are loaded and this session doesn't exist, redirect immediately
    if (sessionsBootstrapped && sessions.length > 0 && !sessions.some((s) => s.id === sessionId)) {
      navigate('/', { replace: true })
      return
    }
    void selectSession(sessionId).catch(() => navigate('/', { replace: true }))
  }, [sessionId, currentSessionId, navigate, selectSession, sessions, sessionsBootstrapped])

  return (
    <div className="agenthub-chat-shell flex h-screen overflow-hidden bg-[#F7F7F7] text-neutral-950">
      <div
        className="h-full shrink-0 overflow-hidden"
        style={{
          width: effectiveSidebarCollapsed ? 68 : 340,
          transition: 'width 300ms cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        <div
          className="h-full w-[340px] transform-gpu will-change-transform"
        >
          <SessionList collapsed={effectiveSidebarCollapsed} onCollapse={toggleSidebar} />
        </div>
      </div>
      <main className="relative min-w-0 flex-1">
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
  const [multiAgentPanelOpen, setMultiAgentPanelOpen] = useState(false)
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
      setMultiAgentPanelOpen(false)
      closeMentionPanel()
      setSkillQuery(command.query)
      setSkillCommandRange({ start: command.start, end: command.end })
      setSkillPanelOpen(true)
    } else if (mention) {
      closeSkillPanel()
      setProjectMenuOpen(false)
      setMultiAgentPanelOpen(false)
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
    setMultiAgentPanelOpen(false)
    closeSkillPanel()
    window.requestAnimationFrame(() => {
      const nextCursor = start + 1
      messageInputRef.current?.focus()
      messageInputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  function insertComposerBlock(text: string) {
    const input = messageInputRef.current
    const source = input?.value ?? message
    const start = input?.selectionStart ?? source.length
    const end = input?.selectionEnd ?? source.length
    const before = source.slice(0, start)
    const after = source.slice(end)
    const prefix = before.trim() && !before.endsWith('\n') ? '\n\n' : ''
    const suffix = after.trim() && !after.startsWith('\n') ? '\n\n' : ''
    const nextMessage = `${before}${prefix}${text}${suffix}${after}`
    setMessage(nextMessage)
    window.requestAnimationFrame(() => {
      const nextCursor = before.length + prefix.length + text.length
      messageInputRef.current?.focus()
      messageInputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  function applyMultiAgentMode(mode: MultiAgentMode) {
    insertComposerBlock(mode.prompt)
    setMultiAgentPanelOpen(false)
    closeSkillPanel()
    closeMentionPanel()
    setProjectMenuOpen(false)
    showHint(`已启用：${mode.label}`)
  }

  function toggleMultiAgentPanel() {
    setMultiAgentPanelOpen((open) => !open)
    setProjectMenuOpen(false)
    closeSkillPanel()
    closeMentionPanel()
  }

  async function startThread(content: string) {
    const trimmed = content.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    try {
      const workspace =
        selectedWorkspace ??
        (
          await api.createAutoWorkspace({
            name: titleFromMessage(trimmed),
            goal: trimmed,
          })
        ).workspace
      if (!selectedWorkspace) {
        setWorkspaces((items) => [workspace, ...items.filter((item) => item.id !== workspace.id)])
        setSelectedWorkspace(workspace)
      }
      const session = await createSession(titleFromMessage(trimmed), {
        type: 'group',
        workspaceId: workspace.id,
        workspaceAgentId: null,
        metadata: { kind: 'workspace-agent-group', managerDefault: true },
      })
      await selectSession(session.id)
      navigate(`/chat/${session.id}`)
      await sendMessageToSession(session.id, trimmed)
      setMessage('')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setMultiAgentPanelOpen(false)
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
    setMultiAgentPanelOpen(false)
    setSelectedWorkspace(null)
    showHint('将从新工作空间开始')
  }

  function applyStarterPrompt(action: WelcomeStarterAction) {
    setMessage(action.prompt)
    closeSkillPanel()
    closeMentionPanel()
    setProjectMenuOpen(false)
    window.requestAnimationFrame(() => {
      messageInputRef.current?.focus()
      const cursor = action.prompt.length
      messageInputRef.current?.setSelectionRange(cursor, cursor)
    })
  }

  return (
    <div className="agenthub-welcome-root flex h-full flex-col bg-[#F8F8F6]">
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-8 sm:px-8">
        <section className="flex w-full max-w-[860px] flex-1 flex-col items-center justify-center py-6 text-center">
          <div className="mb-5 grid h-16 w-16 place-items-center rounded-2xl border border-neutral-200 bg-white shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-neutral-950 text-white">
              <Sparkles className="h-5 w-5" />
            </div>
          </div>
          <div className="mb-2 inline-flex h-8 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-500 shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            AgentHub 工作台
          </div>
          <h2 className="text-[clamp(1.65rem,3vw,2.65rem)] font-semibold leading-tight tracking-normal text-neutral-950">
            <TypewriterHeading text={t('有什么可以帮忙的？')} />
          </h2>
          <p className="mt-3 max-w-[520px] text-sm leading-6 text-neutral-500">
            把今天要推进的事放在这里。
          </p>

          <div className="agenthub-welcome-composer-dock mt-8 w-full max-w-[760px]">
            <form
              onSubmit={handleSubmit}
              className="relative rounded-[26px] border border-neutral-200 bg-white p-3 text-left shadow-[0_24px_70px_rgba(15,23,42,0.11)]"
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
                <div className="absolute bottom-[4.75rem] left-3 z-20 w-[min(20rem,calc(100vw-3rem))] rounded-2xl border border-neutral-200 bg-white p-1.5 text-sm shadow-xl">
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
              {multiAgentPanelOpen && (
                <WelcomeMultiAgentPanel
                  agents={libraryAgents}
                  modes={multiAgentModes}
                  selectedWorkspace={selectedWorkspace}
                  onApplyMode={applyMultiAgentMode}
                  onClose={() => setMultiAgentPanelOpen(false)}
                  onOpenAgentConfig={() => navigate('/agent-config')}
                  onPickAgent={insertMentionReference}
                />
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
                  if (event.key === 'Escape' && multiAgentPanelOpen) {
                    event.preventDefault()
                    setMultiAgentPanelOpen(false)
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
                className="h-28 w-full resize-none bg-transparent px-3 py-3 text-base leading-6 text-neutral-900 outline-none placeholder:text-neutral-400 sm:h-24"
                placeholder={t('发消息给 AgentHub，@ 可提及 Agent')}
              />
              <div className="flex flex-col gap-2 border-t border-neutral-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setProjectMenuOpen((open) => !open)
                      setMultiAgentPanelOpen(false)
                    }}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-neutral-200 bg-white text-neutral-700 shadow-sm hover:bg-neutral-50"
                    aria-label={t('选择工作区')}
                    title="选择工作区"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProjectMenuOpen((open) => !open)
                      setMultiAgentPanelOpen(false)
                    }}
                    className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 text-xs font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
                    aria-label={t('选择工作区')}
                    title={
                      selectedWorkspace
                        ? `${selectedWorkspace.name} · ${selectedWorkspace.projectPath ?? '本地工作空间'}`
                        : '选择工作空间 · 默认从新工作空间开始'
                    }
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <span className="max-w-[11rem] truncate">
                      {selectedWorkspace ? selectedWorkspace.name : '选择工作空间'}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                  </button>
                  <button
                    type="button"
                    onClick={toggleMultiAgentPanel}
                    aria-expanded={multiAgentPanelOpen}
                    aria-label="配置多 Agent 协作"
                    className={[
                      'inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium shadow-sm transition',
                      multiAgentPanelOpen
                        ? 'border-neutral-950 bg-neutral-950 text-white'
                        : 'border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-white hover:text-neutral-950',
                    ].join(' ')}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    多 Agent
                    <ChevronDown className="h-3.5 w-3.5 opacity-70" />
                  </button>
                </div>
                <div className="flex items-center justify-between gap-1.5 sm:justify-end">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      requestSettingsDialog()
                    }}
                    className="grid h-9 w-9 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100"
                    aria-label="前往系统设置"
                    title="可前往「系统设置」设置默认工作空间存储路径"
                  >
                    <CircleHelp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled
                    title="暂未实现"
                    className="grid h-9 w-9 place-items-center rounded-full text-neutral-300"
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={insertAtSign}
                    className="grid h-9 w-9 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100"
                    aria-label="提及 Agent"
                  >
                    <AtSign className="h-4 w-4" />
                  </button>
                  <button
                    type="submit"
                    disabled={!message.trim() || submitting}
                    className="grid h-10 w-10 place-items-center rounded-full bg-neutral-950 text-white shadow-sm hover:bg-neutral-800 disabled:bg-neutral-200 disabled:shadow-none"
                    aria-label="发送"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </form>
          </div>

          <div className="mt-5 flex w-full max-w-[760px] flex-wrap justify-center gap-2">
            {welcomeStarterActions.map((action) => {
              const Icon = action.icon
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => applyStarterPrompt(action)}
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3.5 text-sm font-medium text-neutral-800 shadow-sm transition hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-md"
                >
                  <span
                    className={[
                      'grid h-6 w-6 place-items-center rounded-full',
                      action.iconClassName,
                    ].join(' ')}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  {action.label}
                </button>
              )
            })}
          </div>

          <QuickPromptBubbles
            className="mt-7"
            loading={quickPromptsLoading}
            prompts={quickPrompts}
            onPick={(prompt: string) => void startThread(prompt)}
          />
        </section>
      </div>
    </div>
  )
}

function WelcomeMultiAgentPanel({
  agents,
  modes,
  onApplyMode,
  onClose,
  onOpenAgentConfig,
  onPickAgent,
  selectedWorkspace,
}: {
  agents: SavedAgentConfig[]
  modes: MultiAgentMode[]
  onApplyMode: (mode: MultiAgentMode) => void
  onClose: () => void
  onOpenAgentConfig: () => void
  onPickAgent: (value: string) => void
  selectedWorkspace: Workspace | null
}) {
  const visibleAgents = agents.slice(0, 6)

  return (
    <div
      className="absolute bottom-[4.75rem] left-3 right-3 z-30 overflow-hidden rounded-2xl border border-neutral-200 bg-white text-sm shadow-[0_24px_80px_rgba(15,23,42,0.16)] sm:left-[7.25rem] sm:right-auto sm:w-[30rem]"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center justify-between border-b border-neutral-100 px-3.5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold text-neutral-950">
            <Sparkles className="h-4 w-4" />
            多 Agent 协作
          </div>
          <div className="mt-1 truncate text-xs text-neutral-400">
            {selectedWorkspace ? selectedWorkspace.name : '新工作空间'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
        >
          关闭
        </button>
      </div>

      <div className="grid gap-1.5 p-2 sm:grid-cols-2">
        {modes.map((mode) => {
          const Icon = mode.icon
          return (
            <button
              key={mode.id}
              type="button"
              onClick={() => onApplyMode(mode)}
              className="group flex min-h-[5rem] items-start gap-3 rounded-xl border border-transparent p-3 text-left hover:border-neutral-200 hover:bg-neutral-50"
            >
              <span
                className={[
                  'grid h-8 w-8 shrink-0 place-items-center rounded-full',
                  mode.iconClassName,
                ].join(' ')}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-neutral-900">{mode.label}</span>
                <span className="mt-1 block text-xs leading-5 text-neutral-500">{mode.desc}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="border-t border-neutral-100 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-neutral-500">提及成员</span>
          <button
            type="button"
            onClick={onOpenAgentConfig}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950"
          >
            <Plus className="h-3.5 w-3.5" />
            配置 Agent
          </button>
        </div>
        {visibleAgents.length ? (
          <div className="flex flex-wrap gap-1.5">
            {visibleAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => {
                  onPickAgent(`@${agent.name}`)
                  onClose()
                }}
                className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                title={[agent.role, agent.description].filter(Boolean).join(' · ') || agent.name}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: agent.color ?? '#111827' }}
                />
                <span className="max-w-[9rem] truncate">@{agent.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-4 text-center text-xs text-neutral-400">
            还没有可提及的 Agent
          </div>
        )}
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
