import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
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
  Plus,
  Presentation,
  RefreshCw,
  Search,
  Sheet,
  Square,
  TerminalSquare,
  User,
  Users,
} from 'lucide-react'
import { type ComponentPropsWithoutRef, type FC, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import {
  api,
  type CodeAgentRunMetadata,
  type ModelCatalogItem,
  type OrchestratorDispatchResult,
  type OrchestratorPlan,
  type TaskStatus,
  type Workspace,
  type WorkspaceAgent,
} from '../../lib/api'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../stores/chatStore'

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
      className="relative flex h-full flex-col overflow-hidden bg-white"
      style={{ ['--thread-max-width' as string]: '44rem' }}
    >
      <ThreadHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} />
      <div className="flex min-h-0 flex-1">
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
        {isGroupSession && <GroupMemberPanel />}
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
}> = ({ sidebarCollapsed, onToggleSidebar }) => (
  <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
    <div className="flex min-w-0 items-center gap-3">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
        aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
        title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
      >
        <PanelLeft className={cn('h-4 w-4 transition-transform duration-300', sidebarCollapsed && 'rotate-180')} />
      </button>
      <div className="truncate text-sm font-medium text-neutral-950">AgentHub</div>
      <span className="text-sm text-neutral-300">/</span>
      <span className="truncate text-sm text-neutral-500">对话由 AI 生成</span>
    </div>
    <div className="flex items-center gap-1">
      <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-label="新建">
        <Plus className="h-4 w-4" />
      </button>
      <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-label="对话">
        <MessageSquare className="h-4 w-4" />
      </button>
    </div>
  </header>
)

