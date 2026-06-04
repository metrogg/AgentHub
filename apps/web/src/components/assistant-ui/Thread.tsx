import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessage,
  useThread,
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
  Github,
  Globe2,
  ImagePlus,
  ListTodo,
  Loader2,
  Maximize2,
  MessageCircleReply,
  Minimize2,
  Monitor,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Rocket,
  Search,
  Shield,
  ShieldOff,
  Sheet,
  Square,
  TerminalSquare,
  TextQuote,
  Building2,
  Trash2,
  User,
  X,
  XCircle,
} from 'lucide-react'
import {
  type ClipboardEvent,
  type ComponentPropsWithoutRef,
  type DragEvent,
  type FC,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import { ClarificationCard } from '@/components/ClarificationCard'
import { requestConfirmDialog, requestNoticeDialog } from '../ConfirmDialog'
import DeliveryReport from '@/components/DeliveryReport'
import type { DeliveryReportData } from '@/components/DeliveryReport'
import { FileCard } from '@/components/FileCard'
import { VirtualList } from '../VirtualList'
import {
  api,
  friendlyErrorMessage,
  type AgentArtifact,
  type MemberProposal,
  type Message,
  type ModelCatalogItem,
  type QuotedMessagePreview,
  type SkillSummary,
  type WelcomeQuickPrompt,
  type Workspace,
  type WorkspaceAgent,
} from '../../lib/api'
import type { CodeAgentRunMetadata } from '@agenthub/shared'
import { codeAgentRuntimeLabel } from '../../lib/agentDisplay'
import {
  artifactFileUrl,
  artifactPreviewEvent,
  canFetchWorkspaceTextSource,
  clampPreviewPanelWidth,
  defaultPreviewPanelWidth,
  downloadFileName,
  enrichPreviewItem,
  extractPreviewErrorMessage,
  fileNameFromPath,
  formatPreviewError,
  getPreviewPanelWidthBounds,
  isDocxPreviewItem,
  isPptxPreviewItem,
  loadPreviewArrayBuffer,
  normalizePreviewUrl,
  previewFileName,
  previewPathFromUrl,
  readStoredPreviewPanelWidth,
  requestArtifactPreview,
  storePreviewPanelWidth,
  type ArtifactPreviewItem,
} from '../../lib/artifactPreview'
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
import { useMessageStyleMode } from '../../lib/messageStyle'
import { classifyAgentSession } from '../../lib/sessionTree'
import { cn, compactPath, formatBytes, trimLongText } from '../../lib/utils'
import {
  extractMentionedAgentIds,
  mentionAliasEntries,
  mentionPatternForAliases,
  readMentionCommand,
  readSlashCommand,
} from '../../lib/composerCommands'
import { getCachedAccountProfile } from '../../lib/accountProfile'
import {
  isProjectWorkspace,
  workspaceSearchText,
  workspaceSubtitle,
} from '../../lib/workspaceFilters'
import { useI18n } from '../../lib/i18n'
import {
  getCachedCodeAgentRunMetadata,
  type ThreadCodeAgentRunData,
} from '../../lib/runtime'
import { useChatStore } from '../../stores/chatStore'
import { buildHeaderAgentStatusProjection, type HeaderAgentStatusProjection } from '../../stores/chatStore'
import {
  QuickPromptBubbles,
  createQuickPromptSeed,
  rotateQuickPrompts,
} from '../chat/QuickPromptBubbles'
import { TypewriterHeading } from '../chat/TypewriterHeading'
import { GroupAvatar } from '../chat/GroupAvatar'
import { WorkspaceFileExplorer, type RailFileItem } from './WorkspaceFileExplorer'
import {
  ChatAttachmentsPart,
  PendingAttachmentList,
  attachmentInputAccept,
  fileToChatAttachment,
  isDragWithFiles,
  maxAttachmentBytes,
  maxPendingAttachments,
} from './ChatAttachments'
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
const composerSyncEvent = 'agenthub:composer-sync'
const roomTasksDrawerEvent = 'agenthub:open-room-tasks'

type PreviewActionItem = {
  id: string
  kind: 'open' | 'download'
  status: 'working' | 'success' | 'error'
  title: string
  detail: string
  path?: string
  folder?: string
}

type DiffEditSaveParams = {
  lineText: string
  lineNumber?: number
  fileContent?: string
}

export const Thread: FC = () => {
  const currentSession = useChatStore((state) => state.currentSession)
  const workspaceAgents = useChatStore((state) => state.currentWorkspaceAgents)
  const isGroupSession = currentSession?.type === 'group' && Boolean(currentSession.workspaceId)
  const sessionKind = classifyAgentSession(currentSession)
  const isAgentDirectSession = sessionKind === 'agent-direct'
  const taskBoard = useChatStore((s) => s.taskBoard)
  const agentActivity = useChatStore((s) => s.agentActivity)
  const messages = useChatStore((s) => s.messages)
  const streamingCodeAgentRun = useChatStore((s) => s.streamingCodeAgentRun)
  const visibleTaskBoard =
    taskBoard &&
    taskBoard.sessionId === currentSession?.id &&
    ['planning', 'running', 'synthesizing'].includes(taskBoard.status)
      ? taskBoard
      : null
  const selectedAgentTab = useChatStore((s) => s.selectedAgentTab)
  const agentTabs = useChatStore((s) => s.agentTabs)
  const railTaskBoard =
    taskBoard &&
    (taskBoard.sessionId === currentSession?.id ||
      agentTabs.some((tab) => tab.childSessionId === currentSession?.id))
      ? taskBoard
      : null
  const selectAgentTab = useChatStore((s) => s.selectAgentTab)
  const selectSession = useChatStore((s) => s.selectSession)
  const navigate = useNavigate()
  const planningActivity =
    isGroupSession &&
    selectedAgentTab === null &&
    agentActivity?.sessionId === currentSession?.id &&
    ['thinking', 'planning', 'synthesizing'].includes(agentActivity.phase ?? '')
      ? agentActivity
      : null
  const directActivity =
    !isGroupSession && agentActivity?.sessionId === currentSession?.id ? agentActivity : null
  const directRunProgress = useMemo(
    () =>
      isAgentDirectSession
        ? buildDirectRunProgress({
            activity: directActivity,
            agentName:
              currentSession?.workspaceAgentId
                ? (workspaceAgents.find((a) => a.id === currentSession.workspaceAgentId)?.name ??
                  currentSession.title)
                : currentSession?.title,
            messages,
            streamingRun: streamingCodeAgentRun,
          })
        : null,
    [
      currentSession?.title,
      currentSession?.workspaceAgentId,
      directActivity,
      isAgentDirectSession,
      messages,
      streamingCodeAgentRun,
      workspaceAgents,
    ],
  )
  const showContextRail = Boolean(
    currentSession?.workspaceId || railTaskBoard || planningActivity || directRunProgress,
  )
  const isOrchestratorTaskChild = sessionKind === 'orchestrator-task'
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false)
  const [groupTasksOpen, setGroupTasksOpen] = useState(false)
  const [childDetailsOpen, setChildDetailsOpen] = useState(false)
  const [previewItem, setPreviewItem] = useState<ArtifactPreviewItem | null>(null)
  const [previewCollapsed, setPreviewCollapsed] = useState(false)
  const threadViewportRef = useRef<HTMLDivElement>(null)
  const showInlineContextRail = !isGroupSession && showContextRail && (!previewItem || previewCollapsed)

  async function openGroupConversation() {
    selectAgentTab(null)
    const groupSessionId = taskBoard?.sessionId
    if (!groupSessionId) return
    await selectSession(groupSessionId)
    navigate(`/chat/${groupSessionId}`)
  }

  useEffect(() => {
    setGroupDetailsOpen(false)
    setGroupTasksOpen(false)
    setChildDetailsOpen(false)
  }, [currentSession?.id])

  useEffect(() => {
    function handlePreview(event: Event) {
      const item = (event as CustomEvent<ArtifactPreviewItem>).detail
      if (!item?.id) return
      const workspaceId = item.workspaceId ?? useChatStore.getState().currentSession?.workspaceId
      setPreviewItem(enrichPreviewItem(item, workspaceId ?? undefined))
      setPreviewCollapsed(false)
    }
    window.addEventListener(artifactPreviewEvent, handlePreview)
    return () => window.removeEventListener(artifactPreviewEvent, handlePreview)
  }, [])

  useEffect(() => {
    if (!isGroupSession) return
    function handleOpenRoomTasks() {
      setGroupTasksOpen(true)
    }
    window.addEventListener(roomTasksDrawerEvent, handleOpenRoomTasks)
    return () => window.removeEventListener(roomTasksDrawerEvent, handleOpenRoomTasks)
  }, [isGroupSession])

  return (
    <ThreadPrimitive.Root
      className="agenthub-thread-root relative flex h-full flex-col overflow-hidden bg-white"
      style={{ ['--thread-max-width' as string]: '56rem' }}
    >
      {isGroupSession && !isOrchestratorTaskChild && (
        <GroupChatHeader
          onToggleDetails={() => setGroupDetailsOpen((open) => !open)}
          previewCollapsed={previewCollapsed}
          previewAvailable={Boolean(previewItem)}
          onTogglePreview={() => setPreviewCollapsed((collapsed) => !collapsed)}
        />
      )}
      {isOrchestratorTaskChild && (
        <OrchestratorChildHeader
          agentName={
            currentSession?.workspaceAgentId
              ? (workspaceAgents.find((a) => a.id === currentSession.workspaceAgentId)?.name ??
                'Agent')
              : 'Agent'
          }
          onBack={() => void openGroupConversation()}
          previewCollapsed={previewCollapsed}
          previewAvailable={Boolean(previewItem)}
          onTogglePreview={() => setPreviewCollapsed((collapsed) => !collapsed)}
        />
      )}
      {!isGroupSession && !isOrchestratorTaskChild && isAgentDirectSession && (
        <AgentChatHeader
          onToggleDetails={() => setChildDetailsOpen((open) => !open)}
          previewCollapsed={previewCollapsed}
          previewAvailable={Boolean(previewItem)}
          onTogglePreview={() => setPreviewCollapsed((collapsed) => !collapsed)}
        />
      )}
      {!isGroupSession && !isOrchestratorTaskChild && !isAgentDirectSession && (
        <RegularChatHeader
          previewCollapsed={previewCollapsed}
          previewAvailable={Boolean(previewItem)}
          onTogglePreview={() => setPreviewCollapsed((collapsed) => !collapsed)}
        />
      )}
      <div className="flex min-h-0 flex-1 pt-14">
        <div className="flex min-w-0 flex-1 flex-col">
          {isGroupSession && selectedAgentTab === null && (visibleTaskBoard || planningActivity) && (
            <LeaderViewBanner
              taskBoard={visibleTaskBoard}
              agentTabs={agentTabs}
              activity={planningActivity}
              onOpenTasks={() => setGroupTasksOpen(true)}
            />
          )}
          <ThreadPrimitive.Viewport
            ref={threadViewportRef}
            className="agenthub-thread-viewport flex-1 overflow-y-auto overscroll-contain scroll-auto px-6"
          >
            <ThreadWelcome />
            <VirtualThreadMessages scrollRef={threadViewportRef} />
            <ThreadPrimitive.If empty={false}>
              <div className="min-h-28" />
            </ThreadPrimitive.If>
          </ThreadPrimitive.Viewport>
          <Composer />
        </div>
        {isGroupSession && (
          <RoomTaskDrawer
            open={groupTasksOpen}
            onClose={() => setGroupTasksOpen(false)}
            taskBoard={visibleTaskBoard}
            agentTabs={agentTabs}
            activity={planningActivity}
          />
        )}
        {previewItem && !previewCollapsed && (
          <ArtifactPreviewPanel item={previewItem} onClose={() => setPreviewItem(null)} />
        )}
        {showInlineContextRail && (
          <ThreadContextRail
            taskBoard={railTaskBoard}
            activity={planningActivity}
            directRunProgress={directRunProgress}
          />
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

type PreviewHeaderControlProps = {
  previewCollapsed?: boolean
  previewAvailable?: boolean
  onTogglePreview?: () => void
}

const HeaderPreviewButton: FC<PreviewHeaderControlProps> = ({
  previewCollapsed = false,
  previewAvailable = false,
  onTogglePreview,
}) => {
  if (!onTogglePreview) return null

  const label = previewAvailable
    ? previewCollapsed
      ? '展开预览'
      : '收起预览'
    : '暂无预览'

  return (
    <button
      type="button"
      onClick={onTogglePreview}
      disabled={!previewAvailable}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-neutral-500"
      title={label}
      aria-label={label}
    >
      {previewCollapsed ? (
        <PanelRightOpen className="h-4 w-4" />
      ) : (
        <PanelRightClose className="h-4 w-4" />
      )}
    </button>
  )
}

const HeaderAgentStatusIndicator: FC = () => {
  const status = useHeaderAgentStatus()

  return (
    <div
      className={cn(
        'agenthub-agent-status hidden max-w-[18rem] items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium md:inline-flex',
        status.tone === 'idle' && 'agenthub-agent-status-idle',
        status.tone === 'thinking' && 'agenthub-agent-status-thinking',
        status.tone === 'working' && 'agenthub-agent-status-working',
        status.tone === 'synthesizing' && 'agenthub-agent-status-synthesizing',
        status.tone === 'warning' && 'agenthub-agent-status-warning',
      )}
      data-live={status.live ? 'true' : 'false'}
      title={status.detail ? `${status.label} · ${status.detail}` : status.label}
      aria-label={status.detail ? `Agent 状态：${status.label}，${status.detail}` : `Agent 状态：${status.label}`}
    >
      <span className="agenthub-agent-status-dot" aria-hidden="true" />
      <span className="shrink-0">{status.label}</span>
      {status.detail && (
        <span className="hidden min-w-0 truncate font-normal opacity-70 xl:inline">
          {status.detail}
        </span>
      )}
    </div>
  )
}

const VirtualThreadMessages: FC<{ scrollRef: RefObject<HTMLDivElement> }> = ({ scrollRef }) => {
  const messageCount = useThread((state) => state.messages.length)
  const sourceMessages = useChatStore((state) => state.messages)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const agentTyping = useChatStore((state) => state.agentTyping)
  const items = useMemo(() => Array.from({ length: messageCount }, (_, index) => index), [messageCount])
  const components = useMemo(
    () => ({ UserMessage, AssistantMessage, SystemMessage }),
    [],
  )

  return (
    <VirtualList
      className="agenthub-thread-virtual-list"
      scrollRef={scrollRef}
      items={items}
      getKey={(index) =>
        sourceMessages[index]?.id ??
        (index === sourceMessages.length && streamingMessage?.id) ??
        (index === sourceMessages.length && agentTyping ? 'agenthub-thinking' : `message-${index}`)
      }
      estimateSize={(index) => estimateThreadMessageHeight(sourceMessages[index])}
      overscanPx={1600}
      renderItem={(index) => (
        <ThreadPrimitive.MessageByIndex
          index={index}
          components={components}
        />
      )}
    />
  )
}

function estimateThreadMessageHeight(message?: Message) {
  if (!message) return 120
  const contentLength = (message.content ?? '').length
  const lineCount = Math.max(1, Math.ceil(contentLength / 80))
  let height = 72 + Math.min(520, lineCount * 24)
  const metadata = message.metadata ?? {}
  if (metadata.codeAgentRun) height += 240
  if (metadata.artifacts || metadata.file_card || metadata.delivery_report) height += 150
  if (metadata.attachments) height += 96
  if (message.type === 'task_board') height += 320
  return height
}

function useHeaderAgentStatus(): HeaderAgentStatusProjection {
  const currentSession = useChatStore((state) => state.currentSession)
  const agentTyping = useChatStore((state) => state.agentTyping)
  const agentActivity = useChatStore((state) => state.agentActivity)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const streamingCodeAgentRun = useChatStore((state) => state.streamingCodeAgentRun)
  const taskBoard = useChatStore((state) => state.taskBoard)
  const agentTabs = useChatStore((state) => state.agentTabs)
  return buildHeaderAgentStatusProjection({
    sessionId: currentSession?.id ?? null,
    taskBoard,
    agentTabs,
    agentTyping,
    agentActivity,
    streamingMessage,
    streamingCodeAgentRun,
  })
}

const GroupChatHeader: FC<PreviewHeaderControlProps & { onToggleDetails: () => void }> = ({
  onToggleDetails,
  previewCollapsed,
  previewAvailable,
  onTogglePreview,
}) => {
  const session = useChatStore((state) => state.currentSession)
  const workspace = useChatStore((state) => state.currentWorkspace)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const clearMessages = useChatStore((state) => state.clearMessages)
  const navigate = useNavigate()
  const title = groupChatDisplayTitle(session?.title, workspace?.name)
  const memberCount = agents.length + 1

  async function handleClear() {
    if (!session) return
    if (!window.confirm('确定清空当前会话的所有消息？此操作不可撤销。')) return
    await clearMessages(session.id)
  }

  return (
    <header className="agenthub-thread-header flex h-14 shrink-0 items-center justify-between gap-3 bg-[#f8f8f5] pb-0 pl-[calc(1.25rem+var(--agenthub-thread-header-left-offset,0rem))] pr-5 pt-0 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        <GroupAvatar agents={agents} size="md" title={title} />
        <div className="flex min-w-0 items-center text-sm">
          <span className="truncate font-semibold text-neutral-950">{title}</span>
          <span className="ml-1 shrink-0 font-normal text-neutral-500">({memberCount})</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <HeaderAgentStatusIndicator />
        <button
          type="button"
          onClick={onToggleDetails}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
          title="群聊详情"
          aria-label="群聊详情"
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => navigate(`/office?session=${session?.id ?? ''}`)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-400 transition hover:bg-emerald-50 hover:text-emerald-600"
          title="办公室"
          aria-label="办公室"
        >
          <Building2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-400 transition hover:bg-red-50 hover:text-red-500"
          title="清空消息"
          aria-label="清空消息"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <HeaderPreviewButton
          previewCollapsed={previewCollapsed}
          previewAvailable={previewAvailable}
          onTogglePreview={onTogglePreview}
        />
      </div>
    </header>
  )
}

const AgentChatHeader: FC<PreviewHeaderControlProps & { onToggleDetails: () => void }> = ({
  onToggleDetails,
  previewCollapsed,
  previewAvailable,
  onTogglePreview,
}) => {
  const session = useChatStore((state) => state.currentSession)
  const workspace = useChatStore((state) => state.currentWorkspace)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const agent = agents.find((item) => item.id === session?.workspaceAgentId)
  const title = agent?.name || session?.title || 'Agent'
  const subtitle = [agent?.role, workspace?.name].filter(Boolean).join(' · ') || '单 Agent 会话'
  const navigate = useNavigate()

  return (
    <header className="agenthub-thread-header flex h-14 shrink-0 items-center justify-between gap-3 bg-[#f8f8f5] pb-0 pl-[calc(1.25rem+var(--agenthub-thread-header-left-offset,0rem))] pr-5 pt-0 backdrop-blur">
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
      <div className="flex items-center gap-1">
        <HeaderAgentStatusIndicator />
        <button
          type="button"
          onClick={onToggleDetails}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
          title="Agent 设置"
          aria-label="Agent 设置"
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => navigate(`/office?session=${session?.id ?? ''}`)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-400 transition hover:bg-emerald-50 hover:text-emerald-600"
          title="办公室"
          aria-label="办公室"
        >
          <Building2 className="h-4 w-4" />
        </button>
        <HeaderPreviewButton
          previewCollapsed={previewCollapsed}
          previewAvailable={previewAvailable}
          onTogglePreview={onTogglePreview}
        />
      </div>
    </header>
  )
}

const OrchestratorChildHeader: FC<
  PreviewHeaderControlProps & { agentName: string; onBack: () => void }
> = ({
  agentName,
  onBack,
  previewCollapsed,
  previewAvailable,
  onTogglePreview,
}) => {
  const session = useChatStore((state) => state.currentSession)
  const navigate = useNavigate()

  return (
    <header className="agenthub-thread-header flex h-14 shrink-0 items-center justify-between gap-3 bg-[#f8f8f5] pb-0 pl-[calc(1.25rem+var(--agenthub-thread-header-left-offset,0rem))] pr-5 pt-0 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={onBack}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-950"
          title="返回主对话"
          aria-label="返回主对话"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-sm truncate">
          <span className="font-medium text-neutral-700">{agentName}</span>
          <span className="ml-1.5 text-xs text-neutral-400">成员对话</span>
        </span>
      </div>
      <div className="flex items-center gap-1">
        <HeaderAgentStatusIndicator />
        <button
          type="button"
          onClick={() => navigate(`/office?session=${session?.id ?? ''}`)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-400 transition hover:bg-emerald-50 hover:text-emerald-600"
          title="办公室"
          aria-label="办公室"
        >
          <Building2 className="h-4 w-4" />
        </button>
        <HeaderPreviewButton
          previewCollapsed={previewCollapsed}
          previewAvailable={previewAvailable}
          onTogglePreview={onTogglePreview}
        />
      </div>
    </header>
  )
}

const RegularChatHeader: FC<PreviewHeaderControlProps> = ({
  previewCollapsed,
  previewAvailable,
  onTogglePreview,
}) => {
  const session = useChatStore((state) => state.currentSession)
  const navigate = useNavigate()
  const title = session?.title || '新会话'

  return (
    <header className="agenthub-thread-header flex h-14 shrink-0 items-center justify-between gap-3 bg-[#f8f8f5] pb-0 pl-[calc(1.25rem+var(--agenthub-thread-header-left-offset,0rem))] pr-5 pt-0 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="truncate text-sm font-semibold text-neutral-950">{title}</span>
      </div>
      <div className="flex items-center gap-1">
        <HeaderAgentStatusIndicator />
        <button
          type="button"
          onClick={() => navigate(`/office?session=${session?.id ?? ''}`)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-neutral-400 transition hover:bg-emerald-50 hover:text-emerald-600"
          title="办公室"
          aria-label="办公室"
        >
          <Building2 className="h-4 w-4" />
        </button>
        <HeaderPreviewButton
          previewCollapsed={previewCollapsed}
          previewAvailable={previewAvailable}
          onTogglePreview={onTogglePreview}
        />
      </div>
    </header>
  )
}

interface LeaderViewBannerProps {
  taskBoard: ReturnType<typeof useChatStore.getState>['taskBoard']
  agentTabs: ReturnType<typeof useChatStore.getState>['agentTabs']
  activity: LiveAgentActivity | null
  onOpenTasks: () => void
}

const LeaderViewBanner: FC<LeaderViewBannerProps> = ({
  taskBoard,
  agentTabs,
  activity,
  onOpenTasks,
}) => {
  const runningCount = agentTabs.filter((t) => t.status === 'running').length
  const doneCount = agentTabs.filter((t) => t.status === 'done').length
  const failedCount = agentTabs.filter((t) => t.status === 'failed').length
  const title = taskBoard?.title || taskBoard?.goal || 'Manager 正在组织协作'
  const phaseLabel = taskBoard
    ? runStatusLabel[taskBoard.status] ?? taskBoard.status
    : activity?.phase === 'synthesizing'
      ? '汇总中'
      : activity?.phase === 'planning'
        ? '规划中'
        : '理解中'

  return (
    <div className="shrink-0 border-b border-neutral-100 bg-[#fcfcfb] px-6 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-neutral-700">
          <Bot className="h-3.5 w-3.5 text-blue-600" />
          <span className="font-medium">房间动态</span>
        </span>
        <span className="max-w-[24rem] truncate text-neutral-600" title={title}>
          {title}
        </span>
        <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-blue-700">
          {phaseLabel}
        </span>
        {runningCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-blue-600">
            <Loader2 className="h-3 w-3 animate-spin" />
            {runningCount} 位成员忙碌中
          </span>
        )}
        {doneCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-green-600">
            <CheckCircle2 className="w-3 h-3" />
            {doneCount} 段结果已落地
          </span>
        )}
        {failedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-red-600">
            <XCircle className="w-3 h-3" />
            {failedCount} 处异常
          </span>
        )}
        <span className="text-xs text-neutral-400">{agentTabs.length} 位协作者</span>
        <button
          type="button"
          onClick={onOpenTasks}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-600 transition hover:border-blue-200 hover:text-blue-700"
        >
          <ListTodo className="h-3.5 w-3.5" />
          任务与线程
        </button>
      </div>
    </div>
  )
}

type LiveTaskBoard = NonNullable<ReturnType<typeof useChatStore.getState>['taskBoard']>
type LiveAgentActivity = NonNullable<ReturnType<typeof useChatStore.getState>['agentActivity']>
type DirectRunStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
type DirectRunProgress = {
  agentName?: string
  done: number
  percent: number
  run: CodeAgentRunMetadata
  status: CodeAgentRunMetadata['status']
  steps: Array<{
    id: string
    status: DirectRunStepStatus
    title: string
    subtitle?: string
    detail?: string
  }>
  subtitle: string
  total: number
}

const ThreadContextRail: FC<{
  taskBoard: LiveTaskBoard | null
  activity: LiveAgentActivity | null
  directRunProgress?: DirectRunProgress | null
}> = ({ taskBoard, activity, directRunProgress }) => {
  const workspace = useChatStore((state) => state.currentWorkspace)
  const [progressOpen, setProgressOpen] = useState(true)
  const [workspaceOpen, setWorkspaceOpen] = useState(true)
  const stats = taskProgressStats(taskBoard)
  const files = useMemo(
    () =>
      directRunProgress && !taskBoard
        ? collectDirectRunFiles(directRunProgress, workspace)
        : collectRailFiles(taskBoard, workspace),
    [directRunProgress, taskBoard, workspace?.projectPath],
  )
  const activeTask =
    taskBoard?.tasks.find((task) => task.status === 'running') ??
    taskBoard?.tasks.find((task) => task.status === 'pending') ??
    taskBoard?.tasks[0]
  const workspaceName =
    workspace?.name ||
    (workspace?.projectPath ? workspaceNameFromPath(workspace.projectPath) : 'AgentHub')
  const workspacePath = workspace?.projectPath ?? null
  const progressPercent = taskBoard
    ? stats.percent
    : directRunProgress
      ? directRunProgress.percent
      : activity
        ? 18
        : 0
  const hasProgress = Boolean(taskBoard || directRunProgress || activity)

  return (
    <aside className="agenthub-context-rail pointer-events-none hidden h-full w-[18.5rem] shrink-0 bg-transparent px-5 pb-4 pt-4 lg:block xl:w-[19.5rem] xl:px-8">
      <div className="pointer-events-none max-h-full overflow-visible bg-transparent">
        <div className="flex w-full flex-col gap-3 bg-transparent">
        {hasProgress && (
          <RailCard
            title="进度"
            subtitle={directRunProgress?.subtitle}
            open={progressOpen}
            onToggle={() => setProgressOpen((open) => !open)}
          >
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-[11px] text-neutral-500">
                  <span>
                    {directRunProgress
                      ? `${directRunProgress.done}/${directRunProgress.total} 完成`
                      : `${stats.done}/${stats.total || 0} 完成`}
                  </span>
                  <span>{progressPercent}%</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className="h-full rounded-full bg-neutral-900 transition-all duration-500"
                    style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
                  />
                </div>
              </div>

              {directRunProgress ? (
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-neutral-500">任务规划</div>
                  {directRunProgress.steps.slice(0, 6).map((step) => (
                    <div
                      key={step.id}
                      className="flex items-start gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2.5"
                    >
                      <div className="mt-0.5 shrink-0">{directRunStepIcon(step.status)}</div>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-neutral-800">
                          {step.title}
                        </div>
                        {step.subtitle && (
                          <div className="mt-0.5 truncate text-[11px] text-neutral-500">
                            {step.subtitle}
                          </div>
                        )}
                        {step.detail && (
                          <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-neutral-500">
                            {step.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : activeTask ? (
                <div className="flex items-start gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2.5">
                  <div className="mt-0.5 shrink-0">{taskStatusIcon(activeTask.status)}</div>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-neutral-800">
                      {activeTask.title}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-neutral-500">
                      {activeTask.progressStatus || activeTask.agentName || '等待成员执行'}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </RailCard>
        )}

        <RailCard
          title="工作文件夹"
          subtitle={workspacePath ? compactPath(workspacePath) ?? workspaceName : '当前项目与产物'}
          open={workspaceOpen}
          onToggle={() => setWorkspaceOpen((open) => !open)}
        >
          <WorkspaceFileExplorer workspace={workspace} quickFiles={files} />
        </RailCard>
        </div>
      </div>
    </aside>
  )
}

const RailCard: FC<{
  title: string
  subtitle?: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}> = ({ title, subtitle, open, onToggle, children }) => (
  <section className="agenthub-rail-card pointer-events-auto rounded-2xl border border-neutral-200 bg-white/95 px-4 py-3.5 backdrop-blur">
    <button
      type="button"
      className="flex w-full items-start justify-between gap-3 text-left"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-neutral-950">{title}</span>
        {subtitle && <span className="mt-1 block truncate text-xs text-neutral-500">{subtitle}</span>}
      </span>
      <ChevronDown
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0 text-neutral-400 transition-transform',
          !open && '-rotate-90',
        )}
      />
    </button>
    {open && <div className="mt-3">{children}</div>}
  </section>
)

function buildDirectRunProgress(input: {
  activity: LiveAgentActivity | null
  agentName?: string | null
  messages: Message[]
  streamingRun: CodeAgentRunMetadata | null
}): DirectRunProgress | null {
  const run = input.streamingRun ?? latestCodeAgentRunFromMessages(input.messages)
  if (!run) return null

  const steps = buildDirectRunSteps(run)
  if (!steps.length) return null

  const total = steps.length
  const done = steps.filter((step) =>
    step.status === 'done' || step.status === 'failed' || step.status === 'cancelled',
  ).length
  const rawPercent = Math.round((done / total) * 100)
  const percent =
    run.status === 'running'
      ? Math.min(95, Math.max(8, rawPercent))
      : run.status === 'completed'
        ? 100
        : Math.max(rawPercent, 100)
  const summary = [
    codeAgentRuntimeLabel(run.runtime),
    codeAgentStatusLabel(run.status, Boolean(run.partialSuccess)),
    input.agentName || input.activity?.agentName,
  ].filter(Boolean).join(' · ')

  return {
    agentName: input.agentName ?? input.activity?.agentName,
    done,
    percent,
    run,
    status: run.status,
    steps,
    subtitle: summary,
    total,
  }
}

function latestCodeAgentRunFromMessages(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index]?.metadata?.codeAgentRun
    if (isCodeAgentRunMetadataLike(value)) return value
  }
  return null
}

function isCodeAgentRunMetadataLike(value: unknown): value is CodeAgentRunMetadata {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { type?: unknown }).type === 'code-agent-run' &&
      typeof (value as { status?: unknown }).status === 'string' &&
      typeof (value as { runtime?: unknown }).runtime === 'string',
  )
}

function buildDirectRunSteps(run: CodeAgentRunMetadata): DirectRunProgress['steps'] {
  const steps = run.steps ?? []
  if (steps.length) {
    const rows = steps
      .filter((step) => step.kind !== 'log')
      .map((step) => ({
        detail: step.detail ? trimLongText(step.detail, 120) : undefined,
        id: step.id,
        status: directRunStatusFromCodeAgent(step.status),
        subtitle: [
          step.subtitle,
          step.toolName,
          step.command,
          step.path ? compactPath(step.path) : null,
          step.fileStatus ? fileStatusLabel(step.fileStatus) : null,
        ].filter(Boolean).join(' · ') || undefined,
        title: step.title,
      }))
    const logSteps = steps.filter((step) => step.kind === 'log')
    if (logSteps.length) {
      const lastLog = logSteps[logSteps.length - 1]
      rows.push({
        detail: lastLog.detail ? trimLongText(lastLog.detail, 120) : undefined,
        id: 'direct-log-summary',
        status: logSteps.some((step) => step.status === 'failed') ? 'failed' : 'done',
        subtitle: `${logSteps.length} 条运行日志`,
        title: '整理过程输出',
      })
    }
    return rows
  }

  const inferred: DirectRunProgress['steps'] = [
    {
      detail: run.cwd ? compactPath(run.cwd) ?? run.cwd : undefined,
      id: 'direct-start',
      status: run.status === 'running' ? 'running' : directRunStatusFromCodeAgent(run.status),
      subtitle: [codeAgentRuntimeLabel(run.runtime), run.command].filter(Boolean).join(' · '),
      title: '启动 Coding Tools',
    },
  ]

  for (const command of (run.commands ?? []).slice(0, 3)) {
    inferred.push({
      detail: command.output ? trimLongText(command.output, 120) : undefined,
      id: `direct-command-${command.id}`,
      status: 'done',
      subtitle: command.cwd ? compactPath(command.cwd) ?? command.cwd : undefined,
      title: command.command,
    })
  }

  for (const call of (run.toolCalls ?? []).slice(0, 3)) {
    inferred.push({
      detail: call.detail ? trimLongText(call.detail, 120) : undefined,
      id: `direct-tool-${call.id}`,
      status: 'done',
      subtitle: [call.name, call.target].filter(Boolean).join(' · ') || undefined,
      title: call.label,
    })
  }

  for (const file of (run.files ?? []).slice(0, 4)) {
    inferred.push({
      id: `direct-file-${file.path}`,
      status: directRunStatusFromCodeAgent(run.status === 'running' ? 'running' : 'completed'),
      subtitle: fileStatusLabel(file.status),
      title: compactPath(file.path) ?? file.path,
    })
  }

  const artifacts = readFlowArtifacts(run.artifacts)
  if (artifacts.length) {
    inferred.push({
      id: 'direct-artifacts',
      status: directRunStatusFromCodeAgent(run.status === 'running' ? 'running' : 'completed'),
      subtitle: `${artifacts.length} 个产物`,
      title: '汇总产物',
    })
  }

  if (run.status !== 'running') {
    inferred.push({
      detail: run.finalMessage ? trimLongText(run.finalMessage, 120) : undefined,
      id: 'direct-finish',
      status: directRunStatusFromCodeAgent(run.status),
      title: codeAgentStatusLabel(run.status, Boolean(run.partialSuccess)),
    })
  }

  return inferred
}

function directRunStatusFromCodeAgent(status: CodeAgentRunMetadata['status']): DirectRunStepStatus {
  if (status === 'running') return 'running'
  if (status === 'failed' || status === 'timed-out') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'done'
}

function directRunStepIcon(status: DirectRunStepStatus) {
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
  if (status === 'failed') return <XCircle className="h-4 w-4 text-red-600" />
  if (status === 'cancelled') return <Square className="h-4 w-4 text-neutral-400" />
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-green-600" />
  return <Clock3 className="h-4 w-4 text-neutral-400" />
}

function taskProgressStats(taskBoard: LiveTaskBoard | null) {
  const tasks = taskBoard?.tasks ?? []
  const done = tasks.filter((task) => task.status === 'done').length
  const finished =
    done +
    tasks.filter((task) =>
      ['failed', 'blocked', 'cancelled'].includes(task.status),
    ).length
  return {
    done,
    total: tasks.length,
    percent: tasks.length ? Math.round((finished / tasks.length) * 100) : 0,
  }
}

function activityLabel(activity: LiveAgentActivity | null) {
  if (activity?.phase === 'thinking') return '理解中'
  if (activity?.phase === 'planning') return '规划中'
  if (activity?.phase === 'synthesizing') return '汇总中'
  return '未开始'
}

function collectRailFiles(
  taskBoard: LiveTaskBoard | null,
  workspace: Workspace | null,
): RailFileItem[] {
  const files: RailFileItem[] = []
  const seen = new Set<string>()
  const workspacePath = workspace?.projectPath ?? null

  for (const task of taskBoard?.tasks ?? []) {
    for (const artifact of task.artifacts ?? []) {
      const rawPath = artifact.filePath ?? undefined
      const rawUrl = artifact.url ?? undefined
      const key = artifact.artifactId ?? artifact.id ?? rawPath ?? rawUrl ?? artifact.title
      if (!key || seen.has(key)) continue
      seen.add(key)

      const path = rawPath ? resolveWorkspacePath(rawPath, workspacePath) : undefined
      const title =
        artifact.title ||
        fileNameFromPath(rawPath) ||
        fileNameFromPath(rawUrl) ||
        task.title ||
        '任务产物'

      files.push({
        id: key,
        kind: railPreviewKind(artifact.type ?? artifact.kind, rawPath, rawUrl),
        path,
        source: artifact.source,
        title,
        url: rawUrl,
      })
    }
  }

  return files.slice(0, 4)
}

function collectDirectRunFiles(
  progress: DirectRunProgress,
  workspace: Workspace | null,
): RailFileItem[] {
  const files: RailFileItem[] = []
  const seen = new Set<string>()
  const workspacePath = workspace?.projectPath ?? progress.run.cwd ?? null

  const addFile = (item: RailFileItem) => {
    const key = item.path ?? item.url ?? item.id
    if (!key || seen.has(key)) return
    seen.add(key)
    files.push(item)
  }

  for (const artifact of readFlowArtifacts(progress.run.artifacts)) {
    const preview = previewItemFromArtifact(artifact)
    const rawPath =
      artifact.type === 'diff'
        ? artifact.filePath
        : artifact.type === 'file'
          ? artifact.path
          : undefined
    const path = rawPath ? resolveWorkspacePath(rawPath, workspacePath) : preview.path
    addFile({
      id: artifact.id,
      kind: preview.kind,
      path,
      source: preview.source,
      title: preview.title,
      url: preview.url,
    })
  }

  for (const file of progress.run.files ?? []) {
    addFile({
      id: `direct-run-file-${file.path}`,
      kind: file.diff ? 'diff' : railPreviewKind(undefined, file.path),
      path: resolveWorkspacePath(file.path, workspacePath),
      source: file.diff,
      title: fileNameFromPath(file.path) ?? file.path,
    })
  }

  return files.slice(0, 4)
}

function railPreviewKind(
  artifactKind?: string,
  path?: string,
  url?: string,
): ArtifactPreviewItem['kind'] {
  if (artifactKind === 'diff') return 'diff'
  if (artifactKind === 'deploy') return 'deploy'
  if (artifactKind === 'workflow') return 'workflow'
  if (artifactKind === 'preview' || url) return 'web'
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(path ?? '')) return 'image'
  return 'file'
}

function resolveWorkspacePath(path: string, workspacePath?: string | null) {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) {
    return path
  }
  if (!workspacePath) return path
  return `${workspacePath.replace(/[\\/]+$/, '')}\\${path.replace(/^[\\/]+/, '')}`
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
  assigned: '已分配',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消',
}

function taskStatusClass(status: string) {
  if (status === 'assigned') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'running') return 'border-blue-200 bg-blue-50 text-blue-700'
  if (status === 'done') return 'border-green-200 bg-green-50 text-green-700'
  if (status === 'failed' || status === 'blocked') return 'border-red-200 bg-red-50 text-red-700'
  return 'border-neutral-200 bg-white text-neutral-500'
}

function taskStatusIcon(status: string) {
  if (status === 'assigned') return <Clock3 className="h-4 w-4 text-amber-600" />
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-green-600" />
  if (status === 'failed' || status === 'blocked')
    return <XCircle className="h-4 w-4 text-red-600" />
  return <Clock3 className="h-4 w-4 text-neutral-400" />
}

function TaskRuntimeStrip({
  executionConfig,
}: {
  executionConfig?: {
    runtimeType?: string
    adapterName?: string
    codeAgentType?: string
    command?: string
    modelLabel?: string
    modelId?: string | null
    modelProvider?: string | null
    baseUrlHost?: string | null
    readinessStatus?: string
    sandboxProvider?: string
    isolation?: string
    sandboxPolicy?: string
    workdirRelativePath?: string | null
    executionPath?: string | null
  }
}) {
  if (!executionConfig) return null
  const runtime =
    executionConfig.adapterName ||
    executionConfig.codeAgentType ||
    (executionConfig.runtimeType === 'llm' ? 'LLM fallback' : executionConfig.runtimeType)
  const model = executionConfig.modelLabel || executionConfig.modelId
  const sandbox = [
    executionConfig.sandboxProvider,
    executionConfig.isolation,
    executionConfig.sandboxPolicy,
  ]
    .filter(Boolean)
    .join('/')
  const workdir = executionConfig.workdirRelativePath || compactPath(executionConfig.executionPath)
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
      {runtime && (
        <span className="inline-flex max-w-full items-center gap-1 rounded border border-neutral-200 bg-neutral-50 px-1.5 py-0.5">
          <TerminalSquare className="h-3 w-3 shrink-0" />
          <span className="truncate">{runtime}</span>
        </span>
      )}
      {model && (
        <span className="max-w-[180px] truncate rounded border border-neutral-200 bg-white px-1.5 py-0.5">
          {model}
        </span>
      )}
      {executionConfig.baseUrlHost && (
        <span className="max-w-[150px] truncate rounded border border-neutral-200 bg-white px-1.5 py-0.5">
          {executionConfig.baseUrlHost}
        </span>
      )}
      {sandbox && (
        <span className="max-w-[170px] truncate rounded border border-neutral-200 bg-white px-1.5 py-0.5">
          {sandbox}
        </span>
      )}
      {workdir && (
        <span className="max-w-[220px] truncate rounded border border-neutral-200 bg-white px-1.5 py-0.5">
          {workdir}
        </span>
      )}
      {executionConfig.readinessStatus === 'blocked' && (
        <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-red-700">
          blocked
        </span>
      )}
    </div>
  )
}

type RoomThreadSection = {
  id: string
  title: string
  tasks: LiveTaskBoard['tasks']
}

function taskArtifactPreviewItem(
  artifact: NonNullable<LiveTaskBoard['tasks'][number]['artifacts']>[number],
  taskId: string,
  index: number,
): ArtifactPreviewItem {
  const title = artifact.title || artifact.filePath || artifact.url || `产物 ${index + 1}`
  const kind: ArtifactPreviewItem['kind'] =
    artifact.type === 'diff'
      ? 'diff'
      : artifact.type === 'preview'
        ? 'web'
        : artifact.type === 'deploy'
          ? 'deploy'
          : artifact.type === 'workflow'
            ? 'workflow'
            : artifact.url
              ? 'web'
              : /\.(png|jpg|jpeg|webp|gif)$/i.test(artifact.filePath ?? '')
                ? 'image'
                : 'file'
  return {
    id:
      artifact.artifactId ??
      artifact.id ??
      artifact.filePath ??
      artifact.url ??
      `${taskId}-${index}`,
    title,
    kind,
    url: artifact.url ?? undefined,
    path: artifact.filePath ?? undefined,
    source: artifact.source ?? undefined,
  }
}

function buildRoomThreadSections(tasks: LiveTaskBoard['tasks']): RoomThreadSection[] {
  const running = tasks.filter((task) => task.status === 'running')
  const queued = tasks.filter((task) => ['pending', 'assigned'].includes(task.status))
  const done = tasks.filter((task) => task.status === 'done')
  const issues = tasks.filter((task) => ['failed', 'blocked', 'cancelled'].includes(task.status))
  return [
    { id: 'running', title: '进行中的线程', tasks: running },
    { id: 'queued', title: '等待中的线程', tasks: queued },
    { id: 'done', title: '已完成的线程', tasks: done },
    { id: 'issues', title: '异常与受阻', tasks: issues },
  ].filter((section) => section.tasks.length > 0)
}

const RoomTaskDrawer: FC<{
  open: boolean
  onClose: () => void
  taskBoard: LiveTaskBoard | null
  agentTabs: ReturnType<typeof useChatStore.getState>['agentTabs']
  activity: LiveAgentActivity | null
}> = ({ open, onClose, taskBoard, agentTabs, activity }) => {
  const selectAgentTab = useChatStore((state) => state.selectAgentTab)
  const selectSession = useChatStore((state) => state.selectSession)
  const navigate = useNavigate()
  const [pendingChildNoticeTaskId, setPendingChildNoticeTaskId] = useState<string | null>(null)
  const title = taskBoard?.title || taskBoard?.goal || '房间任务'
  const subtitle = taskBoard
    ? `${runStatusLabel[taskBoard.status] ?? taskBoard.status} · ${taskBoard.tasks.length} 个线程`
    : activity
      ? `${activity.agentName ?? 'Manager'} ${activityLabel(activity)}`
      : '当前没有进行中的协作任务'
  const stats = taskProgressStats(taskBoard)
  const tasks = taskBoard?.tasks ?? []
  const sections = useMemo(() => buildRoomThreadSections(tasks), [tasks])
  const runningCount = tasks.filter((task) => task.status === 'running').length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const issueCount = tasks.filter((task) =>
    ['failed', 'blocked', 'cancelled'].includes(task.status),
  ).length
  const artifactCount = tasks.reduce(
    (total, task) => total + (task.artifactCount ?? task.artifacts?.length ?? 0),
    0,
  )
  const newestArtifacts = tasks
    .flatMap((task) =>
      (task.artifacts ?? []).map((artifact, index) => ({
        item: taskArtifactPreviewItem(artifact, task.id, index),
        taskTitle: task.title,
      })),
    )
    .slice(0, 6)

  async function openChildSession(taskId: string, childSessionId?: string | null) {
    if (!childSessionId) {
      setPendingChildNoticeTaskId(taskId)
      window.setTimeout(() => {
        setPendingChildNoticeTaskId((current) => (current === taskId ? null : current))
      }, 1800)
      return
    }
    selectAgentTab(taskId)
    await selectSession(childSessionId)
    navigate(`/chat/${childSessionId}`)
  }

  return (
    <div
      className={cn(
        'absolute inset-0 z-30 flex justify-end overflow-hidden transition',
        open ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="关闭任务抽屉"
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-black/5 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />
      <aside
        className={cn(
          'relative h-full w-[440px] max-w-[94vw] border-l border-neutral-200 bg-[#FBFBFB] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-neutral-200 bg-white px-5 py-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-neutral-950">房间线程</div>
              <div className="mt-1 truncate text-xs text-neutral-500" title={title}>
                {title}
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">{subtitle}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-neutral-100 text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-900"
              title="关闭"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {!taskBoard ? (
              <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-blue-600 ring-1 ring-blue-100">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-neutral-900">
                        {activity?.agentName ?? 'Manager'} {activityLabel(activity)}
                      </span>
                      <span className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-xs text-blue-700">
                        等待线程出现
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-neutral-600">
                      Manager 正在理解目标、协调成员并准备线程。正式分发后，这里会出现每位成员的工作线程和对应产物。
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-neutral-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                          线程概览
                        </div>
                        <div className="mt-1 text-lg font-semibold text-neutral-950">
                          {stats.done}/{stats.total || 0}
                        </div>
                      </div>
                      <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[11px] text-neutral-600">
                        {runStatusLabel[taskBoard.status] ?? taskBoard.status}
                      </span>
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-100">
                      <div
                        className="h-full rounded-full bg-neutral-900 transition-all duration-500"
                        style={{ width: `${Math.min(100, Math.max(0, stats.percent))}%` }}
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-neutral-500">
                      <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-blue-700">
                        {runningCount} 进行中
                      </span>
                      <span className="rounded-full border border-green-200 bg-green-50 px-2 py-1 text-green-700">
                        {doneCount} 已完成
                      </span>
                      {issueCount > 0 && (
                        <span className="rounded-full border border-red-200 bg-red-50 px-2 py-1 text-red-700">
                          {issueCount} 异常
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-neutral-200 bg-white p-4">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                      房间产物
                    </div>
                    <div className="mt-1 text-lg font-semibold text-neutral-950">{artifactCount}</div>
                    <div className="mt-1 text-xs leading-5 text-neutral-500">
                      线程产出的文件、网页预览和流程结果都从这里进入。
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {newestArtifacts.length > 0 ? (
                        newestArtifacts.map(({ item, taskTitle }) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => requestArtifactPreview(item)}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] text-neutral-700 transition hover:border-blue-200 hover:text-blue-700"
                            title={`${taskTitle} · ${item.title}`}
                          >
                            <FileText className="h-3 w-3 shrink-0" />
                            <span className="max-w-[10rem] truncate">{item.title}</span>
                          </button>
                        ))
                      ) : (
                        <span className="text-[11px] text-neutral-400">还没有产物</span>
                      )}
                    </div>
                  </div>
                </div>

                {sections.map((section) => (
                  <div key={section.id} className="rounded-2xl border border-neutral-200 bg-white">
                    <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
                      <div className="text-sm font-medium text-neutral-900">{section.title}</div>
                      <div className="text-[11px] text-neutral-400">{section.tasks.length}</div>
                    </div>
                    <div className="divide-y divide-neutral-100">
                      {section.tasks.map((task) => {
                        const tab = agentTabs.find((item) => item.taskId === task.id)
                        const childSessionId = tab?.childSessionId || task.childSessionId || null
                        const canOpenChild = Boolean(childSessionId)
                        const artifactTotal = task.artifactCount ?? task.artifacts?.length ?? 0
                        const summary =
                          task.progressStatus || task.outputSummary || task.description || task.agentName
                        return (
                          <div key={task.id} className="px-4 py-3">
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 shrink-0">{taskStatusIcon(task.status)}</div>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="truncate text-sm font-medium text-neutral-900">
                                    {task.title}
                                  </span>
                                  <span
                                    className={`rounded-full border px-2 py-0.5 text-[11px] ${taskStatusClass(task.status)}`}
                                  >
                                    {taskStatusLabel[task.status] ?? task.status}
                                  </span>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                                  <span>{task.agentName || 'Worker'}</span>
                                  {task.taskThreadStatus && (
                                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-500">
                                      {task.taskThreadStatus}
                                    </span>
                                  )}
                                  {artifactTotal > 0 && (
                                    <span className="inline-flex items-center gap-1 text-neutral-600">
                                      <FileText className="h-3.5 w-3.5" />
                                      {artifactTotal} 个产物
                                    </span>
                                  )}
                                </div>
                                <TaskRuntimeStrip executionConfig={task.executionConfig} />
                                {summary && (
                                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-600">
                                    {summary}
                                  </p>
                                )}
                                {pendingChildNoticeTaskId === task.id && !canOpenChild && (
                                  <p className="mt-1 text-xs text-blue-600">
                                    线程正在准备，正式分配后会自动变为可打开。
                                  </p>
                                )}
                                {task.artifacts && task.artifacts.length > 0 && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {task.artifacts.slice(0, 3).map((artifact, index) => {
                                      const item = taskArtifactPreviewItem(artifact, task.id, index)
                                      return (
                                        <button
                                          key={item.id}
                                          type="button"
                                          onClick={() => requestArtifactPreview(item)}
                                          className="inline-flex max-w-full items-center gap-1 rounded-full border border-neutral-200 bg-white px-2 py-1 text-[11px] text-neutral-600 transition hover:border-blue-200 hover:text-blue-700"
                                        >
                                          <FileText className="h-3 w-3 shrink-0" />
                                          <span className="max-w-32 truncate">{item.title}</span>
                                        </button>
                                      )
                                    })}
                                    {task.artifacts.length > 3 && (
                                      <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2 py-1 text-[11px] text-neutral-500">
                                        +{task.artifacts.length - 3}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => void openChildSession(task.id, childSessionId)}
                                className={cn(
                                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition',
                                  canOpenChild
                                    ? 'border-neutral-200 bg-white text-neutral-700 hover:border-blue-200 hover:text-blue-700'
                                    : 'border-neutral-100 bg-neutral-50 text-neutral-400 hover:border-blue-100 hover:text-blue-600',
                                )}
                                title={canOpenChild ? '打开成员线程' : '线程准备中'}
                              >
                                {canOpenChild ? (
                                  <ExternalLink className="h-3.5 w-3.5" />
                                ) : (
                                  <Clock3 className="h-3.5 w-3.5" />
                                )}
                                {canOpenChild ? '线程' : '准备中'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
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
          'relative h-full w-[320px] max-w-[88vw] bg-[#FBFBFB] shadow-none transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-3 bg-[#f5f5f1] px-4 py-4">
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
                  <div className="font-medium text-neutral-900"> 工作区</div>
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
  const groupTitle = session?.title || workspace?.name || 'Project 群聊'
  const currentUser = getCachedAccountProfile()
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
  const managerAgent = agents.find((agent) => agent.roleType === 'orchestrator') ?? null
  const workerAgents = managerAgent ? agents.filter((agent) => agent.id !== managerAgent.id) : agents

  async function saveGroupTitle() {
    const next = titleDraft.trim() || 'Project 群聊'
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
          'relative h-full w-[340px] max-w-[88vw] bg-[#FBFBFB] shadow-none transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-3 bg-[#f5f5f1] px-4 py-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-neutral-950">房间资料</div>
              <div className="mt-1 truncate text-xs text-neutral-500">
                {workspace?.name ?? 'Project 群聊'} · {memberCount} 位成员
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
                {workspace?.projectPath || `${memberCount} 位成员 · Project 房间`}
              </div>
              <div className="mt-4 rounded-2xl border border-neutral-200 bg-white px-3 py-3 text-left">
                <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">协作关系</div>
                <div className="mt-2 text-sm text-neutral-700">
                  你提出目标，<span className="font-medium text-neutral-950">Manager</span> 负责理解和分发，
                  <span className="font-medium text-neutral-950">Workers</span> 在各自线程里执行并回报结果。
                </div>
              </div>
            </div>

            <div className="relative mt-8 grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => workspace?.projectPath && void openPath(workspace.projectPath)}
                disabled={!workspace?.projectPath}
                className="flex h-[72px] flex-col items-center justify-center gap-2 rounded-2xl bg-[#F3F3F3] text-neutral-700 transition hover:bg-neutral-200/70 disabled:opacity-50"
              >
                <FolderOpen className="h-5 w-5" />
                <span className="text-xs">打开项目</span>
              </button>
              <button
                type="button"
                onClick={() => setInviteOpen((value) => !value)}
                disabled={!workspace || busyAction === 'invite'}
                className="flex h-[72px] flex-col items-center justify-center gap-2 rounded-2xl bg-[#F3F3F3] text-neutral-700 transition hover:bg-neutral-200/70 disabled:opacity-50"
              >
                <Plus className="h-5 w-5" />
                <span className="text-xs">补充成员</span>
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
                <span className="text-xs">编辑房间</span>
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
              <div className="mb-2 px-4 text-xs text-neutral-500">你</div>
              <div className="rounded-2xl bg-[#F3F3F3] px-4 py-3">
                <div className="flex items-center gap-3">
                  <UserAvatar profile={currentUser} className="h-10 w-10 ring-0 shadow-none" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-neutral-950">
                        {currentUser.name?.trim() || '你'}
                      </span>
                      <MemberRolePill label="房间发起人" tone="owner" />
                    </div>
                    <div className="mt-0.5 text-xs text-neutral-400">负责提出目标与确认协作方向</div>
                  </div>
                </div>
              </div>
            </div>

            {managerAgent && (
              <div className="mt-5">
                <div className="mb-2 px-4 text-xs text-neutral-500">Manager</div>
                <button
                  type="button"
                  onClick={() => insertComposerMention(managerAgent.name)}
                  className="flex w-full items-center gap-3 rounded-2xl bg-[#F3F3F3] px-4 py-3 text-left transition hover:bg-neutral-200/60"
                >
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
                    style={{ background: managerAgent.color ?? '#2563eb' }}
                  >
                    {managerAgent.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-neutral-950">
                        {managerAgent.name}
                      </span>
                      <MemberRolePill color={managerAgent.color} label={managerAgent.role} />
                    </span>
                    <span className="mt-1 block truncate text-xs text-neutral-400">
                      负责理解目标、安排成员、汇总阶段结果
                    </span>
                  </span>
                </button>
              </div>
            )}

            <div className="mt-5">
              <div className="mb-2 px-4 text-xs text-neutral-500">Workers</div>
              <div className="overflow-hidden rounded-2xl bg-[#F3F3F3]">
                {monitorRows
                  .filter((row) => workerAgents.some((agent) => agent.id === row.id))
                  .map((row, index) => (
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
                {!workerAgents.length && (
                  <div className="px-4 py-6 text-center text-xs text-neutral-400">
                    还没有 Worker，点击上方补充成员。
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
              {busyAction === 'delete' ? <Loader2 className="h-4 w-4 animate-spin" /> : '关闭房间'}
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

function focusComposerInput() {
  window.setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')?.focus()
  }, 0)
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

function messageMetadata(message: Message): Record<string, unknown> {
  return message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function messageDisplayName(message: Message) {
  const metadata = messageMetadata(message)
  if (message.senderType === 'user') {
    const profile = getCachedAccountProfile()
    return profile.name?.trim() || '我'
  }
  if (message.senderType === 'system') return '系统'
  const agentName = metadata.agentName
  const senderName = metadata.senderName
  if (typeof agentName === 'string' && agentName.trim()) return agentName.trim()
  if (typeof senderName === 'string' && senderName.trim()) return senderName.trim()
  return 'Agent'
}

function messageDisplayContent(message: Message) {
  const metadata = messageMetadata(message)
  const displayContent = metadata.displayContent
  if (typeof displayContent === 'string' && displayContent.trim()) return displayContent

  const codeAgentRun = nestedRecord(metadata.codeAgentRun)
  const finalMessage = codeAgentRun?.finalMessage
  if (typeof finalMessage === 'string' && finalMessage.trim()) return finalMessage

  if (message.content.trim()) return message.content

  const attachments = metadata.attachments
  if (Array.isArray(attachments) && attachments.length) {
    return `[${attachments.length} 个附件]`
  }
  return ''
}

function messageDisplaySnippet(message: Message, limit = 96) {
  const text = messageDisplayContent(message)
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/[#>*_`[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return message.type === 'diff' ? '[代码 Diff]' : '[消息]'
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}

function quotedPreviewFromMessage(
  message: Message,
  kind: NonNullable<QuotedMessagePreview['kind']> = 'reply',
): QuotedMessagePreview {
  return {
    messageId: message.id,
    senderName: messageDisplayName(message),
    senderType: message.senderType,
    kind,
    content: messageDisplaySnippet(message, 180),
  }
}

function quotedPreviewFromValue(value: unknown): QuotedMessagePreview | null {
  const record = nestedRecord(value)
  if (!record) return null
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : ''
  const senderName = typeof record.senderName === 'string' ? record.senderName.trim() : ''
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  if (!messageId || !senderName || !content) return null
  return {
    messageId,
    senderName,
    senderType: typeof record.senderType === 'string' ? record.senderType : undefined,
    kind: record.kind === 'quote' ? 'quote' : 'reply',
    content: content.length > 240 ? `${content.slice(0, 239)}…` : content,
  }
}

function quotedPreviewForMessage(message: Message, messages: Message[]): QuotedMessagePreview | null {
  const metadataQuote = quotedPreviewFromValue(messageMetadata(message).quotedMessage)
  if (metadataQuote) return metadataQuote
  const replyToMessageId = typeof message.replyToMessageId === 'string' ? message.replyToMessageId : ''
  if (!replyToMessageId) return null
  const source = messages.find((item) => item.id === replyToMessageId)
  return source ? quotedPreviewFromMessage(source) : null
}

type LocalChangeTarget = {
  filePath?: string
  language?: string
  lineLabel: string
  selectedText: string
  sourceLabel: string
}

function formatLineRangeLabel(start?: number | string, end?: number | string) {
  const first = start ?? '?'
  const last = end ?? first
  if (`${first}` === `${last}`) return `第 ${first} 行`
  return `第 ${first}-${last} 行`
}

function codeFenceForContent(content: string, language?: string) {
  const fence = content.includes('```') ? '````' : '```'
  const normalizedLanguage = (language ?? '').trim().split(/\s+/)[0]?.replace(/[^\w+-]/g, '') ?? ''
  return `${fence}${normalizedLanguage}\n${content}\n${fence}`
}

function buildLocalChangePrompt(target: LocalChangeTarget, instruction: string) {
  return [
    '请根据下面选中的代码片段做对话式局部修改。',
    target.filePath ? `文件：${target.filePath}` : '文件：当前预览或消息中的代码片段',
    `范围：${target.lineLabel}`,
    `来源：${target.sourceLabel}`,
    '',
    '选中代码：',
    codeFenceForContent(target.selectedText, target.language),
    '',
    '修改要求：',
    instruction.trim(),
    '',
    '请优先直接修改对应文件并返回可审查的 diff；如果无法定位文件，请返回修改后的完整片段并说明原因。',
  ].join('\n')
}

function buildLocalChangeDisplay(target: LocalChangeTarget, instruction: string) {
  const location = [target.filePath, target.lineLabel].filter(Boolean).join(' ')
  return [`局部修改${location ? `：${location}` : ''}`, instruction.trim()].join('\n')
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

const QuotedMessageCard: FC<{
  quote: QuotedMessagePreview
  variant?: 'composer' | 'bubble'
  onCancel?: () => void
}> = ({ quote, variant = 'bubble', onCancel }) => {
  const isQuote = quote.kind === 'quote'
  const label = isQuote ? '引用' : '回复'
  const Icon = isQuote ? TextQuote : MessageCircleReply

  return (
    <div
      className={cn(
        'flex min-w-0 items-start gap-2 rounded-xl border py-2 pl-2.5 pr-2 text-left',
        variant === 'composer'
          ? 'mb-2 border-neutral-200 bg-neutral-50 shadow-sm'
          : 'mb-2 border-white/70 bg-white/70',
      )}
    >
      <span className="mt-0.5 h-8 w-1 shrink-0 rounded-full bg-sky-500" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1 text-[11px] font-semibold text-neutral-600">
          <Icon className="h-3 w-3 shrink-0 text-sky-500" />
          <span className="truncate">
            {label} {quote.senderName}
          </span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-neutral-700">
          {quote.content || '[消息]'}
        </span>
      </span>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-neutral-400 transition hover:bg-white hover:text-neutral-800"
          aria-label={`取消${label}`}
          title={`取消${label}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

const ReplyContextBar: FC<{
  message: Message
  kind: NonNullable<QuotedMessagePreview['kind']>
  onCancel: () => void
}> = ({ message, kind, onCancel }) => (
  <QuotedMessageCard
    quote={quotedPreviewFromMessage(message, kind)}
    variant="composer"
    onCancel={onCancel}
  />
)

const LocalChangeComposer: FC<{
  target: LocalChangeTarget
  onCancel: () => void
  onSent: () => void
  className?: string
}> = ({ target, onCancel, onSent, className }) => {
  const sendMessage = useChatStore((state) => state.sendMessage)
  const safetyMode = useChatStore((state) => state.safetyMode)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const agentTyping = useChatStore((state) => state.agentTyping)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const targetSignature = `${target.filePath ?? ''}|${target.lineLabel}|${target.sourceLabel}|${target.selectedText}`
  const running = agentTyping || Boolean(streamingMessage)
  const disabledReason = !currentSessionId
    ? '请先选择一个会话'
    : running
      ? 'Agent 正在输出，稍后再发送局部修改'
      : ''

  useEffect(() => {
    setDraft('')
    setError('')
  }, [targetSignature])

  async function submitLocalChange() {
    const instruction = draft.trim()
    if (!instruction || submitting || disabledReason) return
    setSubmitting(true)
    setError('')
    try {
      await sendMessage(buildLocalChangePrompt(target, instruction), {
        displayContent: buildLocalChangeDisplay(target, instruction),
        safetyMode,
        usePendingAttachments: false,
      })
      setDraft('')
      onSent()
    } catch (submitError) {
      setError(friendlyErrorMessage(submitError, '发送局部修改失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className={cn('agenthub-local-change-box', className)}
      onSubmit={(event) => {
        event.preventDefault()
        void submitLocalChange()
      }}
    >
      <div className="agenthub-local-change-header">
        <div className="agenthub-local-change-title">
          <TextQuote className="h-3.5 w-3.5" />
          局部修改
        </div>
        <div className="agenthub-local-change-meta" title={target.filePath ?? target.sourceLabel}>
          <span>{target.filePath ?? target.sourceLabel}</span>
          <span>{target.lineLabel}</span>
        </div>
      </div>
      <textarea
        className="agenthub-local-change-textarea"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void submitLocalChange()
          }
        }}
        placeholder="描述你希望 Agent 怎么修改这段代码..."
        rows={3}
        autoFocus
      />
      <div className="agenthub-local-change-footer">
        <span
          className={cn(
            'agenthub-local-change-hint',
            error && 'agenthub-local-change-hint-error',
          )}
        >
          {error || disabledReason || 'Ctrl / ⌘ + Enter 发送'}
        </span>
        <div className="agenthub-local-change-actions">
          <button
            type="button"
            className="agenthub-local-change-btn"
            onClick={onCancel}
            disabled={submitting}
          >
            <X className="h-3.5 w-3.5" />
            取消
          </button>
          <button
            type="submit"
            className="agenthub-local-change-btn agenthub-local-change-btn-send"
            disabled={!draft.trim() || submitting || Boolean(disabledReason)}
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
            发送
          </button>
        </div>
      </div>
    </form>
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
  const replyingToMessage = useChatStore((state) => state.replyingToMessage)
  const replyingToKind = useChatStore((state) => state.replyingToKind)
  const setReplyingTo = useChatStore((state) => state.setReplyingTo)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const agentTyping = useChatStore((state) => state.agentTyping)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const safetyMode = useChatStore((state) => state.safetyMode)
  const setSafetyMode = useChatStore((state) => state.setSafetyMode)
  const cancelRun = useChatStore((state) => state.cancelRun)
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
  const [dragActive, setDragActive] = useState(false)
  const [composerSubmitting, setComposerSubmitting] = useState(false)
  const composerRunning = agentTyping || Boolean(streamingMessage)
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
    if (!list.length) return

    const availableSlots = maxPendingAttachments - pendingAttachments.length
    if (availableSlots <= 0) {
      showHint(`最多添加 ${maxPendingAttachments} 个附件`)
      return
    }

    const withinLimit = list.filter((file) => file.size <= maxAttachmentBytes)
    const accepted = withinLimit.slice(0, availableSlots)
    const skippedBySize = list.length - withinLimit.length
    const skippedBySlot = Math.max(0, withinLimit.length - accepted.length)
    if (skippedBySize > 0) showHint(`已跳过超过 ${formatBytes(maxAttachmentBytes)} 的文件`)
    if (skippedBySlot > 0) showHint(`最多添加 ${maxPendingAttachments} 个附件，已添加前 ${accepted.length} 个`)
    if (!accepted.length) return

    try {
      const attachments = await Promise.all(accepted.map(fileToChatAttachment))
      addPendingAttachments(attachments)
      showHint(`已添加 ${attachments.length} 个附件`)
    } catch (error) {
      showHint(friendlyErrorMessage(error, '读取附件失败'))
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files)
    if (!files.length) return
    event.preventDefault()
    void handleFiles(files)
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!isDragWithFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    setDragActive(true)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!isDragWithFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!isDragWithFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    const nextTarget = event.relatedTarget
    if (!nextTarget || !event.currentTarget.contains(nextTarget as Node)) {
      setDragActive(false)
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!isDragWithFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    setDragActive(false)
    void handleFiles(event.dataTransfer.files)
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

  function clearComposerInput(input?: HTMLTextAreaElement | null) {
    const target =
      input ?? document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
    if (target) {
      target.focus()
      target.setSelectionRange(0, target.value.length)
      target.setRangeText('', 0, target.value.length, 'end')
      dispatchComposerInput(target, '', 'deleteContentBackward')
    }
    setComposerText('')
    setComposerScrollTop(0)
    setSkillPanelOpen(false)
    setSkillCommandRange(null)
    setSkillQuery('')
  }

  async function submitComposerMessage(input?: HTMLTextAreaElement | null) {
    if (composerSubmitting || composerRunning) return
    if (!currentSessionId) {
      showHint('请先选择或新建一个会话')
      return
    }
    const target =
      input ?? document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
    const text = target?.value ?? composerText
    if (!text.trim() && pendingAttachments.length === 0) return

    clearComposerInput(target)
    setMenu(null)
    setAgentMenuMode(null)
    setAgentMentionRange(null)
    setComposerSubmitting(true)
    try {
      await sendMessage(text, {
        safetyMode,
        mentions: extractMentionedAgentIds(text, workspaceAgents),
      })
    } catch (error) {
      showHint(friendlyErrorMessage(error, '发送失败'))
    } finally {
      setComposerSubmitting(false)
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
    if (nextText.trim().toLowerCase() === '/stop') {
      setMenu(null)
      setAgentMenuMode(null)
      setAgentMentionRange(null)
      setSkillPanelOpen(false)
      setSkillCommandRange(null)
      setSkillQuery('')
    } else if (command) {
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

  async function cloneGithubWorkspaceFromComposer(repoUrl: string, deployAfterClone: boolean) {
    if (workspaceBusy) return
    if (!currentSessionId) {
      showHint('请先选择或新建一个会话')
      return
    }
    const normalizedRepoUrl = repoUrl.trim()
    if (!normalizedRepoUrl) {
      showHint('请粘贴 GitHub 仓库地址')
      return
    }

    setWorkspaceBusy(true)
    showHint('正在从 GitHub 拉取...')
    try {
      const full = await api.cloneGithubWorkspace({
        repoUrl: normalizedRepoUrl,
        goal: '',
      })
      setWorkspaces((items) => [
        full.workspace,
        ...items.filter((item) => item.id !== full.workspace.id),
      ])
      setOpeningWorkspaceId(full.workspace.id)
      await setSessionWorkspace(currentSessionId, full.workspace.id)
      setMenu(null)
      await fetchSessions()
      showHint(deployAfterClone ? '已拉取，正在部署...' : 'GitHub 仓库已应用到当前会话')
      if (deployAfterClone) {
        await sendMessage('部署', { usePendingAttachments: false })
      }
    } catch (err) {
      showHint(friendlyErrorMessage(err, 'GitHub 拉取失败'))
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
            const input =
              event.target instanceof HTMLTextAreaElement
                ? event.target
                : document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
            const text = input?.value ?? composerText
            if (text.trim() === '/stop') {
              event.preventDefault()
              event.stopPropagation()
              event.nativeEvent.stopImmediatePropagation()
              clearComposerInput(input)
              void cancelRun()
              showHint('已发送停止命令')
              return
            }
            if (pendingAttachments.length > 0) {
              event.preventDefault()
              event.stopPropagation()
              event.nativeEvent.stopImmediatePropagation()
              void submitComposerMessage(input)
              return
            }
            syncComposerTextAfterComposerAction()
          } else if (shouldInsertNewline(sendMode, event)) {
            event.stopPropagation()
          }
        }}
      >
        <div
          className={cn(
            'relative rounded-3xl border border-neutral-200 bg-white p-3 transition focus-within:border-neutral-300',
            dragActive && 'border-neutral-400 bg-neutral-50/80 shadow-[0_0_0_4px_rgba(15,23,42,0.06)]',
          )}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
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
              onCloneGithubWorkspace={(repoUrl, deployAfterClone) =>
                void cloneGithubWorkspaceFromComposer(repoUrl, deployAfterClone)
              }
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
          {replyingToMessage && (
            <ReplyContextBar
              message={replyingToMessage}
              kind={replyingToKind}
              onCancel={() => setReplyingTo(null)}
            />
          )}
          <PendingAttachmentList
            attachments={pendingAttachments}
            onRemove={removePendingAttachment}
          />
          {dragActive && (
            <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-2xl border border-dashed border-neutral-400 bg-white/82 text-sm font-medium text-neutral-700 shadow-sm backdrop-blur-sm">
              松开即可添加附件
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
                accept={attachmentInputAccept}
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
              <SafetyModeButton mode={safetyMode} onChange={setSafetyMode} />
            </div>
            <div className="flex items-center gap-2">
              <ComposerAction
                hasPendingAttachments={pendingAttachments.length > 0}
                isSubmitting={composerSubmitting}
                onSendAttachments={() => void submitComposerMessage()}
              />
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
  onCloneGithubWorkspace: (repoUrl: string, deployAfterClone: boolean) => void
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
  onCloneGithubWorkspace,
  onPlanMode,
  onPick,
  onClose,
}) => {
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [githubRepoUrl, setGithubRepoUrl] = useState('')
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
            <form
              className="mt-1 rounded-xl border border-neutral-200 bg-neutral-50/80 p-2"
              onSubmit={(event) => {
                event.preventDefault()
                onCloneGithubWorkspace(githubRepoUrl, false)
              }}
            >
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-500">
                <Github className="h-3.5 w-3.5" />
                <span>从 GitHub 拉取</span>
              </div>
              <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2 py-1.5">
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <input
                  value={githubRepoUrl}
                  onChange={(event) => setGithubRepoUrl(event.target.value)}
                  disabled={workspaceBusy}
                  className="min-w-0 flex-1 bg-transparent text-xs text-neutral-900 outline-none placeholder:text-neutral-400"
                  placeholder="github.com/owner/repo"
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button
                  type="submit"
                  disabled={workspaceBusy || !githubRepoUrl.trim()}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {workspaceBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Github className="h-3.5 w-3.5" />
                  )}
                  拉取
                </button>
                <button
                  type="button"
                  onClick={() => onCloneGithubWorkspace(githubRepoUrl, true)}
                  disabled={workspaceBusy || !githubRepoUrl.trim()}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-neutral-950 px-2 text-xs font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {workspaceBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Rocket className="h-3.5 w-3.5" />
                  )}
                  拉取并部署
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
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

const SAFETY_MODES = [
  { key: 'ask', label: '询问', desc: '敏感操作前询问', Icon: Shield, color: 'text-blue-500' },
  { key: 'full-access', label: '完全访问', desc: '无需逐条确认', Icon: ShieldOff, color: 'text-orange-500' },
] as const

const SafetyModeButton: FC<{ mode: string; onChange: (mode: string) => void }> = ({
  mode,
  onChange,
}) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = SAFETY_MODES.find((m) => m.key === mode) ?? SAFETY_MODES[0]

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <ComposerToolButton
        aria-label={`安全模式: ${current.label}`}
        title={`${current.label} · ${current.desc}`}
        onClick={() => setOpen(!open)}
        className={cn(current.color)}
      >
        <current.Icon className="h-4 w-4" />
      </ComposerToolButton>
      {open && (
        <div className="agenthub-portal-theme absolute bottom-full left-0 z-50 mb-2 w-52 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl">
          {SAFETY_MODES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                onChange(item.key)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition hover:bg-neutral-50',
                mode === item.key && 'bg-neutral-50',
              )}
            >
              <item.Icon className={cn('h-4 w-4 shrink-0', item.color)} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-neutral-800">{item.label}</div>
                <div className="text-xs text-neutral-400">{item.desc}</div>
              </div>
              {mode === item.key && <Check className="h-3.5 w-3.5 shrink-0 text-neutral-500" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type ComposerActionProps = {
  hasPendingAttachments: boolean
  isSubmitting: boolean
  onSendAttachments: () => void
}

const ComposerAction: FC<ComposerActionProps> = ({
  hasPendingAttachments,
  isSubmitting,
  onSendAttachments,
}) => (
  <>
    <ThreadPrimitive.If running={false}>
      {hasPendingAttachments ? (
        <button
          type="button"
          onClick={onSendAttachments}
          disabled={isSubmitting}
          className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-700 disabled:pointer-events-none disabled:bg-neutral-200"
          aria-label="发送"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      ) : (
        <ComposerPrimitive.Send asChild>
          <button
            className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-700 disabled:pointer-events-none disabled:bg-neutral-200"
            aria-label="发送"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </ComposerPrimitive.Send>
      )}
    </ThreadPrimitive.If>
    <ThreadPrimitive.If running>
      <button
        type="button"
        disabled
        className="grid h-9 w-9 cursor-not-allowed place-items-center rounded-full bg-neutral-200 text-neutral-400"
        aria-label="发送中"
        title="输入 /stop 强制停止"
      >
        <ArrowUp className="h-4 w-4" />
      </button>
    </ThreadPrimitive.If>
  </>
)

const UserMessage: FC = () => {
  const messageStyleMode = useMessageStyleMode()
  const isFlatMessageStyle = messageStyleMode === 'flat'
  const messageId = useMessage((message) => message.id)
  const allMessages = useChatStore((state) => state.messages)
  const sourceMessage = useChatStore((state) =>
    state.messages.find((message) => message.id === messageId),
  )
  const editMessage = useChatStore((state) => state.editMessage)
  const resendMessage = useChatStore((state) => state.resendMessage)
  const withdrawMessage = useChatStore((state) => state.withdrawMessage)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'edit' | 'withdraw' | null>(null)
  const canEdit = Boolean(sourceMessage?.senderType === 'user')
  const text =
    typeof sourceMessage?.metadata?.displayContent === 'string'
      ? sourceMessage.metadata.displayContent
      : (sourceMessage?.content ?? '')
  const quotedPreview = sourceMessage ? quotedPreviewForMessage(sourceMessage, allMessages) : null

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
      await resendMessage(sourceMessage.id)
      setEditing(false)
    } finally {
      setBusy(null)
    }
  }

  function cancelEdit() {
    setDraft(text)
    setEditing(false)
  }

  function handleEditKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void saveEdit()
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

  const userActions =
    canEdit && !editing ? (
      <UserMessageActionBar
        busy={busy}
        onEdit={startEdit}
        onWithdraw={withdraw}
      />
    ) : null
  const timestamp = sourceMessage?.createdAt ? formatTime(sourceMessage.createdAt) : ''

  if (editing) {
    return (
      <MessagePrimitive.Root
        className={cn(
          'group mx-auto flex w-full max-w-[var(--thread-max-width)] items-start gap-3 py-3',
          isFlatMessageStyle ? 'justify-start' : 'justify-end',
        )}
      >
        {isFlatMessageStyle && <Avatar role="user" />}
        <div
          className={cn(
            'flex w-full max-w-[36rem] flex-col gap-1.5',
            isFlatMessageStyle ? 'items-start' : 'items-end',
          )}
        >
          <UserMessageEditor
            busy={busy}
            draft={draft}
            onCancel={cancelEdit}
            onChange={setDraft}
            onKeyDown={handleEditKeyDown}
            onSave={saveEdit}
          />
          {timestamp && (
            <MessageTimestamp align={isFlatMessageStyle ? 'left' : 'right'} value={timestamp} />
          )}
        </div>
        {!isFlatMessageStyle && <Avatar role="user" />}
      </MessagePrimitive.Root>
    )
  }

  return (
    <MessagePrimitive.Root
      className={cn(
        'group mx-auto flex w-full max-w-[var(--thread-max-width)] items-start gap-3',
        isFlatMessageStyle ? 'justify-start border-b border-neutral-100 py-3' : 'justify-end py-3',
      )}
    >
      {isFlatMessageStyle && <Avatar role="user" />}
      <div
        className={cn(
          'flex flex-col gap-1.5',
          isFlatMessageStyle ? 'w-full max-w-none items-start' : 'max-w-[68%] items-end',
        )}
      >
        <div
          className={cn(
            'w-full text-sm leading-6 text-neutral-900 transition-colors',
            isFlatMessageStyle
              ? 'border-l-2 border-neutral-300 bg-transparent py-0 pl-4 text-left shadow-none'
              : 'rounded-[18px] bg-[#f1f1f1] px-5 py-2.5 shadow-none',
          )}
        >
          <UserMessageParts quotedPreview={quotedPreview} />
        </div>
        {userActions}
        {timestamp && (
          <MessageTimestamp align={isFlatMessageStyle ? 'left' : 'right'} value={timestamp} />
        )}
      </div>
      {!isFlatMessageStyle && <Avatar role="user" />}
    </MessagePrimitive.Root>
  )
}

type UserMessageBusy = 'edit' | 'withdraw' | null

function UserMessageParts({
  quotedPreview,
}: {
  quotedPreview: QuotedMessagePreview | null
}) {
  return (
    <>
      {quotedPreview && <QuotedMessageCard quote={quotedPreview} />}
      <MessagePrimitive.Parts
        components={{
          data: { by_name: { chat_attachments: ChatAttachmentsPart } },
        }}
      />
    </>
  )
}

function UserMessageEditor({
  busy,
  draft,
  onCancel,
  onChange,
  onKeyDown,
  onSave,
}: {
  busy: UserMessageBusy
  draft: string
  onCancel: () => void
  onChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSave: () => void
}) {
  return (
    <div className="w-full rounded-2xl border border-neutral-200 bg-white p-2.5 text-sm leading-6 text-neutral-900 shadow-sm">
      <div className="flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="编辑消息"
          className="max-h-36 min-h-16 resize-y rounded-xl bg-neutral-50 px-3 py-2 text-sm leading-6 text-neutral-900 outline-none ring-1 ring-transparent transition placeholder:text-neutral-400 focus:bg-white focus:ring-neutral-200"
          autoFocus
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-neutral-400">Ctrl/⌘ + Enter 发送，Esc 取消</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onCancel}
              className="h-7 rounded-full border border-neutral-200 bg-white px-2.5 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-50 hover:text-neutral-900"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={busy === 'edit' || !draft.trim()}
              className="h-7 rounded-full bg-neutral-950 px-3 text-[11px] font-semibold text-white shadow-sm transition hover:bg-neutral-800 disabled:bg-neutral-300"
            >
              {busy === 'edit' ? '发送中' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function UserMessageActionBar({
  busy,
  onEdit,
  onWithdraw,
}: {
  busy: UserMessageBusy
  onEdit: (event?: React.MouseEvent<HTMLButtonElement>) => void
  onWithdraw: (event?: React.MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <div className="flex items-center gap-1 pr-1 text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100">
      <ToolButton
        type="button"
        aria-label="修改"
        title="修改"
        onClick={onEdit}
        disabled={Boolean(busy)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        type="button"
        aria-label="撤回"
        title="撤回并尝试回滚修改"
        onClick={onWithdraw}
        disabled={Boolean(busy)}
      >
        {busy === 'withdraw' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </ToolButton>
    </div>
  )
}

function MessageTimestamp({
  align = 'left',
  value,
}: {
  align?: 'left' | 'right'
  value: string
}) {
  return (
    <div className={cn('text-[11px] text-neutral-400', align === 'right' && 'pr-1 text-right')}>
      {value}
    </div>
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
  const messageStyleMode = useMessageStyleMode()
  const isFlatMessageStyle = messageStyleMode === 'flat'
  const messageId = useMessage((message) => message.id)
  const sourceMessage = useChatStore((state) =>
    state.messages.find((message) => message.id === messageId),
  )
  const timestamp = sourceMessage?.createdAt ? formatTime(sourceMessage.createdAt) : ''

  return (
    <MessagePrimitive.Root
      className={cn(
        'mx-auto flex w-full max-w-[var(--thread-max-width)] gap-3',
        isFlatMessageStyle ? 'border-b border-neutral-100 py-3' : 'py-4',
      )}
    >
      <Avatar role="assistant" />
      <div className={cn('min-w-0 flex-1', isFlatMessageStyle ? 'pl-1' : '')}>
        <div
          className={cn(
            'text-sm text-neutral-950',
            isFlatMessageStyle
              ? 'leading-6'
              : 'rounded-[18px] border border-neutral-200 bg-white px-4 py-3 leading-7 shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
          )}
        >
          <AssistantMessageParts />
        </div>
        <AssistantActionBar />
        <BranchPicker />
        {timestamp && <div className="mt-1 text-[11px] text-neutral-400">{timestamp}</div>}
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessageParts() {
  return (
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
            member_proposal_card: MemberProposalCard,
            file_card: FileCardMessage,
            delivery_report: DeliveryReportMessage,
          },
        },
      }}
    />
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

function MemberProposalCard({ data }: { data?: Record<string, unknown> | null }) {
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const selectSession = useChatStore((state) => state.selectSession)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const proposals = readMemberProposals(data?.memberProposals)
  const status = typeof data?.memberProposalStatus === 'string' ? data.memberProposalStatus : 'pending'
  const continueStatus =
    typeof data?.memberProposalContinueStatus === 'string'
      ? data.memberProposalContinueStatus
      : 'idle'
  const continueError =
    typeof data?.memberProposalContinueError === 'string' ? data.memberProposalContinueError : ''
  const messageId = typeof data?.messageId === 'string' ? data.messageId : ''
  const [selectedIds, setSelectedIds] = useState(() => proposals.map((proposal) => proposal.expertProfileId))
  const [busy, setBusy] = useState(false)
  const [continueBusy, setContinueBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setSelectedIds(proposals.map((proposal) => proposal.expertProfileId))
  }, [data?.messageId])

  if (!proposals.length) return null

  const confirmed = status === 'confirmed'
  const selectedSet = new Set(selectedIds)

  function toggleProfile(profileId: string) {
    setSelectedIds((ids) =>
      ids.includes(profileId) ? ids.filter((id) => id !== profileId) : [...ids, profileId],
    )
    setError('')
  }

  async function confirm() {
    if (!currentSessionId || !messageId || !selectedIds.length) {
      setError('请选择至少一个 Agent')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.confirmMemberProposals(currentSessionId, messageId, selectedIds)
      await fetchSessions().catch(() => undefined)
      await selectSession(currentSessionId).catch(() => undefined)
    } catch (err) {
      setError(friendlyErrorMessage(err, '加入 Agent 失败'))
    } finally {
      setBusy(false)
    }
  }

  async function continuePlanning() {
    if (!currentSessionId || !messageId || continueBusy || continueStatus === 'running') return
    setContinueBusy(true)
    setError('')
    try {
      await api.continueMemberProposals(currentSessionId, messageId)
      await fetchSessions().catch(() => undefined)
      await selectSession(currentSessionId).catch(() => undefined)
    } catch (err) {
      setError(friendlyErrorMessage(err, '重新规划失败'))
    } finally {
      setContinueBusy(false)
    }
  }

  return (
    <div className="not-prose mt-3 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-neutral-100 px-4 py-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-neutral-950 text-white">
          <Blocks className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-neutral-950">
            {confirmed ? '已加入建议成员' : 'Orchestrator 建议补充成员'}
          </div>
          <div className="mt-1 text-xs leading-5 text-neutral-500">
            这些只是候选 Agent 配置，确认后才会成为当前群聊的真实成员。
          </div>
        </div>
        {confirmed && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            已确认
          </span>
        )}
      </div>
      <div className="divide-y divide-neutral-100">
        {proposals.map((proposal) => {
          const checked = selectedSet.has(proposal.expertProfileId)
          return (
            <button
              key={proposal.expertProfileId}
              type="button"
              disabled={confirmed || busy}
              onClick={() => toggleProfile(proposal.expertProfileId)}
              className={cn(
                'flex w-full items-start gap-3 px-4 py-3 text-left transition',
                !confirmed && 'hover:bg-neutral-50',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border',
                  checked || confirmed
                    ? 'border-neutral-950 bg-neutral-950 text-white'
                    : 'border-neutral-300 bg-white text-transparent',
                )}
              >
                <Check className="h-3.5 w-3.5" />
              </span>
              <span
                className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white"
                style={{ backgroundColor: proposal.color || '#111827' }}
              >
                <Bot className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-neutral-950">{proposal.name}</span>
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                    {proposal.role}
                  </span>
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                    {proposal.runtimeType === 'code-agent'
                      ? proposal.codeAgentType || 'code-agent'
                      : 'LLM'}
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-5 text-neutral-600">
                  {proposal.expectedContribution || proposal.reason || '补齐当前任务所需能力。'}
                </span>
                {proposal.capabilityTags?.length ? (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {proposal.capabilityTags.slice(0, 6).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-md bg-neutral-50 px-1.5 py-0.5 text-[11px] text-neutral-500"
                      >
                        {tag}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
      {!confirmed && (
        <div className="flex flex-col gap-2 border-t border-neutral-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-xs leading-5 text-red-600">{error}</div>
          <button
            type="button"
            disabled={busy || selectedIds.length === 0}
            onClick={() => void confirm()}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:bg-neutral-300"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            加入选中 Agent
          </button>
        </div>
      )}
      {confirmed && (
        <div className="flex flex-col gap-2 border-t border-neutral-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div
            className={cn(
              'min-h-5 text-xs leading-5',
              continueStatus === 'failed' ? 'text-red-600' : 'text-neutral-500',
            )}
          >
            {error ||
              (continueStatus === 'running'
                ? 'Orchestrator 正在重新规划并分发任务...'
                : continueStatus === 'completed'
                  ? '已接回任务计划，任务正在看板中执行。'
                  : continueStatus === 'failed'
                    ? continueError || '重新规划失败，可以重试。'
                    : '补员完成后，可以直接接回当前目标继续分发。')}
          </div>
          <button
            type="button"
            disabled={
              continueBusy || continueStatus === 'running' || continueStatus === 'completed'
            }
            onClick={() => void continuePlanning()}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-500 disabled:bg-neutral-300"
          >
            {continueBusy || continueStatus === 'running' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="h-4 w-4" />
            )}
            {continueStatus === 'completed'
              ? '已继续分发'
              : continueStatus === 'running'
                ? '规划中...'
                : '让 Orchestrator 重新规划/继续分发'}
          </button>
        </div>
      )}
    </div>
  )
}

function readMemberProposals(value: unknown): MemberProposal[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is MemberProposal => {
    if (!item || typeof item !== 'object') return false
    const proposal = item as Partial<MemberProposal>
    return typeof proposal.expertProfileId === 'string' && typeof proposal.name === 'string'
  })
}

interface FileCardEntry {
  fileName: string
  filePath: string
  fileSize?: number
  runId: string
  workspaceId?: string
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
          workspaceId={file.workspaceId}
        />
      ))}
    </div>
  )
}

function DeliveryReportMessage({ data }: { data?: DeliveryReportData | null }) {
  if (!data) return null
  return <DeliveryReport data={data} />
}

const ArtifactPreviewPanel: FC<{ item: ArtifactPreviewItem; onClose: () => void }> = ({
  item,
  onClose,
}) => {
  const activeWorkspaceId = useChatStore((state) => state.currentSession?.workspaceId)
  const previewWorkspaceId = item.workspaceId ?? activeWorkspaceId ?? undefined
  const canOpen = Boolean(item.url)
  const previewSourcePath = item.path ?? previewPathFromUrl(item.url) ?? undefined
  const canInspectSource =
    Boolean(item.source?.trim()) || canFetchWorkspaceTextSource(item, previewSourcePath)
  const runnablePreview = (item.kind === 'web' || item.kind === 'deploy') && Boolean(item.url)
  const [maximized, setMaximized] = useState(false)
  const [visible, setVisible] = useState(false)
  const [panelWidth, setPanelWidth] = useState(() => readStoredPreviewPanelWidth())
  const [resizing, setResizing] = useState(false)
  const [previewMode, setPreviewMode] = useState<'preview' | 'source'>('preview')
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

  useEffect(() => {
    setPreviewMode('preview')
  }, [item.id])

  useEffect(() => {
    if (!canInspectSource && previewMode === 'source') setPreviewMode('preview')
  }, [canInspectSource, previewMode])

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

  function handleResizeReset() {
    const nextWidth = clampPreviewPanelWidth(
      defaultPreviewPanelWidth,
      getPreviewPanelWidthBounds(panelRef.current),
    )
    panelWidthRef.current = nextWidth
    setPanelWidth(nextWidth)
    storePreviewPanelWidth(nextWidth)
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

  async function handleSaveDiffPreviewEdit(params: DiffEditSaveParams) {
    if (!previewWorkspaceId || !item.path) return
    if (params.fileContent !== undefined) {
      await api.writeFile({
        workspaceId: previewWorkspaceId,
        filePath: item.path,
        content: params.fileContent,
      })
      return
    }
    if (!params.lineNumber) throw new Error('当前 Diff 缺少可写入行号，无法保存。')
    await api.writeFile({
      workspaceId: previewWorkspaceId,
      filePath: item.path,
      content: params.lineText,
      startLine: params.lineNumber,
      endLine: params.lineNumber,
    })
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
    const isDataUrl = resolvedUrl.startsWith('data:')
    const filename = downloadFileName(item)
    const desktopApp = isDesktopApp()
    const actionId = pushActionItem({
      kind: 'download',
      status: 'working',
      title: filename,
      detail: desktopApp ? '正在保存到系统下载目录...' : '正在准备下载...',
    })

    try {
      if (desktopApp && !isDataUrl) {
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
            onDoubleClick={handleResizeReset}
            title="拖拽调整预览宽度，双击复位"
            className={cn(
              'group absolute inset-y-0 left-0 z-30 w-5 -translate-x-1/2 cursor-col-resize touch-none',
              'before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-neutral-200',
              'after:absolute after:left-1/2 after:top-1/2 after:h-16 after:w-1.5 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-neutral-300 after:shadow-sm after:transition',
              'hover:after:h-24 hover:after:bg-blue-500 focus-visible:outline-none focus-visible:after:h-24 focus-visible:after:bg-blue-500',
              resizing && 'after:h-28 after:bg-blue-600',
            )}
          />
        )}
        <div className="flex h-16 shrink-0 items-center gap-3 bg-[#f5f5f1] px-3 backdrop-blur">
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
            {runnablePreview && canInspectSource && (
              <div
                className="mr-1 inline-flex h-9 items-center rounded-xl border border-neutral-200 bg-white p-0.5 shadow-sm"
                role="tablist"
                aria-label="预览模式"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewMode === 'preview'}
                  onClick={() => setPreviewMode('preview')}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-xs font-medium transition',
                    previewMode === 'preview'
                      ? 'bg-neutral-950 text-white shadow-sm'
                      : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
                  )}
                >
                  <Monitor className="h-3.5 w-3.5" />
                  预览
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={previewMode === 'source'}
                  onClick={() => setPreviewMode('source')}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-xs font-medium transition',
                    previewMode === 'source'
                      ? 'bg-neutral-950 text-white shadow-sm'
                      : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
                  )}
                >
                  <FileText className="h-3.5 w-3.5" />
                  源码
                </button>
              </div>
            )}
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
            ) : runnablePreview && previewMode === 'source' && canInspectSource ? (
              <TextFilePreview item={item} />
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
                <DiffViewer
                  diff={item.source ?? ''}
                  maxHeightClassName="max-h-none"
                  filePath={item.path}
                  onSaveEdit={
                    previewWorkspaceId && item.path ? handleSaveDiffPreviewEdit : undefined
                  }
                />
              </div>
            ) : item.kind === 'workflow' ? (
              <PreviewPlaceholder item={item} />
            ) : isDocxPreviewItem(item) ? (
              <WordDocumentPreview item={item} />
            ) : isPptxPreviewItem(item) ? (
              <PresentationDocumentPreview item={item} />
            ) : item.source ? (
              <TextFilePreview item={item} />
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
    <div className="flex h-12 items-center justify-between bg-[#f5f5f1] px-4">
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

const WordDocumentPreview: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const styleRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const bodyEl = bodyRef.current
    const styleEl = styleRef.current
    if (!bodyEl || !styleEl) return
    const bodyContainer: HTMLElement = bodyEl
    const styleContainer: HTMLElement = styleEl

    let cancelled = false
    bodyContainer.innerHTML = ''
    styleContainer.innerHTML = ''
    setStatus('loading')
    setError('')

    async function renderDocument() {
      const [{ renderAsync }, data] = await Promise.all([
        import('docx-preview'),
        loadPreviewArrayBuffer(item),
      ])
      if (cancelled) return
      await renderAsync(data, bodyContainer, styleContainer, {
        breakPages: true,
        className: 'agenthub-docx',
        ignoreFonts: false,
        inWrapper: true,
        renderFooters: true,
        renderHeaders: true,
        useBase64URL: true,
      })
      if (!cancelled) setStatus('ready')
    }

    void renderDocument().catch((err) => {
      if (cancelled) return
      setStatus('error')
      setError(formatPreviewError(err))
    })

    return () => {
      cancelled = true
      bodyContainer.innerHTML = ''
      styleContainer.innerHTML = ''
    }
  }, [item.id, item.path, item.url, item.workspaceId, reloadToken])

  if (status === 'error') {
    return (
      <PreviewErrorState
        title={item.title}
        error={error}
        onRetry={() => setReloadToken((value) => value + 1)}
      />
    )
  }

  return (
    <div className="agenthub-office-preview flex h-full flex-col bg-[#f6f7f9]">
      <OfficePreviewHeader item={item} label="Word" />
      <div className="relative min-h-0 flex-1 overflow-auto">
        {status === 'loading' && (
          <div className="absolute inset-0 z-10">
            <PreviewLoadingState item={item} />
          </div>
        )}
        <div className="agenthub-docx-host">
          <div ref={styleRef} />
          <div ref={bodyRef} />
        </div>
      </div>
    </div>
  )
}

const PresentationDocumentPreview: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [renderWidth, setRenderWidth] = useState(900)

  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return

    const updateWidth = () => {
      const nextWidth = Math.max(320, Math.min(1120, Math.floor(scrollEl.clientWidth - 32)))
      setRenderWidth((current) => (Math.abs(current - nextWidth) > 24 ? nextWidth : current))
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(scrollEl)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const hostEl = hostRef.current
    if (!hostEl) return
    const hostContainer: HTMLElement = hostEl

    let cancelled = false
    let previewer: { destroy?: () => void } | null = null
    hostContainer.innerHTML = ''
    setStatus('loading')
    setError('')

    async function renderPresentation() {
      const [{ init }, data] = await Promise.all([
        import('pptx-preview'),
        loadPreviewArrayBuffer(item),
      ])
      if (cancelled) return
      const width = Math.max(320, Math.floor(renderWidth))
      const height = Math.round(width * 0.5625)
      const nextPreviewer = init(hostContainer, { height, mode: 'list', width })
      previewer = nextPreviewer
      await nextPreviewer.preview(data)
      if (!cancelled) setStatus('ready')
    }

    void renderPresentation().catch((err) => {
      if (cancelled) return
      setStatus('error')
      setError(formatPreviewError(err))
    })

    return () => {
      cancelled = true
      previewer?.destroy?.()
      hostContainer.innerHTML = ''
    }
  }, [item.id, item.path, item.url, item.workspaceId, reloadToken, renderWidth])

  if (status === 'error') {
    return (
      <PreviewErrorState
        title={item.title}
        error={error}
        onRetry={() => setReloadToken((value) => value + 1)}
      />
    )
  }

  return (
    <div className="agenthub-office-preview flex h-full flex-col bg-[#f6f7f9]">
      <OfficePreviewHeader item={item} label="PowerPoint" />
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        {status === 'loading' && (
          <div className="absolute inset-0 z-10">
            <PreviewLoadingState item={item} />
          </div>
        )}
        <div className="agenthub-pptx-host">
          <div ref={hostRef} />
        </div>
      </div>
    </div>
  )
}

const OfficePreviewHeader: FC<{ item: ArtifactPreviewItem; label: string }> = ({
  item,
  label,
}) => (
  <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3 text-xs text-neutral-500">
    {isPptxPreviewItem(item) ? (
      <Presentation className="h-4 w-4 text-neutral-400" />
    ) : (
      <FileText className="h-4 w-4 text-neutral-400" />
    )}
    <span className="min-w-0 flex-1 truncate">{previewFileName(item)}</span>
    <span className="rounded-md bg-[#f6f7f9] px-2 py-1">{label}</span>
  </div>
)

const DocumentPreviewPlaceholder: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const fileName = item.path ?? item.title
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2 bg-[#f5f5f1] px-3 text-xs text-neutral-500">
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

const TextFilePreview: FC<{ item: ArtifactPreviewItem }> = ({ item }) => {
  const resolvedPath = item.path ?? previewPathFromUrl(item.url) ?? undefined
  const fileName = resolvedPath ?? item.title
  const language = guessLanguageFromPath(fileName) || 'text'
  const canLoadWorkspaceSource = canFetchWorkspaceTextSource(item, resolvedPath)
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const [sourceLoadState, setSourceLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  )
  const [sourceLoadError, setSourceLoadError] = useState('')
  const source = loadedSource ?? item.source ?? ''
  const lines = useMemo(() => source.replace(/\n$/, '').split('\n'), [source])
  const highlightedLines = useMemo(
    () => lines.map((line) => highlightCode(line, language)),
    [lines, language],
  )
  const selection = useLineSelection(lines.length)
  const [localChangeTarget, setLocalChangeTarget] = useState<LocalChangeTarget | null>(null)

  useEffect(() => {
    selection.clearSelection()
    setLocalChangeTarget(null)
  }, [source, selection.clearSelection])

  useEffect(() => {
    setLoadedSource(null)
    setSourceLoadError('')
    setSourceLoadState('idle')
    if (!canLoadWorkspaceSource || !item.workspaceId || !resolvedPath) return

    const controller = new AbortController()
    setSourceLoadState('loading')

    fetch(artifactFileUrl(item.workspaceId, resolvedPath), {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await extractPreviewErrorMessage(response))
        return response.text()
      })
      .then((text) => {
        setLoadedSource(text)
        setSourceLoadState('ready')
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setSourceLoadState('error')
        setSourceLoadError(formatPreviewError(error))
      })

    return () => controller.abort()
  }, [canLoadWorkspaceSource, item.id, item.workspaceId, resolvedPath])

  function buildTextFileTarget(): LocalChangeTarget | null {
    const selected = selection.sortedSelected
    if (selected.length === 0) return null
    const selectedLines = selected.map((index) => lines[index])
    return {
      filePath: resolvedPath,
      language,
      lineLabel: formatLineRangeLabel(selected[0] + 1, selected[selected.length - 1] + 1),
      selectedText: selectedLines.join('\n'),
      sourceLabel: '文件预览',
    }
  }

  function handleReference() {
    const target = buildTextFileTarget()
    if (!target) return
    const header = target.filePath
      ? `\`${target.filePath}\` ${target.lineLabel}:\n`
      : `${target.lineLabel}:\n`
    insertTextIntoComposer(`${header}${codeFenceForContent(target.selectedText, language)}\n`)
    selection.clearSelection()
    setLocalChangeTarget(null)
  }

  function handleLocalChange() {
    const target = buildTextFileTarget()
    if (target) setLocalChangeTarget(target)
  }

  function clearTextSelection() {
    selection.clearSelection()
    setLocalChangeTarget(null)
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex h-11 shrink-0 items-center gap-2 bg-[#f5f5f1] px-3 text-xs text-neutral-500">
        <FileText className="h-4 w-4 text-neutral-400" />
        <span className="min-w-0 flex-1 truncate">{fileName}</span>
        <span className="rounded-md bg-[#F7F7F7] px-2 py-1">{language}</span>
        {sourceLoadState === 'loading' && (
          <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-blue-600">
            <Loader2 className="h-3 w-3 animate-spin" />
            读取源码
          </span>
        )}
        {sourceLoadState === 'error' && (
          <span className="max-w-[12rem] truncate rounded-md bg-amber-50 px-2 py-1 text-amber-700" title={sourceLoadError}>
            使用缓存源码
          </span>
        )}
      </div>
      <div className="agenthub-file-code-preview min-h-0 flex-1 overflow-auto bg-[#0f172a]">
        {selection.selectedCount > 0 && (
          <LineSelectionToolbar
            selectedCount={selection.selectedCount}
            onReference={handleReference}
            onLocalChange={handleLocalChange}
            onClear={clearTextSelection}
          />
        )}
        {localChangeTarget && (
          <LocalChangeComposer
            target={localChangeTarget}
            onCancel={() => setLocalChangeTarget(null)}
            onSent={clearTextSelection}
          />
        )}
        <pre className="agenthub-code-pre agenthub-file-code-pre not-prose">
          <code className={cn('agenthub-code', `language-${language}`)}>
            <table className="agenthub-code-table">
              <tbody>
                {lines.map((_line, index) => (
                  <tr
                    key={index}
                    className={selection.isSelected(index) ? 'agenthub-code-row-selected' : undefined}
                  >
                    <td
                      className="agenthub-code-ln"
                      onClick={(event) => selection.toggleLine(index, event.shiftKey)}
                    >
                      {index + 1}
                    </td>
                    <td
                      className="agenthub-code-content"
                      onClick={(event) => {
                        if (shouldSkipLineSelectionClick(event)) return
                        selection.toggleLine(index, event.shiftKey)
                      }}
                    >
                      <span dangerouslySetInnerHTML={{ __html: highlightedLines[index] || '&nbsp;' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </code>
        </pre>
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

const CodeAgentRunCard: FC<{ data: ThreadCodeAgentRunData }> = ({ data }) => {
  return <CodeAgentLiveActivity data={data} />
}

const CodeAgentLiveActivity: FC<{ data: ThreadCodeAgentRunData }> = ({ data }) => {
  const runtimeLabel = codeAgentRuntimeLabel(data.runtime)
  const [detailsOpen, setDetailsOpen] = useState(() =>
    data.status === 'running' || data.status === 'failed' || data.status === 'timed-out',
  )
  const detailsData = useMemo(
    () =>
      detailsOpen
        ? (getCachedCodeAgentRunMetadata(data.__agenthubFullRunId) ?? data)
        : data,
    [data, detailsOpen],
  )
  const artifacts = detailsOpen ? readFlowArtifacts(detailsData.artifacts) : []
  const summary = buildCodeAgentRunSummary(data)
  const warning = detailsData.warning ?? data.warning
  const diagnostics = detailsData.diagnostics

  return (
    <div className="not-prose mt-2 max-w-[48rem] text-sm leading-6 text-neutral-700">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-500">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-1 text-neutral-700">
            <Bot className="h-3.5 w-3.5" />
            {runtimeLabel}
          </span>
          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-1 text-neutral-700">
            {codeAgentStatusLabel(data.status, Boolean(data.partialSuccess))}
          </span>
          {data.durationMs > 0 && (
            <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-1 text-neutral-700">
              {formatDurationMs(data.durationMs)}
            </span>
          )}
          {summary && <span>{summary}</span>}
          {data.exitCode !== 0 && (
            <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-1 text-red-700">
              exit {data.exitCode}
            </span>
          )}
          {data.status === 'running' && <CodeAgentTypingDots />}
          {data.partialSuccess && (
            <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-1 text-amber-700">
              部分成功
            </span>
          )}
          {data.reviewRequired && (
            <span className="inline-flex items-center rounded-full bg-violet-50 px-2 py-1 text-violet-700">
              待复核
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDetailsOpen((value) => !value)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
          aria-expanded={detailsOpen}
        >
          <ChevronDown
            className={cn('h-3 w-3 transition-transform', detailsOpen && 'rotate-180')}
          />
          {detailsOpen ? '收起过程' : '展开过程'}
        </button>
      </div>
      {detailsOpen && (
        <>
          {warning && (
            <div className="mb-2 flex items-start gap-2 text-[12px] leading-5 text-amber-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </div>
          )}
          <FlowRail>
            <CodeAgentProcessRows data={detailsData} />
            {diagnostics && <CodeAgentFailureNotice data={detailsData} />}
          </FlowRail>
          {artifacts.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-neutral-400">
                <Blocks className="h-3.5 w-3.5" />
                产物 · {artifacts.length}
              </div>
              <FlowRail>
                {artifacts.map((item) => (
                  <ArtifactCard key={item.id} artifact={item} />
                ))}
              </FlowRail>
            </div>
          )}
        </>
      )}
      </div>
  )
}

const CodeAgentFailureNotice: FC<{ data: CodeAgentRunMetadata }> = ({ data }) => {
  const [open, setOpen] = useState(false)
  const tone: FlowTone =
    data.status === 'failed' ? 'red' : data.status === 'timed-out' ? 'amber' : 'neutral'

  return (
    <FlowRowShell
      icon={<AlertTriangle className="h-3.5 w-3.5" />}
      tone={tone}
      title="诊断日志"
      subtitle="执行器返回了诊断信息，可能包含失败原因或截断线索。"
      action={
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
          {open ? '收起' : '展开'}
        </button>
      }
      expand={
        open ? (
          <pre className="agenthub-readable-code whitespace-pre-wrap break-words pl-6 text-[12px] leading-5 text-neutral-700">
            {data.diagnostics}
          </pre>
        ) : undefined
      }
    />
  )
}

const CodeAgentTypingDots: FC = () => (
  <span className="agenthub-steady-dots inline-flex shrink-0 items-center gap-1 pl-0.5" aria-hidden="true">
    <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
    <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
    <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
  </span>
)

type FlowTone = 'neutral' | 'blue' | 'emerald' | 'amber' | 'red' | 'violet'

type FlowRow = {
  key: string
  icon: ReactNode
  title: string
  subtitle?: string
  detail?: ReactNode
  tone?: FlowTone
  meta?: ReactNode
  action?: ReactNode
  expand?: ReactNode
}

const flowToneClasses: Record<FlowTone, { bubble: string; dot: string; meta: string }> = {
  neutral: {
    bubble: 'bg-neutral-100 text-neutral-600',
    dot: 'bg-neutral-400',
    meta: 'bg-neutral-100 text-neutral-600',
  },
  blue: {
    bubble: 'bg-blue-50 text-blue-600',
    dot: 'bg-blue-500',
    meta: 'bg-blue-50 text-blue-700',
  },
  emerald: {
    bubble: 'bg-emerald-50 text-emerald-600',
    dot: 'bg-emerald-500',
    meta: 'bg-emerald-50 text-emerald-700',
  },
  amber: {
    bubble: 'bg-amber-50 text-amber-600',
    dot: 'bg-amber-500',
    meta: 'bg-amber-50 text-amber-700',
  },
  red: {
    bubble: 'bg-red-50 text-red-600',
    dot: 'bg-red-500',
    meta: 'bg-red-50 text-red-700',
  },
  violet: {
    bubble: 'bg-violet-50 text-violet-600',
    dot: 'bg-violet-500',
    meta: 'bg-violet-50 text-violet-700',
  },
}

const FlowRail: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="relative pl-4">
    <div className="absolute bottom-1 left-2 top-1 w-px rounded-full bg-neutral-200/80" />
    <div className="space-y-1.5">{children}</div>
  </div>
)

const FlowRowShell: FC<Omit<FlowRow, 'key'>> = ({
  action,
  detail,
  expand,
  icon,
  meta,
  subtitle,
  title,
  tone = 'neutral',
}) => {
  const classes = flowToneClasses[tone]

  return (
    <div className="relative py-1.5 pl-4">
      <span
        className={cn(
          'absolute left-[7px] top-3 h-2.5 w-2.5 rounded-full ring-4 ring-white',
          classes.dot,
        )}
      />
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full',
            classes.bubble,
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-neutral-900">{title}</span>
            {meta}
          </div>
          {subtitle && <div className="text-[12px] text-neutral-500">{subtitle}</div>}
          {detail && <div className="mt-0.5 text-[12px] leading-5 text-neutral-600">{detail}</div>}
          {expand && <div className="mt-1">{expand}</div>}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
    </div>
  )
}

const CodeAgentProcessRows: FC<{ data: CodeAgentRunMetadata }> = ({ data }) => {
  const rows = useMemo(() => buildCodeAgentProcessRows(data), [data])
  return (
    <>
      {rows.map(({ key, ...row }) => (
        <FlowRowShell key={key} {...row} />
      ))}
    </>
  )
}

function buildCodeAgentProcessRows(data: CodeAgentRunMetadata): FlowRow[] {
  const rows: FlowRow[] = []
  const steps = data.steps ?? []

  if (steps.length > 0) {
    const logSteps = steps.filter((step) => step.kind === 'log')
    for (const step of steps) {
      if (step.kind === 'log') continue
      rows.push(stepToFlowRow(step))
    }
    if (logSteps.length) {
      const lastLog = logSteps[logSteps.length - 1]
      rows.push({
        key: 'step-log-summary',
        icon: <ListTodo className="h-3.5 w-3.5" />,
        tone: logSteps.some((step) => step.status === 'failed') ? 'red' : 'neutral',
        title: '过程输出',
        subtitle: `${logSteps.length} 条运行日志`,
        detail: trimLongText(
          lastLog.detail || lastLog.subtitle || lastLog.title || '日志已折叠，最终结果保留在消息正文。',
          220,
        ),
      })
    }
  } else {
    if (data.toolCalls?.length) {
      for (const call of data.toolCalls) {
        rows.push({
          key: `tool-${call.id}`,
          icon: <Blocks className="h-3.5 w-3.5" />,
          tone: 'blue',
          title: call.label,
          subtitle: [call.name, call.target].filter(Boolean).join(' · ') || undefined,
          detail: call.detail,
        })
      }
    }

    if (data.commands?.length) {
      for (const command of data.commands) {
        rows.push({
          key: `command-${command.id}`,
          icon: <TerminalSquare className="h-3.5 w-3.5" />,
          tone: 'neutral',
          title: command.command,
          subtitle: command.cwd ?? undefined,
          detail: command.output ? trimLongText(command.output, 220) : undefined,
        })
      }
    }

    if (data.files?.length) {
      for (const file of data.files) {
        rows.push({
          key: `file-${file.path}`,
          icon: <FileText className="h-3.5 w-3.5" />,
          tone: fileTone(file.status),
          title: file.path,
          subtitle: file.status ? fileStatusLabel(file.status) : undefined,
          detail: file.diff ? (
            <InlineDiffReview diff={file.diff} filePath={file.path} compact />
          ) : undefined,
        })
      }
    }

    if (data.logs?.length) {
      const lastLog = data.logs[data.logs.length - 1]
      rows.push({
        key: 'log-summary',
        icon: lastLog.stream === 'stderr' ? <XCircle className="h-3.5 w-3.5" /> : <ListTodo className="h-3.5 w-3.5" />,
        tone: data.logs.some((log) => log.stream === 'stderr') ? 'red' : 'neutral',
        title: '过程输出',
        subtitle: `${data.logs.length} 条运行日志`,
        detail: trimLongText(lastLog.text, 220),
      })
    }
  }

  if (steps.length > 0 && data.files?.some((file) => file.diff)) {
    for (const file of data.files.filter((item) => item.diff)) {
      rows.push({
        key: `file-review-${file.path}`,
        icon: <FileText className="h-3.5 w-3.5" />,
        tone: fileTone(file.status),
        title: file.path,
        subtitle: `${fileStatusLabel(file.status)} · 代码变更待审查`,
        detail: <InlineDiffReview diff={file.diff ?? ''} filePath={file.path} compact />,
      })
    }
  }

  if (!rows.length) {
    rows.push({
      key: 'code-agent-empty',
      icon: <Clock3 className="h-3.5 w-3.5" />,
      tone: data.status === 'failed' ? 'red' : data.status === 'running' ? 'blue' : 'neutral',
      title: codeAgentStatusLabel(data.status, Boolean(data.partialSuccess)),
      subtitle: '当前只拿到汇总状态，还没有拆分出的执行事件。',
    })
  }

  return rows
}

function stepToFlowRow(step: NonNullable<CodeAgentRunMetadata['steps']>[number]): FlowRow {
  const tone = stepTone(step.status)
  const icon = stepIcon(step.kind, step.status)
  const subtitle = [
    step.subtitle,
    step.toolName ? `工具 ${step.toolName}` : null,
    step.command ? `命令 ${step.command}` : null,
    step.path ? `路径 ${step.path}` : null,
    step.fileStatus ? fileStatusLabel(step.fileStatus) : null,
    step.stream ? step.stream : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    key: step.id,
    icon,
    tone,
    title: step.title,
    subtitle: subtitle || undefined,
    detail: step.detail ? trimLongText(step.detail, 240) : undefined,
  }
}

function stepTone(status: CodeAgentRunMetadata['status']): FlowTone {
  if (status === 'failed') return 'red'
  if (status === 'timed-out') return 'amber'
  if (status === 'running') return 'blue'
  if (status === 'cancelled') return 'neutral'
  return 'emerald'
}

function stepIcon(
  kind: NonNullable<CodeAgentRunMetadata['steps']>[number]['kind'],
  status: CodeAgentRunMetadata['status'],
) {
  if (status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin" />
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5" />
  if (status === 'timed-out') return <Clock3 className="h-3.5 w-3.5" />
  if (status === 'cancelled') return <Square className="h-3.5 w-3.5" />
  if (kind === 'tool') return <Blocks className="h-3.5 w-3.5" />
  if (kind === 'command') return <TerminalSquare className="h-3.5 w-3.5" />
  if (kind === 'file') return <FileText className="h-3.5 w-3.5" />
  if (kind === 'log') return <ListTodo className="h-3.5 w-3.5" />
  return <CheckCircle2 className="h-3.5 w-3.5" />
}

function buildCodeAgentRunSummary(data: ThreadCodeAgentRunData) {
  const counts = data.__agenthubSummaryCounts
  const stepCount = counts?.steps ?? data.steps?.length ?? 0
  const toolCallCount = counts?.toolCalls ?? data.toolCalls?.length ?? 0
  const commandCount = counts?.commands ?? data.commands?.length ?? 0
  const fileCount = counts?.files ?? data.files?.length ?? 0
  const logCount = counts?.logs ?? data.logs?.length ?? 0
  const artifactCount = counts?.artifacts ?? readFlowArtifacts(data.artifacts).length
  const parts = [
    stepCount ? `${stepCount} 步骤` : null,
    toolCallCount ? `${toolCallCount} 工具` : null,
    commandCount ? `${commandCount} 命令` : null,
    fileCount ? `${fileCount} 文件` : null,
    logCount ? `${logCount} 日志` : null,
    artifactCount ? `${artifactCount} 产物` : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

function formatDurationMs(value: number) {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}

function summarizeDiff(diff: string) {
  const lines = diff.split(/\r?\n/)
  const additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
  const deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
  return `Diff · +${additions} / -${deletions}`
}

function readFlowArtifacts(value: unknown): AgentArtifact[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.filter((item): item is AgentArtifact => {
    if (!item || typeof item !== 'object') return false
    const artifact = item as { id?: unknown; type?: unknown }
    if (
      typeof artifact.id !== 'string' ||
      typeof artifact.type !== 'string' ||
      seen.has(artifact.id)
    ) {
      return false
    }
    seen.add(artifact.id)
    return ['diff', 'preview', 'file', 'deploy', 'workflow'].includes(artifact.type)
  })
}

function fileTone(status?: CodeAgentRunMetadata['files'][number]['status']): FlowTone {
  if (status === 'deleted') return 'red'
  if (status === 'created') return 'emerald'
  if (status === 'renamed') return 'violet'
  if (status === 'untracked') return 'amber'
  return 'blue'
}

const AgentArtifactsCard: FC<{ data: { items?: AgentArtifact[] } }> = ({ data }) => {
  const items = data.items ?? []
  if (!items.length) return null

  return (
    <div className="not-prose mt-3 max-w-[48rem] text-sm leading-6 text-neutral-700">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-neutral-400">
        <Blocks className="h-3.5 w-3.5" />
        产物 · {items.length}
      </div>
      <FlowRail>
        {items.map((item) => (
          <ArtifactCard key={item.id} artifact={item} />
        ))}
      </FlowRail>
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
  const workspaceId = useChatStore((s) => s.currentSession?.workspaceId)
  const item = enrichPreviewItem(previewItemFromArtifact(artifact), workspaceId ?? undefined)
  return (
    <FlowRowShell
      icon={<FileText className="h-3.5 w-3.5" />}
      tone={fileTone(artifact.status)}
      title={artifact.title || artifact.path.split(/[\\/]/).pop() || artifact.path}
      subtitle={artifact.status ? fileStatusLabel(artifact.status) : '文件产物'}
      detail={artifact.path}
      action={
        <button
          type="button"
          onClick={() => requestArtifactPreview(item)}
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
          title={previewActionLabel(item)}
        >
          {previewActionIcon(item)}
          {previewActionLabel(item)}
        </button>
      }
    />
  )
}

const DiffArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'diff' }> }> = ({
  artifact,
}) => {
  const lines = artifact.diff.split(/\r?\n/)
  const additions = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
  const deletions = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length

  return (
    <FlowRowShell
      icon={<GitBranch className="h-3.5 w-3.5" />}
      tone="blue"
      title={artifact.title || artifact.filePath}
      subtitle={`${fileStatusLabel(artifact.status ?? 'modified')} · Diff · +${additions} / -${deletions}`}
      detail={artifact.description ?? artifact.filePath}
      expand={<InlineDiffReview diff={artifact.diff} filePath={artifact.filePath} previewId={artifact.id} />}
    />
  )
}

const InlineDiffReview: FC<{
  diff: string
  filePath: string
  compact?: boolean
  previewId?: string
}> = ({ compact = false, diff, filePath, previewId }) => {
  const workspaceId = useChatStore((s) => s.currentSession?.workspaceId)
  const [open, setOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<'applied' | 'error' | null>(null)
  const [applyMessage, setApplyMessage] = useState('')
  const summary = summarizeDiff(diff)

  const previewItem: ArtifactPreviewItem = {
    id: previewId ?? `diff-${filePath}`,
    kind: 'diff',
    path: filePath,
    source: diff,
    subtitle: '代码 Diff',
    title: filePath,
  }

  async function handleSaveEdit(params: DiffEditSaveParams) {
    if (!workspaceId) return
    if (params.fileContent !== undefined) {
      await api.writeFile({
        workspaceId,
        filePath,
        content: params.fileContent,
      })
      return
    }
    if (!params.lineNumber) throw new Error('当前 Diff 缺少可写入行号，无法保存。')
    await api.writeFile({
      workspaceId,
      filePath,
      content: params.lineText,
      startLine: params.lineNumber,
      endLine: params.lineNumber,
    })
  }

  async function applyCurrentDiff() {
    if (applying) return
    if (!workspaceId) {
      setOpen(true)
      setApplyResult('error')
      setApplyMessage('当前会话未绑定工作区，无法暂存 Diff。')
      return
    }
    setApplying(true)
    setApplyResult(null)
    setApplyMessage('')
    try {
      const result = await api.applyDiff(workspaceId, diff)
      setOpen(true)
      setApplyResult('applied')
      setApplyMessage(result.message || 'Diff 已暂存到 Git。')
    } catch (error) {
      setOpen(true)
      setApplyResult('error')
      setApplyMessage(friendlyErrorMessage(error, '暂存 Diff 失败'))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className={cn('not-prose', compact ? 'mt-1' : 'mt-2')}>
      <div className="flex flex-wrap items-center gap-1.5">
        {compact && <span className="mr-1 text-[12px] text-neutral-500">{summary}</span>}
        <button
          type="button"
          onClick={() => requestArtifactPreview(previewItem)}
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
        >
          <GitBranch className="h-3 w-3" />
          预览
        </button>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
          aria-expanded={open}
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
          {open ? '收起' : '展开'}
        </button>
        <button
          type="button"
          onClick={() => void applyCurrentDiff()}
          disabled={applying || applyResult === 'applied'}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition disabled:pointer-events-none',
            applyResult === 'applied'
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-neutral-900 text-white hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400',
          )}
        >
          {applying ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : applyResult === 'applied' ? (
            <Check className="h-3 w-3" />
          ) : (
            <CheckCircle2 className="h-3 w-3" />
          )}
          {applying ? '暂存中' : applyResult === 'applied' ? '已暂存' : '暂存'}
        </button>
      </div>
      {applyMessage && (
        <div
          className={cn(
            'mt-2 rounded-xl px-3 py-2 text-[12px] leading-5',
            applyResult === 'error'
              ? 'bg-red-50 text-red-700'
              : 'bg-emerald-50 text-emerald-700',
          )}
        >
          {applyMessage}
        </div>
      )}
      {open && (
        <div className="mt-2 overflow-hidden rounded-xl border border-neutral-200">
          <DiffViewer
            diff={diff}
            maxHeightClassName={compact ? 'max-h-72' : 'max-h-96'}
            filePath={filePath}
            onSaveEdit={workspaceId ? handleSaveEdit : undefined}
          />
        </div>
      )}
    </div>
  )
}

const DiffViewer: FC<{
  diff: string
  maxHeightClassName?: string
  filePath?: string
  /** Called when user saves an inline edit. */
  onSaveEdit?: (params: DiffEditSaveParams) => void | Promise<void>
}> = ({
  diff,
  maxHeightClassName = 'max-h-96',
  filePath,
  onSaveEdit,
}) => {
  const parsedRows = useMemo(() => parseDiffRows(diff), [diff])
  const [rowTextOverrides, setRowTextOverrides] = useState<Record<number, string>>({})
  const rows = useMemo(
    () =>
      parsedRows.map((row, index) =>
        Object.prototype.hasOwnProperty.call(rowTextOverrides, index)
          ? { ...row, text: rowTextOverrides[index] }
          : row,
      ),
    [parsedRows, rowTextOverrides],
  )
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
  const [editSaveNotice, setEditSaveNotice] = useState<{
    tone: 'success' | 'error'
    message: string
  } | null>(null)
  const [localChangeTarget, setLocalChangeTarget] = useState<LocalChangeTarget | null>(null)

  useEffect(() => {
    setRowTextOverrides({})
    setEditSaveNotice(null)
    setEditingSelectableIndex(null)
    setEditDraft('')
  }, [diff])

  function isRowSelected(originalIndex: number) {
    const selIdx = selectableRows.findIndex((r) => r._index === originalIndex)
    return selIdx >= 0 && selection.isSelected(selIdx)
  }

  function handleLineNumberClick(originalIndex: number, shiftKey: boolean) {
    const selIdx = selectableRows.findIndex((r) => r._index === originalIndex)
    if (selIdx >= 0) selection.toggleLine(selIdx, shiftKey)
  }

  function handleDiffCodeClick(
    originalIndex: number,
    event: ReactMouseEvent<HTMLElement>,
  ) {
    if (window.getSelection()?.toString()) return
    handleLineNumberClick(originalIndex, event.shiftKey)
  }

  function buildDiffTarget(): LocalChangeTarget | null {
    const selected = selection.sortedSelected.map((si) => selectableRows[si])
    if (selected.length === 0) return null
    const lines = selected.map((r) => {
      const marker = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
      return `${marker}${r.text}`
    })
    const startLine = selected[0].newNumber ?? selected[0].oldNumber ?? '?'
    const endLine =
      selected[selected.length - 1].newNumber ?? selected[selected.length - 1].oldNumber ?? startLine
    return {
      filePath,
      language: filePath ? guessLanguageFromPath(filePath) : 'diff',
      lineLabel: formatLineRangeLabel(startLine, endLine),
      selectedText: lines.join('\n'),
      sourceLabel: 'Diff 预览',
    }
  }

  function buildReferenceText() {
    const target = buildDiffTarget()
    if (!target) return ''
    const langGuess = filePath ? guessLanguageFromPath(filePath) : ''
    const header = filePath
      ? `\`${filePath}\` ${target.lineLabel}:\n`
      : `${target.lineLabel}:\n`
    return `${header}${codeFenceForContent(target.selectedText, langGuess)}\n`
  }

  function handleReference() {
    const text = buildReferenceText()
    if (text) insertTextIntoComposer(text)
    clearDiffSelection()
  }

  function handleLocalChange() {
    const target = buildDiffTarget()
    if (target) setLocalChangeTarget(target)
  }

  function clearDiffSelection() {
    selection.clearSelection()
    setLocalChangeTarget(null)
  }

  function handleStartEdit() {
    if (selection.sortedSelected.length === 0) return
    const firstSelIdx = selection.sortedSelected[0]
    setEditingSelectableIndex(firstSelIdx)
    setEditSaveNotice(null)
    const row = selectableRows[firstSelIdx]
    const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
    setEditDraft(`${marker}${row.text}`)
  }

  function handleCancelEdit() {
    setEditingSelectableIndex(null)
    setEditDraft('')
    setEditSaveNotice(null)
  }

  async function handleSaveEdit() {
    if (editingSelectableIndex === null || !onSaveEdit) return
    setSaving(true)
    setEditSaveNotice(null)
    try {
      const row = selectableRows[editingSelectableIndex]
      // Determine the 1-based line number in the current file
      // For 'add' and 'context' rows, use newNumber; for 'del', use oldNumber
      const lineNumber = row.kind === 'del' ? row.oldNumber : row.newNumber
      if (!lineNumber) {
        setEditSaveNotice({
          tone: 'error',
          message: '当前 Diff 缺少可写入行号，无法保存。',
        })
        return
      }
      // The editDraft has a prefix marker (+, -, or space); strip it to get just the line text
      const lineText = editDraft.length > 1 ? editDraft.slice(1) : ''
      await onSaveEdit({
        lineText,
        lineNumber,
        fileContent: buildEditableDiffFileContent(rows, row._index, lineText),
      })
      setRowTextOverrides((current) => ({ ...current, [row._index]: lineText }))
      setEditSaveNotice({ tone: 'success', message: '已保存到工作区文件。' })
      setEditingSelectableIndex(null)
      setEditDraft('')
      clearDiffSelection()
    } catch (error) {
      setEditSaveNotice({
        tone: 'error',
        message: friendlyErrorMessage(error, '保存失败'),
      })
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
          onLocalChange={handleLocalChange}
          onEdit={onSaveEdit ? handleStartEdit : undefined}
          onClear={clearDiffSelection}
        />
      )}
      {localChangeTarget && (
        <LocalChangeComposer
          target={localChangeTarget}
          onCancel={() => setLocalChangeTarget(null)}
          onSent={clearDiffSelection}
        />
      )}
      {editSaveNotice && (
        <div
          className={cn(
            'border-t px-3 py-2 text-xs',
            editSaveNotice.tone === 'error'
              ? 'border-red-100 bg-red-50 text-red-700'
              : 'border-emerald-100 bg-emerald-50 text-emerald-700',
          )}
        >
          {editSaveNotice.message}
        </div>
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
                  <code
                    className={cn(
                      'whitespace-pre px-3',
                      canSelect && 'agenthub-diff-code-selectable',
                    )}
                    onClick={canSelect ? (event) => handleDiffCodeClick(index, event) : undefined}
                  >
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
  const item = previewItemFromArtifact(artifact)
  return (
    <FlowRowShell
      icon={<Globe2 className="h-3.5 w-3.5" />}
      tone="emerald"
      title={artifact.title}
      subtitle={previewKindName(artifact.previewKind)}
      detail={artifact.url}
      action={
        <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => requestArtifactPreview(item)}
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
          title="预览网页"
        >
          <Monitor className="h-3 w-3" />
          预览
        </button>
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
          title="新窗口打开"
        >
          <ExternalLink className="h-3 w-3" />
          打开
        </a>
      </div>
      }
    />
  )
}

const DeployArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'deploy' }> }> = ({
  artifact,
}) => {
  const item = previewItemFromArtifact(artifact)
  return (
    <FlowRowShell
      icon={<Rocket className="h-3.5 w-3.5" />}
      tone={artifact.status === 'failed' ? 'red' : artifact.status === 'ready' ? 'emerald' : 'amber'}
      title={artifact.title}
      subtitle={`${artifact.provider} · ${deployStatusLabel(artifact.status)}`}
      detail={artifact.logs ?? artifact.description}
      action={
        artifact.url ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => requestArtifactPreview(item)}
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
              title="预览部署"
            >
              <Monitor className="h-3 w-3" />
              预览
            </button>
            <a
              href={artifact.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
              title="打开部署"
            >
              <ExternalLink className="h-3 w-3" />
              打开
            </a>
          </div>
        ) : undefined
      }
    />
  )
}

const WorkflowArtifactCard: FC<{ artifact: Extract<AgentArtifact, { type: 'workflow' }> }> = ({
  artifact,
}) => (
  <FlowRowShell
    icon={<GitBranch className="h-3.5 w-3.5" />}
    tone="violet"
    title={artifact.title}
    subtitle={`${artifact.nodes.length} 个节点 · ${artifact.edges.length} 条连接`}
    detail={artifact.description}
    action={
      <button
        type="button"
        onClick={() => requestArtifactPreview(previewItemFromArtifact(artifact))}
        className="inline-flex h-7 items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 text-[11px] text-neutral-700 transition hover:bg-neutral-200 hover:text-neutral-950"
        title="查看流程"
      >
        <GitBranch className="h-3 w-3" />
        流程
      </button>
    }
  />
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
  let oldFilePath: string | undefined
  let newFilePath: string | undefined
  const rawLines = diff.split(/\r?\n/)

  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index]
    if (index === rawLines.length - 1 && rawLine === '' && diff.endsWith('\n')) continue

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
      rawLine.startsWith('new file mode ') ||
      rawLine.startsWith('deleted file mode ') ||
      rawLine.startsWith('old mode ') ||
      rawLine.startsWith('new mode ') ||
      rawLine.startsWith('similarity index ') ||
      rawLine.startsWith('dissimilarity index ') ||
      rawLine.startsWith('rename from ') ||
      rawLine.startsWith('rename to ')
    ) {
      rows.push({ kind: 'meta', marker: '', text: rawLine })
      continue
    }

    if (rawLine.startsWith('--- ')) {
      oldFilePath = rawLine.slice(4).trim()
      oldLine = oldFilePath === '/dev/null' ? undefined : (oldLine ?? 1)
      rows.push({ kind: 'meta', marker: '', text: rawLine })
      continue
    }

    if (rawLine.startsWith('+++ ')) {
      newFilePath = rawLine.slice(4).trim()
      newLine = newFilePath === '/dev/null' ? undefined : (newLine ?? 1)
      rows.push({ kind: 'meta', marker: '', text: rawLine })
      continue
    }

    if (rawLine.startsWith('+')) {
      if (newLine === undefined && newFilePath && newFilePath !== '/dev/null') newLine = 1
      rows.push({ kind: 'add', marker: '+', newNumber: newLine, text: rawLine.slice(1) })
      if (newLine !== undefined) newLine += 1
      continue
    }

    if (rawLine.startsWith('-')) {
      if (oldLine === undefined && oldFilePath && oldFilePath !== '/dev/null') oldLine = 1
      rows.push({ kind: 'del', marker: '-', oldNumber: oldLine, text: rawLine.slice(1) })
      if (oldLine !== undefined) oldLine += 1
      continue
    }

    const text = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
    if (oldLine === undefined && oldFilePath && oldFilePath !== '/dev/null') oldLine = 1
    if (newLine === undefined && newFilePath && newFilePath !== '/dev/null') newLine = 1
    rows.push({ kind: 'context', marker: '', oldNumber: oldLine, newNumber: newLine, text })
    if (oldLine !== undefined) oldLine += 1
    if (newLine !== undefined) newLine += 1
  }

  return rows
}

function buildEditableDiffFileContent(
  rows: DiffRow[],
  editedOriginalIndex: number,
  editedLineText: string,
) {
  const isNewFileDiff =
    rows.some((row) => row.kind === 'meta' && row.text === '--- /dev/null') &&
    rows.some(
      (row) =>
        row.kind === 'meta' &&
        row.text.startsWith('+++ ') &&
        row.text.trim() !== '+++ /dev/null',
    )
  if (!isNewFileDiff) return undefined

  return rows
    .flatMap((row, index) => {
      if (row.kind !== 'add' && row.kind !== 'context') return []
      return index === editedOriginalIndex ? [editedLineText] : [row.text]
    })
    .join('\n')
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

function fileStatusLabel(status: CodeAgentRunMetadata['files'][number]['status']) {
  if (status === 'created') return '创建'
  if (status === 'modified') return '修改'
  if (status === 'deleted') return '删除'
  if (status === 'renamed') return '重命名'
  return '未跟踪'
}

function TaskBoardCard({ data }: { data: any }) {
  const liveTaskBoard = useChatStore((s) => s.taskBoard)
  const taskBoard = liveTaskBoard?.runId === data?.runId ? liveTaskBoard : data
  const stats = taskProgressStats(taskBoard)
  const runningCount = taskBoard?.tasks?.filter((task: any) => task.status === 'running').length ?? 0
  const artifactCount =
    taskBoard?.tasks?.reduce(
      (total: number, task: any) => total + (task.artifactCount ?? task.artifacts?.length ?? 0),
      0,
    ) ?? 0

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(roomTasksDrawerEvent))}
      className="not-prose my-2 block w-full rounded-2xl border border-neutral-200 bg-white px-3 py-2.5 text-left text-sm text-neutral-800 transition hover:border-blue-200 hover:bg-blue-50/30"
    >
      <div className="flex items-center gap-3">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600">
          <ListTodo className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <div className="font-medium text-neutral-900">
              {taskBoard?.title || '房间任务'}
            </div>
            <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700">
              {taskBoard ? runStatusLabel[taskBoard.status] ?? taskBoard.status : '查看任务'}
            </span>
          </div>
          <p className="mt-0.5 text-xs leading-5 text-neutral-500">
            {stats.total > 0
              ? `${stats.done}/${stats.total} 已完成，${runningCount} 执行中，${artifactCount} 个产物。`
              : '任务状态、线程入口和产物都收进任务抽屉里。'}
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-neutral-400">展开</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
      </div>
    </button>
  )
}

const SystemMessage: FC = () => (
  <MessagePrimitive.Root className="mx-auto w-full max-w-[var(--thread-max-width)] py-2">
    <div className="rounded-2xl bg-neutral-100 px-3 py-2 text-xs text-neutral-500">
      <AssistantMessageParts />
    </div>
  </MessagePrimitive.Root>
)

const AssistantActionBar: FC = () => {
  const messageId = useMessage((message) => message.id)
  const sourceMessage = useChatStore((state) =>
    state.messages.find((message) => message.id === messageId),
  )
  const setReplyingTo = useChatStore((state) => state.setReplyingTo)
  const regenerateMessage = useChatStore((state) => state.regenerateMessage)
  const [regenerating, setRegenerating] = useState(false)
  const canUseMessage = Boolean(sourceMessage && messageId !== 'agenthub-thinking')

  function reply() {
    if (!canUseMessage) return
    setReplyingTo(messageId, 'reply')
    focusComposerInput()
  }

  function quote() {
    if (!canUseMessage) return
    setReplyingTo(messageId, 'quote')
    focusComposerInput()
  }

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
      className="mt-2 flex flex-wrap items-center gap-1.5 text-neutral-500"
    >
      <MessageActionButton
        aria-label="回复"
        title="回复"
        onClick={reply}
        disabled={!canUseMessage}
        icon={<MessageCircleReply className="h-3.5 w-3.5" />}
      >
        回复
      </MessageActionButton>
      <MessageActionButton
        aria-label="引用"
        title="引用为卡片"
        onClick={quote}
        disabled={!canUseMessage}
        icon={<TextQuote className="h-3.5 w-3.5" />}
      >
        引用
      </MessageActionButton>
      <MessageActionButton
        aria-label="重新生成"
        title="重新生成"
        onClick={regenerate}
        disabled={!canUseMessage || regenerating}
        icon={<RefreshCw className={cn('h-3.5 w-3.5', regenerating && 'animate-spin')} />}
      >
        重新生成
      </MessageActionButton>
    </ActionBarPrimitive.Root>
  )

}

const MessageActionButton: FC<
  ComponentPropsWithoutRef<'button'> & { icon: ReactNode }
> = ({ children, className, icon, ...props }) => (
  <button
    type="button"
    className={cn(
      'inline-flex h-7 items-center gap-1 rounded-full bg-neutral-100 px-2.5 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-200 hover:text-neutral-950 disabled:pointer-events-none disabled:opacity-45',
      className,
    )}
    {...props}
  >
    {icon}
    <span>{children}</span>
  </button>
)

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

const Avatar: FC<{ role: 'user' | 'assistant'; className?: string }> = ({ className, role }) => {
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
        className={cn(
          'grid shrink-0 place-items-center overflow-hidden rounded-full text-sm font-semibold text-white shadow-sm',
          className ?? 'h-9 w-9',
        )}
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
        className={cn(
          'grid shrink-0 place-items-center rounded-full border border-neutral-200 bg-white shadow-sm',
          className ?? 'h-9 w-9',
        )}
        title={codeAgentRuntimeLabel(runtime)}
      >
        <img
          src={codeAgentLogoSrc(runtime)}
          alt={codeAgentRuntimeLabel(runtime)}
          className={cn('object-contain', className ? 'h-3.5 w-3.5' : 'h-5 w-5')}
          decoding="async"
          draggable={false}
        />
      </div>
    )
  }

  if (role === 'user') {
    return <UserAvatar className={className} />
  }

  return (
    <div
      className={cn(
        'grid shrink-0 place-items-center rounded-full',
        role === 'assistant' ? 'bg-[#eef8f6] text-[#87a9a4]' : 'bg-blue-500 text-white',
        className ?? 'h-9 w-9',
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
  const aliases = mentionAliasEntries(agents).map((entry) => entry.alias)
  const pattern = mentionPatternForAliases(aliases)
  if (!pattern) return text
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
  const filePath = guessFilePathFromLanguage(language ?? '') ?? guessFilePathFromLanguage(langLabel)
  const selection = useLineSelection(lines.length)
  const [localChangeTarget, setLocalChangeTarget] = useState<LocalChangeTarget | null>(null)

  function buildCodeBlockTarget(): LocalChangeTarget | null {
    const selected = selection.sortedSelected
    if (selected.length === 0) return null
    const selectedLines = selected.map((i) => lines[i])
    return {
      filePath,
      language: langLabel,
      lineLabel: formatLineRangeLabel(selected[0] + 1, selected[selected.length - 1] + 1),
      selectedText: selectedLines.join('\n'),
      sourceLabel: '消息代码块',
    }
  }

  function handleReference() {
    const target = buildCodeBlockTarget()
    if (!target) return
    const header = filePath
      ? `\`${filePath}\` ${target.lineLabel}:\n`
      : `${target.lineLabel}:\n`
    insertTextIntoComposer(`${header}${codeFenceForContent(target.selectedText, langLabel)}\n`)
    clearCodeSelection()
  }

  function handleLocalChange() {
    const target = buildCodeBlockTarget()
    if (target) setLocalChangeTarget(target)
  }

  function clearCodeSelection() {
    selection.clearSelection()
    setLocalChangeTarget(null)
  }

  // Always render table layout with line numbers for consistent UX
  return (
    <div className="agenthub-code-block-wrapper">
      {selection.selectedCount > 0 && (
        <LineSelectionToolbar
          selectedCount={selection.selectedCount}
          onReference={handleReference}
          onLocalChange={handleLocalChange}
          onClear={clearCodeSelection}
        />
      )}
      {localChangeTarget && (
        <LocalChangeComposer
          target={localChangeTarget}
          onCancel={() => setLocalChangeTarget(null)}
          onSent={clearCodeSelection}
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
                  <td
                    className="agenthub-code-content"
                    onClick={(event) => {
                      if (shouldSkipLineSelectionClick(event)) return
                      selection.toggleLine(i, event.shiftKey)
                    }}
                  >
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
  <div className="not-prose mt-1 max-w-full text-neutral-900">
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
      className="agenthub-markdown prose prose-neutral prose-sm max-w-none prose-p:my-1.5 prose-ul:my-2 prose-code:before:content-none prose-code:after:content-none"
    />
  </div>
)

function shouldSkipLineSelectionClick(event: ReactMouseEvent<HTMLElement>) {
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target?.closest('button, input, textarea, select, a')) return true
  return Boolean(window.getSelection()?.toString())
}
