import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { ArrowUp, ChevronDown, Folder, GitBranch, Plus, ShieldAlert } from 'lucide-react'
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
    <div className="flex h-full items-center justify-center overflow-hidden bg-white px-8">
      <div className="w-full max-w-[730px] -translate-y-8">
        <h2 className="mb-10 text-center text-3xl font-medium tracking-normal text-neutral-900">
          要在 AgentHub 中构建什么？
        </h2>

        <div className="overflow-hidden rounded-[22px] border border-neutral-200 bg-white shadow-sm">
          <div className="px-4 pt-4">
            <textarea
              className="h-14 w-full resize-none bg-transparent text-sm text-neutral-900 outline-none placeholder:text-neutral-300"
              placeholder="可向 AgentHub 询问任何事。输入 @ 使用插件或提及文件"
            />
          </div>
          <div className="flex items-center justify-between px-4 pb-2">
            <div className="flex items-center gap-4">
              <button className="grid h-8 w-8 place-items-center rounded-full text-neutral-400 hover:bg-neutral-100">
                <Plus className="h-4 w-4" />
              </button>
              <button className="inline-flex items-center gap-1 text-sm font-medium text-orange-600">
                <ShieldAlert className="h-4 w-4" />
                完全访问权限
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs text-neutral-600">OpenAI</button>
              <button className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100">
                5.5 低
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button className="grid h-9 w-9 place-items-center rounded-full bg-neutral-400 text-white">
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-6 bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
            <button className="inline-flex items-center gap-1 hover:text-neutral-900">
              <Folder className="h-4 w-4" />
              AgentHub
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button className="inline-flex items-center gap-1 hover:text-neutral-900">
              本地模式
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button className="inline-flex items-center gap-1 hover:text-neutral-900">
              <GitBranch className="h-4 w-4" />
              feat/master
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
