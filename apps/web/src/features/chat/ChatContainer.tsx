import { Box } from '@mui/material'
import MessageInput from './MessageInput'
import MessageList from './MessageList'
import type { ChatMessage } from './MessageList'

interface ChatContainerProps {
  title: string
  messages: ChatMessage[]
  streamingMessageId?: string | null
  onSend: (content: string) => void
  onNewSession: () => void
  isLoading?: boolean
  socketState: number
}

export default function ChatContainer({
  title,
  messages,
  streamingMessageId,
  onSend,
  isLoading,
}: ChatContainerProps) {
  const isStreaming = Boolean(streamingMessageId)

  return (
    <Box
      sx={{
        minHeight: 0,
        display: 'grid',
        gridTemplateRows: '1fr auto',
        bgcolor: 'background.paper',
      }}
    >
      <MessageList title={title} messages={messages} streamingMessageId={streamingMessageId} />
      <MessageInput onSend={onSend} disabled={isLoading} isStreaming={isStreaming} />
    </Box>
  )
}
