import { Avatar, Box, Chip, Paper, Typography } from '@mui/material'
import PersonIcon from '@mui/icons-material/Person'
import SmartToyIcon from '@mui/icons-material/SmartToy'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MessageBubbleProps {
  senderType: 'user' | 'agent' | 'system'
  content: string
  createdAt?: string
  isStreaming?: boolean
}

export default function MessageBubble({
  senderType,
  content,
  createdAt,
  isStreaming,
}: MessageBubbleProps) {
  const isUser = senderType === 'user'

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: isUser ? 'minmax(0, 1fr) 34px' : '34px minmax(0, 1fr)',
        gap: 1.4,
        alignItems: 'start',
        mb: 2,
      }}
    >
      {!isUser && <MessageAvatar isUser={false} />}
      <Box sx={{ justifySelf: isUser ? 'end' : 'start', maxWidth: { xs: '100%', md: '78%' } }}>
        <Box
          sx={{
            display: 'flex',
            justifyContent: isUser ? 'flex-end' : 'flex-start',
            alignItems: 'center',
            gap: 0.8,
            mb: 0.65,
          }}
        >
          <Chip
            size="small"
            label={isUser ? '你' : 'Agent'}
            sx={{
              height: 22,
              bgcolor: isUser ? 'var(--studio-surface-soft)' : 'var(--studio-accent-soft)',
              color: isUser ? 'text.secondary' : 'var(--studio-accent)',
              border: '1px solid var(--studio-border)',
              fontWeight: 800,
            }}
          />
          {createdAt && (
            <Typography variant="caption" color="text.disabled">
              {new Date(createdAt).toLocaleTimeString()}
            </Typography>
          )}
        </Box>
        <Paper
          elevation={0}
          sx={{
            px: 1.7,
            py: 1.35,
            bgcolor: isUser ? 'var(--studio-text)' : 'var(--studio-surface)',
            color: isUser ? 'var(--studio-inverse)' : 'text.primary',
            border: isUser ? '1px solid var(--studio-text)' : '1px solid var(--studio-border)',
            borderRadius: 2.4,
          }}
        >
          {isUser ? (
            <Typography whiteSpace="pre-wrap" sx={{ lineHeight: 1.65 }}>
              {content}
            </Typography>
          ) : (
            <Box className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </Box>
          )}
          {isStreaming && <StreamingCursor />}
        </Paper>
      </Box>
      {isUser && <MessageAvatar isUser />}
    </Box>
  )
}

function MessageAvatar({ isUser }: { isUser: boolean }) {
  return (
    <Avatar
      sx={{
        width: 34,
        height: 34,
        bgcolor: isUser ? 'var(--studio-text)' : 'var(--studio-surface-soft)',
        color: isUser ? 'var(--studio-inverse)' : 'text.primary',
        border: '1px solid var(--studio-border)',
      }}
    >
      {isUser ? <PersonIcon fontSize="small" /> : <SmartToyIcon fontSize="small" />}
    </Avatar>
  )
}

function StreamingCursor() {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        width: 7,
        height: 17,
        ml: 0.5,
        verticalAlign: 'text-bottom',
        bgcolor: 'secondary.main',
        animation: 'blink 1s step-end infinite',
        '@keyframes blink': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0 },
        },
      }}
    />
  )
}
