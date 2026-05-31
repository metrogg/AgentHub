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
  AlertTriangle,
  ArrowUp,
  AtSign,
  Bot,
  Blocks,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  File,
  FileText,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe2,
  ImagePlus,
  ListTodo,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  MoreHorizontal,
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
  X,
  XCircle,
} from 'lucide-react'
import {
  type ClipboardEvent,
  type ComponentPropsWithoutRef,
  type FC,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import { ClarificationCard } from '@/components/ClarificationCard'
import DeliveryReport from '@/components/DeliveryReport'
import type { DeliveryReportData } from '@/components/DeliveryReport'
import { FileCard } from '@/components/FileCard'
import {
  api,
  friendlyErrorMessage,
  type AgentArtifact,
  type ChatAttachment,
  type ModelCatalogItem,
  type SkillSummary,
  type WelcomeQuickPrompt,
  type Workspace,
  type WorkspaceAgent,
} from '../../lib/api'
import type { CodeAgentRunMetadata } from '@agenthub/shared'
import { codeAgentRuntimeLabel } from '../../lib/agentDisplay'
import {
  downloadExternalUrl,
  isDesktopApp,
  notifyUser,
  openExternalUrl,
  openPath,
  openUrlWindow,
  pickWorkspaceFolder,
} from '../../lib/native'
import {
  sendModeShouldSubmit,
  shouldInsertNewline,
  useShortcutSettings,
} from '../../lib/shortcuts'
import { requestSettingsDialog } from '../../lib/settingsDialog'
import { cn } from '../../lib/utils'
import { getCachedAccountProfile } from '../../lib/accountProfile'
import {
  isProjectWorkspace,
  workspaceSearchText,
  workspaceSubtitle,
} from '../../lib/workspaceFilters'
import { useI18n } from '../../lib/i18n'
import { useChatStore } from '../../stores/chatStore'
import {
  QuickPromptBubbles,
  createQuickPromptSeed,
  rotateQuickPrompts,
} from '../chat/QuickPromptBubbles'
import { TypewriterHeading } from '../chat/TypewriterHeading'
import { GroupAvatar } from '../chat/GroupAvatar'
import {
  agentLibraryChangeEvent,
  flushAgentLibraryServerSync,
  loadAgentLibrary,
  saveAgentToLibrary,
  toAgentConfigInput,
  type SavedAgentConfig,
} from '../../lib/agentLibrary'
import { workspaceNameFromPath } from '@agenthub/shared'
import { useLineSelection } from './useLineSelection'
import LineSelectionToolbar from './LineSelectionToolbar'

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
const artifactPreviewEvent = 'agenthub:artifact-preview'
const previewPanelWidthStorageKey = 'agenthub:preview-panel-width'

type ArtifactPreviewItem = {
  id: string
  title: string
  subtitle?: string
  description?: string
  kind: 'web' | 'file' | 'image' | 'diff' | 'deploy' | 'workflow'
  url?: string
  path?: string
  mimeType?: string
  source?: string
  /** 用于构造 HTML 预览 URL 的 workspaceId */
  workspaceId?: string
}

type PreviewActionItem = {
  id: string
  kind: 'open' | 'download'
  status: 'working' | 'success' | 'error'
  title: string
  detail: string
  path?: string
  folder?: string
}

function classifyAgentSession(
  session: ReturnType<typeof useChatStore.getState>['currentSession'],
) {
  if (session?.type !== 'direct' || !session.workspaceId || !session.workspaceAgentId)
    return 'regular'
  const metadata = session.metadata ?? {}
  if (metadata.kind === 'agent-direct') return 'agent-direct'
  if (metadata.orchestratorTaskId || metadata.orchestratorRunId || metadata.hiddenFromSessionTree) {
    return 'orchestrator-task'
  }
  return 'agent-direct'
}

export const Thread: FC = () => {
  const currentSession = useChatStore((state) => state.currentSession)
  const isGroupSession = currentSession?.type === 'group' && Boolean(currentSession.workspaceId)
  const sessionKind = classifyAgentSession(currentSession)
  const isAgentDirectSession = sessionKind === 'agent-direct'
  const taskBoard = useChatStore((s) => s.taskBoard)
  const agentActivity = useChatStore((s) => s.agentActivity)
  const visibleTaskBoard =
    taskBoard &&
    taskBoard.sessionId === currentSession?.id &&
    ['planning', 'running', 'synthesizing'].includes(taskBoard.status)
      ? taskBoard
      : null
  const selectedAgentTab = useChatStore((s) => s.selectedAgentTab)
  const agentTabs = useChatStore((s) => s.agentTabs)
  const selectAgentTab = useChatStore((s) => s.selectAgentTab)
  const planningActivity =
    isGroupSession &&
    selectedAgentTab === null &&
    agentActivity?.sessionId === currentSession?.id &&
    agentActivity.phase === 'planning'
      ? agentActivity
      : null
  const isOrchestratorTaskChild = sessionKind === 'orchestrator-task'
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false)
  const [childDetailsOpen, setChildDetailsOpen] = useState(false)
  const [previewItem, setPreviewItem] = useState<ArtifactPreviewItem | null>(null)

  useEffect(() => {
    setGroupDetailsOpen(false)
    setChildDetailsOpen(false)
  }, [currentSession?.id])

  useEffect(() => {
    function handlePreview(event: Event) {
      const item = (event as CustomEvent<ArtifactPreviewItem>).detail
      if (!item?.id) return
      setPreviewItem(item)
    }
    window.addEventListener(artifactPreviewEvent, handlePreview)
    return () => window.removeEventListener(artifactPreviewEvent, handlePreview)
  }, [])

  return (
    <ThreadPrimitive.Root
      className="agenthub-thread-root relative flex h-full flex-col overflow-hidden bg-white"
      style={{ ['--thread-max-width' as string]: '44rem' }}
    >
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {isGroupSession && !isOrchestratorTaskChild && (
            <GroupChatHeader onToggleDetails={() => setGroupDetailsOpen((open) => !open)} />
          )}
          {isOrchestratorTaskChild && (
            <OrchestratorChildHeader
              agentName={
                currentSession?.workspaceAgentId
                  ? (useChatStore
                      .getState()
                      .currentWorkspaceAgents.find((a) => a.id === currentSession?.workspaceAgentId)
                      ?.name ?? 'Agent')
                  : 'Agent'
              }
              onBack={() => selectAgentTab(null)}
            />
          )}
          {!isGroupSession &&
            !isOrchestratorTaskChild &&
            isAgentDirectSession && (
              <AgentChatHeader onToggleDetails={() => setChildDetailsOpen((open) => !open)} />
            )}
          {isGroupSession && visibleTaskBoard && selectedAgentTab === null && (
            <LeaderViewBanner taskBoard={visibleTaskBoard} agentTabs={agentTabs} />
          )}
          <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto overscroll-contain scroll-auto px-6">
            <ThreadWelcome />
            <ThreadPrimitive.Messages
              components={{ UserMessage, AssistantMessage, SystemMessage }}
            />
            {isGroupSession &&
              selectedAgentTab === null &&
              (visibleTaskBoard || planningActivity) && (
                <TeamExecutionPanel
                  taskBoard={visibleTaskBoard}
                  agentTabs={agentTabs}
                  activity={planningActivity}
                />
              )}
            <ThreadPrimitive.If empty={false}>
              <div className="min-h-28" />
            </ThreadPrimitive.If>
          </ThreadPrimitive.Viewport>
          <Composer />
        </div>
        {previewItem && (
          <ArtifactPreviewPanel item={previewItem} onClose={() => setPreviewItem(null)} />
        )}
        {isGroupSession && (
          <GroupChatDetailsPanel
            open={groupDetailsOpen}
            onClose={() => setGroupDetailsOpen(false)}
          />
        )}
      </div>
      {!isGroupSession && isAgentDirectSession && (
        <WorkspaceChildSessionDrawer
          open={childDetailsOpen}
          onClose={() => setChildDetailsOpen(false)}
        />
      )}
    </ThreadPrimitive.Root>
  )
}

const GroupChatHeader: FC<{ onToggleDetails: () => void }> = ({ onToggleDetails }) => {
  const session = useChatStore((state) => state.currentSession)
  const workspace = useChatStore((state) => state.currentWorkspace)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const clearMessages = useChatStore((state) => state.clearMessages)
  const title = groupChatDisplayTitle(session?.title, workspace?.name)
  const memberCount = agents.length + 1

  async function handleClear() {
    if (!session) return
    if (!window.confirm('确定清空当前会话的所有消息？此操作不可撤销。')) return
    await clearMessages(session.id)
  }

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-neutral-200 bg-white/95 pb-0 pl-[calc(1.25rem+var(--agenthub-thread-header-left-offset,0rem))] pr-5 pt-0 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        <GroupAvatar agents={agents} size="md" title={title} />
        <div className="flex min-w-0 items-center text-sm">
          <span className="truncate font-semibold text-neutral-950">{title}</span>
          <span className="ml-1 shrink-0 font-normal text-neutral-500">({memberCount})</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleClear}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-400 transition hover:bg-red-50 hover:text-red-500"
          title="清空消息"
          aria-label="清空消息"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onToggleDetails}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
          title="群聊详情"
          aria-label="群聊详情"
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </div>
    </header>
  )
}

const AgentChatHeader: FC<{ onToggleDetails: () => void }> = ({ onToggleDetails }) => {
  const session = useChatStore((state) => state.currentSession)
  const workspace = useChatStore((state) => state.currentWorkspace)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const agent = agents.find((item) => item.id === session?.workspaceAgentId)
  const title = agent?.name || session?.title || 'Agent'
  const subtitle = [agent?.role, workspace?.name].filter(Boolean).join(' · ') || '单 Agent 会话'

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-neutral-200 bg-white/95 pb-0 pl-[calc(1.25rem+var(--agenthub-thread-header-left-offset,0rem))] pr-5 pt-0 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-sm font-semibold text-white shadow-sm"
          style={{ background: agent?.color ?? '#111827' }}
        >
          {(title.trim().slice(0, 1) || 'A').toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-neutral-950">{title}</div>
          <div className="mt-0.5 truncate text-xs text-neutral-500">{subtitle}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggleDetails}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
        title="Agent 设置"
        aria-label="Agent 设置"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
    </header>
  )
}

const OrchestratorChildHeader: FC<{ agentName: string; onBack: () => void }> = ({
  agentName,
  onBack,
}) => {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white/95 pb-0 pl-[calc(1.25rem+var(--agenthub-thread-header-left-offset,0rem))] pr-5 pt-0 backdrop-blur">
      <button
        type="button"
        onClick={onBack}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
        title="返回主对话"
        aria-label="返回主对话"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="text-sm truncate">
          <span className="font-medium text-neutral-700">{agentName}</span>
          <span className="ml-1.5 text-xs text-neutral-400">成员对话</span>
        </span>
      </div>
    </header>
  )
}

interface LeaderViewBannerProps {
  taskBoard: NonNullable<ReturnType<typeof useChatStore.getState>['taskBoard']>
  agentTabs: ReturnType<typeof useChatStore.getState>['agentTabs']
}

const LeaderViewBanner: FC<LeaderViewBannerProps> = ({ taskBoard, agentTabs }) => {
  const runningCount = agentTabs.filter((t) => t.status === 'running').length
  const doneCount = agentTabs.filter((t) => t.status === 'done').length
  const failedCount = agentTabs.filter((t) => t.status === 'failed').length

  return (
    <div className="shrink-0 border-b border-neutral-100 bg-white px-6 py-2.5">
      <div className="flex items-center gap-2 text-xs">
        <Bot className="h-4 w-4 text-blue-600" />
        <span className="font-semibold text-neutral-700">主对话</span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-500">
          {taskBoard.goal
            ? taskBoard.goal.slice(0, 40) + (taskBoard.goal.length > 40 ? '...' : '')
            : '任务执行中'}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-1 ml-7">
        {runningCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-blue-600">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
            </span>
            {runningCount} 执行中
          </span>
        )}
        {doneCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-green-600">
            <CheckCircle2 className="w-3 h-3" />
            {doneCount} 已完成
          </span>
        )}
        {failedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-red-600">
            <XCircle className="w-3 h-3" />
            {failedCount} 失败
          </span>
        )}
        <span className="text-xs text-neutral-400">共 {agentTabs.length} 个 Agent</span>
      </div>
    </div>
  )
}

type LiveTaskBoard = NonNullable<ReturnType<typeof useChatStore.getState>['taskBoard']>
type LiveAgentActivity = NonNullable<ReturnType<typeof useChatStore.getState>['agentActivity']>

interface TeamExecutionPanelProps {
  taskBoard: LiveTaskBoard | null
  agentTabs: ReturnType<typeof useChatStore.getState>['agentTabs']
  activity: LiveAgentActivity | null
}

const runStatusLabel: Record<string, string> = {
  planning: '规划中',
  running: '执行中',
  synthesizing: '汇总中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const taskStatusLabel: Record<string, string> = {
  pending: '等待',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消',
}

function taskStatusClass(status: string) {
  if (status === 'running') return 'border-blue-200 bg-blue-50 text-blue-700'
  if (status === 'done') return 'border-green-200 bg-green-50 text-green-700'
  if (status === 'failed' || status === 'blocked') return 'border-red-200 bg-red-50 text-red-700'
  return 'border-neutral-200 bg-white text-neutral-500'
}

function taskStatusIcon(status: string) {
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-green-600" />
  if (status === 'failed' || status === 'blocked')
    return <XCircle className="h-4 w-4 text-red-600" />
  return <Clock3 className="h-4 w-4 text-neutral-400" />
}

