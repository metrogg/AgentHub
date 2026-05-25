import { Navigate, Route, Routes } from 'react-router-dom'
import AgentConfigPage from './pages/AgentConfigPage'
import AgentWorldPage from './pages/AgentWorldPage'
import ChatPage from './pages/ChatPage'
import CodingToolsPage from './pages/CodingToolsPage'
import OfficePage from './pages/OfficePage'
import SettingsPage from './pages/SettingsPage'
import SkillsMarketPage from './pages/SkillsMarketPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ChatPage />} />
      <Route path="/chat/:sessionId" element={<ChatPage />} />
      <Route path="/coding-tools" element={<CodingToolsPage />} />
      <Route path="/agent-config" element={<AgentConfigPage />} />
      <Route path="/agent-world" element={<AgentWorldPage />} />
      <Route path="/office" element={<OfficePage />} />
      <Route path="/skills" element={<SkillsMarketPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
