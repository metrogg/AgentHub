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
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  MessageSquare,
  PanelLeft,
  Paperclip,
  Plus,
  RefreshCw,
  Square,
  User,
} from 'lucide-react'
import { type ComponentPropsWithoutRef, type FC } from 'react'
import remarkGfm from 'remark-gfm'
import { cn } from '../../lib/utils'

export const Thread: FC = () => {
  return (
    <ThreadPrimitive.Root
      className="relative flex h-full flex-col overflow-hidden bg-white"
      style={{ ['--thread-max-width' as string]: '44rem' }}
    >
      <ThreadHeader />
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

const ThreadHeader: FC = () => {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
      <div className="flex min-w-0 items-center gap-3">
        <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-label="切换侧栏">
          <PanelLeft className="h-4 w-4" />
        </button>
        <div className="truncate text-sm font-medium text-neutral-950">AgentHub</div>
        <span className="text-sm text-neutral-300">/</span>
        <span className="truncate text-sm text-neutral-500">对话由 AI 生成</span>
      </div>
      <div className="flex items-center gap-1">
        <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-label="新建">
          <Plus className="h-4 w-4" />
        </button>
        <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900" aria-label="模型">
          <MessageSquare className="h-4 w-4" />
        </button>
      </div>
    </header>
  )
}

const ThreadWelcome: FC = () => {
  return (
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
}

const PromptCard: FC<{ title: string; text: string }> = ({ title, text }) => {
  return (
    <div className="rounded-3xl border border-neutral-200 bg-white px-5 py-4 shadow-sm">
      <div className="text-sm font-medium text-neutral-950">{title}</div>
      <div className="mt-1 text-sm text-neutral-500">{text}</div>
    </div>
  )
}

const Composer: FC = () => {
  return (
    <div className="shrink-0 bg-gradient-to-t from-white via-white to-white/80 px-6 pb-6 pt-3">
      <ComposerPrimitive.Root className="mx-auto w-full max-w-[var(--thread-max-width)]">
        <div className="rounded-3xl border border-neutral-200 bg-white p-3 shadow-[0_10px_40px_rgba(15,23,42,0.10)] focus-within:border-neutral-300">
          <ComposerPrimitive.Input
            autoFocus
            placeholder="发消息给 AgentHub，@ 可提及 Agent"
            rows={1}
            className="max-h-[180px] min-h-12 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 text-neutral-950 outline-none placeholder:text-neutral-400"
          />
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-1">
              <ComposerToolButton aria-label="添加">
                <Plus className="h-4 w-4" />
              </ComposerToolButton>
              <ComposerToolButton aria-label="附件">
                <Paperclip className="h-4 w-4" />
              </ComposerToolButton>
              <ComposerToolButton aria-label="提及">
                <AtSign className="h-4 w-4" />
              </ComposerToolButton>
            </div>
            <div className="flex items-center gap-2">
              <button className="hidden h-8 items-center gap-1 rounded-full border border-neutral-200 px-3 text-xs text-neutral-600 hover:bg-neutral-50 sm:inline-flex">
                自动
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <ComposerAction />
            </div>
          </div>
        </div>
      </ComposerPrimitive.Root>
    </div>
  )
}

const ComposerAction: FC = () => {
  return (
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
          <button className="grid h-9 w-9 place-items-center rounded-full bg-neutral-900 text-white" aria-label="停止生成">
            <Square className="h-3.5 w-3.5" />
          </button>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </>
  )
}

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-[var(--thread-max-width)] justify-end gap-3 py-4">
      <div className="max-w-[78%] rounded-3xl bg-[#eef3ff] px-4 py-2.5 text-sm leading-6 text-neutral-950">
        <MessagePrimitive.Parts />
      </div>
      <Avatar role="user" />
    </MessagePrimitive.Root>
  )
}

const AssistantMessage: FC = () => {
  return (
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
}

const SystemMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="mx-auto w-full max-w-[var(--thread-max-width)] py-2">
      <div className="rounded-2xl bg-neutral-100 px-3 py-2 text-xs text-neutral-500">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="mt-2 flex items-center gap-1 text-neutral-400"
    >
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
}

const BranchPicker: FC = () => {
  return (
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
}

const Avatar: FC<{ role: 'user' | 'assistant' }> = ({ role }) => {
  const isAssistant = role === 'assistant'
  return (
    <div
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-full',
        isAssistant ? 'bg-[#eef8f6] text-[#87a9a4]' : 'bg-blue-500 text-white'
      )}
    >
      {isAssistant ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
    </div>
  )
}

const ToolButton: FC<ComponentPropsWithoutRef<'button'>> = ({ className, ...props }) => {
  return (
    <button
      className={cn('grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700', className)}
      {...props}
    />
  )
}

const ComposerToolButton: FC<ComponentPropsWithoutRef<'button'>> = ({ className, ...props }) => {
  return (
    <button
      type="button"
      className={cn('grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900', className)}
      {...props}
    />
  )
}

const MarkdownText: FC = () => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="prose prose-neutral prose-sm max-w-none prose-p:my-2 prose-ul:my-2 prose-pre:border prose-pre:border-neutral-200 prose-pre:bg-neutral-50 prose-code:before:content-none prose-code:after:content-none"
    />
  )
}
