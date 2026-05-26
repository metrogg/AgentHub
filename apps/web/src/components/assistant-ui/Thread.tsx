import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
  type EmptyMessagePartComponent,
} from '@assistant-ui/react'
import {
  MarkdownTextPrimitive,
  type CodeHeaderProps,
  type MarkdownTextPrimitiveProps,
  type SyntaxHighlighterProps,
} from '@assistant-ui/react-markdown'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import {
  ArrowUp,
  AtSign,
  Bot,
  Blocks,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderX,
  GitBranch,
  Globe2,
  ImagePlus,
  ListTodo,
  Loader2,
  MessageSquare,
  PanelLeft,
  Paperclip,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Rocket,
  Search,
  Sheet,
  Square,
  TerminalSquare,
  Trash2,
  User,
  Users,
} from 'lucide-react'
import { type ClipboardEvent, type ComponentPropsWithoutRef, type FC, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import {
  api,
  friendlyErrorMessage,
  type AgentArtifact,
  type ChatAttachment,
  type CodeAgentRunMetadata,
  type ModelCatalogItem,
  type OrchestratorDispatchResult,
  type OrchestratorPlan,
  type SkillSummary,
  type TaskStatus,
  type Workspace,
  type WorkspaceAgent,
} from '../../lib/api'
import { pickWorkspaceFolder } from '../../lib/native'
import { sendModeShouldSubmit, shouldInsertNewline, useShortcutSettings } from '../../lib/shortcuts'
import { cn } from '../../lib/utils'
import { useI18n } from '../../lib/i18n'
import { useChatStore } from '../../stores/chatStore'
import { TypewriterHeading } from '../chat/TypewriterHeading'

const highlightLanguageMap = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
}

Object.entries(highlightLanguageMap).forEach(([name, syntax]) => {
  if (!hljs.getLanguage(name)) {
    hljs.registerLanguage(name, syntax)
  }
})

const languageAliases: Record<string, string> = {
  cjs: 'javascript',
  html: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
}

const autoHighlightLanguages = Object.keys(highlightLanguageMap)
type MarkdownComponents = NonNullable<MarkdownTextPrimitiveProps['components']>
const maxPastedImageBytes = 5 * 1024 * 1024
const composerSyncEvent = 'agenthub:composer-sync'

export const Thread: FC<{
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}> = ({ sidebarCollapsed, onToggleSidebar }) => {
  const currentSession = useChatStore((state) => state.currentSession)
  const isGroupSession = currentSession?.type === 'group' && Boolean(currentSession.workspaceId)
  const isWorkspaceChildSession =
    currentSession?.type === 'direct' &&
    Boolean(currentSession.workspaceId) &&
    Boolean(currentSession.workspaceAgentId)

  return (
    <ThreadPrimitive.Root
      className="agenthub-thread-root relative flex h-full flex-col overflow-hidden bg-white"
      style={{ ['--thread-max-width' as string]: '44rem' }}
    >
      <ThreadHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} />
      <div className="flex min-h-0 flex-1">
        {isGroupSession && <GroupMemberPanel />}
        <div className="flex min-w-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto overscroll-contain scroll-auto px-6">
            <ThreadWelcome />
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, SystemMessage }} />
            <ThreadPrimitive.If empty={false}>
              <div className="min-h-28" />
            </ThreadPrimitive.If>
          </ThreadPrimitive.Viewport>
          <Composer />
        </div>
        {!isGroupSession && isWorkspaceChildSession && <WorkspaceChildSessionRail />}
      </div>
    </ThreadPrimitive.Root>
  )
}

const WorkspaceChildSessionRail: FC = () => {
  const session = useChatStore((state) => state.currentSession)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const agent = agents.find((item) => item.id === session?.workspaceAgentId)

  return (
    <aside className="hidden w-72 shrink-0 border-l border-neutral-200 bg-[#fbfbf9] px-4 py-5 xl:block">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-950">子会话</div>
          <div className="mt-1 truncate text-xs text-neutral-500">{agent ? `${agent.name} / ${agent.role}` : 'Agent Task'}</div>
        </div>
        <div className="grid h-8 w-8 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm">
          <Bot className="h-4 w-4" />
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-neutral-200 bg-white p-3 text-xs leading-5 text-neutral-500">
        <div className="font-medium text-neutral-900">独立输出</div>
        <div className="mt-1">这个子会话只展示当前 Agent 的任务上下文和执行结果。</div>
      </div>
    </aside>
  )
}

const ThreadHeader: FC<{
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}> = ({ sidebarCollapsed, onToggleSidebar }) => {
  const { t } = useI18n()
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
          aria-label={sidebarCollapsed ? t('展开侧栏') : t('收起侧栏')}
          title={sidebarCollapsed ? t('展开侧栏') : t('收起侧栏')}
        >
          <PanelLeft className={cn('h-4 w-4 transition-transform duration-300', sidebarCollapsed && 'rotate-180')} />
        </button>
        <div className="truncate text-sm font-medium text-neutral-950">AgentHub</div>
        <span className="text-sm text-neutral-300">/</span>
        <span className="truncate text-sm text-neutral-500">{t('对话由 AI 生成')}</span>
      </div>
      <div className="flex items-center gap-1">
        <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-label={t('新建')}>
          <Plus className="h-4 w-4" />
        </button>
        <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-label={t('对话')}>
          <MessageSquare className="h-4 w-4" />
        </button>
      </div>
    </header>
  )
}

const GroupMemberPanel: FC = () => {
  const navigate = useNavigate()
  const workspace = useChatStore((state) => state.currentWorkspace)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const messages = useChatStore((state) => state.messages)
  const activeAgentIds = new Set(messages.filter((message) => message.senderType === 'agent').map((message) => message.senderId))
  const [collapsed, setCollapsed] = useState(false)

  return (
    <aside
      className={cn(
        'hidden shrink-0 border-r border-neutral-200 bg-[#fbfbf9] xl:block',
        'transition-[width,padding] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]',
        collapsed ? 'w-12 px-0 py-4' : 'w-72 px-4 py-5'
      )}
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="grid h-8 w-8 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm transition hover:bg-neutral-100 hover:text-neutral-900"
            title="展开成员栏"
            aria-label="展开成员栏"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="grid h-8 w-8 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm">
            <Users className="h-4 w-4" />
          </div>
          <div className="mt-2 flex flex-col items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-full bg-blue-500 text-[10px] font-semibold text-white transition-transform duration-300" title="You">Y</div>
            <div className="grid h-7 w-7 place-items-center rounded-full bg-neutral-900 text-[10px] font-semibold text-white transition-transform duration-300" title="Orchestrator">O</div>
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white transition-transform duration-300"
                style={{ background: agent.color ?? '#111827' }}
                title={agent.name}
              >
                {agent.name.slice(0, 1).toUpperCase()}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-neutral-950">群聊成员</div>
              <div className="mt-1 truncate text-xs text-neutral-500">{workspace?.name ?? 'Agent Group'}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                className="grid h-8 w-8 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm transition hover:bg-neutral-100 hover:text-neutral-900"
                title="折叠成员栏"
                aria-label="折叠成员栏"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <div className="grid h-8 w-8 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm">
                <Users className="h-4 w-4" />
              </div>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            <MemberRow name="You" role="发起人与决策者" active />
            <MemberRow name="Orchestrator" role="拆解、协调、生成任务卡" active={activeAgentIds.has('orchestrator')} mentionName="orchestrator" />
            {agents.map((agent) => (
              <MemberRow
                key={agent.id}
                name={agent.name}
                role={`${agent.role} · ${agent.runtimeType}${agent.codeAgentType ? `/${agent.codeAgentType}` : ''}`}
                color={agent.color}
                active={activeAgentIds.has(agent.id)}
                mentionName={agent.name}
              />
            ))}
          </div>

          <div className="mt-5 rounded-2xl border border-neutral-200 bg-white p-3 text-xs leading-5 text-neutral-500">
            <div className="font-medium text-neutral-900">提及方式</div>
            <div className="mt-1">输入 @Agent 名称即可让对应成员在当前群聊里回复。未指定成员时由 Orchestrator 接管。</div>
          </div>

          {workspace?.projectPath && (
            <div className="mt-3 flex items-start gap-2 rounded-2xl border border-neutral-200 bg-white p-3 text-xs leading-5 text-neutral-500">
              <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
              <div className="min-w-0">
                <div className="font-medium text-neutral-900">项目文件夹</div>
                <div className="mt-1 break-all font-mono">{workspace.projectPath}</div>
              </div>
            </div>
          )}

          {workspace && (
            <button
              type="button"
              onClick={() => navigate('/agent-world', { state: { workspaceId: workspace.id } })}
              className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-xl bg-neutral-950 text-sm font-medium text-white transition hover:bg-neutral-800"
            >
              打开 Agent Group
            </button>
          )}
        </div>
      )}
    </aside>
  )
}

const MemberRow: FC<{ name: string; role: string; color?: string; active?: boolean; mentionName?: string }> = ({ name, role, color, active, mentionName }) => (
  <div className="group flex items-center gap-3 rounded-2xl px-2 py-2 transition hover:bg-white">
    <div
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
      style={{ background: color ?? (name === 'You' ? '#2563eb' : '#111827') }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-neutral-950">{name}</div>
      <div className="truncate text-xs text-neutral-500">{role}</div>
    </div>
    {mentionName && (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          insertComposerMention(mentionName)
        }}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 opacity-70 transition hover:bg-neutral-100 hover:text-blue-600 group-hover:opacity-100"
        title={`提及 ${name}`}
        aria-label={`提及 ${name}`}
      >
        <AtSign className="h-3.5 w-3.5" />
      </button>
    )}
    <span className={cn('h-2 w-2 rounded-full', active ? 'bg-emerald-500' : 'bg-neutral-300')} />
  </div>
)

