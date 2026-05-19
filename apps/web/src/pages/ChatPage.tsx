import { useEffect, useState, useCallback, useRef } from 'react'
import { Box, Typography } from '@mui/material'
import ChatContainer from '../features/chat/ChatContainer'
import type { ChatMessage } from '../features/chat/MessageList'
import { useSessionStore } from '../stores/sessionStore'
import { useWebSocket } from '../hooks/useWebSocket'
import { fetchMessages, sendMessage as apiSendMessage } from '../api/messages'

export default function ChatPage() {
  const { currentSessionId } = useSessionStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const streamingContent = useRef<Record<string, string>>({})

  const wsUrl = `${import.meta.env.VITE_API_URL?.replace(/^http/, 'ws').replace(/\/api$/, '') ?? 'ws://localhost:8000'}`
  const { sendMessage, subscribe } = useWebSocket(wsUrl)

  // Join WebSocket room when session changes
  useEffect(() => {
    if (!currentSessionId) return
    sendMessage({ type: 'session:join', payload: { sessionId: currentSessionId } })
  }, [currentSessionId, sendMessage])

  // Load messages when session changes
  useEffect(() => {
    if (!currentSessionId) {
      setMessages([])
      return
    }
    setIsLoading(true)
    fetchMessages(currentSessionId)
      .then((items) => setMessages(items))
      .finally(() => setIsLoading(false))
  }, [currentSessionId])

  // Subscribe to WebSocket events
  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.type === 'message:stream' && event.payload.messageId) {
        const msgId = event.payload.messageId as string
        const delta = (event.payload.delta as string) ?? ''
        setStreamingId(msgId)
        streamingContent.current[msgId] = (streamingContent.current[msgId] ?? '') + delta
        setMessages((prev) => {
          const exists = prev.find((m) => m.id === msgId)
          if (exists) {
            return prev.map((m) =>
              m.id === msgId ? { ...m, content: streamingContent.current[msgId] } : m
            )
          }
          return [
            ...prev,
            {
              id: msgId,
              senderType: 'agent',
              content: streamingContent.current[msgId],
              createdAt: new Date().toISOString(),
            },
          ]
        })
      }

      if (event.type === 'message:completed' && event.payload.message) {
        const msg = event.payload.message as ChatMessage
        setStreamingId(null)
        delete streamingContent.current[msg.id]
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== msg.id)
          return [...filtered, msg]
        })
      }

      if (event.type === 'agent:typing') {
        // Could show typing indicator in future
      }
    })
    return () => unsubscribe()
  }, [subscribe])

  const handleSend = useCallback(
    async (content: string) => {
      if (!currentSessionId) return
      setIsLoading(true)
      try {
        const msg = await apiSendMessage(currentSessionId, content)
        setMessages((prev) => [...prev, msg as ChatMessage])
      } finally {
        // Agent reply will come via WebSocket; we keep loading until stream starts
        // but actually we should show a loading state while waiting for first stream chunk
        // For simplicity, we clear loading here and let the stream handle the rest
        setIsLoading(false)
      }
    },
    [currentSessionId]
  )

  if (!currentSessionId) {
    return (
      <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography color="text.secondary">请从左侧选择一个会话或创建新会话</Typography>
      </Box>
    )
  }

  return (
    <Box sx={{ height: 'calc(100vh - 64px)' }}>
      <ChatContainer
        messages={messages}
        streamingMessageId={streamingId}
        onSend={handleSend}
        isLoading={isLoading}
      />
    </Box>
  )
}
