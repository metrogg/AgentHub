import { AppBar, Toolbar, Typography } from '@mui/material'

export default function TopBar() {
  return (
    <AppBar position="fixed" sx={{ zIndex: (theme) => theme.zIndex.drawer + 1 }}>
      <Toolbar>
        <Typography variant="h6" noWrap component="div">
          AgentHub
        </Typography>
      </Toolbar>
    </AppBar>
  )
}