function insertComposerMention(name: string) {
  const value = `@${name} `
  insertTextIntoComposer(value)
}

function insertTextIntoComposer(value: string, inputType = 'insertText') {
  const input = document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
  if (!input) {
    void navigator.clipboard?.writeText(value).catch(() => undefined)
    return null
  }
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? input.value.length
  input.focus()
  input.setSelectionRange(start, end)
  input.setRangeText(value, start, end, 'end')
  dispatchComposerInput(input, value, inputType)
  return input
}

function dispatchComposerInput(input: HTMLTextAreaElement, data: string, inputType = 'insertText') {
  try {
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }))
  } catch {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  window.dispatchEvent(new CustomEvent(composerSyncEvent, { detail: { value: input.value, scrollTop: input.scrollTop } }))
}

const ThreadWelcome: FC = () => (
  <ThreadPrimitive.Empty>
    <ThreadWelcomeContent />
  </ThreadPrimitive.Empty>
)

const ThreadWelcomeContent: FC = () => {
  const { t } = useI18n()
  return (
    <div className="mx-auto flex min-h-[calc(100vh-15rem)] w-full max-w-[var(--thread-max-width)] flex-col justify-center py-10">
      <div className="mb-24">
        <h2 className="text-2xl font-semibold tracking-normal text-neutral-950">
          <TypewriterHeading text={t('有什么可以帮忙的？')} />
        </h2>
        <p className="mt-2 text-base text-neutral-500">{t('创建 Agent、拆解任务，或直接 @ 某个助手开始协作。')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <PromptCard title={t('创建 coder 代理')} text={t('帮我单开一个跳跃小游戏')} />
        <PromptCard title={t('解释架构')} text={t('这个项目的具体技术栈')} />
      </div>
    </div>
  )
}

const PromptCard: FC<{ title: string; text: string }> = ({ title, text }) => (
  <div className="rounded-3xl border border-neutral-200 bg-white px-5 py-4 shadow-sm">
    <div className="text-sm font-medium text-neutral-950">{title}</div>
    <div className="mt-1 text-sm text-neutral-500">{text}</div>
  </div>
)

const Composer: FC = () => {
  const { sendMode } = useShortcutSettings()
  const { t } = useI18n()
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedModelId = useChatStore((state) => state.selectedModelId)
  const setSelectedModelId = useChatStore((state) => state.setSelectedModelId)
  const currentWorkspace = useChatStore((state) => state.currentWorkspace)
  const workspaceAgents = useChatStore((state) => state.currentWorkspaceAgents)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const selectSession = useChatStore((state) => state.selectSession)
  const pendingAttachments = useChatStore((state) => state.pendingAttachments)
  const addPendingAttachments = useChatStore((state) => state.addPendingAttachments)
  const removePendingAttachment = useChatStore((state) => state.removePendingAttachment)
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [menu, setMenu] = useState<'tools' | 'agents' | 'models' | 'workspace' | null>(null)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillPanelOpen, setSkillPanelOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [skillCommandRange, setSkillCommandRange] = useState<{ start: number; end: number } | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [openingWorkspaceId, setOpeningWorkspaceId] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [composerText, setComposerText] = useState('')
  const [composerScrollTop, setComposerScrollTop] = useState(0)
  const selectedModel = models.find((item) => item.id === selectedModelId)
  const modelLabel = selectedModel?.modelId ?? t('自动')

  useEffect(() => {
    let cancelled = false
    api
      .getSettings()
      .then((settings) => {
        if (cancelled || !settings.MODEL_CATALOG) return
        const parsed = JSON.parse(settings.MODEL_CATALOG) as ModelCatalogItem[]
        setModels(parsed.filter((item) => item.enabled))
      })
      .catch(() => setModels([]))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (menu !== 'workspace') return
    let cancelled = false
    setWorkspaceBusy(true)
    api
      .listWorkspaces()
      .then(({ items }) => {
        if (!cancelled) setWorkspaces(items)
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
  }, [menu])

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
    window.setTimeout(() => setHint(null), 1800)
  }

  async function handleFiles(files: FileList | File[] | null) {
    const list = Array.from(files ?? [])
    const imageFiles = list.filter((file) => file.type.startsWith('image/'))
    if (!imageFiles.length) {
      if (list.length) showHint('当前只支持图片附件')
      return
    }
    const accepted = imageFiles.filter((file) => file.size <= maxPastedImageBytes)
    if (accepted.length !== imageFiles.length) showHint('已跳过超过 5MB 的图片')
    if (!accepted.length) return
    const attachments = await Promise.all(accepted.map(fileToChatAttachment))
    addPendingAttachments(attachments)
    showHint(`已添加 ${attachments.length} 张图片`)
    if (!composerText.trim()) insertComposerText('请看这张图片')
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    void handleFiles(files)
  }

  function insertComposerText(value: string) {
    const input = insertTextIntoComposer(value)
    if (input) {
      setComposerText(input.value)
      setComposerScrollTop(input.scrollTop)
    }
  }

  function handleComposerInput(event: FormEvent<HTMLTextAreaElement>) {
    const input = event.currentTarget
    const nextText = input.value
    const cursor = input.selectionStart ?? nextText.length
    const command = readSlashCommand(nextText, cursor)
    setComposerText(nextText)
    setComposerScrollTop(input.scrollTop)
    if (command) {
      setMenu(null)
      setSkillQuery(command.query)
      setSkillCommandRange({ start: command.start, end: command.end })
      setSkillPanelOpen(true)
    } else {
      setSkillPanelOpen(false)
      setSkillCommandRange(null)
      setSkillQuery('')
    }
  }

  function insertSkillReference(skill: SkillSummary) {
    const input = document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
    const reference = `$${skill.id || skill.name} `
    if (!input) {
      void navigator.clipboard?.writeText(reference).catch(() => undefined)
      return
    }
    const fallbackCursor = input.selectionStart ?? input.value.length
    const liveCommand = readSlashCommand(input.value, fallbackCursor)
    const range = liveCommand ?? skillCommandRange
    const start = range?.start ?? fallbackCursor
    const end = range?.end ?? fallbackCursor
    input.focus()
    input.setSelectionRange(start, end)
    input.setRangeText(reference, start, end, 'end')
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: reference }))
    setComposerText(input.value)
    setComposerScrollTop(input.scrollTop)
    setSkillPanelOpen(false)
    setSkillCommandRange(null)
    setSkillQuery('')
    showHint(`已选择 Skill：${skill.name || skill.id}`)
  }

  async function openWorkspace(workspaceId: string) {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    setOpeningWorkspaceId(workspaceId)
    showHint('正在打开项目...')
    try {
      const { session } = await api.openWorkspaceGroupSession(workspaceId)
      await fetchSessions()
      await selectSession(session.id)
      setMenu(null)
      navigate(`/chat/${session.id}`)
    } catch (err) {
      showHint(friendlyErrorMessage(err, '打开项目失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  async function createBlankWorkspace() {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    try {
      const full = await api.createWorkspace({
        name: '空白项目',
        goal: '',
        projectPath: null,
        template: 'classic',
      })
      setWorkspaces((items) => [full.workspace, ...items.filter((item) => item.id !== full.workspace.id)])
      setOpeningWorkspaceId(full.workspace.id)
      showHint('已创建项目，正在进入...')
      const { session } = await api.openWorkspaceGroupSession(full.workspace.id)
      await fetchSessions()
      await selectSession(session.id)
      setMenu(null)
      navigate(`/chat/${session.id}`)
    } catch (err) {
      showHint(friendlyErrorMessage(err, '打开文件夹失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  async function openFolderFromComposer() {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    showHint('正在打开文件夹选择器...')
    try {
      const nativePath = await pickWorkspaceFolder().catch(() => null)
      const result = await api.openWorkspaceFolder(nativePath)
      if (result.cancelled || !result.projectPath) {
        showHint('已取消选择文件夹')
        return
      }
      showHint('已选择文件夹，正在打开项目...')
      const workspace =
        result.workspace ??
        (
          await api.createWorkspace({
            name: workspaceNameFromPath(result.projectPath),
            goal: '',
            projectPath: result.projectPath,
            template: 'classic',
          })
        ).workspace
      setWorkspaces((items) => [workspace, ...items.filter((item) => item.id !== workspace.id)])
      setOpeningWorkspaceId(workspace.id)
      showHint('项目已加入，正在进入...')
      const { session } = await api.openWorkspaceGroupSession(workspace.id)
      await fetchSessions()
      await selectSession(session.id)
      setMenu(null)
      navigate(`/chat/${session.id}`)
    } catch (err) {
      showHint(friendlyErrorMessage(err, '打开文件夹失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  function clearWorkspaceContext() {
    setMenu(null)
    navigate('/')
  }

  function syncComposerTextFromInput() {
    const input = document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
    setComposerText(input?.value ?? '')
    setComposerScrollTop(input?.scrollTop ?? 0)
  }

  function syncComposerTextAfterComposerAction() {
    window.setTimeout(syncComposerTextFromInput, 0)
    window.setTimeout(syncComposerTextFromInput, 80)
    window.setTimeout(syncComposerTextFromInput, 300)
  }

  useEffect(() => {
    window.addEventListener(composerSyncEvent, syncComposerTextFromInput)
    return () => window.removeEventListener(composerSyncEvent, syncComposerTextFromInput)
  })

  return (
    <div className="agenthub-composer-dock shrink-0 px-6 pb-6 pt-3">
      <ComposerPrimitive.Root
        className="mx-auto w-full max-w-[var(--thread-max-width)]"
        onSubmitCapture={syncComposerTextAfterComposerAction}
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest('button[aria-label="发送"]')) {
            syncComposerTextAfterComposerAction()
          }
        }}
        onKeyDownCapture={(event) => {
          if (sendModeShouldSubmit(sendMode, event)) {
            syncComposerTextAfterComposerAction()
          } else if (shouldInsertNewline(sendMode, event)) {
            event.stopPropagation()
          }
        }}
      >
        <div className="relative rounded-3xl border border-neutral-200 bg-white p-3 shadow-[0_10px_40px_rgba(15,23,42,0.10)] focus-within:border-neutral-300">
          {menu && (
            <ComposerMenu
              key={menu}
              type={menu}
              models={models}
              agents={workspaceAgents}
              workspaces={workspaces}
              currentWorkspaceId={currentWorkspace?.id ?? null}
              openingWorkspaceId={openingWorkspaceId}
              selectedModelId={selectedModelId}
              workspaceBusy={workspaceBusy}
              planMode={planMode}
              onOpenWorkspace={(workspaceId) => void openWorkspace(workspaceId)}
              onCreateBlankWorkspace={() => void createBlankWorkspace()}
              onOpenFolderWorkspace={() => void openFolderFromComposer()}
              onClearWorkspace={clearWorkspaceContext}
              onPlanMode={(next) => {
                setPlanMode(next)
                showHint(next ? '已开启计划模式' : '已关闭计划模式')
              }}
              onModel={(modelId) => {
                setSelectedModelId(modelId)
                showHint(modelId ? `已切换到 ${models.find((item) => item.id === modelId)?.modelId ?? modelId}` : '已切换到自动选择')
              }}
              onPick={(value) => {
                insertComposerText(`${value} `)
                showHint(`已插入 ${value}`)
              }}
              onClose={() => setMenu(null)}
            />
          )}
          {skillPanelOpen && (
            <SkillCommandPanel
              query={skillQuery}
              skills={skills}
              loading={skillsLoading}
              onPick={insertSkillReference}
              onClose={() => {
                setSkillPanelOpen(false)
                setSkillCommandRange(null)
                setSkillQuery('')
              }}
            />
          )}
          {hint && <div className="absolute -top-9 left-4 rounded-full bg-neutral-900 px-3 py-1 text-xs text-white shadow">{hint}</div>}
          {pendingAttachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingAttachments.map((attachment) => (
                <div key={attachment.id} className="group relative h-16 w-16 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50">
                  <img src={attachment.dataUrl} alt={attachment.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removePendingAttachment(attachment.id)}
                    className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-[11px] text-white opacity-90 transition hover:bg-black"
                    aria-label={`移除 ${attachment.name}`}
                  >
                    x
                  </button>
                  <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
                    {attachment.name}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="relative min-h-12">
            {composerText && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden px-2 py-2 text-sm leading-6 text-neutral-950"
              >
                <div
                  className="whitespace-pre-wrap break-words"
                  style={{ transform: `translateY(-${composerScrollTop}px)` }}
                >
                  {renderMentionHighlights(composerText, workspaceAgents)}
                </div>
              </div>
            )}
            <ComposerPrimitive.Input
              autoFocus
              data-agenthub-composer="true"
              placeholder={t('发消息给 AgentHub，@ 可提及 Agent')}
              rows={1}
              onPaste={handlePaste}
              onInput={handleComposerInput}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && skillPanelOpen) {
                  event.preventDefault()
                  setSkillPanelOpen(false)
                  setSkillCommandRange(null)
                  setSkillQuery('')
                }
              }}
              onScroll={(event) => setComposerScrollTop(event.currentTarget.scrollTop)}
              className={cn(
                'relative max-h-[180px] min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-neutral-400',
                composerText ? 'text-transparent caret-neutral-950' : 'text-neutral-950'
              )}
            />
          </div>
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-1">
              <ComposerToolButton aria-label="添加" onClick={() => setMenu(menu === 'tools' ? null : 'tools')}>
                <Plus className="h-4 w-4" />
              </ComposerToolButton>
              <ComposerToolButton
                aria-label="项目文件夹"
                title="项目文件夹"
                onClick={() => setMenu(menu === 'workspace' ? null : 'workspace')}
                className={cn((currentWorkspace || menu === 'workspace') && 'agenthub-icon-button-open')}
              >
                <FolderOpen className="h-4 w-4" />
              </ComposerToolButton>
              <ComposerToolButton aria-label="附件" onClick={() => fileInputRef.current?.click()}>
                <Paperclip className="h-4 w-4" />
              </ComposerToolButton>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  void handleFiles(event.target.files)
                  event.currentTarget.value = ''
                }}
              />
              <ComposerToolButton aria-label="提及" onClick={() => setMenu(menu === 'agents' ? null : 'agents')}>
                <AtSign className="h-4 w-4" />
              </ComposerToolButton>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMenu(menu === 'models' ? null : 'models')}
                className={cn(
                  'hidden h-8 max-w-40 items-center gap-1 rounded-full border border-neutral-200 px-3 text-xs text-neutral-600 transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out hover:-translate-y-px hover:bg-neutral-50 sm:inline-flex',
                  menu === 'models' && 'border-neutral-300 bg-neutral-100 text-neutral-950 shadow-sm'
                )}
              >
                <span className="truncate">{modelLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </button>
              <ComposerAction />
            </div>
          </div>
        </div>
      </ComposerPrimitive.Root>
    </div>
  )
}

export const SkillCommandPanel: FC<{
  query: string
  skills: SkillSummary[]
  loading: boolean
  onPick: (skill: SkillSummary) => void
  onClose: () => void
}> = ({ query, skills, loading, onPick, onClose }) => {
  const normalizedQuery = query.trim().toLowerCase()
  const filteredSkills = useMemo(() => {
    if (!normalizedQuery) return skills
    return skills.filter((skill) =>
      `${skill.name} ${skill.id} ${skill.description} ${skill.source}`.toLowerCase().includes(normalizedQuery)
    )
  }, [normalizedQuery, skills])
  const visibleSkills = filteredSkills.slice(0, 8)

  return (
    <div
      className="absolute bottom-[calc(100%+0.5rem)] left-3 right-3 z-30 overflow-hidden rounded-2xl border border-neutral-200 bg-white text-sm shadow-[0_18px_60px_rgba(15,23,42,0.16)] sm:right-auto sm:w-[26rem]"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-neutral-950 text-xs font-semibold text-white">/</span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-neutral-950">选择 Skill</div>
            <div className="truncate text-xs text-neutral-500">{normalizedQuery ? `筛选：${query}` : '已安装技能'}</div>
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900">
          关闭
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto p-1.5">
        {loading && (
          <div className="space-y-1.5 p-1">
            {[0, 1, 2].map((item) => (
              <div key={item} className="flex items-center gap-3 rounded-xl px-2 py-2">
                <div className="h-8 w-8 animate-pulse rounded-lg bg-neutral-100" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-28 animate-pulse rounded-full bg-neutral-100" />
                  <div className="h-2.5 w-48 animate-pulse rounded-full bg-neutral-100" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading &&
          visibleSkills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => onPick(skill)}
              className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-neutral-50"
            >
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-600">
                <Blocks className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium text-neutral-950">{skill.name || skill.id}</span>
                  <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-normal text-neutral-500">
                    {skill.source || 'local'}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-neutral-500">{skill.description || skill.id}</span>
                <span className="mt-1 block truncate font-mono text-[11px] text-neutral-400">${skill.id}</span>
              </span>
            </button>
          ))}
        {!loading && skills.length === 0 && (
          <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-8 text-center text-xs text-neutral-400">
            暂无已安装 Skills
          </div>
        )}
        {!loading && skills.length > 0 && filteredSkills.length === 0 && (
          <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-8 text-center text-xs text-neutral-400">
            没有匹配的 Skill
          </div>
        )}
      </div>
    </div>
  )
}

const ComposerMenu: FC<{
  type: 'tools' | 'agents' | 'models' | 'workspace'
  models: ModelCatalogItem[]
  agents: WorkspaceAgent[]
  workspaces: Workspace[]
  currentWorkspaceId: string | null
  openingWorkspaceId: string | null
  selectedModelId: string | null
  workspaceBusy: boolean
  planMode: boolean
  onOpenWorkspace: (workspaceId: string) => void
  onCreateBlankWorkspace: () => void
  onOpenFolderWorkspace: () => void
  onClearWorkspace: () => void
  onPlanMode: (enabled: boolean) => void
  onModel: (modelId: string | null) => void
  onPick: (value: string) => void
  onClose: () => void
}> = ({
  type,
  models,
  agents,
  workspaces,
  currentWorkspaceId,
  openingWorkspaceId,
  selectedModelId,
  workspaceBusy,
  planMode,
  onOpenWorkspace,
  onCreateBlankWorkspace,
  onOpenFolderWorkspace,
  onClearWorkspace,
  onPlanMode,
  onModel,
  onPick,
  onClose,
}) => {
  const { t } = useI18n()
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const legacyAgents = [
    { title: '@Orchestrator', desc: '拆解任务并分发到 Agent Group' },
    { title: '@architect', desc: '架构与任务拆解' },
    { title: '@coder', desc: '代码实现' },
    { title: '@reviewer', desc: '审查与边界检查' },
  ]
  const agentRows = agents.length
    ? [
        { title: '@orchestrator', desc: '拆解任务、创建任务卡并协调 Agent Group' },
        ...agents.map((agent) => ({
          title: `@${agent.name}`,
          desc: `${agent.role} · ${agent.runtimeType}${agent.codeAgentType ? `/${agent.codeAgentType}` : ''}${agent.capabilityTags.length ? ` · ${agent.capabilityTags.slice(0, 3).join(', ')}` : ''}`,
        })),
      ]
    : legacyAgents
  const plugins = [
    { title: 'Documents', icon: FileText, color: 'text-blue-500', value: '@documents' },
    { title: 'Spreadsheets', icon: Sheet, color: 'text-emerald-600', value: '@spreadsheets' },
    { title: 'Presentations', icon: Presentation, color: 'text-amber-500', value: '@presentations' },
    { title: '浏览器', icon: Globe2, color: 'text-sky-500', value: '@browser' },
  ]
  const filteredWorkspaces = workspaces.filter((workspace) => {
    const query = workspaceQuery.trim().toLowerCase()
    if (!query) return true
    return `${workspace.name} ${workspace.projectPath ?? ''}`.toLowerCase().includes(query)
  })

  return (
    <div
      className={cn(
        'agenthub-menu-popover absolute bottom-[4.5rem] z-20 rounded-2xl border border-neutral-200 bg-white p-1.5 text-sm shadow-xl',
        type === 'models' ? 'right-12 w-64' : 'left-3',
        type === 'workspace' ? 'w-80' : type === 'models' ? 'w-64' : 'w-64'
      )}
    >
      {type === 'tools' && (
        <div className="relative group/tools">
          <button type="button" onClick={() => onPlanMode(!planMode)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-neutral-50">
            <ListTodo className="h-4 w-4 text-neutral-500" />
            <span className="flex-1 text-neutral-900">计划模式</span>
            <span className={cn('relative h-4 w-8 rounded-full transition', planMode ? 'bg-neutral-900' : 'bg-neutral-200')}>
              <span className={cn('absolute top-0.5 h-3 w-3 rounded-full bg-white transition', planMode ? 'left-4' : 'left-0.5')} />
            </span>
          </button>
          <div className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-neutral-50">
            <Blocks className="h-4 w-4 text-neutral-500" />
            <span className="flex-1 text-neutral-900">插件</span>
            <ChevronRight className="h-4 w-4 text-neutral-400" />
          </div>
          <div className="agenthub-menu-flyout invisible absolute bottom-0 left-[calc(100%+0.5rem)] w-52 -translate-x-1 scale-95 rounded-2xl border border-neutral-200 bg-white p-2 opacity-0 shadow-xl transition group-hover/tools:visible group-hover/tools:translate-x-0 group-hover/tools:scale-100 group-hover/tools:opacity-100">
            <div className="px-3 pb-1 pt-1 text-xs text-neutral-400">4 个已装插件</div>
            {plugins.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => {
                    onPick(item.value)
                    onClose()
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-neutral-100"
                >
                  <Icon className={cn('h-4 w-4', item.color)} />
                  <span className="text-neutral-900">{item.title}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      {type === 'agents' &&
        agentRows.map((item) => <MenuRow key={item.title} title={item.title} desc={item.desc} onClick={() => { onPick(item.title); onClose() }} />)}
      {type === 'models' && (
        <>
          <button
            type="button"
            onClick={() => { onModel(null); onClose() }}
            className={cn('flex w-full items-center justify-between rounded-xl px-3 py-2 text-left hover:bg-neutral-50', !selectedModelId && 'bg-neutral-100')}
          >
            <span>{t('自动')}</span>
            <span className="text-xs text-neutral-400">{t('随机可用模型')}</span>
          </button>
          {models.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => { onModel(item.id); onClose() }}
              className={cn('flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left hover:bg-neutral-50', selectedModelId === item.id && 'bg-neutral-100')}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-neutral-900">{item.modelId}</span>
                <span className="block truncate text-xs text-neutral-400">{item.name || item.provider}</span>
              </span>
              <span className="shrink-0 text-xs text-neutral-400">{item.provider}</span>
            </button>
          ))}
          {models.length === 0 && <div className="px-3 py-2 text-xs text-neutral-400">还没有启用的模型</div>}
        </>
      )}
      {type === 'workspace' && (
        <div className="p-1">
          <div className="flex h-9 items-center gap-2 px-2 text-neutral-400">
            <Search className="h-4 w-4 shrink-0" />
            <input
              value={workspaceQuery}
              onChange={(event) => setWorkspaceQuery(event.target.value)}
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
              placeholder="搜索项目"
            />
          </div>
          <div className="max-h-44 space-y-1 overflow-y-auto py-1">
            {filteredWorkspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                onClick={() => onOpenWorkspace(workspace.id)}
                disabled={workspaceBusy}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-neutral-50 disabled:opacity-60',
                  (workspace.id === currentWorkspaceId || workspace.id === openingWorkspaceId) && 'bg-neutral-100'
                )}
              >
                <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                <span className="min-w-0 flex-1 truncate text-neutral-900">{workspace.name}</span>
                {workspace.id === openingWorkspaceId ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />
                ) : (
                  workspace.id === currentWorkspaceId && <ChevronDown className="h-4 w-4 shrink-0 text-neutral-300" />
                )}
              </button>
            ))}
            {!workspaceBusy && filteredWorkspaces.length === 0 && (
              <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-5 text-center text-xs text-neutral-400">
                没有匹配的项目
              </div>
            )}
            {workspaceBusy && <div className="px-2.5 py-2 text-xs text-neutral-400">正在处理项目...</div>}
          </div>
          <div className="mt-1 border-t border-neutral-200 pt-1.5">
            <div className="relative group/new-project">
              <button
                type="button"
                onClick={() => setAddProjectOpen((open) => !open)}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-neutral-50"
              >
                <FolderPlus className="h-4 w-4 shrink-0 text-neutral-600" />
                <span className="min-w-0 flex-1 truncate text-neutral-900">添加新项目</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              </button>
              <div
                className={cn(
                  'agenthub-menu-flyout absolute bottom-0 left-[calc(100%+0.35rem)] w-56 -translate-x-1 scale-95 rounded-2xl border border-neutral-200 bg-white p-1.5 opacity-0 shadow-xl transition group-hover/new-project:visible group-hover/new-project:translate-x-0 group-hover/new-project:scale-100 group-hover/new-project:opacity-100',
                  addProjectOpen ? 'visible translate-x-0 scale-100 opacity-100' : 'invisible opacity-0'
                )}
              >
                <button
                  type="button"
                  onClick={onCreateBlankWorkspace}
                  disabled={workspaceBusy}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-100 disabled:opacity-60"
                >
                  <Plus className="h-4 w-4 shrink-0 text-neutral-600" />
                  新建空白项目
                </button>
                <button
                  type="button"
                  onClick={onOpenFolderWorkspace}
                  disabled={workspaceBusy}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg bg-neutral-100 px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-200 disabled:opacity-60"
                >
                  <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                  使用现有文件夹
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={onClearWorkspace}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-50"
            >
              <FolderX className="h-4 w-4 shrink-0 text-neutral-600" />
              不使用项目
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function readSlashCommand(text: string, cursor: number) {
  const before = text.slice(0, cursor)
  const match = /(^|\s)\/([^\s/]*)$/.exec(before)
  if (!match) return null
  const suffix = /^[^\s]*/.exec(text.slice(cursor))?.[0] ?? ''
  const start = match.index + match[1].length
  const prefix = match[2] ?? ''
  return {
    start,
    end: cursor + suffix.length,
    query: `${prefix}${suffix}`,
  }
}

function workspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || '项目文件夹'
}

function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.onload = () => {
      resolve({
        id: crypto.randomUUID(),
        type: 'image',
        name: file.name || `pasted-image-${Date.now()}.png`,
        mimeType: file.type || 'image/png',
        size: file.size,
        dataUrl: String(reader.result ?? ''),
      })
    }
    reader.readAsDataURL(file)
  })
}