const TeamExecutionPanel: FC<TeamExecutionPanelProps> = ({ taskBoard, agentTabs, activity }) => {
  const selectAgentTab = useChatStore((state) => state.selectAgentTab)

  if (!taskBoard) {
    return (
      <div className="mx-auto mt-4 w-full max-w-[var(--thread-max-width)] rounded-lg border border-blue-200 bg-blue-50/70 p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-blue-600 ring-1 ring-blue-100">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-neutral-900">
                {activity?.agentName ?? 'Orchestrator'} 正在规划
              </span>
              <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-xs text-blue-700">
                等待任务拆解
              </span>
            </div>
            <p className="mt-1 text-sm text-neutral-600">
              正在调用模型分析目标、成员能力和任务依赖。计划生成后会在这里展开任务、成员状态和子对话入口。
            </p>
          </div>
        </div>
      </div>
    )
  }

  const tasks = taskBoard.tasks
  const runningTasks = tasks.filter((task) => task.status === 'running')
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const failedCount = tasks.filter(
    (task) => task.status === 'failed' || task.status === 'blocked',
  ).length
  const artifactCount = tasks.reduce(
    (total, task) => total + (task.artifactCount ?? task.artifacts?.length ?? 0),
    0,
  )
  const completedLike =
    doneCount + failedCount + tasks.filter((task) => task.status === 'cancelled').length
  const progress = tasks.length > 0 ? Math.round((completedLike / tasks.length) * 100) : 0
  const visibleTasks = [
    ...runningTasks,
    ...tasks.filter((task) => task.status === 'pending'),
    ...tasks.filter((task) => task.status === 'done'),
    ...tasks.filter((task) => task.status === 'failed' || task.status === 'blocked'),
  ].slice(0, 6)

  return (
    <div className="mx-auto mt-4 w-full max-w-[var(--thread-max-width)] rounded-lg border border-neutral-200 bg-white shadow-sm">
      <div className="border-b border-neutral-100 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ListTodo className="h-4 w-4 text-blue-600" />
              <h3 className="truncate text-sm font-semibold text-neutral-900">
                {taskBoard.title || '团队任务'}
              </h3>
              <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                {runStatusLabel[taskBoard.status] ?? taskBoard.status}
              </span>
            </div>
            {taskBoard.goal && (
              <p className="mt-1 line-clamp-2 text-sm text-neutral-600">{taskBoard.goal}</p>
            )}
          </div>
          <div className="shrink-0 text-right text-xs text-neutral-500">
            <div>
              {doneCount}/{tasks.length} 完成
            </div>
            <div>{agentTabs.length || tasks.length} 个成员任务</div>
          </div>
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-100">
          <div
            className="h-full rounded-full bg-blue-600 transition-all duration-500"
            style={{ width: `${Math.max(4, progress)}%` }}
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-neutral-200 px-2 py-1 text-neutral-600">
            {runningTasks.length} 执行中
          </span>
          <span className="rounded-full border border-green-200 bg-green-50 px-2 py-1 text-green-700">
            {doneCount} 已完成
          </span>
          {failedCount > 0 && (
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-red-700">
              {failedCount} 异常
            </span>
          )}
          <span className="rounded-full border border-neutral-200 px-2 py-1 text-neutral-600">
            {artifactCount} 个产物
          </span>
        </div>
      </div>

      <div className="divide-y divide-neutral-100">
        {visibleTasks.map((task) => {
          const tab = agentTabs.find((item) => item.taskId === task.id)
          const canOpenChild = Boolean(tab?.childSessionId || task.childSessionId)
          const artifacts = task.artifactCount ?? task.artifacts?.length ?? 0
          return (
            <div key={task.id} className="flex items-start gap-3 p-3">
              <div className="mt-0.5">{taskStatusIcon(task.status)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-neutral-800">
                    {task.title}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${taskStatusClass(task.status)}`}
                  >
                    {taskStatusLabel[task.status] ?? task.status}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                  <span>{task.agentName || 'Agent'}</span>
                  {task.progressStatus && <span className="truncate">{task.progressStatus}</span>}
                  {artifacts > 0 && (
                    <span className="inline-flex items-center gap-1 text-neutral-600">
                      <FileText className="h-3.5 w-3.5" />
                      {artifacts} 个产物
                    </span>
                  )}
                </div>
                {task.outputSummary && (
                  <p className="mt-1 line-clamp-2 text-xs text-neutral-600">{task.outputSummary}</p>
                )}
              </div>
              <button
                type="button"
                disabled={!canOpenChild}
                onClick={() => canOpenChild && selectAgentTab(task.id)}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition',
                  canOpenChild
                    ? 'border-neutral-200 bg-white text-neutral-700 hover:border-blue-200 hover:text-blue-700'
                    : 'cursor-not-allowed border-neutral-100 bg-neutral-50 text-neutral-400',
                )}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                子对话
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const WorkspaceChildSessionDrawer: FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const session = useChatStore((state) => state.currentSession)
  const workspace = useChatStore((state) => state.currentWorkspace)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const selectSession = useChatStore((state) => state.selectSession)
  const agent = agents.find((item) => item.id === session?.workspaceAgentId)
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const usesCodingCli = agent?.runtimeType === 'code-agent'
  const [draft, setDraft] = useState({
    role: '',
    description: '',
    systemPrompt: '',
    modelId: '',
  })
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const modelChoices = models

  useEffect(() => {
    if (!open) return
    api
      .getSettings()
      .then((settings) => {
        if (!settings.MODEL_CATALOG) {
          setModels([])
          return
        }
        const parsed = JSON.parse(settings.MODEL_CATALOG) as ModelCatalogItem[]
        setModels(parsed.filter((item) => item.enabled))
      })
      .catch(() => setModels([]))
  }, [open])

  useEffect(() => {
    setDraft({
      role: agent?.role ?? '',
      description: agent?.description ?? '',
      systemPrompt: agent?.systemPrompt ?? '',
      modelId: agent?.modelId ?? '',
    })
    setSaveState('idle')
  }, [
    agent?.id,
    agent?.role,
    agent?.description,
    agent?.systemPrompt,
    agent?.modelId,
    agent?.runtimeType,
  ])

  async function saveAgentPatch(
    patch: Partial<Pick<WorkspaceAgent, 'role' | 'description' | 'systemPrompt' | 'modelId'>>,
  ) {
    if (!workspace || !agent || saveState === 'saving') return
    setSaveState('saving')
    try {
      await api.updateWorkspaceAgent(workspace.id, agent.id, patch)
      syncAgentLibraryFromWorkspaceAgent({ ...agent, ...patch })
      await flushAgentLibraryServerSync()
      if (session?.id) await selectSession(session.id)
      setSaveState('saved')
      window.setTimeout(() => setSaveState('idle'), 1400)
    } catch {
      setSaveState('error')
    }
  }

  function saveTextField(field: 'role' | 'description' | 'systemPrompt') {
    if (!agent) return
    const next = draft[field].trim()
    if (next === agent[field]) return
    void saveAgentPatch({ [field]: next })
  }

  function updateModel(modelId: string) {
    setDraft((current) => ({ ...current, modelId }))
    void saveAgentPatch({ modelId: modelId || null })
  }

  return (
    <div
      className={cn(
        'absolute inset-0 z-40 flex justify-end overflow-hidden transition',
        open ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="关闭会话详情"
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-black/5 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />
      <aside
        className={cn(
          'relative h-full w-[320px] max-w-[88vw] border-l border-neutral-200 bg-[#FBFBFB] shadow-none transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-4 py-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-neutral-950">
                {agent?.name ?? 'Agent 设置'}
              </div>
              <div className="mt-1 truncate text-xs text-neutral-500">
                {agent?.role ? `${agent.role} · 快捷配置` : '模型与系统提示词'}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm transition hover:bg-neutral-100 hover:text-neutral-950"
              title="关闭"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            <div className="flex items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-3">
              <div
                className="grid h-9 w-9 place-items-center rounded-xl text-sm font-semibold text-white"
                style={{ background: agent?.color ?? '#111827' }}
              >
                {(agent?.name?.slice(0, 1) || 'A').toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-neutral-950">
                  {agent?.name ?? session?.title ?? 'Agent'}
                </div>
                <div className="truncate text-xs text-neutral-500">
                  {agent?.role ?? '独立 Agent 会话'}
                </div>
              </div>
            </div>

            {agent && (
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between px-1">
                  <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Agent 配置
                  </div>
                  <AgentQuickSaveState state={saveState} />
                </div>

                {usesCodingCli ? (
                  <div className="rounded-2xl border border-neutral-200 bg-white p-3 text-xs leading-5 text-neutral-500">
                    <div className="font-medium text-neutral-900">模型</div>
                    <div className="mt-1">
                      模型、Base URL 和 API Key 由 Coding Tools 页面统一管理；这里仅维护 Agent
                      角色和提示词。
                    </div>
                  </div>
                ) : (
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-neutral-500">模型</span>
                    <select
                      value={draft.modelId}
                      onChange={(event) => updateModel(event.target.value)}
                      disabled={saveState === 'saving'}
                      className="h-9 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none transition focus:border-neutral-300 disabled:opacity-60"
                    >
                      <option value="">默认模型</option>
                      {modelChoices.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name || model.modelId}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1 block text-xs leading-5 text-neutral-400">
                      LLM Agent 可以单独覆盖默认模型。
                    </span>
                  </label>
                )}

                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-500">角色</span>
                  <input
                    value={draft.role}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, role: event.target.value }))
                    }
                    onBlur={() => saveTextField('role')}
                    className="h-9 w-full rounded-xl border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-neutral-300"
                    placeholder="例如：规划"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-500">简介</span>
                  <textarea
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, description: event.target.value }))
                    }
                    onBlur={() => saveTextField('description')}
                    rows={3}
                    className="min-h-20 w-full resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm leading-5 text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-neutral-300"
                    placeholder="这个 Agent 负责什么"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-neutral-500">
                    系统提示词
                  </span>
                  <textarea
                    value={draft.systemPrompt}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, systemPrompt: event.target.value }))
                    }
                    onBlur={() => saveTextField('systemPrompt')}
                    rows={6}
                    className="min-h-32 w-full resize-none rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm leading-5 text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-neutral-300"
                    placeholder="描述这个 Agent 的行为准则、输出风格和限制"
                  />
                </label>
              </div>
            )}

            {workspace?.projectPath && (
              <div className="mt-3 flex items-start gap-2 rounded-2xl border border-neutral-200 bg-white p-3 text-xs leading-5 text-neutral-500">
                <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" />
                <div className="min-w-0">
                  <div className="font-medium text-neutral-900">工作区</div>
                  <div className="mt-1 break-all font-mono">{workspace.projectPath}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

const AgentQuickSaveState: FC<{ state: 'idle' | 'saving' | 'saved' | 'error' }> = ({ state }) => {
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-neutral-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        保存中
      </span>
    )
  }
  if (state === 'saved') return <span className="text-xs text-emerald-600">已保存</span>
  if (state === 'error') return <span className="text-xs text-red-500">保存失败</span>
  return <span className="text-xs text-neutral-300">自动保存</span>
}

function syncAgentLibraryFromWorkspaceAgent(agent: WorkspaceAgent) {
  const library = loadAgentLibrary()
  const matched =
    library.find((item) => item.id === agent.id) ??
    library.find((item) => item.name === agent.name && item.role === agent.role) ??
    library.find((item) => item.roleType && item.roleType === agent.roleType)
  if (!matched) return
  saveAgentToLibrary(
    library,
    {
      ...toAgentConfigInput(matched),
      name: agent.name,
      role: agent.role,
      roleType: agent.roleType,
      description: agent.description,
      avatar: agent.avatar,
      systemPrompt: agent.systemPrompt,
      roleProfile: agent.roleProfile ?? null,
      color: agent.color,
      modelId: agent.modelId,
      runtimeType: agent.runtimeType,
      codeAgentType: agent.runtimeType === 'code-agent' ? agent.codeAgentType : null,
      capabilityTags: agent.capabilityTags,
      toolPermissions: agent.toolPermissions,
      sandboxPolicy: agent.sandboxPolicy,
      contextPolicy: agent.contextPolicy,
      autoInvoke: agent.autoInvoke,
      approvalRequired: agent.approvalRequired,
    },
    matched.id,
  )
}

const GroupChatDetailsPanel: FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const navigate = useNavigate()
  const session = useChatStore((state) => state.currentSession)
  const workspace = useChatStore((state) => state.currentWorkspace)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const messages = useChatStore((state) => state.messages)
  const selectSession = useChatStore((state) => state.selectSession)
  const deleteSession = useChatStore((state) => state.deleteSession)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const memberCount = agents.length + 1
  const groupTitle = session?.title || workspace?.name || 'Agent 群聊'
  const [titleDraft, setTitleDraft] = useState(groupTitle)
  const [libraryAgents, setLibraryAgents] = useState<SavedAgentConfig[]>([])
  const [inviteOpen, setInviteOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<'rename' | 'invite' | 'delete' | null>(null)

  useEffect(() => {
    setTitleDraft(groupTitle)
  }, [groupTitle])

  useEffect(() => {
    if (!open) return
    const syncAgents = () => setLibraryAgents(loadAgentLibrary())
    syncAgents()
    window.addEventListener(agentLibraryChangeEvent, syncAgents)
    window.addEventListener('storage', syncAgents)
    return () => {
      window.removeEventListener(agentLibraryChangeEvent, syncAgents)
      window.removeEventListener('storage', syncAgents)
    }
  }, [open])

  const inviteCandidates = libraryAgents.filter(
    (candidate) =>
      !agents.some((agent) => agent.name.toLowerCase() === candidate.name.toLowerCase()),
  )

  async function saveGroupTitle() {
    const next = titleDraft.trim() || 'Agent 群聊'
    if (!session || next === groupTitle || busyAction) return
    setBusyAction('rename')
    try {
      await api.updateSession(session.id, { title: next })
      if (workspace) await api.updateWorkspace(workspace.id, { name: next }).catch(() => undefined)
      await fetchSessions()
      await selectSession(session.id)
    } finally {
      setBusyAction(null)
    }
  }

  async function inviteAgent(agent: SavedAgentConfig) {
    if (!workspace || !session || busyAction) return
    setBusyAction('invite')
    try {
      await api.addWorkspaceAgent(workspace.id, toAgentConfigInput(agent))
      await selectSession(session.id)
      setInviteOpen(false)
    } finally {
      setBusyAction(null)
    }
  }

  async function deleteGroupChat() {
    if (!session || busyAction) return
    if (!window.confirm('确定删除这个群聊吗？')) return
    setBusyAction('delete')
    try {
      await deleteSession(session.id)
      await fetchSessions()
      onClose()
      navigate('/', { replace: true })
    } finally {
      setBusyAction(null)
    }
  }

  const monitorRows: AgentMonitorRowData[] = agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: `${agent.role} · ${agent.runtimeType}${agent.codeAgentType ? `/${agent.codeAgentType}` : ''}`,
      color: agent.color,
      mentionName: agent.name,
    }))
    .map((row) => {
      const live = isStreamingForAgent(streamingMessage, row.id, row.name)
      const latest = live
        ? streamingMessage?.content
        : latestAgentOutput(messages, row.id, row.name)
      return {
        ...row,
        active: live,
        bubble: latest ? lastOutputSnippet(latest, 20) : '',
      }
    })

  return (
    <div
      className={cn(
        'absolute inset-0 z-40 flex justify-end overflow-hidden transition',
        open ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="关闭群聊详情"
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-black/5 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />
      <aside
        className={cn(
          'relative h-full w-[340px] max-w-[88vw] border-l border-neutral-200 bg-[#FBFBFB] shadow-none transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-4 py-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-neutral-950">群聊设置</div>
              <div className="mt-1 truncate text-xs text-neutral-500">
                {workspace?.name ?? 'Agent 群聊'} · {memberCount} 位成员
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-neutral-500 shadow-sm transition hover:bg-neutral-100 hover:text-neutral-950"
              title="关闭"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto bg-[#FBFBFB] px-6 py-6">
            <div className="flex flex-col items-center text-center">
              <div className="relative h-20 w-20">
                <UserAvatar className="absolute left-1 top-3 h-12 w-12 ring-4 ring-[#FBFBFB]" />
                {agents.slice(0, 3).map((agent, index) => (
                  <div
                    key={agent.id}
                    className="absolute grid place-items-center overflow-hidden rounded-full text-sm font-semibold text-white ring-4 ring-[#FBFBFB]"
                    style={{
                      width: index === 0 ? 48 : 40,
                      height: index === 0 ? 48 : 40,
                      right: index === 0 ? 0 : index === 1 ? 10 : 28,
                      bottom: index === 0 ? 2 : index === 1 ? 0 : 10,
                      background: agent.color ?? '#2563eb',
                    }}
                  >
                    {agent.avatar ? (
                      <img
                        src={agent.avatar}
                        alt={agent.name}
                        className="h-full w-full bg-white object-contain"
                      />
                    ) : (
                      agent.name.slice(0, 1).toUpperCase()
                    )}
                  </div>
                ))}
              </div>
              <input
                data-agenthub-group-title-input="true"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void saveGroupTitle()}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  event.currentTarget.blur()
                }}
                disabled={busyAction === 'rename'}
                className="mt-4 h-9 max-w-[18rem] rounded-lg bg-transparent px-2 text-center text-base font-semibold text-neutral-950 outline-none transition focus:bg-white focus:ring-1 focus:ring-neutral-200 disabled:opacity-60"
              />
              <div className="mt-1 max-w-[18rem] truncate text-xs text-neutral-400">
                {workspace?.projectPath || `${memberCount} 位成员 · AgentHub 群聊`}
              </div>
            </div>

            <div className="relative mt-8 grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setInviteOpen((value) => !value)}
                className="flex h-[72px] flex-col items-center justify-center gap-2 rounded-2xl bg-[#F3F3F3] text-neutral-700 transition hover:bg-neutral-200/70"
              >
                <User className="h-5 w-5" />
                <span className="text-xs">邀请朋友</span>
              </button>
              <button
                type="button"
                onClick={() => setInviteOpen((value) => !value)}
                disabled={!workspace || busyAction === 'invite'}
                className="flex h-[72px] flex-col items-center justify-center gap-2 rounded-2xl bg-[#F3F3F3] text-neutral-700 transition hover:bg-neutral-200/70 disabled:opacity-50"
              >
                <Plus className="h-5 w-5" />
                <span className="text-xs">添加Agent</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  document
                    .querySelector<HTMLInputElement>('[data-agenthub-group-title-input="true"]')
                    ?.focus()
                }
                className="flex h-[72px] flex-col items-center justify-center gap-2 rounded-2xl bg-[#F3F3F3] text-neutral-700 transition hover:bg-neutral-200/70"
              >
                <Pencil className="h-5 w-5" />
                <span className="text-xs">编辑群信息</span>
              </button>
              {inviteOpen && (
                <div className="absolute left-0 right-0 top-[5rem] z-20 rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-xl">
                  {inviteCandidates.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => void inviteAgent(agent)}
                      disabled={busyAction === 'invite'}
                      className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-neutral-50 disabled:opacity-60"
                    >
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold text-white"
                        style={{ background: agent.color ?? '#111827' }}
                      >
                        {agent.avatar ? (
                          <img
                            src={agent.avatar}
                            alt={agent.name}
                            className="h-full w-full bg-white object-contain"
                          />
                        ) : (
                          agent.name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-neutral-900">
                          {agent.name}
                        </span>
                        <span className="block truncate text-xs text-neutral-500">
                          {agent.role}
                        </span>
                      </span>
                    </button>
                  ))}
                  {!inviteCandidates.length && (
                    <div className="px-3 py-4 text-center text-xs text-neutral-400">
                      没有可添加的 Agent
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-7">
              <div className="mb-2 px-4 text-xs text-neutral-500">人类</div>
              <div className="rounded-2xl bg-[#F3F3F3] px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-neutral-900 text-sm font-semibold text-white">
                    Y
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-neutral-950">You</span>
                      <MemberRolePill label="群主" tone="owner" />
                    </div>
                    <div className="mt-0.5 text-xs text-neutral-400">发起人与决策者</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="mb-2 px-4 text-xs text-neutral-500">Agent</div>
              <div className="overflow-hidden rounded-2xl bg-[#F3F3F3]">
                {monitorRows.map((row, index) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => insertComposerMention(row.mentionName)}
                    className={cn(
                      'relative flex min-h-[74px] w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-neutral-200/60',
                      index > 0 && 'border-t border-neutral-200',
                    )}
                  >
                    <span
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
                      style={{ background: row.color ?? '#2563eb' }}
                    >
                      {row.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span
                      className={cn(
                        'absolute left-11 top-[2.85rem] h-2 w-2 rounded-full ring-2 ring-[#F3F3F3]',
                        row.active ? 'bg-emerald-500' : 'bg-neutral-300',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-neutral-950">
                          {row.name}
                        </span>
                        <MemberRolePill color={row.color} label={row.role} />
                      </span>
                      <span className="mt-1 block truncate text-xs text-neutral-400">
                        {row.active && row.bubble ? row.bubble : `@${row.mentionName}`}
                      </span>
                    </span>
                  </button>
                ))}
                {!monitorRows.length && (
                  <div className="px-4 py-6 text-center text-xs text-neutral-400">
                    还没有 Agent，点击上方添加。
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void deleteGroupChat()}
              disabled={busyAction === 'delete'}
              className="mt-5 flex h-11 w-full items-center justify-center rounded-xl bg-[#F3F3F3] text-sm font-medium text-red-500 transition hover:bg-red-50 disabled:opacity-60"
            >
              {busyAction === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : '解散群聊'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}

type AgentMonitorRowData = {
  id: string
  name: string
  role: string
  color?: string
  mentionName: string
  active: boolean
  bubble: string
}

function isStreamingForAgent(
  streaming: { id: string; content: string; agentId?: string; agentName?: string } | null,
  id: string,
  name: string,
) {
  if (!streaming) return false
  return streaming.agentId === id || streaming.agentName?.toLowerCase() === name.toLowerCase()
}

function latestAgentOutput(
  messages: Array<{
    senderType: string
    senderId: string
    content: string
    metadata: Record<string, unknown> | null
  }>,
  id: string,
  name: string,
) {
  for (const message of [...messages].reverse()) {
    if (message.senderType !== 'agent') continue
    const agentName =
      typeof message.metadata?.agentName === 'string' ? message.metadata.agentName : ''
    if (message.senderId === id || agentName.toLowerCase() === name.toLowerCase())
      return message.content
  }
  return ''
}

function lastOutputSnippet(content: string, maxLength: number) {
  const text = content.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return text.slice(-maxLength)
}

const MemberRolePill: FC<{ color?: string | null; label: string; tone?: 'agent' | 'owner' }> = ({
  color,
  label,
  tone = 'agent',
}) => {
  const accent = tone === 'owner' ? '#111827' : color || '#737373'
  return (
    <span
      className={cn(
        'inline-flex h-5 max-w-[7.75rem] shrink min-w-0 items-center gap-1.5 rounded-full border bg-white/75 px-2 text-[11px] leading-none text-neutral-600 shadow-[0_1px_0_rgba(15,23,42,0.03)]',
        tone === 'owner' && 'border-neutral-200 bg-white text-neutral-700',
      )}
      style={tone === 'agent' ? { borderColor: `${accent}24` } : undefined}
      title={label}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent }} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}

function insertComposerMention(name: string) {
  const value = `@${name} `
  insertTextIntoComposer(value)
}

function insertTextIntoComposer(
  value: string,
  inputType = 'insertText',
  range?: { start: number; end: number },
) {
  const input = document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
  if (!input) {
    void navigator.clipboard?.writeText(value).catch(() => undefined)
    return null
  }
  const start = range?.start ?? input.selectionStart ?? input.value.length
  const end = range?.end ?? input.selectionEnd ?? input.value.length
  input.focus()
  input.setSelectionRange(start, end)
  input.setRangeText(value, start, end, 'end')
  dispatchComposerInput(input, value, inputType)
  return input
}

function replaceTextRangeInComposer(value: string, range: { start: number; end: number }) {
  return insertTextIntoComposer(value, 'insertReplacementText', range)
}

export function readMentionCommand(text: string, cursor: number) {
  const before = text.slice(0, cursor)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
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

function dispatchComposerInput(input: HTMLTextAreaElement, data: string, inputType = 'insertText') {
  try {
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }))
  } catch {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  window.dispatchEvent(
    new CustomEvent(composerSyncEvent, {
      detail: { value: input.value, scrollTop: input.scrollTop },
    }),
  )
}

const ThreadWelcome: FC = () => {
  const loadingMessages = useChatStore((state) => state.loadingMessages)

  return (
    <ThreadPrimitive.Empty>{!loadingMessages && <ThreadWelcomeContent />}</ThreadPrimitive.Empty>
  )
}

const ThreadWelcomeContent: FC = () => {
  const { t } = useI18n()
  const [quickPrompts, setQuickPrompts] = useState<WelcomeQuickPrompt[]>([])
  const [quickPromptsLoading, setQuickPromptsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const seed = createQuickPromptSeed('thread')
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

  return (
    <div className="mx-auto flex min-h-[calc(100vh-15rem)] w-full max-w-[58rem] flex-col justify-center py-10 text-center">
      <div>
        <h2 className="text-2xl font-semibold tracking-normal text-neutral-950">
          <TypewriterHeading text={t('有什么可以帮忙的？')} />
        </h2>
      </div>
      <QuickPromptBubbles
        className="mt-8"
        loading={quickPromptsLoading}
        prompts={quickPrompts}
        onPick={(prompt) => insertTextIntoComposer(prompt)}
      />
    </div>
  )
}

const Composer: FC = () => {
  const { sendMode } = useShortcutSettings()
  const { t } = useI18n()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const currentWorkspace = useChatStore((state) => state.currentWorkspace)
  const workspaceAgents = useChatStore((state) => state.currentWorkspaceAgents)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const setSessionWorkspace = useChatStore((state) => state.setSessionWorkspace)
  const pendingAttachments = useChatStore((state) => state.pendingAttachments)
  const addPendingAttachments = useChatStore((state) => state.addPendingAttachments)
  const removePendingAttachment = useChatStore((state) => state.removePendingAttachment)
  const [menu, setMenu] = useState<'tools' | 'agents' | 'workspace' | null>(null)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillPanelOpen, setSkillPanelOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [skillCommandRange, setSkillCommandRange] = useState<{ start: number; end: number } | null>(
    null,
  )
  const [agentMenuMode, setAgentMenuMode] = useState<'manual' | 'mention' | null>(null)
  const [agentMentionRange, setAgentMentionRange] = useState<{
    start: number
    end: number
    query: string
  } | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [openingWorkspaceId, setOpeningWorkspaceId] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [composerText, setComposerText] = useState('')
  const [composerScrollTop, setComposerScrollTop] = useState(0)
  const currentProjectWorkspace =
    currentWorkspace && isProjectWorkspace(currentWorkspace) ? currentWorkspace : null

  useEffect(() => {
    if (menu !== 'workspace') return
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
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    )
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

  function replaceComposerTextRange(value: string, range: { start: number; end: number }) {
    const input = replaceTextRangeInComposer(value, range)
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
    const mention = readMentionCommand(nextText, cursor)
    setComposerText(nextText)
    setComposerScrollTop(input.scrollTop)
    if (command) {
      setMenu(null)
      setAgentMenuMode(null)
      setAgentMentionRange(null)
      setSkillQuery(command.query)
      setSkillCommandRange({ start: command.start, end: command.end })
      setSkillPanelOpen(true)
    } else if (mention) {
      setSkillPanelOpen(false)
      setSkillCommandRange(null)
      setSkillQuery('')
      setAgentMentionRange(mention)
      setAgentMenuMode('mention')
      setMenu('agents')
    } else {
      setSkillPanelOpen(false)
      setSkillCommandRange(null)
      setSkillQuery('')
      setAgentMentionRange(null)
      if (agentMenuMode === 'mention') {
        setAgentMenuMode(null)
        setMenu((current) => (current === 'agents' ? null : current))
      }
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
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertReplacementText',
        data: reference,
      }),
    )
    setComposerText(input.value)
    setComposerScrollTop(input.scrollTop)
    setSkillPanelOpen(false)
    setSkillCommandRange(null)
    setSkillQuery('')
    showHint(`已选择 Skill：${skill.name || skill.id}`)
  }

  async function openWorkspace(workspaceId: string) {
    if (workspaceBusy || !currentSessionId) return
    setWorkspaceBusy(true)
    setOpeningWorkspaceId(workspaceId)
    showHint('正在选择工作区...')
    try {
      await setSessionWorkspace(currentSessionId, workspaceId)
      setMenu(null)
      await fetchSessions()
      showHint('工作区已应用到当前会话')
    } catch (err) {
      showHint(friendlyErrorMessage(err, '选择工作区失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
  }

  async function createBlankWorkspace() {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    try {
      const full = await api.createAutoWorkspace({
        name: '新工作空间',
        goal: '',
      })
      setWorkspaces((items) => [
        full.workspace,
        ...items.filter((item) => item.id !== full.workspace.id),
      ])
      setOpeningWorkspaceId(full.workspace.id)
      if (currentSessionId) await setSessionWorkspace(currentSessionId, full.workspace.id)
      setMenu(null)
      await fetchSessions()
      showHint('已创建并应用工作区')
    } catch (err) {
      showHint(friendlyErrorMessage(err, '创建工作区失败'))
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
      if (currentSessionId) await setSessionWorkspace(currentSessionId, workspace.id)
      setMenu(null)
      await fetchSessions()
      showHint('工作区已应用到当前会话')
    } catch (err) {
      showHint(friendlyErrorMessage(err, '处理工作区失败'))
    } finally {
      setWorkspaceBusy(false)
      setOpeningWorkspaceId(null)
    }
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
        <div className="relative rounded-3xl border border-neutral-200 bg-white p-3 focus-within:border-neutral-300">
          {menu && (
            <ComposerMenu
              key={menu}
              type={menu}
              agents={workspaceAgents}
              agentQuery={agentMenuMode === 'mention' ? (agentMentionRange?.query ?? '') : ''}
              workspaces={workspaces}
              currentWorkspaceId={currentProjectWorkspace?.id ?? null}
              openingWorkspaceId={openingWorkspaceId}
              workspaceBusy={workspaceBusy}
              planMode={planMode}
              onOpenWorkspace={(workspaceId) => void openWorkspace(workspaceId)}
              onCreateBlankWorkspace={() => void createBlankWorkspace()}
              onOpenFolderWorkspace={() => void openFolderFromComposer()}
              onPlanMode={(next) => {
                setPlanMode(next)
                showHint(next ? '已开启计划模式' : '已关闭计划模式')
              }}
              onPick={(value) => {
                const mentionRange = agentMenuMode === 'mention' ? agentMentionRange : null
                if (mentionRange) {
                  replaceComposerTextRange(`${value} `, mentionRange)
                  setAgentMentionRange(null)
                  setAgentMenuMode(null)
                } else {
                  insertComposerText(`${value} `)
                }
                showHint(`已插入 ${value}`)
              }}
              onClose={() => {
                setMenu(null)
                setAgentMenuMode(null)
                setAgentMentionRange(null)
              }}
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
          {hint && (
            <div className="absolute -top-9 left-4 rounded-full bg-neutral-900 px-3 py-1 text-xs text-white shadow">
              {hint}
            </div>
          )}
          {pendingAttachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="group relative h-16 w-16 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50"
                >
                  <img
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="h-full w-full object-cover"
                  />
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
                } else if (event.key === 'Escape' && menu) {
                  event.preventDefault()
                  setMenu(null)
                  setAgentMenuMode(null)
                  setAgentMentionRange(null)
                } else if (
                  event.key === 'Enter' &&
                  menu === 'agents' &&
                  agentMenuMode === 'mention'
                ) {
                  event.preventDefault()
                }
              }}
              onScroll={(event) => setComposerScrollTop(event.currentTarget.scrollTop)}
              className={cn(
                'relative max-h-[180px] min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-neutral-400',
                composerText ? 'text-transparent caret-neutral-950' : 'text-neutral-950',
              )}
            />
          </div>
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-1">
              <ComposerToolButton
                aria-label="添加"
                onClick={() => setMenu(menu === 'tools' ? null : 'tools')}
              >
                <Plus className="h-4 w-4" />
              </ComposerToolButton>
              <ComposerToolButton
                aria-label="选择工作区"
                title={currentProjectWorkspace ? currentProjectWorkspace.name : '选择工作区'}
                onClick={() => setMenu(menu === 'workspace' ? null : 'workspace')}
                className={cn(
                  (currentProjectWorkspace || menu === 'workspace') && 'agenthub-icon-button-open',
                )}
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
              <ComposerToolButton
                aria-label="提及"
                onClick={() => {
                  const nextOpen = menu !== 'agents'
                  setMenu(nextOpen ? 'agents' : null)
                  setAgentMenuMode(nextOpen ? 'manual' : null)
                  setAgentMentionRange(null)
                  setSkillPanelOpen(false)
                }}
              >
                <AtSign className="h-4 w-4" />
              </ComposerToolButton>
            </div>
            <div className="flex items-center gap-2">
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
      `${skill.name} ${skill.id} ${skill.description} ${skill.source}`
        .toLowerCase()
        .includes(normalizedQuery),
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
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-neutral-950 text-xs font-semibold text-white">
            /
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-neutral-950">选择 Skill</div>
            <div className="truncate text-xs text-neutral-500">
              {normalizedQuery ? `筛选：${query}` : '已安装技能'}
            </div>
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
                  <span className="truncate font-medium text-neutral-950">
                    {skill.name || skill.id}
                  </span>
                  <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-normal text-neutral-500">
                    {skill.source || 'local'}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-neutral-500">
                  {skill.description || skill.id}
                </span>
                <span className="mt-1 block truncate font-mono text-[11px] text-neutral-400">
                  ${skill.id}
                </span>
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
  type: 'tools' | 'agents' | 'workspace'
  agents: WorkspaceAgent[]
  agentQuery?: string
  workspaces: Workspace[]
  currentWorkspaceId: string | null
  openingWorkspaceId: string | null
  workspaceBusy: boolean
  planMode: boolean
  onOpenWorkspace: (workspaceId: string) => void
  onCreateBlankWorkspace: () => void
  onOpenFolderWorkspace: () => void
  onPlanMode: (enabled: boolean) => void
  onPick: (value: string) => void
  onClose: () => void
}> = ({
  type,
  agents,
  agentQuery = '',
  workspaces,
  currentWorkspaceId,
  openingWorkspaceId,
  workspaceBusy,
  planMode,
  onOpenWorkspace,
  onCreateBlankWorkspace,
  onOpenFolderWorkspace,
  onPlanMode,
  onPick,
  onClose,
}) => {
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const normalizedAgentQuery = agentQuery.trim().toLowerCase()
  const agentRows = agents.map((agent) => ({
    title: `@${agent.name}`,
    desc: `${agent.role} · ${agent.runtimeType}${agent.codeAgentType ? `/${agent.codeAgentType}` : ''}${(agent.capabilityTags ?? []).length ? ` · ${(agent.capabilityTags ?? []).slice(0, 3).join(', ')}` : ''}`,
    color: agent.color ?? '#111827',
  }))
  const filteredAgentRows = normalizedAgentQuery
    ? agentRows.filter((item) =>
        `${item.title} ${item.desc}`.toLowerCase().includes(normalizedAgentQuery),
      )
    : agentRows
  const plugins = [
    { title: 'Documents', icon: FileText, color: 'text-blue-500', value: '@documents' },
    { title: 'Spreadsheets', icon: Sheet, color: 'text-emerald-600', value: '@spreadsheets' },
    {
      title: 'Presentations',
      icon: Presentation,
      color: 'text-amber-500',
      value: '@presentations',
    },
    { title: '浏览器', icon: Globe2, color: 'text-sky-500', value: '@browser' },
  ]
  const filteredWorkspaces = workspaces.filter((workspace) => {
    const query = workspaceQuery.trim().toLowerCase()
    if (!query) return true
    return workspaceSearchText(workspace).includes(query)
  })

  return (
    <div
      className={cn(
        'agenthub-menu-popover absolute bottom-[4.5rem] z-20 rounded-2xl border border-neutral-200 bg-white p-1.5 text-sm shadow-xl',
        'left-3',
        type === 'workspace' ? 'w-80' : 'w-64',
      )}
    >
      {type === 'tools' && (
        <div className="relative group/tools">
          <button
            type="button"
            onClick={() => onPlanMode(!planMode)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-neutral-50"
          >
            <ListTodo className="h-4 w-4 text-neutral-500" />
            <span className="flex-1 text-neutral-900">计划模式</span>
            <span
              className={cn(
                'relative h-4 w-8 rounded-full transition',
                planMode ? 'bg-neutral-900' : 'bg-neutral-200',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-3 w-3 rounded-full bg-white transition',
                  planMode ? 'left-4' : 'left-0.5',
                )}
              />
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
      {type === 'agents' && (
        <div className="max-h-72 overflow-y-auto">
          {agentQuery !== '' && (
            <div className="px-3 pb-1 pt-1 text-xs text-neutral-400">
              {filteredAgentRows.length ? `匹配：${agentQuery}` : `没有匹配：${agentQuery}`}
            </div>
          )}
          {filteredAgentRows.map((item) => (
            <MenuRow
              key={item.title}
              title={item.title}
              desc={item.desc}
              color={item.color}
              onClick={() => {
                onPick(item.title)
                onClose()
              }}
            />
          ))}
          {filteredAgentRows.length === 0 && (
            <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-6 text-center text-xs text-neutral-400">
              没有匹配的 Agent
            </div>
          )}
        </div>
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
              placeholder="搜索工作区"
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
                  'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-neutral-50 disabled:opacity-60',
                  (workspace.id === currentWorkspaceId || workspace.id === openingWorkspaceId) &&
                    'bg-neutral-100',
                )}
              >
                <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-neutral-900">{workspace.name}</span>
                  <span className="block truncate text-[11px] text-neutral-400">
                    {workspaceSubtitle(workspace)}
                  </span>
                </span>
                {workspace.id === openingWorkspaceId ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />
                ) : (
                  workspace.id === currentWorkspaceId && (
                    <ChevronDown className="h-4 w-4 shrink-0 text-neutral-300" />
                  )
                )}
              </button>
            ))}
            {!workspaceBusy && filteredWorkspaces.length === 0 && (
              <div className="rounded-xl border border-dashed border-neutral-200 px-3 py-5 text-center text-xs text-neutral-400">
                没有匹配的工作区
              </div>
            )}
            {workspaceBusy && (
              <div className="px-2.5 py-2 text-xs text-neutral-400">正在处理工作区...</div>
            )}
          </div>
          <div className="mt-1 border-t border-neutral-200 pt-1.5">
            <div className="mb-1 flex items-center justify-between gap-2 px-2">
              <span className="text-xs font-medium text-neutral-400">工作空间来源</span>
              <button
                type="button"
                onClick={requestSettingsDialog}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
                aria-label="前往系统设置"
                title="可前往「系统设置」设置默认工作空间存储路径"
              >
                <CircleHelp className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={onCreateBlankWorkspace}
              disabled={workspaceBusy}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-50 disabled:opacity-60"
            >
              <FolderPlus className="h-4 w-4 shrink-0 text-neutral-600" />
              <span className="min-w-0 flex-1 truncate">从新工作空间开始</span>
              {!currentWorkspaceId && <Check className="h-4 w-4 shrink-0 text-emerald-500" />}
            </button>
            <button
              type="button"
              onClick={onOpenFolderWorkspace}
              disabled={workspaceBusy}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-neutral-900 hover:bg-neutral-50 disabled:opacity-60"
            >
              <FolderOpen className="h-4 w-4 shrink-0 text-neutral-600" />
              <span className="min-w-0 flex-1 truncate">打开本地工作空间</span>
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

const MenuRow: FC<{ title: string; desc: string; color?: string; onClick: () => void }> = ({
  title,
  desc,
  color = '#111827',
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left hover:bg-neutral-50"
  >
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
      style={{ background: color }}
    >
      {mentionInitial(title)}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium text-neutral-900">{title}</span>
      <span className="block truncate text-xs text-neutral-500">{desc}</span>
    </span>
  </button>
)

function mentionInitial(title: string) {
  return title.replace(/^@/, '').trim().slice(0, 1).toUpperCase() || '@'
}

const ComposerAction: FC = () => (
  <>
    <ThreadPrimitive.If running={false}>
      <ComposerPrimitive.Send asChild>
        <button
          className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-700 disabled:pointer-events-none disabled:bg-neutral-200"
          aria-label="发送"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </ComposerPrimitive.Send>
    </ThreadPrimitive.If>
    <ThreadPrimitive.If running>
      <ComposerPrimitive.Cancel asChild>
        <button
          className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white"
          aria-label="停止生成"
        >
          <Square className="h-3.5 w-3.5" />
        </button>
      </ComposerPrimitive.Cancel>
    </ThreadPrimitive.If>
  </>
)

const UserMessage: FC = () => {
  const messageId = useMessage((message) => message.id)
  const sourceMessage = useChatStore((state) =>
    state.messages.find((message) => message.id === messageId),
  )
  const editMessage = useChatStore((state) => state.editMessage)
  const withdrawMessage = useChatStore((state) => state.withdrawMessage)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'edit' | 'withdraw' | null>(null)
  const canEdit = Boolean(sourceMessage?.senderType === 'user')
  const text =
    typeof sourceMessage?.metadata?.displayContent === 'string'
      ? sourceMessage.metadata.displayContent
      : (sourceMessage?.content ?? '')

  function startEdit(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault()
    event?.stopPropagation()
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

  async function withdraw(event?: React.MouseEvent<HTMLButtonElement>) {
    event?.preventDefault()
    event?.stopPropagation()
    if (!sourceMessage) return
    const ok = window.confirm('撤回这条消息？如果后续 Agent 产生了文件修改，将尝试一并回滚。')
    if (!ok) return
    setBusy('withdraw')
    try {
      const rollback = await withdrawMessage(sourceMessage.id)
      if (rollback?.failed) {
        window.alert(
          `消息已撤回，但有 ${rollback.failed} 个文件变更未能自动回滚，请检查 git diff。`,
        )
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <MessagePrimitive.Root className="group mx-auto flex w-full max-w-[var(--thread-max-width)] items-start justify-end gap-3 py-3">
      <div className={cn('flex flex-col items-end gap-1.5', editing ? 'min-w-0 flex-1' : 'max-w-[68%]')}>
        <div
          className={cn(
            'w-full text-sm leading-6 text-neutral-900',
            editing
              ? 'min-h-36 rounded-[28px] bg-[#f4f4f4] px-4 pb-4 pt-3'
              : 'rounded-[18px] bg-[#f1f1f1] px-5 py-2.5 shadow-none',
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
            <ToolButton
              type="button"
              aria-label="修改"
              title="修改"
              onClick={startEdit}
              disabled={Boolean(busy)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </ToolButton>
            <ToolButton
              type="button"
              aria-label="撤回"
              title="撤回并尝试回滚修改"
              onClick={withdraw}
              disabled={Boolean(busy)}
            >
              {busy === 'withdraw' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </ToolButton>
          </div>
        )}
        {sourceMessage?.createdAt && (
          <div className="pr-1 text-[11px] text-neutral-400">
            {formatTime(sourceMessage.createdAt)}
          </div>
        )}
      </div>
      <Avatar role="user" />
    </MessagePrimitive.Root>
  )
}

function formatTime(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

const AssistantMessage: FC = () => {
  const messageId = useMessage((message) => message.id)
  const createdAt = useChatStore(
    (state) => state.messages.find((message) => message.id === messageId)?.createdAt,
  )
  return (
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
                  task_board: TaskBoardCard,
                  code_agent_run: CodeAgentRunCard,
                  agent_artifacts: AgentArtifactsCard,
                  chat_attachments: ChatAttachmentsPart,
                  clarification_card: ClarificationCardWrapper,
                  file_card: FileCardMessage,
                  delivery_report: DeliveryReportMessage,
                },
              },
            }}
          />
        </div>
        <AssistantActionBar />
        <BranchPicker />
        {createdAt && (
          <div className="mt-1 text-[11px] text-neutral-400">{formatTime(createdAt)}</div>
        )}
      </div>
    </MessagePrimitive.Root>
  )
}

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

function ClarificationCardWrapper({ data }: { data: any }) {
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessionId = currentSessionId || ''

  return (
    <ClarificationCard
      question={data?.question || ''}
      options={data?.options}
      messageId={data?.messageId || ''}
      taskId={data?.taskId || ''}
      sessionId={sessionId}
    />
  )
}

interface FileCardEntry {
  fileName: string
  filePath: string
  fileSize?: number
  runId: string
}

function FileCardMessage({ data }: { data?: { files?: FileCardEntry[] } | null }) {
  const files = data?.files
  if (!files || files.length === 0) return null

  return (
    <div className="not-prose mt-3 space-y-2">
      {files.map((file) => (
        <FileCard
          key={file.fileName}
          fileName={file.fileName}
          filePath={file.filePath}
          fileSize={file.fileSize}
          runId={file.runId}
        />
      ))}
    </div>
  )
}

function DeliveryReportMessage({ data }: { data?: DeliveryReportData | null }) {
  if (!data) return null
  return <DeliveryReport data={data} />
}

function requestArtifactPreview(item: ArtifactPreviewItem) {
  window.dispatchEvent(new CustomEvent<ArtifactPreviewItem>(artifactPreviewEvent, { detail: item }))
}

const ChatAttachmentsPart: FC<{ data: { items?: ChatAttachment[] } }> = ({ data }) => {
  const items = Array.isArray(data.items) ? data.items : []
  if (!items.length) return null
  return (
    <div className="not-prose mt-3 grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() =>
            requestArtifactPreview({
              id: item.id,
              kind: 'image',
              mimeType: item.mimeType,
              subtitle: `${formatBytes(item.size)} · 图片附件`,
              title: item.name,
              url: item.dataUrl,
            })
          }
          className="group overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm"
        >
          <img
            src={item.dataUrl}
            alt={item.name}
            className="aspect-video w-full bg-neutral-100 object-cover transition group-hover:scale-[1.015]"
          />
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500">
            <ImagePlus className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

const ArtifactPreviewPanel: FC<{ item: ArtifactPreviewItem; onClose: () => void }> = ({
  item,
  onClose,
}) => {
  const canOpen = Boolean(item.url)
  const [maximized, setMaximized] = useState(false)
  const [visible, setVisible] = useState(false)
  const [panelWidth, setPanelWidth] = useState(() => readStoredPreviewPanelWidth())
  const [resizing, setResizing] = useState(false)
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    item.kind === 'web' || item.kind === 'deploy' ? 'loading' : 'ready',
  )
  const [loadError, setLoadError] = useState('')
  const [actionPanelOpen, setActionPanelOpen] = useState(false)
  const [actionItems, setActionItems] = useState<PreviewActionItem[]>([])
  const [reloadToken, setReloadToken] = useState(0)
  const panelRef = useRef<HTMLElement | null>(null)
  const panelWidthRef = useRef(panelWidth)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewUrl = useMemo(() => normalizePreviewUrl(item.url), [item.url])

  useEffect(() => {
    panelWidthRef.current = panelWidth
  }, [panelWidth])

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  function handleClose() {
    setVisible(false)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(onClose, 240)
  }

  function handleResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (maximized) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect

    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function commitPanelWidth(clientX: number) {
      const containerRect = panelRef.current?.parentElement?.getBoundingClientRect()
      const rawWidth = containerRect ? containerRect.right - clientX : window.innerWidth - clientX
      const nextWidth = clampPreviewPanelWidth(
        rawWidth,
        getPreviewPanelWidthBounds(panelRef.current),
      )
      panelWidthRef.current = nextWidth
      setPanelWidth(nextWidth)
    }

    commitPanelWidth(event.clientX)

    function handlePointerMove(moveEvent: PointerEvent) {
      moveEvent.preventDefault()
      commitPanelWidth(moveEvent.clientX)
    }

    function handlePointerUp() {
      setResizing(false)
      storePreviewPanelWidth(panelWidthRef.current)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('pointercancel', handlePointerUp)
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp, { once: true })
    document.addEventListener('pointercancel', handlePointerUp, { once: true })
  }

  function pushActionItem(item: Omit<PreviewActionItem, 'id'>) {
    const id = `${item.kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    setActionItems((items) => [{ ...item, id }, ...items].slice(0, 8))
    setActionPanelOpen(true)
    return id
  }

  function updateActionItem(id: string, patch: Partial<PreviewActionItem>) {
    setActionItems((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
    setActionPanelOpen(true)
  }

  async function handleOpenDownloadedPath(path?: string) {
    if (!path) return
    try {
      const opened = await openPath(path)
      if (!opened) return
    } catch (error) {
      pushActionItem({
        kind: 'open',
        status: 'error',
        title: '打开失败',
        detail: formatPreviewError(error),
      })
    }
  }

  async function handleOpenInNewWindow() {
    if (!item.url) return
    const resolvedUrl = normalizePreviewUrl(item.url)?.href ?? item.url
    const desktopApp = isDesktopApp()
    const actionId = pushActionItem({
      kind: 'open',
      status: 'working',
      title: item.title,
      detail: desktopApp ? '正在打开外部浏览器窗口...' : '正在打开新窗口...',
    })
    try {
      const openedNative = await openExternalUrl(resolvedUrl)
      if (openedNative) {
        updateActionItem(actionId, {
          status: 'success',
          detail: '已请求系统浏览器打开新窗口',
        })
        return
      }
    } catch (error) {
      console.warn('[AgentHub] Failed to open external preview URL:', error)
      if (desktopApp) {
        try {
          const openedPreviewWindow = await openUrlWindow(resolvedUrl)
          if (openedPreviewWindow) {
            updateActionItem(actionId, {
              status: 'success',
              detail: '外部浏览器命令不可用，已打开独立预览窗口',
            })
            return
          }
        } catch (fallbackError) {
          console.warn('[AgentHub] Failed to open native preview window:', fallbackError)
        }
        const detail =
          formatPreviewError(error) ||
          '请确认系统已安装并设置默认浏览器，或重启客户端加载最新桌面命令。'
        updateActionItem(actionId, {
          status: 'error',
          detail: `无法打开外部浏览器窗口：${detail}`,
        })
        await notifyUser('无法打开外部浏览器窗口', detail).catch(() => undefined)
        return
      }
    }
    window.open(resolvedUrl, '_blank', 'noopener,noreferrer')
    updateActionItem(actionId, {
      status: 'success',
      detail: '已交给浏览器打开新窗口',
    })
  }

  async function handleDownload() {
    if (!item.url) return
    const resolvedUrl = normalizePreviewUrl(item.url)?.href ?? item.url
    const filename = downloadFileName(item)
    const desktopApp = isDesktopApp()
    const actionId = pushActionItem({
      kind: 'download',
      status: 'working',
      title: filename,
      detail: desktopApp ? '正在保存到系统下载目录...' : '正在准备下载...',
    })

    try {
      if (desktopApp) {
        let nativeDownloadError: unknown = null
        const result = await downloadExternalUrl(resolvedUrl, filename).catch((error) => {
          nativeDownloadError = error
          return null
        })
        if (result) {
          updateActionItem(actionId, {
            status: 'success',
            title: result.fileName,
            detail: '已保存到下载目录',
            path: result.path,
            folder: result.folder,
          })
          await notifyUser('下载完成', result.fileName).catch(() => undefined)
          return
        }
        console.warn(
          '[AgentHub] Native download failed, falling back to browser download:',
          nativeDownloadError,
        )
      }

      const response = await fetch(resolvedUrl, { credentials: 'include' })
      if (!response.ok) throw new Error(await extractPreviewErrorMessage(response))

      const blob = await response.blob()
      const blobUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = filename
      link.rel = 'noreferrer'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)

      updateActionItem(actionId, {
        status: 'success',
        detail: desktopApp ? '客户端下载命令不可用，已使用浏览器下载' : '浏览器已开始下载',
      })
    } catch (error) {
      const message = formatPreviewError(error)
      updateActionItem(actionId, {
        status: 'error',
        detail: `下载失败：${message}`,
      })
      if (desktopApp) await notifyUser('下载失败', message).catch(() => undefined)
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (maximized) setMaximized(false)
        else handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [maximized])

  useEffect(() => {
    function syncPanelWidth() {
      setPanelWidth((width) => {
        const bounds = getPreviewPanelWidthBounds(panelRef.current)
        const nextWidth = clampPreviewPanelWidth(width, bounds)
        panelWidthRef.current = nextWidth
        storePreviewPanelWidth(nextWidth)
        return nextWidth
      })
    }

    syncPanelWidth()
    window.addEventListener('resize', syncPanelWidth)
    return () => window.removeEventListener('resize', syncPanelWidth)
  }, [])

  useEffect(() => {
    if (!item.url || (item.kind !== 'web' && item.kind !== 'deploy')) {
      setLoadingState('ready')
      setLoadError('')
      return
    }

    let cancelled = false
    setLoadingState('loading')
    setLoadError('')

    async function probePreview() {
      if (!previewUrl || previewUrl.origin !== window.location.origin) {
        if (!cancelled) setLoadingState('ready')
        return
      }

      try {
        const response = await fetch(previewUrl.href, { credentials: 'include' })
        if (cancelled) return
        if (!response.ok) throw new Error(await extractPreviewErrorMessage(response))
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          throw new Error(await extractPreviewErrorMessage(response))
        }
        setLoadingState('ready')
      } catch (error) {
        if (cancelled) return
        setLoadingState('error')
        setLoadError(formatPreviewError(error))
      }
    }

    void probePreview()
    return () => {
      cancelled = true
    }
  }, [item.kind, item.url, previewUrl, reloadToken])

  const panelClasses = cn(
    'relative flex shrink-0 flex-col overflow-hidden border-neutral-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.12)]',
    resizing ? 'transition-none' : 'transition-all duration-300 ease-out',
    maximized ? 'fixed inset-3 z-50 rounded-2xl border' : 'border-l',
    visible ? 'translate-x-0 scale-100 opacity-100' : 'translate-x-4 scale-[0.985] opacity-0',
  )

  return (
    <>
      {maximized && (
        <button
          type="button"
          aria-label="Close preview overlay"
          onClick={handleClose}
          className={cn(
            'fixed inset-0 z-40 bg-slate-950/20 backdrop-blur-[1px] transition-opacity duration-300',
            visible ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
      {resizing && (
        <div
          className="fixed inset-0 z-40 cursor-col-resize select-none bg-transparent"
          aria-hidden="true"
        />
      )}
      <aside
        ref={panelRef}
        className={panelClasses}
        style={maximized ? undefined : { width: panelWidth }}
      >
        {!maximized && (
          <button
            type="button"
            aria-label="Resize preview panel"
            onPointerDown={handleResizeStart}
            className={cn(
              'absolute inset-y-0 left-0 z-20 w-3 -translate-x-1/2 cursor-col-resize touch-none',
              'after:absolute after:inset-y-3 after:left-1/2 after:w-px after:-translate-x-1/2 after:rounded-full after:bg-transparent after:transition',
              'hover:after:bg-neutral-300 focus-visible:outline-none focus-visible:after:bg-neutral-400',
              resizing && 'after:bg-neutral-400',
            )}
          />
        )}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-neutral-200 bg-white/90 px-3 backdrop-blur">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-neutral-200 bg-gradient-to-br from-white to-neutral-100 text-neutral-500 shadow-sm">
              {previewIcon(item)}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-neutral-900">{item.title}</div>
              <div className="truncate text-xs text-neutral-500">
                {item.subtitle ?? previewKindLabel(item)}
              </div>
            </div>
          </div>

          <div className="hidden min-w-0 max-w-[36%] flex-1 justify-center md:flex">
            <div className="truncate rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-[11px] text-neutral-500">
              {item.path ?? item.url ?? 'Preview window'}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {canOpen && (
              <>
                <button
                  type="button"
                  onClick={() => void handleOpenInNewWindow()}
                  className="grid h-9 w-9 place-items-center rounded-xl text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
                  title="Open in new window"
                  aria-label="Open in new window"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDownload()}
                  className="grid h-9 w-9 place-items-center rounded-xl text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
                  title="Download"
                  aria-label="Download"
                >
                  <Download className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setMaximized((v) => !v)}
              className="grid h-9 w-9 place-items-center rounded-xl text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
              title={maximized ? 'Restore preview' : 'Enlarge preview'}
              aria-label={maximized ? 'Restore preview' : 'Enlarge preview'}
            >
              {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <div className="mx-1 h-5 w-px bg-neutral-200" />
            <button
              type="button"
              onClick={handleClose}
              className="grid h-9 w-9 place-items-center rounded-xl text-neutral-400 transition hover:bg-red-50 hover:text-red-500"
              title="Close preview"
              aria-label="Close preview"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {actionPanelOpen && actionItems.length > 0 && (
          <PreviewActionPanel
            items={actionItems}
            onClose={() => setActionPanelOpen(false)}
            onOpenPath={(path) => void handleOpenDownloadedPath(path)}
          />
        )}

        <div className="flex min-h-0 flex-1 flex-col bg-[#f6f7f9] p-2">
          {item.description && (
            <div className="mb-2 rounded-2xl border border-neutral-200 bg-white/90 px-3 py-2 text-xs leading-5 text-neutral-600 shadow-sm">
              {item.description}
            </div>
          )}
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
            {item.kind === 'image' && item.url ? (
              <div className="grid h-full place-items-center bg-neutral-950 p-4">
                <img
                  src={item.url}
                  alt={item.title}
                  className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
                  decoding="async"
                  draggable={false}
                />
              </div>
            ) : (item.kind === 'web' || item.kind === 'deploy') && item.url ? (
              loadingState === 'error' ? (
                <PreviewErrorState
                  title={item.title}
                  error={loadError}
                  onRetry={() => setReloadToken((value) => value + 1)}
                />
              ) : loadingState !== 'ready' ? (
                <PreviewLoadingState item={item} />
              ) : (
                <iframe
                  title={item.title}
                  src={item.url}
                  className="h-full w-full border-0 bg-white"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              )
            ) : item.kind === 'diff' ? (
              <div className="h-full overflow-auto">
                <DiffViewer diff={item.source ?? ''} maxHeightClassName="max-h-none" filePath={item.path} />
              </div>
            ) : item.kind === 'workflow' ? (
              <PreviewPlaceholder item={item} />
            ) : (
              <DocumentPreviewPlaceholder item={item} />
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

const PreviewActionPanel: FC<{
  items: PreviewActionItem[]
  onClose: () => void
  onOpenPath: (path?: string) => void
}> = ({ items, onClose, onOpenPath }) => (
  <div className="absolute right-3 top-[4.5rem] z-30 w-[min(22rem,calc(100%-1.5rem))] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-[0_18px_60px_rgba(15,23,42,0.18)]">
    <div className="flex h-12 items-center justify-between border-b border-neutral-100 px-4">
      <div className="text-sm font-semibold text-neutral-950">下载</div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
          title="下载目录"
          aria-label="下载目录"
          onClick={() => onOpenPath(items.find((item) => item.folder)?.folder)}
        >
          <FolderOpen className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
          title="关闭"
          aria-label="关闭下载弹窗"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
    <div className="max-h-[28rem] overflow-y-auto p-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 rounded-lg px-2 py-2.5 transition hover:bg-neutral-50"
        >
          <div className="mt-0.5 grid h-8 w-8 place-items-center rounded-lg bg-neutral-50 text-neutral-500">
            {item.status === 'working' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : item.status === 'error' ? (
              <AlertTriangle className="h-4 w-4 text-red-500" />
            ) : item.kind === 'download' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <ExternalLink className="h-4 w-4 text-emerald-600" />
            )}
          </div>
          <div className="min-w-0">
            <div
              className={cn(
                'truncate text-sm text-neutral-900',
                item.status === 'error' && 'text-red-600',
              )}
              title={item.title}
            >
              {item.title}
            </div>
            <div className="mt-1 line-clamp-2 text-xs leading-4 text-neutral-500">
              {item.detail}
            </div>
            {item.status === 'success' && item.path && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onOpenPath(item.path)}
                  className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200"
                >
                  打开文件
                </button>
                <button
                  type="button"
                  onClick={() => onOpenPath(item.folder)}
                  className="rounded-md bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-700 transition hover:bg-neutral-200"
                >
                  打开文件夹
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  </div>
)

const PreviewLoadingState: FC<{ item: ArtifactPreviewItem }> = ({ item }) => (
  <div className="grid h-full place-items-center bg-[#f8fafc] p-6">
    <div className="w-full max-w-md rounded-[22px] border border-neutral-200 bg-white p-6 text-center shadow-sm">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-neutral-100 bg-neutral-50 text-neutral-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
      <div className="mt-4 text-sm font-semibold text-neutral-950">Loading preview</div>
      <div className="mt-2 text-xs leading-5 text-neutral-500">
        {item.subtitle ?? previewKindLabel(item)}
      </div>
    </div>
  </div>
)

const PreviewErrorState: FC<{ error: string; onRetry: () => void; title: string }> = ({
  error,
  onRetry,
  title,
}) => (
  <div className="grid h-full place-items-center bg-[#f8fafc] p-6">
    <div className="w-full max-w-lg rounded-[22px] border border-red-100 bg-white p-6 text-center shadow-sm">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-red-100 bg-red-50 text-red-500">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <div className="mt-4 text-sm font-semibold text-neutral-950">Preview failed</div>
      <div className="mt-2 text-xs leading-6 text-neutral-500">{title}</div>
      <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-left text-xs leading-6 text-red-700">
        {error || 'The preview service returned an error response.'}
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800"
      >
        <RefreshCw className="h-4 w-4" />
        Retry
      </button>
    </div>
  </div>
)
const DocumentPreviewPlaceholder: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const fileName = item.path ?? item.title
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-3 text-xs text-neutral-500">
        <FileText className="h-4 w-4 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate">{fileName}</span>
        <span className="rounded-md bg-[#F7F7F7] px-2 py-1">只读预览</span>
      </div>
      <div className="grid min-h-0 flex-1 place-items-center bg-[#F7F7F7] p-8">
        <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[#F7F7F7] text-neutral-500">
            <File className="h-8 w-8" />
          </div>
          <div className="mt-4 truncate text-sm font-semibold text-neutral-950">{item.title}</div>
          <div className="mt-2 text-xs leading-5 text-neutral-500">{previewFileHint(item)}</div>
          {item.path && (
            <div className="agenthub-readable-code mt-4 rounded-xl bg-[#F7F7F7] px-3 py-2 text-left text-xs leading-5 text-neutral-500">
              {item.path}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const PreviewPlaceholder: FC<{ item: ArtifactPreviewItem }> = ({ item }) => (
  <div className="grid h-full place-items-center bg-[#F7F7F7] p-8">
    <div className="max-w-md rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm">
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-[#F7F7F7] text-neutral-500">
        <GitBranch className="h-8 w-8" />
      </div>
      <div className="mt-4 text-sm font-semibold text-neutral-950">{item.title}</div>
      <div className="mt-2 text-xs leading-5 text-neutral-500">
        {item.description ?? '这个产物当前显示结构化摘要和关联信息。'}
      </div>
    </div>
  </div>
)

type CodeAgentRunStep = NonNullable<CodeAgentRunMetadata['steps']>[number]

const CodeAgentRunCard: FC<{ data: CodeAgentRunMetadata }> = ({ data }) => {
  const changedFiles = data.files ?? []
  const commands = data.commands ?? []
  const toolCalls = data.toolCalls ?? []
  const logs = data.logs ?? []
  const eventCount = logs.filter((log) => displayLogStream(log) === 'event').length
  const steps = useMemo(() => codeAgentProcessSteps(data), [data])
  const hasDetails =
    toolCalls.length > 0 || commands.length > 0 || changedFiles.length > 0 || logs.length > 0

  return (
    <div className="not-prose mt-3 space-y-2 text-sm">
      <CodeAgentStatusCard
        data={data}
        commandCount={commands.length}
        eventCount={eventCount}
        fileCount={changedFiles.length}
        toolCount={toolCalls.length}
      />
      <CodeAgentProcessTimeline steps={steps} running={data.status === 'running'} />
      {data.diagnostics && <CodeAgentDiagnosticsCard diagnostics={data.diagnostics} />}
      <CodeAgentOutputReviewCard data={data} />
      {hasDetails && (
        <CodeAgentRunDetails
          changedFiles={changedFiles}
          commands={commands}
          cwd={data.cwd ?? commands.find((command) => command.cwd)?.cwd}
          logs={logs}
          running={data.status === 'running'}
          toolCalls={toolCalls}
        />
      )}
    </div>
  )
}

const CodeAgentStatusCard: FC<{
  commandCount: number
  data: CodeAgentRunMetadata
  eventCount: number
  fileCount: number
  toolCount: number
}> = ({ commandCount, data, eventCount, fileCount, toolCount }) => {
  const statusTone =
    data.status === 'running'
      ? 'text-blue-600'
      : data.status === 'completed'
        ? 'text-neutral-500'
        : data.partialSuccess || data.status === 'timed-out'
          ? 'text-amber-600'
          : 'text-red-600'

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        <div className={cn('inline-flex min-w-0 items-center gap-2', statusTone)}>
          {data.status === 'running' ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : data.partialSuccess ? (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          ) : (
            <Clock3 className="h-4 w-4 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="truncate font-medium">
              {codeAgentStatusLabel(data.status, Boolean(data.partialSuccess))} · {formatRunDuration(data.durationMs)}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-neutral-400">
              {codeAgentRuntimeLabel(data.runtime)} · {data.command}
            </div>
            {data.warning && (
              <div className="mt-1 truncate text-[11px] text-amber-700">{data.warning}</div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
          <CodeAgentMiniStat
            icon={<Search className="h-3.5 w-3.5" />}
            label="工具"
            value={toolCount}
          />
          <CodeAgentMiniStat
            icon={<TerminalSquare className="h-3.5 w-3.5" />}
            label="命令"
            value={commandCount}
          />
          <CodeAgentMiniStat
            icon={<FileText className="h-3.5 w-3.5" />}
            label="文件"
            value={fileCount}
          />
          <CodeAgentMiniStat
            icon={<ListTodo className="h-3.5 w-3.5" />}
            label="事件"
            value={eventCount}
          />
        </div>
      </div>
    </div>
  )
}

const CodeAgentMiniStat: FC<{ icon: ReactNode; label: string; value: number }> = ({
  icon,
  label,
  value,
}) => (
  <span
    className={cn(
      'inline-flex h-7 items-center gap-1 rounded-md border px-2',
      value
        ? 'border-neutral-200 bg-neutral-50 text-neutral-700'
        : 'border-neutral-100 bg-white text-neutral-300',
    )}
  >
    {icon}
    {label} {value}
  </span>
)

const CodeAgentProcessTimeline: FC<{ running: boolean; steps: CodeAgentRunStep[] }> = ({
  running,
  steps,
}) => {
  const [expanded, setExpanded] = useState(false)
  const visibleSteps = !running || expanded ? steps : steps.slice(-1)
  const hiddenCount = Math.max(0, steps.length - visibleSteps.length)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 text-xs text-neutral-500">
        <span className="inline-flex items-center gap-2 font-medium text-neutral-700">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              running ? 'bg-blue-500 shadow-[0_0_0_4px_rgba(59,130,246,0.12)]' : 'bg-neutral-300',
            )}
          />
          执行过程
        </span>
        <span>
          {running ? '实时更新' : '已记录'} {steps.length} 项
        </span>
      </div>

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-9 w-full items-center justify-center gap-1 rounded-lg border border-neutral-200 bg-white text-xs font-medium text-neutral-500 shadow-sm transition hover:border-neutral-300 hover:text-neutral-800"
        >
          展开更早 {hiddenCount} 项
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}

      <div className="space-y-1.5">
        {visibleSteps.length ? (
          visibleSteps.map((step, index) => (
            <CodeAgentProcessStepCard
              key={step.id}
              latest={running && index === visibleSteps.length - 1}
              step={step}
            />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-neutral-200 bg-white px-3 py-3 text-xs text-neutral-500">
            等待 Coding Tools 返回过程事件
          </div>
        )}
      </div>
    </div>
  )
}

const CodeAgentProcessStepCard: FC<{ latest: boolean; step: CodeAgentRunStep }> = ({
  latest,
  step,
}) => {
  const canExpand = Boolean(step.detail || step.command || step.path)
  const content = (
    <div
      className={cn(
        'agenthub-code-agent-step flex min-h-[3.75rem] min-w-0 items-center gap-3 rounded-lg border bg-white px-3 py-2.5 shadow-sm transition',
        step.status === 'failed'
          ? 'border-red-200 bg-red-50/50'
          : step.status === 'running'
            ? 'border-blue-200 bg-blue-50/40'
            : 'border-neutral-200',
        latest && 'agenthub-code-agent-step-live',
      )}
    >
      <span
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-md border',
          step.status === 'failed'
            ? 'border-red-200 bg-white text-red-600'
            : step.status === 'running'
              ? 'border-blue-200 bg-white text-blue-600'
              : 'border-neutral-200 bg-neutral-50 text-neutral-500',
        )}
      >
        {codeAgentStepIcon(step)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[11px] font-semibold text-neutral-400">
            {codeAgentStepKindLabel(step)}
          </span>
          <span className="truncate text-[13px] font-medium leading-5 text-neutral-900">
            {step.title}
          </span>
        </span>
        <span
          className="mt-0.5 block truncate text-[13px] leading-5 text-neutral-600"
          title={step.subtitle ?? step.detail ?? step.command ?? step.path}
        >
          {step.subtitle ?? step.detail ?? step.command ?? step.path ?? '处理中'}
        </span>
      </span>
      <span className="grid h-6 w-6 shrink-0 place-items-center text-neutral-400">
        {step.status === 'running' ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        ) : step.status === 'failed' ? (
          <AlertTriangle className="h-4 w-4 text-red-500" />
        ) : canExpand ? (
          <ChevronRight className="h-4 w-4 transition group-open:rotate-90" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-neutral-300" />
        )}
      </span>
    </div>
  )

  if (!canExpand) return content

  return (
    <details className="group">
      <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
        {content}
      </summary>
      <div className="mx-3 border-l border-neutral-200 px-4 py-2 text-xs leading-5 text-neutral-600">
        {step.command && (
          <pre className="agenthub-readable-code max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-950 px-3 py-2 text-neutral-100">
            {step.command}
          </pre>
        )}
        {step.detail && <div className="mt-1 whitespace-pre-wrap break-words">{step.detail}</div>}
        {step.path && !step.command && (
          <div className="agenthub-readable-code mt-1 truncate text-neutral-500">{step.path}</div>
        )}
      </div>
    </details>
  )
}

const CodeAgentRunDetails: FC<{
  changedFiles: CodeAgentRunMetadata['files']
  commands: CodeAgentRunMetadata['commands']
  cwd?: string
  logs: NonNullable<CodeAgentRunMetadata['logs']>
  running: boolean
  toolCalls: NonNullable<CodeAgentRunMetadata['toolCalls']>
}> = ({ changedFiles, commands, cwd, logs, running, toolCalls }) => (
  <details className="group">
    <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3 text-left text-[13px] font-medium text-neutral-700 shadow-sm transition hover:bg-neutral-50 [&::-webkit-details-marker]:hidden">
      <span className="inline-flex min-w-0 items-center gap-2">
        <ListTodo className="h-4 w-4 shrink-0 text-neutral-500" />
        执行明细
      </span>
      <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-open:rotate-180" />
    </summary>
    <div className="mt-2 space-y-2">
      {toolCalls.length > 0 && <CodeAgentToolsCard items={toolCalls} running={running} />}
      {commands.length > 0 && <CodeAgentCommandsCard commands={commands} />}
      {changedFiles.length > 0 && <CodeAgentFilesCard cwd={cwd} files={changedFiles} />}
      {logs.length > 0 && <CodeAgentLogsCard logs={logs} />}
    </div>
  </details>
)

const CodeAgentOutputReviewCard: FC<{ data: CodeAgentRunMetadata }> = ({ data }) => {
  const messageId = useMessage((message) => message.id)
  const currentSession = useChatStore((state) => state.currentSession)
  const sourceMessage = useChatStore((state) =>
    state.messages.find((message) => message.id === messageId),
  )
  const sendMessageToSession = useChatStore((state) => state.sendMessageToSession)
  const finalMessage = (data.finalMessage ?? '').trim()
  const reviewRequired =
    data.reviewRequired || data.runtime === 'codex' || data.runtime === 'claude-code'
  const startsExpanded = finalMessage.length <= 1600 && finalMessage.split(/\r?\n/).length <= 14
  const [expanded, setExpanded] = useState(startsExpanded)
  const [confirmed, setConfirmed] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [continueError, setContinueError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setExpanded(startsExpanded)
    setConfirmed(false)
    setContinuing(false)
    setContinueError('')
    setCopied(false)
  }, [finalMessage, startsExpanded])

  if (!reviewRequired) return null

  const running = data.status === 'running'
  const hasFinalMessage = finalMessage.length > 0
  const preview = expanded ? finalMessage : codeAgentReviewPreview(finalMessage)
  const hasMore = preview !== finalMessage
  const lineCount = hasFinalMessage ? finalMessage.split(/\r?\n/).length : 0
  const runtimeLabel = codeAgentRuntimeLabel(data.runtime)
  const sourceMetadata =
    sourceMessage?.metadata && typeof sourceMessage.metadata === 'object'
      ? (sourceMessage.metadata as Record<string, unknown>)
      : null
  const sourceAgentName =
    typeof sourceMetadata?.agentName === 'string' ? sourceMetadata.agentName.trim() : ''
  const shouldMentionAgent = currentSession?.type === 'group' && sourceAgentName.length > 0

  async function copyFinalMessage() {
    if (!finalMessage) return
    try {
      await navigator.clipboard.writeText(finalMessage)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  async function continueOutput() {
    if (!messageId || !currentSession?.id || continuing || confirmed) return
    const continuationPrompt = buildCodeAgentContinuationPrompt({
      finalMessage,
      runtimeLabel,
      agentName: shouldMentionAgent ? sourceAgentName : null,
    })
    setContinuing(true)
    setContinueError('')
    try {
      await sendMessageToSession(currentSession.id, continuationPrompt, {
        displayContent: '继续输出',
        replyToMessageId: messageId,
      })
      setConfirmed(true)
    } catch (error) {
      setContinueError(friendlyErrorMessage(error, '继续输出失败'))
    } finally {
      setContinuing(false)
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-white shadow-sm',
        confirmed ? 'border-emerald-200' : 'border-neutral-200',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <div className="inline-flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'grid h-8 w-8 shrink-0 place-items-center rounded-md border',
              confirmed
                ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
                : running
                  ? 'border-blue-200 bg-blue-50 text-blue-600'
                  : hasFinalMessage
                    ? 'border-neutral-200 bg-neutral-50 text-neutral-600'
                    : 'border-amber-200 bg-amber-50 text-amber-600',
            )}
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : confirmed ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : hasFinalMessage ? (
              <FileText className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium leading-5 text-neutral-900">
              输出审核
            </span>
            <span className="block truncate text-[11px] leading-5 text-neutral-500">
              {running
                ? `${runtimeLabel} 正在写入流式输出`
                : hasFinalMessage
                  ? `完整终稿 ${lineCount} 行 · ${finalMessage.length.toLocaleString()} 字`
                  : `${runtimeLabel} 未捕获到完整终稿`}
            </span>
          </span>
        </div>
        <span
          className={cn(
            'inline-flex h-6 items-center rounded-md border px-2 text-[11px] font-medium',
            confirmed
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : running
                ? 'border-blue-100 bg-blue-50 text-blue-600'
                : 'border-neutral-200 bg-neutral-50 text-neutral-500',
          )}
        >
          {confirmed ? '已确认' : running ? '待完成' : '待审核'}
        </span>
      </div>

      <div className="border-t border-neutral-100 bg-neutral-50/70 px-3 py-3">
        {running ? (
          <div className="rounded-md border border-dashed border-blue-200 bg-white px-3 py-2 text-xs leading-5 text-neutral-500">
            Claude Code / Codex 的最终正文会在执行结束后锁定到这里，审核时可展开全文确认。
          </div>
        ) : hasFinalMessage ? (
          <>
            <pre
              className={cn(
                'agenthub-readable-code whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-white px-3 py-2 text-[13px] leading-6 text-neutral-800',
                expanded ? 'max-h-[32rem] overflow-auto' : 'max-h-44 overflow-hidden',
              )}
            >
              {preview}
            </pre>
            {hasMore && (
              <div className="mt-2 text-[11px] leading-5 text-neutral-500">
                当前为预览，展开后显示完整输出。
              </div>
            )}
          </>
        ) : (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
            本次运行没有返回可锁定的最终正文；过程日志和文件变更仍可在执行明细中查看。
          </div>
        )}
        {!running && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {hasFinalMessage && (
                <>
                  <button
                    type="button"
                    onClick={copyFinalMessage}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? '已复制' : '复制全文'}
                  </button>
                  {hasMore && (
                    <button
                      type="button"
                      onClick={() => setExpanded((value) => !value)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900"
                    >
                      <ChevronDown
                        className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')}
                      />
                      {expanded ? '收起全文' : '展开全文'}
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => void continueOutput()}
                disabled={continuing || confirmed || !currentSession?.id}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition',
                  confirmed
                    ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'bg-neutral-950 text-white hover:bg-neutral-800 disabled:bg-neutral-300 disabled:text-neutral-500',
                )}
              >
                {continuing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : confirmed ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {confirmed ? '已继续输出' : continuing ? '提交中...' : '确认并继续输出'}
              </button>
            </div>
            {continueError && (
              <div className="mt-2 text-[11px] leading-5 text-red-500">{continueError}</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function codeAgentReviewPreview(value: string) {
  const lines = value.split(/\r?\n/)
  if (lines.length <= 14 && value.length <= 1600) return value
  const firstLines = lines.slice(0, 14).join('\n')
  if (firstLines.length <= 1600) return `${firstLines}\n...`
  return `${firstLines.slice(0, 1600)}\n...`
}

function buildCodeAgentContinuationPrompt({
  finalMessage,
  runtimeLabel,
  agentName,
}: {
  finalMessage: string
  runtimeLabel: string
  agentName: string | null
}) {
  const tail = finalMessage.trim()
  const tailPreview = tail.length > 1200 ? `${tail.slice(-1200).trimStart()}` : tail
  const prefix = agentName ? `@${agentName} ` : ''
  const lines = [
    `${prefix}请继续上一轮 ${runtimeLabel} 的输出，不要重复已经给出的内容。`,
    '如果上一轮已经结束，请补充剩余结论、验证结果和剩余风险；如果还没结束，请从最后一句之后接着写。',
  ]
  if (tailPreview) {
    lines.push(`上一轮输出末尾：\n${tailPreview}`)
  }
  return lines.join('\n\n')
}

const CodeAgentToolsCard: FC<{
  items: NonNullable<CodeAgentRunMetadata['toolCalls']>
  running: boolean
}> = ({ items, running }) => (
  <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
    <div className="flex h-10 items-center justify-between gap-3 border-b border-neutral-100 px-3">
      <span className="inline-flex min-w-0 items-center gap-2 font-medium text-neutral-800">
        <Search className="h-4 w-4 shrink-0 text-blue-500" />
        工具调用 {items.length}
      </span>
      {running && (
        <span className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_0_4px_rgba(59,130,246,0.12)]" />
      )}
    </div>
    <div className="grid gap-1.5 p-2">
      {items.slice(-12).map((item) => (
        <div
          key={item.id}
          className="grid grid-cols-[5.25rem_minmax(0,1fr)] gap-3 rounded-md bg-neutral-50 px-3 py-2.5 antialiased"
        >
          <span className="text-[13px] font-medium leading-6 text-neutral-500">{item.label}</span>
          <span className="min-w-0">
            <span
              className="block truncate text-[13px] leading-6 text-neutral-900"
              title={item.target ?? item.name}
            >
              {item.target ?? item.name}
            </span>
            {item.detail && (
              <span
                className="mt-0.5 block truncate text-xs leading-5 text-neutral-500"
                title={item.detail}
              >
                {item.detail}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  </div>
)

const CodeAgentCommandsCard: FC<{ commands: CodeAgentRunMetadata['commands'] }> = ({
  commands,
}) => (
  <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
    <div className="flex h-10 items-center gap-2 border-b border-neutral-100 px-3 font-medium text-neutral-800">
      <TerminalSquare className="h-4 w-4 shrink-0 text-emerald-600" />
      命令记录 {commands.length}
    </div>
    <div className="space-y-1.5 p-2">
      {commands.map((command) => (
        <details
          key={command.id}
          className="group rounded-md border border-neutral-200 bg-neutral-50 text-neutral-900"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
            <span
              className="agenthub-readable-code truncate text-[13px] leading-6"
              title={command.command}
            >
              {command.command}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400 transition group-open:rotate-180" />
          </summary>
          {(command.cwd || command.output) && (
            <div className="border-t border-neutral-200 bg-white px-3 py-2 text-[13px] leading-6 text-neutral-700">
              {command.cwd && (
                <div className="agenthub-readable-code truncate text-neutral-500">
                  cwd: {command.cwd}
                </div>
              )}
              {command.output && (
                <pre className="agenthub-readable-code mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                  {command.output}
                </pre>
              )}
            </div>
          )}
        </details>
      ))}
    </div>
  </div>
)

const CodeAgentFilesCard: FC<{ cwd?: string; files: CodeAgentRunMetadata['files'] }> = ({
  cwd,
  files,
}) => {
  const workspaceId = useChatStore((s) => s.currentSession?.workspaceId)

  async function handleSaveEdit(filePath: string, params: { lineText: string; lineNumber: number }) {
    if (!workspaceId) return
    try {
      await api.writeFile({
        workspaceId,
        filePath,
        content: params.lineText,
        startLine: params.lineNumber,
        endLine: params.lineNumber,
      })
    } catch (err) {
      console.error('[CodeAgentFilesCard] Failed to save edit:', err)
    }
  }

  return (
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
                <span className="truncate text-[13px] leading-6 text-neutral-800" title={file.path}>
                  {file.path}
                </span>
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
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-neutral-400 transition group-open:rotate-180',
                    !file.diff && 'opacity-0',
                  )}
                />
              </summary>
              {file.diff && (
                <DiffViewer
                  diff={file.diff}
                  maxHeightClassName="max-h-72"
                  filePath={file.path}
                  onSaveEdit={workspaceId ? (params) => handleSaveEdit(file.path, params) : undefined}
                />
              )}
            </details>
          )
        })}
      </div>
    </div>
  )
}

const CodeAgentLogsCard: FC<{ logs: NonNullable<CodeAgentRunMetadata['logs']> }> = ({ logs }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-10 w-full items-center justify-between gap-3 px-3 text-left font-medium text-neutral-800 hover:bg-neutral-50"
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <ListTodo className="h-4 w-4 shrink-0 text-neutral-500" />
          过程日志 {logs.length}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-neutral-400 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div className="max-h-64 space-y-1.5 overflow-auto border-t border-neutral-100 bg-white p-2">
          {logs.map((log) => (
            <CodeAgentLogRow key={log.id} log={log} />
          ))}
        </div>
      )}
    </div>
  )
}

const CodeAgentLogRow: FC<{ log: NonNullable<CodeAgentRunMetadata['logs']>[number] }> = ({
  log,
}) => {
  const stream = displayLogStream(log)
  return (
    <div
      className={cn(
        'grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 rounded-md border px-3 py-2.5 text-[13px] leading-6 antialiased',
        stream === 'stderr'
          ? 'border-red-100 bg-red-50/70'
          : stream === 'event'
            ? 'border-blue-100 bg-blue-50/60'
            : 'border-neutral-100 bg-neutral-50',
      )}
    >
      <span
        className={cn(
          'inline-flex h-5 items-center justify-center rounded px-1.5 text-[11px] font-medium',
          stream === 'stderr'
            ? 'bg-red-100 text-red-700'
            : stream === 'event'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-neutral-200 text-neutral-600',
        )}
      >
        {logStreamLabel(stream)}
      </span>
      <span className="whitespace-pre-wrap break-words text-neutral-800">{log.text}</span>
    </div>
  )
}

function displayLogStream(log: NonNullable<CodeAgentRunMetadata['logs']>[number]) {
  if (log.stream !== 'stderr') return log.stream
  return isProgressLikeCodeAgentLog(log.text) ? 'event' : 'stderr'
}

function isProgressLikeCodeAgentLog(text: string) {
  const normalized = text.trim()
  return (
    /^(->|→)\s*(Read|Edit|Write|MultiEdit|Grep|Glob|Bash|TodoWrite|Task|WebFetch|WebSearch)\b/i.test(
      normalized,
    ) ||
    /^#\s*Todos\b/i.test(normalized) ||
    /^\[[ xX-]\]\s+/.test(normalized) ||
    /^[✓✔]\s+/.test(normalized) ||
    /^[•·]\s+/.test(normalized) ||
    /^>\s*[\w.-]+\s*·\s*[\w./:+-]+/i.test(normalized) ||
    /\b(Explore|Plan|Analyze|Review|Build|Write|Read)\b.*\bAgent\b/i.test(normalized) ||
    /^(Read|Edit|Write|MultiEdit|Grep|Glob|Bash|TodoWrite|Task|WebFetch|WebSearch)[：:]/i.test(
      normalized,
    ) ||
    /^(Warning|Warn|警告)[：:\s]/i.test(normalized)
  )
}

function codeAgentProcessSteps(data: CodeAgentRunMetadata): CodeAgentRunStep[] {
  const steps = Array.isArray(data.steps) ? data.steps.filter(isCodeAgentStep) : []
  if (steps.length) return steps.slice(-120)

  const fallback: CodeAgentRunStep[] = []
  fallback.push({
    id: 'fallback-status',
    kind: 'status',
    status:
      data.status === 'running'
        ? 'running'
        : data.status === 'completed' || data.partialSuccess
          ? 'completed'
          : 'failed',
    title: codeAgentStatusLabel(data.status, Boolean(data.partialSuccess)),
    subtitle: `${codeAgentRuntimeLabel(data.runtime)} · ${formatRunDuration(data.durationMs)}`,
  })

  for (const item of (data.toolCalls ?? []).slice(-20)) {
    fallback.push({
      id: `fallback-tool-${item.id}`,
      kind: 'tool',
      status: 'completed',
      title: item.label,
      subtitle: item.target ?? item.name,
      detail: item.detail,
      toolName: item.name,
    })
  }

  for (const command of (data.commands ?? []).slice(-20)) {
    fallback.push({
      id: `fallback-command-${command.id}`,
      kind: 'command',
      status: 'completed',
      title: '运行命令',
      subtitle: command.command,
      detail: command.cwd ? `cwd: ${command.cwd}` : undefined,
      command: command.command,
    })
  }

  for (const file of (data.files ?? []).slice(-20)) {
    fallback.push({
      id: `fallback-file-${file.status}-${file.path}`,
      kind: 'file',
      status: 'completed',
      title: `${fileStatusLabel(file.status)}文件`,
      subtitle: file.path,
      path: file.path,
      fileStatus: file.status,
    })
  }

  return fallback.slice(-120)
}

function isCodeAgentStep(value: unknown): value is CodeAgentRunStep {
  if (!value || typeof value !== 'object') return false
  const step = value as Partial<CodeAgentRunStep>
  return (
    typeof step.id === 'string' &&
    typeof step.title === 'string' &&
    (step.kind === 'status' ||
      step.kind === 'tool' ||
      step.kind === 'command' ||
      step.kind === 'file' ||
      step.kind === 'log') &&
    (step.status === 'running' ||
      step.status === 'completed' ||
      step.status === 'failed' ||
      step.status === 'cancelled' ||
      step.status === 'timed-out')
  )
}

function codeAgentStepKindLabel(step: CodeAgentRunStep) {
  if (step.kind === 'command') return '命令'
  if (step.kind === 'file') return '文件'
  if (step.kind === 'log') return step.stream === 'stderr' ? '错误' : '日志'
  if (step.kind === 'status') return '运行'
  if (step.toolName === 'TodoWrite') return '待办'
  if (step.toolName === 'Read') return '读取'
  if (step.toolName === 'Grep' || step.toolName === 'Glob') return '搜索'
  if (step.toolName === 'WebFetch' || step.toolName === 'WebSearch') return '网页'
  return '工具'
}

function codeAgentStepIcon(step: CodeAgentRunStep): ReactNode {
  if (step.status === 'running') return <Loader2 className="h-4 w-4 animate-spin" />
  if (step.status === 'failed' || step.status === 'cancelled' || step.status === 'timed-out')
    return <AlertTriangle className="h-4 w-4" />
  if (step.kind === 'command') return <TerminalSquare className="h-4 w-4" />
  if (step.kind === 'file')
    return step.fileStatus === 'created' ? <FilePlusIcon /> : <FileText className="h-4 w-4" />
  if (step.kind === 'log') return <ListTodo className="h-4 w-4" />
  if (step.kind === 'status') return <Rocket className="h-4 w-4" />
  if (step.toolName === 'TodoWrite') return <ListTodo className="h-4 w-4" />
  if (step.toolName === 'Read') return <FileText className="h-4 w-4" />
  if (step.toolName === 'WebFetch' || step.toolName === 'WebSearch')
    return <Globe2 className="h-4 w-4" />
  if (step.toolName === 'Grep' || step.toolName === 'Glob') return <Search className="h-4 w-4" />
  return <Pencil className="h-4 w-4" />
}

const FilePlusIcon: FC = () => (
  <span className="relative grid h-4 w-4 place-items-center">
    <FileText className="h-4 w-4" />
    <Plus className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-white" />
  </span>
)

const CodeAgentDiagnosticsCard: FC<{ diagnostics: string }> = ({ diagnostics }) => {
  const [open, setOpen] = useState(true)
  return (
    <div className="overflow-hidden rounded-lg border border-red-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-10 w-full items-center justify-between gap-3 px-3 text-left font-medium text-red-700 hover:bg-red-50"
      >
        <span className="inline-flex items-center gap-2">
          <AlertCircleIcon />
          诊断输出
        </span>
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-red-300 transition-transform', open && 'rotate-180')}
        />
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
  if (artifact.type === 'workflow') return <WorkflowArtifactCard artifact={artifact} />
  return <FileArtifactCard artifact={artifact} />
}

const FileArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'file' }> }> = ({
  artifact,
}) => {
  const item = previewItemFromArtifact(artifact)
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-6 text-neutral-800" title={artifact.path}>
            {artifact.path}
          </div>
          <div className="mt-0.5 text-xs text-neutral-400">
            {artifact.status ? fileStatusLabel(artifact.status) : '文件产物'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => requestArtifactPreview(item)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-neutral-50 px-2.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-950"
          title={previewActionLabel(item)}
        >
          {previewActionIcon(item)}
          {previewActionLabel(item)}
        </button>
      </div>
    </div>
  )
}

const DiffArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'diff' }> }> = ({
  artifact,
}) => {
  const [open, setOpen] = useState(false)
  const lines = artifact.diff.split(/\r?\n/)
  const additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
  const deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
  const workspaceId = useChatStore((s) => s.currentSession?.workspaceId)

  async function handleSaveEdit(params: { lineText: string; lineNumber: number }) {
    if (!workspaceId) return
    await api.writeFile({
      workspaceId,
      filePath: artifact.filePath,
      content: params.lineText,
      startLine: params.lineNumber,
      endLine: params.lineNumber,
    })
  }

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
            <span className="block truncate text-[13px] leading-6 text-neutral-900">
              {artifact.filePath}
            </span>
            <span className="block text-xs text-neutral-400">
              +{additions} / -{deletions}
            </span>
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-neutral-400 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      <div className="border-t border-neutral-100 px-3 py-2">
        <button
          type="button"
          onClick={() => requestArtifactPreview(previewItemFromArtifact(artifact))}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-neutral-50 px-2.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-950"
        >
          <GitBranch className="h-3.5 w-3.5" />
          查看 Diff
        </button>
      </div>
      {open && <DiffViewer diff={artifact.diff} maxHeightClassName="max-h-96" filePath={artifact.filePath} onSaveEdit={workspaceId ? handleSaveEdit : undefined} />}
    </div>
  )
}

const DiffViewer: FC<{
  diff: string
  maxHeightClassName?: string
  filePath?: string
  /** Called when user saves an inline edit. Receives the new line text and the 1-based line number in the current file. */
  onSaveEdit?: (params: { lineText: string; lineNumber: number }) => void
}> = ({
  diff,
  maxHeightClassName = 'max-h-96',
  filePath,
  onSaveEdit,
}) => {
  const rows = useMemo(() => parseDiffRows(diff), [diff])
  // Only selectable rows are add/del/context (not hunk/meta)
  const selectableRows = useMemo(
    () => rows.map((row, i) => ({ ...row, _index: i })).filter((r) => r.kind === 'add' || r.kind === 'del' || r.kind === 'context'),
    [rows],
  )
  const selectableCount = selectableRows.length
  const selection = useLineSelection(selectableCount)
  const [editingSelectableIndex, setEditingSelectableIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)

  function isRowSelected(originalIndex: number) {
    const selIdx = selectableRows.findIndex((r) => r._index === originalIndex)
    return selIdx >= 0 && selection.isSelected(selIdx)
  }

  function handleLineNumberClick(originalIndex: number, shiftKey: boolean) {
    const selIdx = selectableRows.findIndex((r) => r._index === originalIndex)
    if (selIdx >= 0) selection.toggleLine(selIdx, shiftKey)
  }

  function buildReferenceText() {
    const selected = selection.sortedSelected.map((si) => selectableRows[si])
    if (selected.length === 0) return ''
    const lines = selected.map((r) => {
      const marker = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
      return `${marker}${r.text}`
    })
    const lineRange = selected.length === 1
      ? `第 ${selected[0].newNumber ?? selected[0].oldNumber ?? '?'} 行`
      : `第 ${selected[0].newNumber ?? selected[0].oldNumber ?? '?'}-${selected[selected.length - 1].newNumber ?? selected[selected.length - 1].oldNumber ?? '?'} 行`
    const langGuess = filePath ? guessLanguageFromPath(filePath) : ''
    const header = filePath
      ? `\`${filePath}\` ${lineRange}:\n`
      : `${lineRange}:\n`
    return `${header}\`\`\`${langGuess}\n${lines.join('\n')}\n\`\`\`\n`
  }

  function handleReference() {
    const text = buildReferenceText()
    if (text) insertTextIntoComposer(text)
    selection.clearSelection()
  }

  function handleStartEdit() {
    if (selection.sortedSelected.length === 0) return
    const firstSelIdx = selection.sortedSelected[0]
    setEditingSelectableIndex(firstSelIdx)
    const row = selectableRows[firstSelIdx]
    const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
    setEditDraft(`${marker}${row.text}`)
  }

  function handleCancelEdit() {
    setEditingSelectableIndex(null)
    setEditDraft('')
  }

  async function handleSaveEdit() {
    if (editingSelectableIndex === null || !onSaveEdit) return
    setSaving(true)
    try {
      const row = selectableRows[editingSelectableIndex]
      // Determine the 1-based line number in the current file
      // For 'add' and 'context' rows, use newNumber; for 'del', use oldNumber
      const lineNumber = row.kind === 'del' ? row.oldNumber : row.newNumber
      if (!lineNumber) {
        setSaving(false)
        return
      }
      // The editDraft has a prefix marker (+, -, or space); strip it to get just the line text
      const lineText = editDraft.length > 1 ? editDraft.slice(1) : ''
      await onSaveEdit({ lineText, lineNumber })
      setEditingSelectableIndex(null)
      setEditDraft('')
      selection.clearSelection()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="agenthub-diff-container">
      {selection.selectedCount > 0 && (
        <LineSelectionToolbar
          selectedCount={selection.selectedCount}
          onReference={handleReference}
          onEdit={onSaveEdit ? handleStartEdit : undefined}
          onClear={selection.clearSelection}
        />
      )}
      <div
        className={cn(
          'overflow-auto border-t border-neutral-200 bg-white text-[13px]',
          maxHeightClassName,
          selection.selectedCount > 0 && 'border-t-0',
        )}
      >
        <div className="agenthub-readable-code min-w-max py-1 leading-7">
          {rows.map((row, index) => {
            const selected = isRowSelected(index)
            const isEditing = selectableRows.findIndex((r) => r._index === index) === editingSelectableIndex
            const canSelect = row.kind === 'add' || row.kind === 'del' || row.kind === 'context'

            return (
              <div
                key={`${index}-${row.text}`}
                className={cn(
                  'grid grid-cols-[3.25rem_3.25rem_minmax(32rem,1fr)] border-l-4 pr-4',
                  row.kind === 'add' && 'border-emerald-500 bg-emerald-50 text-emerald-950',
                  row.kind === 'del' && 'border-red-500 bg-red-50 text-red-950',
                  row.kind === 'hunk' && 'border-blue-300 bg-blue-50 text-blue-700',
                  row.kind === 'meta' && 'border-transparent bg-neutral-50 text-neutral-500',
                  row.kind === 'context' && 'border-transparent text-neutral-800',
                  selected && 'agenthub-diff-row-selected',
                )}
              >
                <span
                  className={cn(
                    'select-none border-r border-neutral-100 px-2 text-right text-neutral-400',
                    row.kind === 'add' && 'text-emerald-600',
                    row.kind === 'del' && 'text-red-600',
                    canSelect && 'agenthub-diff-line-number',
                  )}
                  onClick={canSelect ? (e) => handleLineNumberClick(index, e.shiftKey) : undefined}
                >
                  {row.oldNumber ?? ''}
                </span>
                <span
                  className={cn(
                    'select-none border-r border-neutral-100 px-2 text-right text-neutral-400',
                    row.kind === 'add' && 'text-emerald-600',
                    row.kind === 'del' && 'text-red-600',
                    canSelect && 'agenthub-diff-line-number',
                  )}
                  onClick={canSelect ? (e) => handleLineNumberClick(index, e.shiftKey) : undefined}
                >
                  {row.newNumber ?? ''}
                </span>
                {isEditing ? (
                  <div className="flex flex-col px-1 py-0.5">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      className="agenthub-inline-edit"
                      autoFocus
                      rows={1}
                    />
                    <div className="agenthub-inline-edit-actions">
                      <button
                        type="button"
                        className="agenthub-inline-edit-btn agenthub-inline-edit-btn-save"
                        onClick={handleSaveEdit}
                        disabled={saving}
                      >
                        {saving ? '保存中...' : '保存'}
                      </button>
                      <button
                        type="button"
                        className="agenthub-inline-edit-btn agenthub-inline-edit-btn-cancel"
                        onClick={handleCancelEdit}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <code className="whitespace-pre px-3">
                    <span
                      className={cn(
                        'mr-2 inline-block w-3 select-none',
                        row.kind === 'add' && 'text-emerald-600',
                        row.kind === 'del' && 'text-red-600',
                      )}
                    >
                      {row.marker}
                    </span>
                    {row.text}
                  </code>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const PreviewArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'preview' }> }> = ({
  artifact,
}) => {
  return (
    <div className="agenthub-embedded-window overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className="flex h-11 items-center justify-between gap-3 px-3">
        <button
          type="button"
          onClick={() => requestArtifactPreview(previewItemFromArtifact(artifact))}
          className="inline-flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Globe2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium text-neutral-900">
              {artifact.title}
            </span>
            <span className="block truncate text-[11px] text-neutral-400">{artifact.url}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => requestArtifactPreview(previewItemFromArtifact(artifact))}
          className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
          title="预览网页"
        >
          <Monitor className="h-3.5 w-3.5" />
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
    </div>
  )
}

const DeployArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'deploy' }> }> = ({
  artifact,
}) => (
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
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="grid h-7 w-7 place-items-center rounded-md text-emerald-700 hover:bg-emerald-100"
          title="打开部署"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
      {artifact.url && (
        <button
          type="button"
          onClick={() => requestArtifactPreview(previewItemFromArtifact(artifact))}
          className="grid h-7 w-7 place-items-center rounded-md text-emerald-700 hover:bg-emerald-100"
          title="预览部署"
        >
          <Monitor className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  </div>
)

const WorkflowArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'workflow' }> }> = ({
  artifact,
}) => (
  <div className="overflow-hidden rounded-lg border border-indigo-200 bg-white shadow-sm">
    <div className="flex h-11 items-center justify-between gap-3 px-3">
      <button
        type="button"
        onClick={() => requestArtifactPreview(previewItemFromArtifact(artifact))}
        className="inline-flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <GitBranch className="h-4 w-4 shrink-0 text-indigo-500" />
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-neutral-900">
            {artifact.title}
          </span>
          <span className="block truncate text-[11px] text-neutral-400">
            {artifact.nodes.length} 个节点 · {artifact.edges.length} 条连接
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => requestArtifactPreview(previewItemFromArtifact(artifact))}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-indigo-500 hover:bg-indigo-50"
        title="查看流程"
      >
        <GitBranch className="h-3.5 w-3.5" />
      </button>
    </div>
    <div className="border-t border-indigo-100 bg-indigo-50/40 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {artifact.nodes.map((node, index) => (
          <div key={node.id} className="flex items-center gap-2">
            <div
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                node.type === 'input'
                  ? 'border-neutral-200 bg-white text-neutral-600'
                  : node.type === 'output'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-indigo-200 bg-white text-indigo-700',
              )}
            >
              {node.type === 'agent' && (
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: node.agentColor ?? '#6366f1' }}
                />
              )}
              <span>{node.label}</span>
            </div>
            {index < artifact.nodes.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
            )}
          </div>
        ))}
      </div>
    </div>
    <div className="border-t border-indigo-100 bg-white px-3 py-3">
      <div className="space-y-2 text-xs text-neutral-600">
        {artifact.edges.map((edge) => (
          <div
            key={`${edge.from}-${edge.to}`}
            className="flex items-center gap-2 rounded-md bg-neutral-50 px-2.5 py-1.5"
          >
            <span className="font-medium text-neutral-800">
              {artifact.nodes.find((n) => n.id === edge.from)?.label ?? edge.from}
            </span>
            <ChevronRight className="h-3 w-3 text-neutral-300" />
            <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">
              {edge.label ?? '下一步'}
            </span>
            <ChevronRight className="h-3 w-3 text-neutral-300" />
            <span className="font-medium text-neutral-800">
              {artifact.nodes.find((n) => n.id === edge.to)?.label ?? edge.to}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-md bg-neutral-50 px-3 py-2 text-xs leading-5 text-neutral-500">
        <span className="font-medium text-neutral-700">Workflow 说明</span>
        <div className="mt-1">{artifact.description}</div>
      </div>
    </div>
  </div>
)

function deployStatusLabel(status: Extract<AgentArtifact, { type: 'deploy' }>['status']) {
  if (status === 'ready') return '已就绪'
  if (status === 'running') return '部署中'
  if (status === 'failed') return '失败'
  return '待部署'
}

function previewItemFromArtifact(artifact: AgentArtifact): ArtifactPreviewItem {
  if (artifact.type === 'preview') {
    return {
      id: artifact.id,
      description: artifact.description,
      kind: 'web',
      source: artifact.source,
      subtitle: previewKindName(artifact.previewKind),
      title: artifact.title,
      url: artifact.url,
    }
  }
  if (artifact.type === 'deploy') {
    return {
      id: artifact.id,
      description: artifact.description ?? artifact.logs,
      kind: 'deploy',
      source: artifact.source,
      subtitle: `${artifact.provider} · ${deployStatusLabel(artifact.status)}`,
      title: artifact.title,
      url: artifact.url,
    }
  }
  if (artifact.type === 'diff') {
    return {
      id: artifact.id,
      description: artifact.description,
      kind: 'diff',
      path: artifact.filePath,
      source: artifact.diff,
      subtitle: `${fileStatusLabel(artifact.status ?? 'modified')} · Diff`,
      title: artifact.title || artifact.filePath,
    }
  }
  if (artifact.type === 'workflow') {
    return {
      id: artifact.id,
      description: artifact.description,
      kind: 'workflow',
      source: artifact.source,
      subtitle: `${artifact.nodes.length} 个节点 · ${artifact.edges.length} 条连接`,
      title: artifact.title,
    }
  }
  // HTML 文件生成预览 URL
  const ext = artifact.path.split('.').pop()?.toLowerCase()
  const isHtml = ext === 'html' || ext === 'htm'

  return {
    id: artifact.id,
    description: artifact.description,
    kind: isHtml ? 'web' : filePreviewKind(artifact),
    mimeType: artifact.mimeType,
    path: artifact.path,
    source: artifact.source,
    subtitle:
      [artifact.mimeType, artifact.size ? formatBytes(artifact.size) : null]
        .filter(Boolean)
        .join(' · ') || fileStatusLabel(artifact.status ?? 'created'),
    title: artifact.title || artifact.path.split(/[\\/]/).pop() || artifact.path,
    url: isHtml
      ? `/api/artifacts/preview-file?path=${encodeURIComponent(artifact.path)}`
      : undefined,
  }
}

function filePreviewKind(
  artifact: Extract<AgentArtifact, { type: 'file' }>,
): ArtifactPreviewItem['kind'] {
  if (artifact.mimeType?.startsWith('image/')) return 'image'
  return 'file'
}

function previewKindName(kind: Extract<AgentArtifact, { type: 'preview' }>['previewKind']) {
  if (kind === 'dev-server') return '开发服务器预览'
  if (kind === 'static-html') return 'HTML 预览'
  return '网页预览'
}

function previewKindLabel(item: ArtifactPreviewItem) {
  if (item.kind === 'web') return '网页预览'
  if (item.kind === 'deploy') return '部署预览'
  if (item.kind === 'image') return '图片预览'
  if (item.kind === 'diff') return '代码 Diff'
  if (item.kind === 'workflow') return '流程预览'
  return '文件预览'
}

function previewActionLabel(item: ArtifactPreviewItem) {
  if (item.kind === 'web') return '预览网页'
  if (item.kind === 'deploy') return '预览部署'
  if (item.kind === 'image') return '查看图片'
  if (item.kind === 'diff') return '查看 Diff'
  if (item.kind === 'workflow') return '查看流程'
  return '查看文件'
}

function previewActionIcon(item: ArtifactPreviewItem) {
  if (item.kind === 'web' || item.kind === 'deploy') return <Monitor className="h-3.5 w-3.5" />
  if (item.kind === 'image') return <ImagePlus className="h-3.5 w-3.5" />
  if (item.kind === 'diff' || item.kind === 'workflow') return <GitBranch className="h-3.5 w-3.5" />
  return <FileText className="h-3.5 w-3.5" />
}

function previewFileHint(item: ArtifactPreviewItem) {
  const lower = (item.mimeType || item.path || item.title).toLowerCase()
  if (/\.(docx?|pptx?|xlsx?|pdf)$/.test(lower)) {
    return '文档类产物当前展示文件信息，可从产物卡打开文件查看。'
  }
  if (/\.(html?|svg)$/.test(lower)) {
    return '这个文件可以作为网页预览打开。若 Agent 提供 URL，会自动切换为内嵌网页视图。'
  }
  return '这个产物当前展示文件信息，可从产物卡打开文件查看。'
}

function previewIcon(item: ArtifactPreviewItem) {
  if (item.kind === 'web' || item.kind === 'deploy') return <Globe2 className="h-4 w-4" />
  if (item.kind === 'image') return <ImagePlus className="h-4 w-4" />
  if (item.kind === 'diff' || item.kind === 'workflow') return <GitBranch className="h-4 w-4" />
  return <FileText className="h-4 w-4" />
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
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

    if (
      rawLine.startsWith('diff --git') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('--- ') ||
      rawLine.startsWith('+++ ')
    ) {
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

function guessLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    css: 'css', scss: 'css', less: 'css', html: 'xml', xml: 'xml',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', vue: 'xml',
    svelte: 'xml',
  }
  return map[ext] ?? ''
}

const AlertCircleIcon: FC = () => (
  <span className="grid h-4 w-4 place-items-center rounded-full border border-neutral-300 text-[10px]">
    !
  </span>
)

function formatRunDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

function codeAgentStatusLabel(status: CodeAgentRunMetadata['status'], partialSuccess = false) {
  if (status === 'running') return '正在执行'
  if (status === 'completed') return '执行完成'
  if (status === 'cancelled') return '已停止'
  if (status === 'timed-out') return '已超时'
  if (partialSuccess) return '已产出，需复核'
  return '执行失败'
}

function groupChatDisplayTitle(sessionTitle?: string | null, workspaceName?: string | null) {
  const normalized = (sessionTitle || workspaceName || 'Agent 群聊').trim()
  const withoutSuffix = normalized.replace(/\s*\/\s*Agent Group\s*$/i, '').trim()
  return withoutSuffix || workspaceName?.trim() || 'Agent 群聊'
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

function TaskBoardCard({ data }: { data: any }) {
  const liveTaskBoard = useChatStore((s) => s.taskBoard)
  const taskBoard = liveTaskBoard?.runId === data?.runId ? liveTaskBoard : data

  return (
    <div className="not-prose my-3 rounded-lg border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm text-blue-900">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white text-blue-600 ring-1 ring-blue-100">
          <ListTodo className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{taskBoard?.title || '团队执行计划已生成'}</div>
          <p className="mt-0.5 text-xs leading-5 text-blue-700">
            任务状态、成员对话和产物统一在右侧任务看板与左侧成员栏查看，这里不再重复展示旧任务卡片。
          </p>
        </div>
      </div>
    </div>
  )
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
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="mt-2 flex items-center gap-1 text-neutral-400"
    >
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
      <ToolButton
        aria-label="重新生成"
        title="重新生成"
        onClick={regenerate}
        disabled={regenerating}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', regenerating && 'animate-spin')} />
      </ToolButton>
    </ActionBarPrimitive.Root>
  )
}

const BranchPicker: FC = () => (
  <BranchPickerPrimitive.Root
    hideWhenSingleBranch
    className="mt-1 flex items-center gap-1 text-xs text-neutral-400"
  >
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
  const messageId = useMessage((message) => message.id)
  const sourceMessage = useChatStore((state) => state.messages.find((m) => m.id === messageId))
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const workspaceAgents = useChatStore((state) => state.currentWorkspaceAgents)

  // 尝试匹配发送者 workspace agent（优先 senderId，其次 metadata.agentName）
  const senderId =
    sourceMessage?.senderId ??
    (messageId === streamingMessage?.id ? streamingMessage?.agentId : undefined)
  const senderName =
    sourceMessage?.metadata && typeof sourceMessage.metadata === 'object'
      ? ((sourceMessage.metadata as Record<string, unknown>).agentName as string | undefined)
      : messageId === streamingMessage?.id
        ? streamingMessage.agentName
        : undefined
  const senderAgent = workspaceAgents.find(
    (a) => a.id === senderId || (senderName && a.name.toLowerCase() === senderName.toLowerCase()),
  )

  const runtime = useMessage((message) =>
    role === 'assistant' ? codeAgentRuntimeFromParts(message.content) : null,
  )
  // 优先显示 workspace agent 头像
  if (role === 'assistant' && senderAgent) {
    return (
      <div
        className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full text-sm font-semibold text-white shadow-sm"
        style={{ background: senderAgent.color ?? '#111827' }}
      >
        {senderAgent.avatar ? (
          <img
            src={senderAgent.avatar}
            alt={senderAgent.name}
            className="h-full w-full bg-white object-contain"
            decoding="async"
            draggable={false}
          />
        ) : (
          senderAgent.name.slice(0, 1).toUpperCase()
        )}
      </div>
    )
  }

  if (role === 'assistant' && runtime) {
    return (
      <div
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-neutral-200 bg-white shadow-sm"
        title={codeAgentRuntimeLabel(runtime)}
      >
        <img
          src={codeAgentLogoSrc(runtime)}
          alt={codeAgentRuntimeLabel(runtime)}
          className="h-5 w-5 object-contain"
          decoding="async"
          draggable={false}
        />
      </div>
    )
  }

  if (role === 'user') {
    return <UserAvatar />
  }

  return (
    <div
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-full',
        role === 'assistant' ? 'bg-[#eef8f6] text-[#87a9a4]' : 'bg-blue-500 text-white',
      )}
    >
      {role === 'assistant' ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
    </div>
  )
}

function UserAvatar({
  profile,
  className,
}: {
  profile?: ReturnType<typeof getCachedAccountProfile>
  className?: string
}) {
  const resolvedProfile = profile ?? getCachedAccountProfile()
  const label = (resolvedProfile.name.trim().slice(0, 1) || 'Y').toUpperCase()

  return (
    <div
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-full bg-white text-sm font-semibold text-neutral-900 shadow-sm ring-1 ring-neutral-200',
        className ?? 'h-9 w-9',
      )}
      title={resolvedProfile.name || 'You'}
    >
      {resolvedProfile.avatar ? (
        <img
          src={resolvedProfile.avatar}
          alt={resolvedProfile.name || 'You'}
          className="h-full w-full bg-white object-contain"
          decoding="async"
          draggable={false}
        />
      ) : (
        label
      )}
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
      if (
        runtime === 'codex' ||
        runtime === 'claude-code' ||
        runtime === 'opencode' ||
        runtime === 'gemini'
      )
        return runtime
    }
    if (item.name === 'code_agent_run') {
      const runtime = (item.data as { runtime?: unknown } | null)?.runtime
      if (
        runtime === 'codex' ||
        runtime === 'claude-code' ||
        runtime === 'opencode' ||
        runtime === 'gemini'
      )
        return runtime
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

const ToolButton: FC<ComponentPropsWithoutRef<'button'>> = ({ className, ...props }) => (
  <button
    type="button"
    className={cn(
      'grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:pointer-events-none disabled:opacity-45',
      className,
    )}
    {...props}
  />
)

function renderMentionHighlights(text: string, agents: WorkspaceAgent[]) {
  const aliases = mentionAliases(agents)
  if (!aliases.length) return text

  const pattern = new RegExp(
    `@(${aliases.map(escapeRegExp).join('|')})(?=$|\\s|[，,。.!！?？:：；;）)\\]】])`,
    'gi',
  )
  const parts: ReactNode[] = []
  let lastIndex = 0

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > lastIndex) parts.push(text.slice(lastIndex, index))
    parts.push(
      <span key={`${index}-${match[0]}`} className="font-medium text-blue-600">
        {match[0]}
      </span>,
    )
    lastIndex = index + match[0].length
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts.length ? parts : text
}

function mentionAliases(agents: WorkspaceAgent[]) {
  const aliases: string[] = []
  for (const agent of agents) {
    aliases.push(agent.name, agent.role)
    if (agent.roleType === 'orchestrator') {
      aliases.push('orchestrator', 'coordinator', '总指挥', '协调器', '调度')
    }
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
      className,
    )}
    {...props}
  />
)

const CodePre: NonNullable<MarkdownComponents['pre']> = ({ className, node: _node, ...props }) => (
  <pre className={cn('agenthub-code-pre not-prose', className)} {...props} />
)

const CodeToken: NonNullable<MarkdownComponents['code']> = ({
  className,
  node: _node,
  ...props
}) => {
  const isBlock = className?.includes('agenthub-code') || className?.includes('language-')
  return (
    <code
      className={cn(isBlock ? 'agenthub-code' : 'agenthub-inline-code', className)}
      {...props}
    />
  )
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
      <button
        type="button"
        className="agenthub-code-copy"
        onClick={copyCode}
        title="Copy code"
        aria-label="Copy code"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}

const CodeSyntaxHighlighter: FC<SyntaxHighlighterProps> = ({
  components: { Pre, Code },
  language,
  code,
}) => {
  const normalizedLanguage = normalizeHighlightLanguage(language)
  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code])
  const highlightedLines = useMemo(
    () => lines.map((line) => highlightCode(line, normalizedLanguage)),
    [lines, normalizedLanguage],
  )
  const langLabel = normalizedLanguage || 'text'
  const filePath = guessFilePathFromLanguage(langLabel)
  const selection = useLineSelection(lines.length)

  const handleReference = useCallback(() => {
    const selected = selection.sortedSelected
    if (selected.length === 0) return
    const selectedLines = selected.map((i) => lines[i])
    const lineRange = selected.length === 1
      ? `第 ${selected[0] + 1} 行`
      : `第 ${selected[0] + 1}-${selected[selected.length - 1] + 1} 行`
    const header = filePath
      ? `\`${filePath}\` ${lineRange}:\n`
      : `${lineRange}:\n`
    const text = `${header}\`\`\`${langLabel}\n${selectedLines.join('\n')}\n\`\`\`\n`
    insertTextIntoComposer(text)
    selection.clearSelection()
  }, [selection, lines, filePath, langLabel])

  // Always render table layout with line numbers for consistent UX
  return (
    <div className="agenthub-code-block-wrapper">
      {selection.selectedCount > 0 && (
        <LineSelectionToolbar
          selectedCount={selection.selectedCount}
          onReference={handleReference}
          onClear={() => { selection.clearSelection() }}
        />
      )}
      <Pre className="agenthub-code-pre not-prose">
        <Code className={cn('agenthub-code', `language-${langLabel}`)}>
          <table className="agenthub-code-table">
            <tbody>
              {lines.map((_line, i) => (
                <tr
                  key={i}
                  className={selection.isSelected(i) ? 'agenthub-code-row-selected' : undefined}
                >
                  <td
                    className="agenthub-code-ln"
                    onClick={(e) => { selection.toggleLine(i, e.shiftKey) }}
                  >
                    {i + 1}
                  </td>
                  <td className="agenthub-code-content">
                    <span dangerouslySetInnerHTML={{ __html: highlightedLines[i] || '&nbsp;' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Code>
      </Pre>
    </div>
  )
}

/** Heuristic: try to extract a file path from the language label (e.g. "typescript // src/app.ts") */
function guessFilePathFromLanguage(langLabel: string): string | undefined {
  const match = langLabel.match(/^(.+?)\s+(?:\/\/\s*)?(.+\.\w+)$/)
  if (match) return match[2]
  // If the label itself looks like a file path
  if (langLabel.includes('/') || langLabel.includes('\\')) return langLabel
  return undefined
}

function normalizeHighlightLanguage(language: string | undefined) {
  const key = (language ?? '').toLowerCase().trim()
  if (
    !key ||
    key === 'unknown' ||
    key === 'text' ||
    key === 'txt' ||
    key === 'plain' ||
    key === 'plaintext'
  ) {
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

function normalizePreviewUrl(url?: string) {
  if (!url) return null
  try {
    return new URL(url, window.location.origin)
  } catch {
    return null
  }
}

function downloadFileName(item: ArtifactPreviewItem) {
  const source = item.path || normalizePreviewUrl(item.url)?.pathname || item.title || 'preview'
  const rawName = source.split(/[\\/]/).filter(Boolean).pop() || item.title || 'preview'
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(rawName)
  const fallbackExtension = item.mimeType?.includes('image/')
    ? item.mimeType.split('/').pop()
    : 'html'
  const name = hasExtension ? rawName : `${rawName}.${fallbackExtension || 'html'}`
  return sanitizeDownloadFileName(name)
}

function sanitizeDownloadFileName(value: string) {
  return (
    value
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'preview.html'
  )
}

function getPreviewPanelWidthBounds(panel: HTMLElement | null) {
  const containerWidth = panel?.parentElement?.clientWidth ?? window.innerWidth
  const reservedThreadWidth = Math.min(360, Math.max(280, Math.round(containerWidth * 0.38)))
  const maxWidth = Math.max(320, containerWidth - reservedThreadWidth)
  const minWidth = Math.min(420, maxWidth)
  return { maxWidth, minWidth }
}

function clampPreviewPanelWidth(width: number, bounds: { maxWidth: number; minWidth: number }) {
  return Math.min(bounds.maxWidth, Math.max(bounds.minWidth, width))
}

function readStoredPreviewPanelWidth() {
  const fallbackWidth = 520
  try {
    const storedWidth = Number(window.localStorage.getItem(previewPanelWidthStorageKey))
    return Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : fallbackWidth
  } catch {
    return fallbackWidth
  }
}

function storePreviewPanelWidth(width: number) {
  try {
    window.localStorage.setItem(previewPanelWidthStorageKey, String(Math.round(width)))
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

async function extractPreviewErrorMessage(response: Response) {
  const text = await response.text().catch(() => '')
  if (!text.trim()) return 'HTTP ' + response.status
  try {
    const parsed = JSON.parse(text)
    const payload = parsed?.error ?? parsed
    if (typeof payload === 'string') return payload
    if (payload && typeof payload === 'object') {
      return payload.message ?? payload.details?.message ?? text
    }
  } catch {
    // ignore
  }
  return text
}

function formatPreviewError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Preview request failed'
}
