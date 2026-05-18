import { Box, Paper, Typography } from '@mui/material'

interface Props {
  content: string
  isSelf?: boolean
}

export default function MessageBubble({ content, isSelf = false }: Props) {
  return (
    <Box sx={{ display: 'flex', justifyContent: isSelf ? 'flex-end' : 'flex-start', mb: 1 }}>
      <Paper
        sx={{
          p: 1.5,
          maxWidth: '70%',
          bgcolor: isSelf ? 'primary.main' : 'grey.100',
          color: isSelf ? 'white' : 'text.primary',
        }}
      >
        <Typography variant="body2">{content}</Typography>
      </Paper>
    </Box>
  )
}