const MenuRow: FC<{ title: string; desc: string; onClick: () => void }> = ({ title, desc, onClick }) => (
  <button type="button" onClick={onClick} className="w-full rounded-xl px-3 py-2 text-left hover:bg-neutral-50">
    <div className="font-medium text-neutral-900">{title}</div>
    <div className="text-xs text-neutral-500">{desc}</div>
  </button>
)

const ComposerAction: FC = () => (
  <>
    <ThreadPrimitive.If running={false}>
      <ComposerPrimitive.Send asChild>
        <button className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-700 disabled:pointer-events-none disabled:bg-neutral-200" aria-label="发送">
          <ArrowUp className="h-4 w-4" />
        </button>
      </ComposerPrimitive.Send>
    </ThreadPrimitive.If>
    <ThreadPrimitive.If running>
      <ComposerPrimitive.Cancel asChild>
        <button className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white" aria-label="停止生成">
          <Square className="h-3.5 w-3.5" />
        </button>
      </ComposerPrimitive.Cancel>
    </ThreadPrimitive.If>
  </>
)

const UserMessage: FC = () => {
  const messageId = useMessage((message) => message.id)
  const sourceMessage = useChatStore((state) => state.messages.find((message) => message.id === messageId))
  const editMessage = useChatStore((state) => state.editMessage)
  const withdrawMessage = useChatStore((state) => state.withdrawMessage)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'edit' | 'withdraw' | null>(null)
  const canEdit = Boolean(sourceMessage?.senderType === 'user')
  const text =
    typeof sourceMessage?.metadata?.displayContent === 'string'
      ? sourceMessage.metadata.displayContent
      : sourceMessage?.content ?? ''

  function startEdit() {
    setDraft(text)
    setEditing(true)
  }

  async function saveEdit() {
    if (!sourceMessage || !draft.trim()) return
    setBusy('edit')
    try {
      await editMessage(sourceMessage.id, draft.trim())
      setEditing(false)
    } finally {
      setBusy(null)
    }
  }

  async function withdraw() {
    if (!sourceMessage) return
    const ok = window.confirm('撤回这条消息？如果后续 Agent 产生了文件修改，将尝试一并回滚。')
    if (!ok) return
    setBusy('withdraw')
    try {
      const rollback = await withdrawMessage(sourceMessage.id)
      if (rollback?.failed) {
        window.alert(`消息已撤回，但有 ${rollback.failed} 个文件变更未能自动回滚，请检查 git diff。`)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <MessagePrimitive.Root className="group mx-auto flex w-full max-w-[var(--thread-max-width)] justify-end py-3">
      <div className={cn('flex flex-col items-end gap-1.5', editing ? 'w-full' : 'max-w-[68%]')}>
        <div
          className={cn(
            'w-full text-sm leading-6 text-neutral-900',
            editing
              ? 'min-h-36 rounded-[28px] bg-[#f4f4f4] px-4 pb-4 pt-3'
              : 'rounded-[18px] bg-[#f1f1f1] px-5 py-2.5 shadow-none'
          )}
        >
          {editing ? (
            <div className="flex min-h-32 flex-col">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="编辑消息"
                className="min-h-20 flex-1 resize-none bg-transparent px-1 py-1 text-base leading-7 text-neutral-900 outline-none placeholder:text-neutral-300"
                autoFocus
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="h-10 rounded-[14px] border border-neutral-200 bg-white px-4 text-base font-medium text-neutral-900 shadow-sm transition hover:bg-neutral-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={busy === 'edit' || !draft.trim()}
                  className="h-10 rounded-[14px] bg-neutral-950 px-4 text-base font-semibold text-white shadow-sm transition hover:bg-neutral-800 disabled:bg-neutral-300"
                >
                  {busy === 'edit' ? '发送中' : '发送'}
                </button>
              </div>
            </div>
          ) : (
            <MessagePrimitive.Parts
              components={{
                data: { by_name: { chat_attachments: ChatAttachmentsPart } },
              }}
            />
          )}
        </div>
        {canEdit && !editing && (
          <div className="flex items-center gap-1 pr-1 text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100">
            <ToolButton type="button" aria-label="修改" title="修改" onClick={startEdit} disabled={Boolean(busy)}>
              <Pencil className="h-3.5 w-3.5" />
            </ToolButton>
            <ToolButton type="button" aria-label="撤回" title="撤回并尝试回滚修改" onClick={withdraw} disabled={Boolean(busy)}>
              {busy === 'withdraw' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </ToolButton>
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  )
}

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="mx-auto flex w-full max-w-[var(--thread-max-width)] gap-3 py-4">
    <Avatar role="assistant" />
    <div className="min-w-0 flex-1">
      <div className="text-sm leading-7 text-neutral-950">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Empty: AssistantThinking,
            data: {
              by_name: {
                agent_avatar: AgentAvatarPart,
                orchestrator_plan: OrchestratorPlanCard,
                code_agent_run: CodeAgentRunCard,
                agent_artifacts: AgentArtifactsCard,
                chat_attachments: ChatAttachmentsPart,
              },
            },
          }}
        />
      </div>
      <AssistantActionBar />
      <BranchPicker />
    </div>
  </MessagePrimitive.Root>
)

const AssistantThinking: EmptyMessagePartComponent = ({ status }) => {
  if (status?.type !== 'running') return null

  return (
    <div className="agenthub-thinking not-prose" aria-label="思考中">
      <span>思考中</span>
      <span className="agenthub-thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  )
}

const AgentAvatarPart: FC<{ data: { runtime?: CodeAgentRunMetadata['runtime'] } }> = () => null

const ChatAttachmentsPart: FC<{ data: { items?: ChatAttachment[] } }> = ({ data }) => {
  const items = Array.isArray(data.items) ? data.items : []
  if (!items.length) return null
  return (
    <div className="not-prose mt-3 grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <a
          key={item.id}
          href={item.dataUrl}
          target="_blank"
          rel="noreferrer"
          className="group overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm"
        >
          <img src={item.dataUrl} alt={item.name} className="aspect-video w-full bg-neutral-100 object-cover transition group-hover:scale-[1.015]" />
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500">
            <ImagePlus className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
          </div>
        </a>
      ))}
    </div>
  )
}

