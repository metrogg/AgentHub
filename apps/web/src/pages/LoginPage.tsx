import { Box, Button, Container, TextField, Typography, Paper } from '@mui/material'

export default function LoginPage() {
  return (
    <Container maxWidth="sm" sx={{ mt: 10 }}>
      <Paper elevation={3} sx={{ p: 4 }}>
        <Typography variant="h4" align="center" gutterBottom>
          AgentHub 登录
        </Typography>
        <Box component="form" sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 3 }}>
          <TextField label="邮箱" type="email" fullWidth />
          <TextField label="密码" type="password" fullWidth />
          <Button variant="contained" size="large" fullWidth>
            登录
          </Button>
        </Box>
      </Paper>
    </Container>
  )
}
