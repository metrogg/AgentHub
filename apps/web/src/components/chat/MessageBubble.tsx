import { Box, Paper, Typography, Avatar } from '@mui/material'
import SmartToyIcon from '@mui/icons-material/SmartToy'
import PersonIcon from '@mui/icons-material/Person'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MessageBubbleProps {
  senderType: 'user' | 'agent' | 'system'
  content: string
  isStreaming?: boolean
}

export default function MessageBubble({ senderType, content, isStreaming }: MessageBubbleProps) {
  const isUser = senderType === 'user'

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: isUser ? 'row-reverse' : 'row',
        alignItems: 'flex-start',
        gap: 1.5,
        mb: 2,
      }}
    >
      <Avatar sx={{ bgcolor: isUser ? 'primary.main' : 'secondary.main', width: 36, height: 36 }}>
        {isUser ? <PersonIcon fontSize="small" /> : <SmartToyIcon fontSize="small" />}
      </Avatar>
      <Paper
        elevation={1}
        sx={{
          px: 2,
          py: 1.5,
          maxWidth: '70%',
          bgcolor: isUser ? 'primary.50' : 'background.paper',
          borderRadius: 2,
          position: 'relative',
        }}
      >
        {isUser ? (
          <Typography whiteSpace="pre-wrap">{content}</Typography>
        ) : (
          <Box className="markdown-body" sx={{ '& p': { my: 0.5 } }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </Box>
        )}
        {isStreaming && (
          <Box
            component="span"
            sx={{
              display: 'inline-block',
              width: 8,
              height: 16,
              ml: 0.5,
              bgcolor: 'primary.main',
              animation: 'blink 1s step-end infinite',
              '@keyframes blink': {
                '0%, 100%': { opacity: 1 },
                '50%': { opacity: 0 },
              },
            }}
          />
        )}
      </Paper>
    </Box>
  )
}