const CodeAgentRunCard: FC<{ data: CodeAgentRunMetadata }> = ({ data }) => {
  const changedFiles = data.files ?? []
  const commands = data.commands ?? []
  const toolCalls = data.toolCalls ?? []
  const logs = data.logs ?? []

  return (
    <div className="not-prose mt-3 space-y-2 text-sm">
      <CodeAgentStatusCard data={data} commandCount={commands.length} fileCount={changedFiles.length} toolCount={toolCalls.length} />
      {toolCalls.length > 0 && <CodeAgentToolsCard items={toolCalls} running={data.status === 'running'} />}
      {commands.length > 0 && <CodeAgentCommandsCard commands={commands} />}
      {changedFiles.length > 0 && <CodeAgentFilesCard cwd={data.cwd ?? commands.find((command) => command.cwd)?.cwd} files={changedFiles} />}
      {data.diagnostics && <CodeAgentDiagnosticsCard diagnostics={data.diagnostics} />}
      {logs.length > 0 && <CodeAgentLogsCard logs={logs} />}
    </div>
  )
}

const CodeAgentStatusCard: FC<{
  commandCount: number
  data: CodeAgentRunMetadata
  fileCount: number
  toolCount: number
}> = ({ commandCount, data, fileCount, toolCount }) => {
  const statusTone =
    data.status === 'running'
      ? 'text-blue-600'
      : data.status === 'completed'
        ? 'text-neutral-500'
        : data.status === 'timed-out'
          ? 'text-amber-600'
          : 'text-red-600'

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        <div className={cn('inline-flex min-w-0 items-center gap-2', statusTone)}>
          {data.status === 'running' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Clock3 className="h-4 w-4 shrink-0" />}
          <div className="min-w-0">
            <div className="truncate font-medium">{codeAgentStatusLabel(data.status)} · {formatRunDuration(data.durationMs)}</div>
            <div className="mt-0.5 truncate text-[11px] text-neutral-400">
              {runtimeLabel(data.runtime)} · {data.command}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
          <CodeAgentMiniStat icon={<Search className="h-3.5 w-3.5" />} label="工具" value={toolCount} />
          <CodeAgentMiniStat icon={<TerminalSquare className="h-3.5 w-3.5" />} label="命令" value={commandCount} />
          <CodeAgentMiniStat icon={<FileText className="h-3.5 w-3.5" />} label="文件" value={fileCount} />
        </div>
      </div>
    </div>
  )
}

