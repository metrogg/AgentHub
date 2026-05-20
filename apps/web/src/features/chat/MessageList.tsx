import { Avatar, Box, Typography } from '@mui/material'
import MessageBubble from '../../components/chat/MessageBubble'

export interface ChatMessage {
  id: string
  senderType: 'user' | 'agent' | 'system'
  content: string
  createdAt: string
}

interface MessageListProps {
  title: string
  messages: ChatMessage[]
  streamingMessageId?: string | null
}

export default function MessageList({ title, messages, streamingMessageId }: MessageListProps) {
  return (
    <Box sx={{ minHeight: 0, overflowY: 'auto', px: { xs: 2, md: 3 }, py: 2 }}>
      {messages.length === 0 ? (
        <EmptyThread title={title} />
      ) : (
        <Box sx={{ maxWidth: 860, mx: 'auto', pt: 2 }}>
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              senderType={msg.senderType}
              content={msg.content}
              createdAt={msg.createdAt}
              isStreaming={msg.id === streamingMessageId}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}

function EmptyThread({ title }: { title: string }) {
  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 420,
        display: 'grid',
        placeItems: 'center',
        textAlign: 'center',
      }}
    >
      <Box sx={{ maxWidth: 520, px: 2 }}>
        <Avatar
          sx={{
            width: 44,
            height: 44,
            mx: 'auto',
            mb: 3,
            bgcolor: 'var(--studio-surface-soft)',
            border: '1px solid var(--studio-border)',
            color: 'text.primary',
            fontWeight: 800,
          }}
        >
          {title.slice(0, 1).toUpperCase()}
        </Avatar>
        <Typography variant="h6" sx={{ mb: 0.8 }}>
          今天想让 {title} 帮你做什么？
        </Typography>
        <Typography color="text.secondary" sx={{ lineHeight: 1.7 }}>
          可以询问天气、拆解任务，或让 Agent 解释工作流、工具、记忆和评估配置。
        </Typography>
      </Box>
    </Box>
  )
}