const GroupMemberPanel: FC = () => {
  const navigate = useNavigate()
  const workspace = useChatStore((state) => state.currentWorkspace)
  const agents = useChatStore((state) => state.currentWorkspaceAgents)
  const messages = useChatStore((state) => state.messages)
  const activeAgentIds = new Set(messages.filter((message) => message.senderType === 'agent').map((message) => message.senderId))
  const [collapsed, setCollapsed] = useState(false)

  if (collapsed) {
    return (
      <aside className="hidden w-12 shrink-0 border-l border-neutral-200 bg-[#fbfbf9] xl:block">
        <div className="flex flex-col items-center gap-3 py-4">
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
            <div className="grid h-7 w-7 place-items-center rounded-full bg-blue-500 text-[10px] font-semibold text-white" title="You">Y</div>
            <div className="grid h-7 w-7 place-items-center rounded-full bg-neutral-900 text-[10px] font-semibold text-white" title="Orchestrator">O</div>
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
                style={{ background: agent.color ?? '#111827' }}
                title={agent.name}
              >
                {agent.name.slice(0, 1).toUpperCase()}
              </div>
            ))}
          </div>
        </div>
      </aside>
    )
  }

  return (
    <aside className="hidden w-72 shrink-0 border-l border-neutral-200 bg-[#fbfbf9] px-4 py-5 xl:block">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-neutral-950">群聊成员</div>
          <div className="mt-1 truncate text-xs text-neutral-500">{workspace?.name ?? 'Agent Group'}</div>
        </div>
        <div className="flex items-center gap-1.5">
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
        <MemberRow name="Orchestrator" role="拆解、协调、生成任务卡" active={activeAgentIds.has('orchestrator')} />
        {agents.map((agent) => (
          <MemberRow
            key={agent.id}
            name={agent.name}
            role={`${agent.role} · ${agent.runtimeType}${agent.codeAgentType ? `/${agent.codeAgentType}` : ''}`}
            color={agent.color}
            active={activeAgentIds.has(agent.id)}
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
    </aside>
  )
}

const MemberRow: FC<{ name: string; role: string; color?: string; active?: boolean }> = ({ name, role, color, active }) => (
  <div className="flex items-center gap-3 rounded-2xl px-2 py-2 transition hover:bg-white">
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
    <span className={cn('h-2 w-2 rounded-full', active ? 'bg-emerald-500' : 'bg-neutral-300')} />
  </div>
)

const ThreadWelcome: FC = () => (
  <ThreadPrimitive.Empty>
    <div className="mx-auto flex min-h-[calc(100vh-15rem)] w-full max-w-[var(--thread-max-width)] flex-col justify-center py-10">
      <div className="mb-24">
        <h2 className="text-2xl font-semibold tracking-normal text-neutral-950">有什么可以帮忙的？</h2>
        <p className="mt-2 text-base text-neutral-500">创建 Agent、拆解任务，或直接 @ 某个助手开始协作。</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <PromptCard title="创建 coder 代理" text="帮我单开一个跳跃小游戏" />
        <PromptCard title="解释架构" text="这个项目如何接入 assistant-ui" />
      </div>
    </div>
  </ThreadPrimitive.Empty>
)

const PromptCard: FC<{ title: string; text: string }> = ({ title, text }) => (
  <div className="rounded-3xl border border-neutral-200 bg-white px-5 py-4 shadow-sm">
    <div className="text-sm font-medium text-neutral-950">{title}</div>
    <div className="mt-1 text-sm text-neutral-500">{text}</div>
  </div>
)

const Composer: FC = () => {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedModelId = useChatStore((state) => state.selectedModelId)
  const setSelectedModelId = useChatStore((state) => state.setSelectedModelId)
  const currentWorkspace = useChatStore((state) => state.currentWorkspace)
  const workspaceAgents = useChatStore((state) => state.currentWorkspaceAgents)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const selectSession = useChatStore((state) => state.selectSession)
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [menu, setMenu] = useState<'tools' | 'agents' | 'models' | 'workspace' | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [openingWorkspaceId, setOpeningWorkspaceId] = useState<string | null>(null)
  const [attachment, setAttachment] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [composerText, setComposerText] = useState('')
  const [composerScrollTop, setComposerScrollTop] = useState(0)
  const selectedModel = models.find((item) => item.id === selectedModelId)
  const modelLabel = selectedModel?.modelId ?? '自动'

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

  function showHint(text: string) {
    setHint(text)
    window.setTimeout(() => setHint(null), 1800)
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setAttachment(file.name)
  }

  function insertComposerText(value: string) {
    const input = document.querySelector<HTMLTextAreaElement>('[data-agenthub-composer="true"]')
    if (!input) {
      void navigator.clipboard?.writeText(value).catch(() => undefined)
      return
    }
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? input.value.length
    input.focus()
    input.setSelectionRange(start, end)
    const inserted = document.execCommand?.('insertText', false, value)
    if (!inserted) {
      input.setRangeText(value, start, end, 'end')
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    }
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
      showHint(errorMessage(err, '打开项目失败'))
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
      showHint(errorMessage(err, '创建空白项目失败'))
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
      const result = await api.openWorkspaceFolder()
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
      showHint(errorMessage(err, '打开文件夹失败'))
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

  return (
    <div className="shrink-0 bg-gradient-to-t from-white via-white to-white/80 px-6 pb-6 pt-3">
      <ComposerPrimitive.Root
        className="mx-auto w-full max-w-[var(--thread-max-width)]"
        onSubmitCapture={syncComposerTextAfterComposerAction}
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest('button[aria-label="发送"]')) {
            syncComposerTextAfterComposerAction()
          }
        }}
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            syncComposerTextAfterComposerAction()
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
              onAttach={() => {
                fileInputRef.current?.click()
                setMenu(null)
              }}
              onWorkspaceMenu={() => setMenu('workspace')}
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
                showHint(`已复制 ${value}，可粘贴到输入框`)
              }}
              onClose={() => setMenu(null)}
            />
          )}
          {hint && <div className="absolute -top-9 left-4 rounded-full bg-neutral-900 px-3 py-1 text-xs text-white shadow">{hint}</div>}
          {attachment && (
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-600">
              <Paperclip className="h-3.5 w-3.5" />
              {attachment}
              <button type="button" onClick={() => setAttachment(null)} className="text-neutral-400 hover:text-neutral-900">
                x
              </button>
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
              placeholder="发消息给 AgentHub，@ 可提及 Agent"
              rows={1}
              onInput={(event) => setComposerText(event.currentTarget.value)}
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
              <input ref={fileInputRef} type="file" className="hidden" onChange={(event) => handleFiles(event.target.files)} />
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
  onAttach: () => void
  onWorkspaceMenu: () => void
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
  onAttach,
  onWorkspaceMenu,
  onOpenWorkspace,
  onCreateBlankWorkspace,
  onOpenFolderWorkspace,
  onClearWorkspace,
  onPlanMode,
  onModel,
  onPick,
  onClose,
}) => {
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
          <button type="button" onClick={onAttach} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-neutral-50">
            <ImagePlus className="h-4 w-4 text-neutral-500" />
            <span className="flex-1 text-neutral-900">添加照片和文件</span>
          </button>
          <button type="button" onClick={onWorkspaceMenu} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-neutral-50">
            <FolderOpen className="h-4 w-4 text-neutral-500" />
            <span className="flex-1 text-neutral-900">打开项目文件夹</span>
          </button>
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
            <span>自动</span>
            <span className="text-xs text-neutral-400">随机可用模型</span>
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

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

function workspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || '项目文件夹'
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

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="mx-auto flex w-full max-w-[var(--thread-max-width)] justify-end gap-3 py-4">
    <div className="max-w-[78%] rounded-3xl bg-[#eef3ff] px-4 py-2.5 text-sm leading-6 text-neutral-950">
      <MessagePrimitive.Parts />
    </div>
    <Avatar role="user" />
  </MessagePrimitive.Root>
)

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="mx-auto flex w-full max-w-[var(--thread-max-width)] gap-3 py-4">
    <Avatar role="assistant" />
    <div className="min-w-0 flex-1">
      <div className="text-sm leading-7 text-neutral-950">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Empty: AssistantThinking,
            data: { by_name: { orchestrator_plan: OrchestratorPlanCard, code_agent_run: CodeAgentRunCard } },
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