const CodeAgentMiniStat: FC<{ icon: ReactNode; label: string; value: number }> = ({ icon, label, value }) => (
  <span className={cn('inline-flex h-7 items-center gap-1 rounded-md border px-2', value ? 'border-neutral-200 bg-neutral-50 text-neutral-700' : 'border-neutral-100 bg-white text-neutral-300')}>
    {icon}
    {label} {value}
  </span>
)

const CodeAgentToolsCard: FC<{ items: NonNullable<CodeAgentRunMetadata['toolCalls']>; running: boolean }> = ({ items, running }) => (
  <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
    <div className="flex h-10 items-center justify-between gap-3 border-b border-neutral-100 px-3">
      <span className="inline-flex min-w-0 items-center gap-2 font-medium text-neutral-800">
        <Search className="h-4 w-4 shrink-0 text-blue-500" />
        工具调用 {items.length}
      </span>
      {running && <span className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_0_4px_rgba(59,130,246,0.12)]" />}
    </div>
    <div className="grid gap-1.5 p-2">
      {items.slice(-12).map((item) => (
        <div key={item.id} className="grid grid-cols-[5.25rem_minmax(0,1fr)] gap-3 rounded-md bg-neutral-50 px-3 py-2.5 antialiased">
          <span className="text-[13px] font-medium leading-6 text-neutral-500">{item.label}</span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] leading-6 text-neutral-900" title={item.target ?? item.name}>
              {item.target ?? item.name}
            </span>
            {item.detail && <span className="mt-0.5 block truncate text-xs leading-5 text-neutral-500" title={item.detail}>{item.detail}</span>}
          </span>
        </div>
      ))}
    </div>
  </div>
)

