import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import {
  ArrowUp,
  AtSign,
  Bot,
  Blocks,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Globe2,
  ImagePlus,
  ListTodo,
  MessageSquare,
  PanelLeft,
  Paperclip,
  Plus,
  Presentation,
  RefreshCw,
  Sheet,
  Square,
  User,
} from 'lucide-react'
import { type ComponentPropsWithoutRef, type FC, useEffect, useRef, useState } from 'react'
import remarkGfm from 'remark-gfm'
import { api, type ModelCatalogItem } from '../../lib/api'
import { cn } from '../../lib/utils'
import { useChatStore } from '../../stores/chatStore'

export const Thread: FC<{
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}> = ({ sidebarCollapsed, onToggleSidebar }) => {
  return (
    <ThreadPrimitive.Root
      className="relative flex h-full flex-col overflow-hidden bg-white"
      style={{ ['--thread-max-width' as string]: '44rem' }}
    >
      <ThreadHeader sidebarCollapsed={sidebarCollapsed} onToggleSidebar={onToggleSidebar} />
      <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto scroll-smooth px-6">
        <ThreadWelcome />
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage, SystemMessage }} />
        <ThreadPrimitive.If empty={false}>
          <div className="min-h-28" />
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>
      <Composer />
    </ThreadPrimitive.Root>
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectedModelId = useChatStore((state) => state.selectedModelId)
  const setSelectedModelId = useChatStore((state) => state.setSelectedModelId)
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [menu, setMenu] = useState<'tools' | 'agents' | 'models' | null>(null)
  const [attachment, setAttachment] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [planMode, setPlanMode] = useState(false)
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

  function showHint(text: string) {
    setHint(text)
    window.setTimeout(() => setHint(null), 1800)
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setAttachment(file.name)
  }

  return (
    <div className="shrink-0 bg-gradient-to-t from-white via-white to-white/80 px-6 pb-6 pt-3">
      <ComposerPrimitive.Root className="mx-auto w-full max-w-[var(--thread-max-width)]">
        <div className="relative rounded-3xl border border-neutral-200 bg-white p-3 shadow-[0_10px_40px_rgba(15,23,42,0.10)] focus-within:border-neutral-300">
          {menu && (
            <ComposerMenu
              type={menu}
              models={models}
              selectedModelId={selectedModelId}
              planMode={planMode}
              onAttach={() => {
                fileInputRef.current?.click()
                setMenu(null)
              }}
              onPlanMode={(next) => {
                setPlanMode(next)
                showHint(next ? '已开启计划模式' : '已关闭计划模式')
              }}
              onModel={(modelId) => {
                setSelectedModelId(modelId)
                showHint(modelId ? `已切换到 ${models.find((item) => item.id === modelId)?.modelId ?? modelId}` : '已切换到自动选择')
              }}
              onPick={(value) => {
                void navigator.clipboard?.writeText(value).catch(() => undefined)
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
          <ComposerPrimitive.Input
            autoFocus
            placeholder="发消息给 AgentHub，@ 可提及 Agent"
            rows={1}
            className="max-h-[180px] min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-neutral-950 outline-none placeholder:text-neutral-400"
          />
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-1">
              <ComposerToolButton aria-label="添加" onClick={() => setMenu(menu === 'tools' ? null : 'tools')}>
                <Plus className="h-4 w-4" />
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
                className="hidden h-8 max-w-40 items-center gap-1 rounded-full border border-neutral-200 px-3 text-xs text-neutral-600 hover:bg-neutral-50 sm:inline-flex"
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
  type: 'tools' | 'agents' | 'models'
  models: ModelCatalogItem[]
  selectedModelId: string | null
  planMode: boolean
  onAttach: () => void
  onPlanMode: (enabled: boolean) => void
  onModel: (modelId: string | null) => void
  onPick: (value: string) => void
  onClose: () => void
}> = ({ type, models, selectedModelId, planMode, onAttach, onPlanMode, onModel, onPick, onClose }) => {
  const agents = [
    { title: '@architect', desc: '架构与任务拆解' },
    { title: '@coder', desc: '代码实现' },
    { title: '@reviewer', desc: '审查与边界检查' },
  ]
  const plugins = [
    { title: 'Documents', icon: FileText, color: 'text-blue-500', value: '@documents' },
    { title: 'Spreadsheets', icon: Sheet, color: 'text-emerald-600', value: '@spreadsheets' },
    { title: 'Presentations', icon: Presentation, color: 'text-amber-500', value: '@presentations' },
    { title: '浏览器', icon: Globe2, color: 'text-sky-500', value: '@browser' },
  ]

  return (
    <div className="absolute bottom-[4.5rem] left-3 z-20 w-64 rounded-2xl border border-neutral-200 bg-white p-2 text-sm shadow-xl">
      {type === 'tools' && (
        <div className="relative group/tools">
          <button type="button" onClick={onAttach} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-neutral-50">
            <ImagePlus className="h-4 w-4 text-neutral-500" />
            <span className="flex-1 text-neutral-900">添加照片和文件</span>
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
          <div className="invisible absolute bottom-0 left-[calc(100%+0.5rem)] w-52 rounded-2xl border border-neutral-200 bg-white p-2 opacity-0 shadow-xl transition group-hover/tools:visible group-hover/tools:opacity-100">
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
        agents.map((item) => <MenuRow key={item.title} title={item.title} desc={item.desc} onClick={() => { onPick(item.title); onClose() }} />)}
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
    </div>
  )
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
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
      <AssistantActionBar />
      <BranchPicker />
    </div>
  </MessagePrimitive.Root>
)

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

const ComposerToolButton: FC<ComponentPropsWithoutRef<'button'>> = ({ className, ...props }) => (
  <button type="button" className={cn('grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900', className)} {...props} />
)

const MarkdownText: FC = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    className="prose prose-neutral prose-sm max-w-none prose-p:my-2 prose-ul:my-2 prose-pre:border prose-pre:border-neutral-200 prose-pre:bg-neutral-50 prose-code:before:content-none prose-code:after:content-none"
  />
)
