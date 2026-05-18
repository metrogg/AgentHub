import { Box, Typography } from '@mui/material'

export default function ChatPage() {
  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        聊天
      </Typography>
      <Typography color="text.secondary">
        选择一个会话开始与 Agent 协作
      </Typography>
    </Box>
  )
}