const CodeAgentCommandsCard: FC<{ commands: CodeAgentRunMetadata['commands'] }> = ({ commands }) => (
  <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
    <div className="flex h-10 items-center gap-2 border-b border-neutral-100 px-3 font-medium text-neutral-800">
      <TerminalSquare className="h-4 w-4 shrink-0 text-emerald-600" />
      命令记录 {commands.length}
    </div>
    <div className="space-y-1.5 p-2">
      {commands.map((command) => (
        <details key={command.id} className="group rounded-md border border-neutral-200 bg-neutral-50 text-neutral-900">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
            <span className="agenthub-readable-code truncate text-[13px] leading-6" title={command.command}>{command.command}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400 transition group-open:rotate-180" />
          </summary>
          {(command.cwd || command.output) && (
            <div className="border-t border-neutral-200 bg-white px-3 py-2 text-[13px] leading-6 text-neutral-700">
              {command.cwd && <div className="agenthub-readable-code truncate text-neutral-500">cwd: {command.cwd}</div>}
              {command.output && <pre className="agenthub-readable-code mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{command.output}</pre>}
            </div>
          )}
        </details>
      ))}
    </div>
  </div>
)

const CodeAgentFilesCard: FC<{ cwd?: string; files: CodeAgentRunMetadata['files'] }> = ({ cwd, files }) => (
  <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
    <div className="flex h-10 items-center gap-2 border-b border-neutral-100 px-3 font-medium text-neutral-800">
      <FileText className="h-4 w-4 shrink-0 text-amber-600" />
      文件变更 {files.length}
    </div>
    <div className="space-y-1.5 p-2">
      {files.map((file) => {
        const vscodeHref = file.status === 'deleted' ? null : vscodeFileHref(file.path, cwd)
        return (
          <details key={`${file.status}-${file.path}`} className="group rounded-md bg-neutral-50">
            <summary className="grid cursor-pointer list-none grid-cols-[4.75rem_minmax(0,1fr)_auto_1rem] items-center gap-2 px-3 py-2.5">
              <span className="text-[13px] text-neutral-500">{fileStatusLabel(file.status)}</span>
              <span className="truncate text-[13px] leading-6 text-neutral-800" title={file.path}>{file.path}</span>
              {vscodeHref ? (
                <a
                  href={vscodeHref}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    window.location.href = vscodeHref
                  }}
                  className="inline-flex h-7 min-w-10 items-center justify-center gap-1 rounded-full border border-neutral-200 bg-white px-2 text-neutral-500 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
                  title="用 VS Code 打开"
                  aria-label={`用 VS Code 打开 ${file.path}`}
                >
                  <img src="/vscode-color.svg" alt="" className="h-4 w-4" draggable={false} />
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="h-7 min-w-10" />
              )}
              <ChevronDown className={cn('h-3.5 w-3.5 text-neutral-400 transition group-open:rotate-180', !file.diff && 'opacity-0')} />
            </summary>
            {file.diff && (
              <DiffViewer diff={file.diff} maxHeightClassName="max-h-72" />
            )}
          </details>
        )
      })}
    </div>
  </div>
)

const CodeAgentLogsCard: FC<{ logs: NonNullable<CodeAgentRunMetadata['logs']> }> = ({ logs }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex h-10 w-full items-center justify-between gap-3 px-3 text-left font-medium text-neutral-800 hover:bg-neutral-50">
        <span className="inline-flex min-w-0 items-center gap-2">
          <ListTodo className="h-4 w-4 shrink-0 text-neutral-500" />
          过程日志 {logs.length}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-neutral-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="max-h-64 space-y-1.5 overflow-auto border-t border-neutral-100 bg-white p-2">
          {logs.map((log) => (
            <div key={log.id} className={cn('grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 rounded-md border px-3 py-2.5 text-[13px] leading-6 antialiased', log.stream === 'stderr' ? 'border-red-100 bg-red-50/70' : log.stream === 'event' ? 'border-blue-100 bg-blue-50/60' : 'border-neutral-100 bg-neutral-50')}>
              <span className={cn('inline-flex h-5 items-center justify-center rounded px-1.5 text-[11px] font-medium', log.stream === 'stderr' ? 'bg-red-100 text-red-700' : log.stream === 'event' ? 'bg-blue-100 text-blue-700' : 'bg-neutral-200 text-neutral-600')}>
                {logStreamLabel(log.stream)}
              </span>
              <span className="whitespace-pre-wrap break-words text-neutral-800">{log.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const CodeAgentDiagnosticsCard: FC<{ diagnostics: string }> = ({ diagnostics }) => {
  const [open, setOpen] = useState(true)
  return (
    <div className="overflow-hidden rounded-lg border border-red-200 bg-white">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex h-10 w-full items-center justify-between gap-3 px-3 text-left font-medium text-red-700 hover:bg-red-50">
        <span className="inline-flex items-center gap-2">
          <AlertCircleIcon />
          诊断输出
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-red-300 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <pre className="max-h-56 overflow-auto border-t border-red-100 bg-neutral-950 px-3 py-2 text-xs leading-5 text-neutral-100">
          {diagnostics}
        </pre>
      )}
    </div>
  )
}

const AgentArtifactsCard: FC<{ data: { items?: AgentArtifact[] } }> = ({ data }) => {
  const items = data.items ?? []
  if (!items.length) return null
  const diffCount = items.filter((item) => item.type === 'diff').length
  const previewCount = items.filter((item) => item.type === 'preview').length
  const deployCount = items.filter((item) => item.type === 'deploy').length

  return (
    <div className="not-prose mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2.5 py-1">
          <Blocks className="h-3.5 w-3.5" />
          产物 {items.length}
        </span>
        {diffCount > 0 && <span>{diffCount} 个 Diff</span>}
        {previewCount > 0 && <span>{previewCount} 个预览</span>}
        {deployCount > 0 && <span>{deployCount} 个部署</span>}
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <ArtifactCard key={item.id} artifact={item} />
        ))}
      </div>
    </div>
  )
}

const ArtifactCard: FC<{ artifact: AgentArtifact }> = ({ artifact }) => {
  if (artifact.type === 'diff') return <DiffArtifactCard artifact={artifact} />
  if (artifact.type === 'preview') return <PreviewArtifactCard artifact={artifact} />
  if (artifact.type === 'deploy') return <DeployArtifactCard artifact={artifact} />
  return <FileArtifactCard artifact={artifact} />
}

const FileArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'file' }> }> = ({ artifact }) => (
  <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
    <div className="flex items-center gap-2">
      <FileText className="h-4 w-4 shrink-0 text-neutral-400" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-6 text-neutral-800" title={artifact.path}>{artifact.path}</div>
        <div className="mt-0.5 text-xs text-neutral-400">{artifact.status ? fileStatusLabel(artifact.status) : '文件产物'}</div>
      </div>
    </div>
  </div>
)

const DiffArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'diff' }> }> = ({ artifact }) => {
  const [open, setOpen] = useState(false)
  const lines = artifact.diff.split(/\r?\n/)
  const additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
  const deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 w-full items-center justify-between gap-3 px-3 text-left hover:bg-neutral-50"
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <GitBranch className="h-4 w-4 shrink-0 text-blue-500" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] leading-6 text-neutral-900">{artifact.filePath}</span>
            <span className="block text-xs text-neutral-400">+{additions} / -{deletions}</span>
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-neutral-400 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <DiffViewer diff={artifact.diff} maxHeightClassName="max-h-96" />
      )}
    </div>
  )
}

const DiffViewer: FC<{ diff: string; maxHeightClassName?: string }> = ({ diff, maxHeightClassName = 'max-h-96' }) => {
  const rows = useMemo(() => parseDiffRows(diff), [diff])

  return (
    <div className={cn('overflow-auto border-t border-neutral-200 bg-white text-[13px]', maxHeightClassName)}>
      <div className="agenthub-readable-code min-w-max py-1 leading-7">
        {rows.map((row, index) => (
          <div
            key={`${index}-${row.text}`}
            className={cn(
              'grid grid-cols-[3.25rem_3.25rem_minmax(32rem,1fr)] border-l-4 pr-4',
              row.kind === 'add' && 'border-emerald-500 bg-emerald-50 text-emerald-950',
              row.kind === 'del' && 'border-red-500 bg-red-50 text-red-950',
              row.kind === 'hunk' && 'border-blue-300 bg-blue-50 text-blue-700',
              row.kind === 'meta' && 'border-transparent bg-neutral-50 text-neutral-500',
              row.kind === 'context' && 'border-transparent text-neutral-800'
            )}
          >
            <span className={cn('select-none border-r border-neutral-100 px-2 text-right text-neutral-400', row.kind === 'add' && 'text-emerald-600', row.kind === 'del' && 'text-red-600')}>
              {row.oldNumber ?? ''}
            </span>
            <span className={cn('select-none border-r border-neutral-100 px-2 text-right text-neutral-400', row.kind === 'add' && 'text-emerald-600', row.kind === 'del' && 'text-red-600')}>
              {row.newNumber ?? ''}
            </span>
            <code className="whitespace-pre px-3">
              <span className={cn('mr-2 inline-block w-3 select-none', row.kind === 'add' && 'text-emerald-600', row.kind === 'del' && 'text-red-600')}>
                {row.marker}
              </span>
              {row.text}
            </code>
          </div>
        ))}
      </div>
    </div>
  )
}

const PreviewArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'preview' }> }> = ({ artifact }) => {
  const [open, setOpen] = useState(artifact.previewKind === 'static-html')

  return (
    <div className="agenthub-embedded-window overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className="flex h-11 items-center justify-between gap-3 px-3">
        <button type="button" onClick={() => setOpen((value) => !value)} className="inline-flex min-w-0 flex-1 items-center gap-2 text-left">
          <Globe2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium text-neutral-900">{artifact.title}</span>
            <span className="block truncate text-[11px] text-neutral-400">{artifact.url}</span>
          </span>
        </button>
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
          title="新窗口打开"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      {open && (
        <div className="agenthub-embedded-window-body border-t border-neutral-200 bg-neutral-50 p-2">
          <iframe title={artifact.title} src={artifact.url} className="h-80 w-full rounded-md border border-neutral-200 bg-white" />
        </div>
      )}
    </div>
  )
}

const DeployArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'deploy' }> }> = ({ artifact }) => (
  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
    <div className="flex items-center gap-2">
      <Rocket className="h-4 w-4 shrink-0 text-emerald-700" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold text-emerald-900">{artifact.title}</div>
        <div className="mt-0.5 truncate text-[11px] text-emerald-700">
          {artifact.provider} · {deployStatusLabel(artifact.status)}
        </div>
      </div>
      {artifact.url && (
        <a href={artifact.url} target="_blank" rel="noreferrer" className="grid h-7 w-7 place-items-center rounded-md text-emerald-700 hover:bg-emerald-100" title="打开部署">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  </div>
)

function deployStatusLabel(status: Extract<AgentArtifact, { type: 'deploy' }>['status']) {
  if (status === 'ready') return '已就绪'
  if (status === 'running') return '部署中'
  if (status === 'failed') return '失败'
  return '待部署'
}

type DiffRow = {
  kind: 'add' | 'context' | 'del' | 'hunk' | 'meta'
  marker: string
  newNumber?: number
  oldNumber?: number
  text: string
}

function parseDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine: number | undefined
  let newLine: number | undefined

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith('@@')) {
      const match = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/)
      oldLine = match ? Number(match[1]) : undefined
      newLine = match ? Number(match[2]) : undefined
      rows.push({ kind: 'hunk', marker: '@@', text: rawLine })
      continue
    }

    if (rawLine.startsWith('diff --git') || rawLine.startsWith('index ') || rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
      rows.push({ kind: 'meta', marker: '', text: rawLine })
      continue
    }

    if (rawLine.startsWith('+')) {
      rows.push({ kind: 'add', marker: '+', newNumber: newLine, text: rawLine.slice(1) })
      if (newLine !== undefined) newLine += 1
      continue
    }

    if (rawLine.startsWith('-')) {
      rows.push({ kind: 'del', marker: '-', oldNumber: oldLine, text: rawLine.slice(1) })
      if (oldLine !== undefined) oldLine += 1
      continue
    }

    const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
    rows.push({ kind: 'context', marker: '', oldNumber: oldLine, newNumber: newLine, text })
    if (oldLine !== undefined) oldLine += 1
    if (newLine !== undefined) newLine += 1
  }

  return rows
}

const AlertCircleIcon: FC = () => <span className="grid h-4 w-4 place-items-center rounded-full border border-neutral-300 text-[10px]">!</span>

function formatRunDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

function codeAgentStatusLabel(status: CodeAgentRunMetadata['status']) {
  if (status === 'running') return '正在执行'
  if (status === 'completed') return '执行完成'
  if (status === 'cancelled') return '已停止'
  if (status === 'timed-out') return '已超时'
  return '执行失败'
}

function runtimeLabel(runtime: CodeAgentRunMetadata['runtime']) {
  if (runtime === 'claude-code') return 'Claude Code'
  if (runtime === 'opencode') return 'OpenCode'
  if (runtime === 'gemini') return 'Gemini CLI'
  return 'Codex'
}

function logStreamLabel(stream: NonNullable<CodeAgentRunMetadata['logs']>[number]['stream']) {
  if (stream === 'stderr') return '错误'
  if (stream === 'event') return '事件'
  return '输出'
}

function fileStatusLabel(status: CodeAgentRunMetadata['files'][number]['status']) {
  if (status === 'created') return '创建'
  if (status === 'modified') return '修改'
  if (status === 'deleted') return '删除'
  if (status === 'renamed') return '重命名'
  return '未跟踪'
}

