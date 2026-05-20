import { Outlet } from 'react-router-dom'
import { Box } from '@mui/material'
import { useState } from 'react'
import Sidebar from './Sidebar'

export default function MainLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'grid',
        gridTemplateColumns: {
          xs: '1fr',
          lg: `${sidebarCollapsed ? 72 : 240}px minmax(0, 1fr)`,
        },
        bgcolor: 'background.default',
        color: 'text.primary',
        overflow: 'hidden',
        transition: 'grid-template-columns var(--studio-motion-slow)',
      }}
    >
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((value) => !value)} />
      <Box component="main" sx={{ minWidth: 0, minHeight: 0, p: { xs: 1, md: 1.5 } }}>
        <Outlet />
      </Box>
    </Box>
  )
}
