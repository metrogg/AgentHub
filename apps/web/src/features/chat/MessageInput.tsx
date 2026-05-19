import { useState } from 'react'
import { Box, Chip, CircularProgress, IconButton, Stack, TextareaAutosize, Tooltip, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import KeyboardVoiceIcon from '@mui/icons-material/KeyboardVoice'
import SendIcon from '@mui/icons-material/Send'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'

interface MessageInputProps {
  onSend: (content: string) => void
  disabled?: boolean
  isStreaming?: boolean
}

export default function MessageInput({ onSend, disabled, isStreaming }: MessageInputProps) {
  const [text, setText] = useState('')

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
  }

  return (
    <Box sx={{ px: { xs: 1.5, md: 2 }, pb: 1.5 }}>
      <Box
        sx={{
          maxWidth: 900,
          mx: 'auto',
          p: 1.2,
          border: '1px solid var(--studio-border)',
          bgcolor: 'var(--studio-surface)',
          borderRadius: 3,
          boxShadow: '0 18px 40px rgba(0,0,0,0.25)',
        }}
      >
        <TextareaAutosize
          minRows={2}
          maxRows={7}
          placeholder="输入你的消息..."
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              handleSubmit()
            }
          }}
          disabled={disabled}
          style={{
            width: '100%',
            resize: 'none',
            border: 0,
            outline: 0,
            background: 'transparent',
            color: 'var(--studio-text)',
            font: 'inherit',
            lineHeight: 1.6,
            padding: '8px 10px',
          }}
        />
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
            <Typography
              variant="caption"
              sx={{ display: { xs: 'none', sm: 'inline-flex' }, color: 'warning.main', alignItems: 'center', gap: 0.5 }}
            >
              <WarningAmberIcon sx={{ fontSize: 15 }} />
              配置 ANTHROPIC_API_KEY 后即可连接模型
            </Typography>
            <Chip size="small" label="Anthropic" sx={{ bgcolor: 'var(--studio-surface-soft)', color: 'text.secondary' }} />
            <Chip size="small" label="claude-sonnet-4-6" sx={{ bgcolor: 'var(--studio-surface-soft)', color: 'text.secondary' }} />
          </Stack>
          <Stack direction="row" gap={0.7}>
            <Tooltip title="添加附件">
              <IconButton size="small" sx={{ bgcolor: 'var(--studio-surface-soft)' }}>
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="语音输入">
              <IconButton size="small" sx={{ bgcolor: 'var(--studio-surface-soft)' }}>
                <KeyboardVoiceIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={isStreaming ? 'Agent 正在输出' : '发送'}>
              <span>
                <IconButton
                  size="small"
                  onClick={handleSubmit}
                  disabled={disabled || !text.trim()}
                  aria-label="发送"
                  sx={{ bgcolor: 'var(--studio-text)', color: 'var(--studio-inverse)', '&:hover': { bgcolor: 'var(--studio-text)' } }}
                >
                  {disabled ? <CircularProgress size={18} /> : <SendIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
      </Box>
    </Box>
  )
}