function vscodeFileHref(filePath: string, cwd?: string) {
  const absolutePath = absoluteEditorPath(filePath, cwd)
  if (!absolutePath) return null
  const normalized = absolutePath.replace(/\\/g, '/')
  return `vscode://file/${encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

function absoluteEditorPath(filePath: string, cwd?: string) {
  const trimmed = filePath.trim()
  if (!trimmed) return null
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) return trimmed
  const root = cwd?.trim()
  if (!root || (!/^[a-zA-Z]:[\\/]/.test(root) && !root.startsWith('/'))) return null
  return `${root.replace(/[\\/]+$/, '')}/${trimmed.replace(/^[\\/]+/, '')}`
}

const OrchestratorPlanCard: FC<{ data: OrchestratorPlan }> = ({ data }) => {
  const navigate = useNavigate()
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const [plan, setPlan] = useState(data)
  const [saving, setSaving] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [result, setResult] = useState<OrchestratorDispatchResult | null>(data.dispatchResult ?? null)
  const [error, setError] = useState('')

  useEffect(() => {
    setPlan(data)
    setResult(data.dispatchResult ?? null)
  }, [data])

  function patchTask(taskId: string, patch: Partial<{ agentKey: string; status: TaskStatus }>) {
    setPlan((current) => ({
      ...current,
      tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
    }))
  }

  async function savePlan() {
    if (!currentSessionId || !data.messageId) return plan
    setSaving(true)
    setError('')
    try {
      const updated = await api.updateOrchestratorPlan(currentSessionId, data.messageId, {
        tasks: plan.tasks.map((task) => ({
          id: task.id,
          agentKey: task.agentKey,
          status: task.status,
        })),
      })
      const nextPlan = (updated.metadata as { plan?: OrchestratorPlan } | null)?.plan ?? plan
      setPlan(nextPlan)
      return nextPlan
    } catch (err: any) {
      setError(err?.message || '保存任务卡失败')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function dispatchPlan() {
    if (!currentSessionId || !data.messageId || dispatching) return
    setDispatching(true)
    setError('')
    try {
      const saved = await savePlan()
      if (!saved) return
      const next = await api.dispatchOrchestratorPlan(currentSessionId, data.messageId)
      setResult(next)
      await fetchSessions()
    } catch (err: any) {
      setError(err?.message || '分发失败')
    } finally {
      setDispatching(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_12px_40px_rgba(15,23,42,0.08)]">
      <div className="border-b border-neutral-200 bg-[#fbfbf8] px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em] text-neutral-400">
              <GitBranch className="h-3.5 w-3.5" />
              Orchestrator Plan Draft
            </div>
            <h3 className="mt-1 truncate text-base font-semibold text-neutral-950">{plan.title}</h3>
          </div>
          <span className="shrink-0 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-500">
            {plan.tasks.length} tasks
          </span>
        </div>
        <p className="mt-2 line-clamp-2 text-sm leading-6 text-neutral-500">{plan.goal}</p>
      </div>

      <div className="px-4 py-3">
        <div className="space-y-2">
          {plan.tasks.map((task, index) => {
            const agent = plan.agents.find((item) => item.key === task.agentKey)
            const status = task.status ?? 'pending'
            return (
              <div key={task.id} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 rounded-xl border border-neutral-200 bg-white p-3">
                <div
                  className="grid h-7 w-7 place-items-center rounded-lg text-xs font-semibold text-white"
                  style={{ background: agent?.color ?? '#111827' }}
                >
                  {index + 1}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate text-sm font-semibold text-neutral-900">{task.title}</div>
                    <select
                      value={task.agentKey}
                      onChange={(event) => patchTask(task.id, { agentKey: event.target.value })}
                      disabled={Boolean(result)}
                      className="h-7 rounded-full border border-neutral-200 bg-neutral-50 px-2 text-xs text-neutral-600 outline-none transition hover:bg-white focus:border-neutral-400 disabled:opacity-60"
                    >
                      {plan.agents.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.name} / {item.role}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">{task.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(['pending', 'running', 'done'] as TaskStatus[]).map((item) => (
                      <button
                        key={item}
                        type="button"
                        disabled={Boolean(result)}
                        onClick={() => patchTask(task.id, { status: item })}
                        className={cn(
                          'h-7 rounded-full border px-2.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-60',
                          status === item
                            ? 'border-neutral-900 bg-neutral-950 text-white'
                            : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-300 hover:text-neutral-900'
                        )}
                      >
                        {taskStatusLabel(item)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {error && <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}

        {result ? (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              已分发 {result.tasks.length} 个子任务到 Agent 子会话
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => navigate('/agent-world', { state: { workspaceId: result.workspaceId } })}
                className="inline-flex h-8 items-center gap-2 rounded-lg bg-neutral-950 px-3 text-xs font-medium text-white hover:bg-neutral-800"
              >
                打开 Agent Group
              </button>
              {result.groupSessionId && (
                <button
                  type="button"
                  onClick={() => navigate(`/chat/${result.groupSessionId}`)}
                  className="inline-flex h-8 items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                >
                  回到群聊
                </button>
              )}
              {result.tasks[0] && (
                <button
                  type="button"
                  onClick={() => navigate(`/chat/${result.tasks[0].sessionId}`)}
                  className="inline-flex h-8 items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                >
                  查看首个子会话
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1.4fr]">
            <button
              type="button"
              onClick={() => void savePlan()}
              disabled={saving || dispatching}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:bg-neutral-100 disabled:text-neutral-400"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {saving ? '正在保存' : '保存调度'}
            </button>
            <button
              type="button"
              onClick={dispatchPlan}
              disabled={dispatching || saving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-neutral-950 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-300"
            >
              {dispatching ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
              {dispatching ? '正在创建并分发' : '创建并分发到 Agent Group'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function taskStatusLabel(status: TaskStatus) {
  if (status === 'running') return '进行中'
  if (status === 'done') return '已完成'
  return '待处理'
}

const SystemMessage: FC = () => (
  <MessagePrimitive.Root className="mx-auto w-full max-w-[var(--thread-max-width)] py-2">
    <div className="rounded-2xl bg-neutral-100 px-3 py-2 text-xs text-neutral-500">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
)

const AssistantActionBar: FC = () => {
  const messageId = useMessage((message) => message.id)
  const regenerateMessage = useChatStore((state) => state.regenerateMessage)
  const [regenerating, setRegenerating] = useState(false)

  async function regenerate() {
    if (messageId === 'agenthub-thinking' || regenerating) return
    setRegenerating(true)
    try {
      await regenerateMessage(messageId)
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" autohideFloat="single-branch" className="mt-2 flex items-center gap-1 text-neutral-400">
      <ActionBarPrimitive.Copy asChild>
        <ToolButton aria-label="复制" title="复制">
          <MessagePrimitive.If copied>
            <Check className="h-3.5 w-3.5" />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <Copy className="h-3.5 w-3.5" />
          </MessagePrimitive.If>
        </ToolButton>
      </ActionBarPrimitive.Copy>
      <ToolButton aria-label="重新生成" title="重新生成" onClick={regenerate} disabled={regenerating}>
        <RefreshCw className={cn('h-3.5 w-3.5', regenerating && 'animate-spin')} />
      </ToolButton>
    </ActionBarPrimitive.Root>
  )
}

const BranchPicker: FC = () => (
  <BranchPickerPrimitive.Root hideWhenSingleBranch className="mt-1 flex items-center gap-1 text-xs text-neutral-400">
    <BranchPickerPrimitive.Previous asChild>
      <ToolButton aria-label="上一分支">
        <ChevronLeft className="h-3.5 w-3.5" />
      </ToolButton>
    </BranchPickerPrimitive.Previous>
    <span className="font-mono">
      <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
    </span>
    <BranchPickerPrimitive.Next asChild>
      <ToolButton aria-label="下一分支">
        <ChevronRight className="h-3.5 w-3.5" />
      </ToolButton>
    </BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
)

const Avatar: FC<{ role: 'user' | 'assistant' }> = ({ role }) => {
  const runtime = useMessage((message) => (role === 'assistant' ? codeAgentRuntimeFromParts(message.content) : null))

  if (role === 'assistant' && runtime) {
    return (
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-neutral-200 bg-white shadow-sm" title={codeAgentRuntimeLabel(runtime)}>
        <img src={codeAgentLogoSrc(runtime)} alt={codeAgentRuntimeLabel(runtime)} className="h-5 w-5 object-contain" />
      </div>
    )
  }

  return (
    <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full', role === 'assistant' ? 'bg-[#eef8f6] text-[#87a9a4]' : 'bg-blue-500 text-white')}>
      {role === 'assistant' ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
    </div>
  )
}

function codeAgentRuntimeFromParts(parts: unknown): CodeAgentRunMetadata['runtime'] | null {
  if (!Array.isArray(parts)) return null
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const item = part as { data?: unknown; name?: unknown; type?: unknown }
    if (item.type !== 'data') continue
    if (item.name === 'agent_avatar') {
      const runtime = (item.data as { runtime?: unknown } | null)?.runtime
      if (runtime === 'codex' || runtime === 'claude-code' || runtime === 'opencode' || runtime === 'gemini') return runtime
    }
    if (item.name === 'code_agent_run') {
      const runtime = (item.data as { runtime?: unknown } | null)?.runtime
      if (runtime === 'codex' || runtime === 'claude-code' || runtime === 'opencode' || runtime === 'gemini') return runtime
    }
  }
  return null
}

function codeAgentLogoSrc(runtime: CodeAgentRunMetadata['runtime']) {
  if (runtime === 'claude-code') return '/claude-color.svg'
  if (runtime === 'opencode') return '/opencode.svg'
  if (runtime === 'gemini') return '/gemini-color.svg'
  return '/codex-color.svg'
}

function codeAgentRuntimeLabel(runtime: CodeAgentRunMetadata['runtime']) {
  if (runtime === 'claude-code') return 'Claude Code'
  if (runtime === 'opencode') return 'OpenCode'
  if (runtime === 'gemini') return 'Gemini CLI'
  return 'Codex'
}

const ToolButton: FC<ComponentPropsWithoutRef<'button'>> = ({ className, ...props }) => (
  <button
    type="button"
    className={cn('grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:pointer-events-none disabled:opacity-45', className)}
    {...props}
  />
)

function renderMentionHighlights(text: string, agents: WorkspaceAgent[]) {
  const aliases = mentionAliases(agents)
  if (!aliases.length) return text

  const pattern = new RegExp(`@(${aliases.map(escapeRegExp).join('|')})(?=$|\\s|[，,。.!！?？:：；;）)\\]】])`, 'gi')
  const parts: ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > lastIndex) parts.push(text.slice(lastIndex, index))
    parts.push(
      <span key={`${index}-${match[0]}`} className="font-medium text-blue-600">
        {match[0]}
      </span>
    )
    lastIndex = index + match[0].length
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts.length ? parts : text
}

function mentionAliases(agents: WorkspaceAgent[]) {
  const aliases = [
    'orchestrator',
    'coordinator',
    'agenthub',
    '协调器',
    '调度',
    'Architect',
    'Coder',
    'Researcher',
    'Reviewer',
    '规划',
    '实现',
    '研究',
    '审查',
  ]
  for (const agent of agents) {
    aliases.push(agent.name, agent.role)
  }
  return Array.from(new Set(aliases.filter(Boolean))).sort((a, b) => b.length - a.length)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ComposerToolButton: FC<ComponentPropsWithoutRef<'button'>> = ({ className, ...props }) => (
  <button
    type="button"
    className={cn(
      'agenthub-icon-button grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
      className
    )}
    {...props}
  />
)

const CodePre: NonNullable<MarkdownComponents['pre']> = ({ className, node: _node, ...props }) => (
  <pre className={cn('agenthub-code-pre not-prose', className)} {...props} />
)

const CodeToken: NonNullable<MarkdownComponents['code']> = ({ className, node: _node, ...props }) => {
  const isBlock = className?.includes('agenthub-code') || className?.includes('language-')
  return <code className={cn(isBlock ? 'agenthub-code' : 'agenthub-inline-code', className)} {...props} />
}

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const [copied, setCopied] = useState(false)
  const label = formatLanguageLabel(language)

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code.replace(/\n$/, ''))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="agenthub-code-header not-prose">
      <span>{label}</span>
      <button type="button" className="agenthub-code-copy" onClick={copyCode} title="Copy code" aria-label="Copy code">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

const CodeSyntaxHighlighter: FC<SyntaxHighlighterProps> = ({ components: { Pre, Code }, language, code }) => {
  const normalizedLanguage = normalizeHighlightLanguage(language)
  const highlighted = useMemo(() => highlightCode(code, normalizedLanguage), [code, normalizedLanguage])

  return (
    <Pre className="agenthub-code-pre not-prose">
      <Code
        className={cn('agenthub-code', normalizedLanguage ? `language-${normalizedLanguage}` : 'language-text')}
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </Pre>
  )
}

function normalizeHighlightLanguage(language: string | undefined) {
  const key = (language ?? '').toLowerCase().trim()
  if (!key || key === 'unknown' || key === 'text' || key === 'txt' || key === 'plain' || key === 'plaintext') {
    return ''
  }
  return languageAliases[key] ?? key
}

function formatLanguageLabel(language: string | undefined) {
  const normalized = normalizeHighlightLanguage(language)
  return normalized || 'text'
}

function highlightCode(code: string, language: string) {
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value
    }

    if (code.trim()) {
      return hljs.highlightAuto(code, autoHighlightLanguages).value
    }
  } catch {
    return escapeHtml(code)
  }

  return escapeHtml(code)
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function closeUnterminatedCodeFence(text: string) {
  let openFence: string | null = null
  const fencePattern = /(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*/g

  for (const match of text.matchAll(fencePattern)) {
    const marker = match[1]
    if (!openFence) {
      openFence = marker
      continue
    }

    if (marker[0] === openFence[0] && marker.length >= openFence.length) {
      openFence = null
    }
  }

  if (!openFence) return text
  return `${text}${text.endsWith('\n') ? '' : '\n'}${openFence}`
}

const MarkdownText: FC = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    smooth={false}
    preprocess={closeUnterminatedCodeFence}
    components={{
      pre: CodePre,
      code: CodeToken,
      CodeHeader,
      SyntaxHighlighter: CodeSyntaxHighlighter,
    }}
    className="agenthub-markdown prose prose-neutral prose-sm max-w-none prose-p:my-2 prose-ul:my-2 prose-code:before:content-none prose-code:after:content-none"
  />
)
