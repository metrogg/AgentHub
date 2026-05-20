import { Navigate, Route, Routes } from 'react-router-dom'
import MainLayout from './components/layout/MainLayout'
import ChatPage from './pages/ChatPage'
import StudioModulePage from './pages/StudioModulePage'
import { StudioThemeProvider } from './theme/StudioThemeProvider'

function App() {
  return (
    <StudioThemeProvider>
      <Routes>
        <Route path="/" element={<MainLayout />}>
          <Route index element={<Navigate to="/agents/weather-agent/chat/new" replace />} />
          <Route path="agents" element={<StudioModulePage />} />
          <Route path="agents/:agentId/chat/new" element={<ChatPage />} />
          <Route path=":moduleKey" element={<StudioModulePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/agents/weather-agent/chat/new" replace />} />
      </Routes>
    </StudioThemeProvider>
  )
}

export default App
