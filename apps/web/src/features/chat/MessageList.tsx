import { Box } from '@mui/material'
import MessageBubble from '../../components/chat/MessageBubble'

export interface ChatMessage {
  id: string
  senderType: 'user' | 'agent' | 'system'
  content: string
  createdAt: string
}

interface MessageListProps {
  messages: ChatMessage[]
  streamingMessageId?: string | null
}

export default function MessageList({ messages, streamingMessageId }: MessageListProps) {
  return (
    <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          senderType={msg.senderType}
          content={msg.content}
          isStreaming={msg.id === streamingMessageId}
        />
      ))}
    </Box>
  )
}