const CodeAgentRunCard: FC<{ data: CodeAgentRunMetadata }> = ({ data }) => {
  const [open, setOpen] = useState(false)
  const changedFiles = data.files ?? []
  const commands = data.commands ?? []
  const logs = data.logs ?? []
  const createdCount = changedFiles.filter((file) => file.status === 'created').length
  const fileSummary = changedFiles.length
    ? createdCount === changedFiles.length
      ? `已创建 ${createdCount} 个文件`
      : `已变更 ${changedFiles.length} 个文件`
    : '无文件变更'
  const commandSummary = commands.length ? `已运行 ${commands.length} 条命令` : '未记录命令'
  const statusTone =
    data.status === 'running'
      ? 'text-blue-600'
      : data.status === 'completed'
      ? 'text-neutral-500'
      : data.status === 'timed-out'
        ? 'text-amber-600'
        : 'text-red-600'

  return (
    <div className="not-prose mt-3 overflow-hidden rounded-lg border border-neutral-200 bg-[#fbfbf9] text-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 w-full items-center justify-between gap-3 px-3 text-left transition hover:bg-white"
      >
        <span className={cn('inline-flex min-w-0 items-center gap-2', statusTone)}>
          {data.status === 'running' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Clock3 className="h-4 w-4 shrink-0" />}
          <span className="truncate">{data.status === 'running' ? '正在执行' : '已处理'} {formatRunDuration(data.durationMs)}</span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-neutral-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t border-neutral-200 bg-white px-3 py-2">
          <div className="space-y-1.5">
            <CodeAgentRunSection icon={<FileText className="h-4 w-4" />} title={fileSummary} disabled={!changedFiles.length}>
              <div className="space-y-1">
                {changedFiles.map((file) => (
                  <div key={`${file.status}-${file.path}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 rounded-md bg-neutral-50 px-2 py-1.5">
                    <span className="text-xs text-neutral-400">{fileStatusLabel(file.status)}</span>
                    <span className="truncate font-mono text-xs text-neutral-600" title={file.path}>
                      {file.path}
                    </span>
                  </div>
                ))}
              </div>
            </CodeAgentRunSection>

            <CodeAgentRunSection icon={<TerminalSquare className="h-4 w-4" />} title={commandSummary} disabled={!commands.length}>
              <div className="space-y-1">
                {commands.map((command) => (
                  <div key={command.id} className="rounded-md bg-neutral-50 px-2 py-1.5">
                    <div className="truncate font-mono text-xs text-neutral-600" title={command.command}>
                      已运行 {command.command}
                    </div>
                    {command.cwd && <div className="mt-1 truncate font-mono text-[11px] text-neutral-400">{command.cwd}</div>}
                  </div>
                ))}
              </div>
            </CodeAgentRunSection>

            <CodeAgentRunSection icon={<ListTodo className="h-4 w-4" />} title={logs.length ? `过程日志 ${logs.length} 条` : '暂无过程日志'} disabled={!logs.length}>
              <div className="max-h-56 space-y-1 overflow-auto rounded-md bg-neutral-950 p-2">
                {logs.map((log) => (
                  <div key={log.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 font-mono text-[11px] leading-5">
                    <span
                      className={cn(
                        'uppercase',
                        log.stream === 'stderr' ? 'text-red-300' : log.stream === 'event' ? 'text-cyan-300' : 'text-neutral-500'
                      )}
                    >
                      {log.stream}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-neutral-100">{log.text}</span>
                  </div>
                ))}
              </div>
            </CodeAgentRunSection>

            {data.diagnostics && (
              <CodeAgentRunSection icon={<AlertCircleIcon />} title="诊断输出">
                <pre className="max-h-56 overflow-auto rounded-md bg-neutral-950 px-3 py-2 text-xs leading-5 text-neutral-100">
                  {data.diagnostics}
                </pre>
              </CodeAgentRunSection>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const CodeAgentRunSection: FC<{ children: ReactNode; disabled?: boolean; icon: ReactNode; title: string }> = ({
  children,
  disabled,
  icon,
  title,
}) => {
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button
        type="button"
        onClick={() => !disabled && setOpen((value) => !value)}
        disabled={disabled}
        className="flex h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-neutral-500 transition hover:bg-neutral-50 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="text-neutral-400">{icon}</span>
          <span className="truncate">{title}</span>
        </span>
        {!disabled && <ChevronDown className={cn('h-4 w-4 shrink-0 text-neutral-400 transition-transform', open && 'rotate-180')} />}
      </button>
      {open && <div className="pb-2 pl-8 pr-1">{children}</div>}
    </div>
  )
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

function fileStatusLabel(status: CodeAgentRunMetadata['files'][number]['status']) {
  if (status === 'created') return '创建'
  if (status === 'modified') return '修改'
  if (status === 'deleted') return '删除'
  if (status === 'renamed') return '重命名'
  return '未跟踪'
}

const OrchestratorPlanCard: FC<{ data: OrchestratorPlan }> = ({ data }) => {
  const navigate = useNavigate()
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const [plan, setPlan] = useState(data)
  const [saving, setSaving] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [result, setResult] = useState<OrchestratorDispatchResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setPlan(data)
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

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" autohideFloat="single-branch" className="mt-2 flex items-center gap-1 text-neutral-400">
    <ActionBarPrimitive.Copy asChild>
      <ToolButton aria-label="复制">
        <MessagePrimitive.If copied>
          <Check className="h-3.5 w-3.5" />
        </MessagePrimitive.If>
        <MessagePrimitive.If copied={false}>
          <Copy className="h-3.5 w-3.5" />
        </MessagePrimitive.If>
      </ToolButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <ToolButton aria-label="重新生成">
        <RefreshCw className="h-3.5 w-3.5" />
      </ToolButton>
    </ActionBarPrimitive.Reload>
  </ActionBarPrimitive.Root>
)

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

const Avatar: FC<{ role: 'user' | 'assistant' }> = ({ role }) => (
  <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full', role === 'assistant' ? 'bg-[#eef8f6] text-[#87a9a4]' : 'bg-blue-500 text-white')}>
    {role === 'assistant' ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
  </div>
)

const ToolButton: FC<ComponentPropsWithoutRef<'button'>> = ({ className, ...props }) => (
  <button className={cn('grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700', className)} {...props} />
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
