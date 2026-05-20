import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { Bot } from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import MessageItem from '../components/chat/MessageItem'
import Composer from '../components/chat/Composer'
import { useChatStore } from '../stores/chatStore'

export default function ChatPage() {
  const { sessionId } = useParams()
  const {
    currentSessionId,
    messages,
    streamingMessage,
    agentTyping,
    selectSession,
    sendMessage,
    initWebSocket,
  } = useChatStore()

  const scrollRef = useRef<HTMLDivElement>(null)

  // Init WebSocket once
  useEffect(() => {
    const off = initWebSocket()
    return off
  }, [initWebSocket])

  // Switch session
  useEffect(() => {
    if (sessionId && sessionId !== currentSessionId) {
      selectSession(sessionId)
    }
  }, [sessionId, currentSessionId, selectSession])

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, streamingMessage?.content])

  const hasSession = !!sessionId

  return (
    <div className="h-screen flex bg-bg overflow-hidden">
      <SessionList />

      <main className="flex-1 flex flex-col min-w-0">
        {hasSession ? (
          <>
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
                {messages.length === 0 && !streamingMessage && !agentTyping && (
                  <Empty />
                )}
                {messages.map((m) => (
                  <MessageItem key={m.id} message={m} />
                ))}
                {streamingMessage && <MessageItem streaming={streamingMessage} />}
                {agentTyping && !streamingMessage && (
                  <div className="flex items-center gap-2 text-xs text-zinc-500 px-10">
                    <span className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </span>
                    Agent 正在思考…
                  </div>
                )}
              </div>
            </div>
            <Composer onSend={sendMessage} disabled={!hasSession} />
          </>
        ) : (
          <Welcome />
        )}
      </main>
    </div>
  )
}

function Empty() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20">
      <div className="w-12 h-12 rounded-xl bg-accent/10 ring-1 ring-accent/20 flex items-center justify-center mb-4">
        <Bot className="w-6 h-6 text-accent" />
      </div>
      <h2 className="text-base font-medium text-zinc-200 mb-1">开始一段对话</h2>
      <p className="text-sm text-zinc-500">在下方输入框中向 Agent 发送你的第一条消息</p>
    </div>
  )
}

function Welcome() {
  return (
    <div className="flex-1 flex items-center justify-center text-center p-8">
      <div>
        <div className="w-14 h-14 rounded-2xl bg-accent/10 ring-1 ring-accent/20 flex items-center justify-center mx-auto mb-4">
          <Bot className="w-7 h-7 text-accent" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">欢迎使用 AgentHub</h2>
        <p className="text-sm text-zinc-500">在左侧创建一个会话开始与 Agent 协作</p>
      </div>
    </div>
  )
}
