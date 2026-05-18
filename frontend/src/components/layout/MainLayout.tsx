import { Outlet } from 'react-router-dom'
import { Box } from '@mui/material'
import Sidebar from './Sidebar'
import TopBar from './TopBar'

export default function MainLayout() {
  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <TopBar />
      <Sidebar />
      <Box component="main" sx={{ flexGrow: 1, mt: 8, p: 2 }}>
        <Outlet />
      </Box>
    </Box>
  )
}
