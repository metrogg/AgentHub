import {
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Fab,
  Box,
  Typography,
  Divider,
} from '@mui/material'
import ChatIcon from '@mui/icons-material/Chat'
import AddIcon from '@mui/icons-material/Add'
import { useEffect } from 'react'
import { useSessionStore } from '../../stores/sessionStore'

export default function Sidebar() {
  const { sessions, currentSessionId, fetchSessions, createSession, setCurrentSession } =
    useSessionStore()

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  const handleCreate = async () => {
    await createSession(`新会话 ${new Date().toLocaleTimeString()}`)
  }

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: 280,
        flexShrink: 0,
        [`& .MuiDrawer-paper`]: { width: 280, boxSizing: 'border-box', mt: 8 },
      }}
    >
      <Toolbar />
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle1" fontWeight={600}>
          会话列表
        </Typography>
        <Fab size="small" color="primary" aria-label="add" onClick={handleCreate}>
          <AddIcon />
        </Fab>
      </Box>
      <Divider />
      <List dense>
        {sessions.length === 0 && (
          <ListItem>
            <ListItemText secondary="暂无会话，点击 + 创建" />
          </ListItem>
        )}
        {sessions.map((s) => (
          <ListItem key={s.id} disablePadding>
            <ListItemButton
              selected={s.id === currentSessionId}
              onClick={() => setCurrentSession(s.id)}
            >
              <ListItemIcon>
                <ChatIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary={s.title}
                secondary={new Date(s.updatedAt).toLocaleString()}
                primaryTypographyProps={{ noWrap: true }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Drawer>
  )
}
