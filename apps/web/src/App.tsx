import { Navigate, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import AgentConfigPage from './pages/AgentConfigPage'
import AgentWorldPage from './pages/AgentWorldPage'
import ChatPage from './pages/ChatPage'
import CodingToolsPage from './pages/CodingToolsPage'
import { DesktopAppMenu } from './components/DesktopAppMenu'
import OfficePage from './pages/OfficePage'
import SettingsPage from './pages/SettingsPage'
import SkillsMarketPage from './pages/SkillsMarketPage'
import { api } from './lib/api'
import { applyAppearanceSettings, type AppearanceSettings } from './lib/appearance'
import { I18nProvider, useI18n } from './lib/i18n'
import { isDesktopApp, setDesktopWindowTitle } from './lib/native'
import { useChatStore } from './stores/chatStore'

export default function App() {
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  )
}

function AppShell() {
  const desktop = isDesktopApp()
  const { language } = useI18n()

  useEffect(() => {
    applyAppearanceSettings(defaultAppearanceSettings)
    api
      .getSettings()
      .then((settings) => {
        if (!settings.APP_SETTINGS) return
        applyAppearanceSettings({ ...defaultAppearanceSettings, ...JSON.parse(settings.APP_SETTINGS) })
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!desktop) return
    void setDesktopWindowTitle(language === 'en' ? 'File    Edit    Window' : '文件    编辑    窗口')
  }, [desktop, language])

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
    <div className={desktop ? 'agenthub-app-theme flex h-full flex-col' : 'agenthub-app-theme contents'}>
      <NativeDesktopBridge />
      {desktop && <DesktopAppMenu />}
      <div className={desktop ? 'min-h-0 flex-1' : 'contents'}>{routes}</div>
    </div>
  )
}

const defaultAppearanceSettings: AppearanceSettings = {
  accent: '黑色',
  bodyFont: '默认',
  codeBlockFont: '默认',
  fontSize: '14',
  inlineCodeFont: '默认',
  mainWindowTheme: '跟随系统',
  embeddedWindowTheme: '暗色',
  terminalFont: '默认',
  uiFont: '默认',
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
