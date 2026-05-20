import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowUp, AtSign, ChevronDown, MessageSquare, PanelLeft, Paperclip, Plus } from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { Thread } from '../components/assistant-ui/Thread'
import { AgentHubRuntimeProvider } from '../lib/runtime'
import { useChatStore } from '../stores/chatStore'

export default function ChatPage() {
  const { sessionId } = useParams()
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const selectSession = useChatStore((state) => state.selectSession)
  const initWebSocket = useChatStore((state) => state.initWebSocket)

  useEffect(() => {
    const off = initWebSocket()
    return off
  }, [initWebSocket])

  useEffect(() => {
    if (sessionId && sessionId !== currentSessionId) {
      selectSession(sessionId)
    }
  }, [sessionId, currentSessionId, selectSession])

  return (
    <div className="flex h-screen overflow-hidden bg-white text-neutral-950">
      <SessionList />
      <main className="min-w-0 flex-1">
        {sessionId ? (
          <AgentHubRuntimeProvider>
            <Thread />
          </AgentHubRuntimeProvider>
        ) : (
          <Welcome />
        )}
      </main>
    </div>
  )
}

function Welcome() {
  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-7">
        <div className="flex items-center gap-4">
          <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100" aria-label="侧栏">
            <PanelLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-3 text-sm">
            <span className="font-semibold text-neutral-950">AgentHub</span>
            <span className="text-neutral-300">/</span>
            <span className="text-neutral-500">对话由 AI 生成</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100" aria-label="新建">
            <Plus className="h-4 w-4" />
          </button>
          <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100" aria-label="对话">
            <MessageSquare className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center px-8">
        <section className="mt-[18vh] w-full max-w-[704px]">
          <h2 className="text-2xl font-semibold tracking-normal text-neutral-950">
            有什么可以帮忙的？
          </h2>
          <p className="mt-3 text-base text-neutral-500">
            创建 Agent、拆解任务，或直接 @ 某个助手开始协作。
          </p>

          <div className="mt-24 grid gap-3 sm:grid-cols-2">
            <PromptCard title="创建 coder 代理" text="帮我单开一个跳跃小游戏" />
            <PromptCard title="解释架构" text="这个项目如何接入 assistant-ui" />
          </div>
        </section>

        <div className="mt-auto w-full max-w-[704px] pb-5">
          <div className="rounded-[22px] border border-neutral-200 bg-white p-3 shadow-[0_18px_60px_rgba(15,23,42,0.12)]">
            <textarea
              className="h-14 w-full resize-none bg-transparent px-2 py-2 text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
              placeholder="发消息给 AgentHub，@ 可提及 Agent"
            />
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-1">
                <button className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100">
                  <Plus className="h-4 w-4" />
                </button>
                <button className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100">
                  <Paperclip className="h-4 w-4" />
                </button>
                <button className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 hover:bg-neutral-100">
                  <AtSign className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button className="inline-flex h-8 items-center gap-1 rounded-full border border-neutral-200 px-3 text-xs text-neutral-600 hover:bg-neutral-50">
                  自动
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button className="grid h-9 w-9 place-items-center rounded-full bg-neutral-200 text-white">
                  <ArrowUp className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PromptCard({ title, text }: { title: string; text: string }) {
  return (
    <button className="rounded-[22px] border border-neutral-200 bg-white px-5 py-4 text-left shadow-sm transition hover:border-neutral-300">
      <div className="text-sm font-medium text-neutral-950">{title}</div>
      <div className="mt-1 text-sm text-neutral-500">{text}</div>
    </button>
  )
}
