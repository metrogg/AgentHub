import { Routes, Route } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import MainLayout from './components/layout/MainLayout'
import ChatPage from './pages/ChatPage'
import LoginPage from './pages/LoginPage'

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#2563eb',
    },
  },
})

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<MainLayout />}>
          <Route index element={<ChatPage />} />
        </Route>
      </Routes>
    </ThemeProvider>
  )
}

export default App
