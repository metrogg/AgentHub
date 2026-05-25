import { Navigate, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import AgentConfigPage from './pages/AgentConfigPage'
import AgentWorldPage from './pages/AgentWorldPage'
import ChatPage from './pages/ChatPage'
import CodingToolsPage from './pages/CodingToolsPage'
import OfficePage from './pages/OfficePage'
import SettingsPage from './pages/SettingsPage'
import SkillsMarketPage from './pages/SkillsMarketPage'
import { api } from './lib/api'
import { useChatStore } from './stores/chatStore'

export default function App() {
  const routes = (
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

  return (
    <>
      <NativeDesktopBridge />
      {routes}
    </>
  )
}

function NativeDesktopBridge() {
  const navigate = useNavigate()
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const selectSession = useChatStore((state) => state.selectSession)

  useEffect(() => {
    async function handleWorkspacePicked(event: Event) {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (!path) return
      const result = await api.openWorkspaceFolder(path)
      if (result.cancelled || !result.projectPath) return
      const workspace =
        result.workspace ??
        (
          await api.createWorkspace({
            name: workspaceNameFromPath(result.projectPath),
            goal: '',
            projectPath: result.projectPath,
            template: 'classic',
          })
        ).workspace
      const { session } = await api.openWorkspaceGroupSession(workspace.id)
      await fetchSessions()
      await selectSession(session.id)
      navigate(`/chat/${session.id}`)
    }

    window.addEventListener('agenthub:native-workspace-picked', handleWorkspacePicked)
    return () => window.removeEventListener('agenthub:native-workspace-picked', handleWorkspacePicked)
  }, [fetchSessions, navigate, selectSession])

  return null
}

function workspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || '项目文件夹'
}
