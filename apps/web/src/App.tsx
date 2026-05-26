import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import AgentConfigPage from './pages/AgentConfigPage'
import ChatPage from './pages/ChatPage'
import CodingToolsPage from './pages/CodingToolsPage'
import { DesktopAppMenu } from './components/DesktopAppMenu'
import OfficePage from './pages/OfficePage'
import SettingsPage from './pages/SettingsPage'
import SkillsMarketPage from './pages/SkillsMarketPage'
import { api } from './lib/api'
import { applyAppearanceSettings, type AppearanceSettings } from './lib/appearance'
import { openWorkspaceFolderAsSession, useAppActions } from './lib/app-actions'
import { I18nProvider, useI18n } from './lib/i18n'
import { isDesktopApp, setDesktopWindowTitle } from './lib/native'
import { shortcutFor, shortcutMatches, useShortcutSettings, type ShortcutActionId } from './lib/shortcuts'
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
    void setDesktopWindowTitle('AgentHub')
  }, [desktop, language])

  const routes = (
    <Routes>
      <Route path="/" element={<ChatPage />} />
      <Route path="/chat/:sessionId" element={<ChatPage />} />
      <Route path="/coding-tools" element={<CodingToolsPage />} />
      <Route path="/agent-config" element={<AgentConfigPage />} />
      <Route path="/agent-world" element={<Navigate to="/agent-config" replace />} />
      <Route path="/office" element={<OfficePage />} />
      <Route path="/skills" element={<SkillsMarketPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )

  return (
    <div className={desktop ? 'agenthub-app-theme flex h-full flex-col' : 'agenthub-app-theme contents'}>
      <NativeDesktopBridge />
      <GlobalShortcutBridge />
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
      await openWorkspaceFolderAsSession({ projectPath: path, fetchSessions, selectSession, navigate })
    }

    window.addEventListener('agenthub:native-workspace-picked', handleWorkspacePicked)
    return () => window.removeEventListener('agenthub:native-workspace-picked', handleWorkspacePicked)
  }, [fetchSessions, navigate, selectSession])

  return null
}

const globalShortcutActions: ShortcutActionId[] = [
  'close-window',
  'new-window',
  'new-chat',
  'quick-chat',
  'open-folder',
  'settings',
  'reload',
  'minimize',
  'toggle-maximize',
  'toggle-fullscreen',
]

function GlobalShortcutBridge() {
  const { bindings } = useShortcutSettings()
  const { runAppAction } = useAppActions()
  const location = useLocation()

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      for (const action of globalShortcutActions) {
        if (!shortcutMatches(event, shortcutFor(bindings, action))) continue
        event.preventDefault()
        void runAppAction(action)
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [bindings, location.pathname, runAppAction])

  return null
}
