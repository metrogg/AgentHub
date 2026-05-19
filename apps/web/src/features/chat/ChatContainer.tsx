import { Box, Typography } from '@mui/material'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import type { ChatMessage } from './MessageList'

interface ChatContainerProps {
  messages: ChatMessage[]
  streamingMessageId?: string | null
  onSend: (content: string) => void
  isLoading?: boolean
}

export default function ChatContainer({ messages, streamingMessageId, onSend, isLoading }: ChatContainerProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {messages.length === 0 ? (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography color="text.secondary">发送消息开始与 Agent 协作</Typography>
        </Box>
      ) : (
        <MessageList messages={messages} streamingMessageId={streamingMessageId} />
      )}
      <MessageInput onSend={onSend} disabled={isLoading} />
    </Box>
  )
}
