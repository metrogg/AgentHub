import { Drawer, List, ListItem, ListItemButton, ListItemIcon, ListItemText, Toolbar } from '@mui/material'
import ChatIcon from '@mui/icons-material/Chat'
import SettingsIcon from '@mui/icons-material/Settings'

export default function Sidebar() {
  return (
    <Drawer
      variant="permanent"
      sx={{
        width: 240,
        flexShrink: 0,
        [`& .MuiDrawer-paper`]: { width: 240, boxSizing: 'border-box', mt: 8 },
      }}
    >
      <Toolbar />
      <List>
        <ListItem disablePadding>
          <ListItemButton>
            <ListItemIcon><ChatIcon /></ListItemIcon>
            <ListItemText primary="会话" />
          </ListItemButton>
        </ListItem>
        <ListItem disablePadding>
          <ListItemButton>
            <ListItemIcon><SettingsIcon /></ListItemIcon>
            <ListItemText primary="设置" />
          </ListItemButton>
        </ListItem>
      </List>
    </Drawer>
  )
}
