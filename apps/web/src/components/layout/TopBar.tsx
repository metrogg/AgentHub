import { useState } from 'react'
import { AppBar, Box, Chip, IconButton, Toolbar, Tooltip, Typography } from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import HubIcon from '@mui/icons-material/Hub'
import SettingsIcon from '@mui/icons-material/Settings'
import SettingsDrawer from './SettingsDrawer'

export default function TopBar() {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <>
      <AppBar
        position="static"
        elevation={0}
        sx={{
          bgcolor: 'var(--studio-surface)',
          color: 'var(--studio-text)',
          borderBottom: '1px solid var(--studio-border)',
        }}
      >
        <Toolbar sx={{ minHeight: 56, gap: 1.5 }}>
          <Box
            sx={{
              width: 32,
              height: 32,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 1.5,
              bgcolor: 'var(--studio-text)',
              color: 'var(--studio-inverse)',
            }}
          >
            <HubIcon fontSize="small" />
          </Box>
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Typography variant="h6" noWrap component="div" sx={{ lineHeight: 1.05 }}>
              AgentHub 工作室
            </Typography>
            <Typography variant="caption" color="text.secondary">
              面向 Agent、工作流、工具、评估与追踪的本地工作台
            </Typography>
          </Box>
          <Chip
            size="small"
            icon={<AutoAwesomeIcon />}
            label="Studio"
            sx={{
              display: { xs: 'none', sm: 'inline-flex' },
              bgcolor: 'var(--studio-accent-soft)',
              color: 'var(--studio-accent)',
              border: '1px solid var(--studio-accent-soft)',
              '& .MuiChip-icon': { color: 'var(--studio-accent)' },
            }}
          />
          <Tooltip title="设置">
            <IconButton color="inherit" onClick={() => setSettingsOpen(true)} aria-label="设置">
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  )
}
