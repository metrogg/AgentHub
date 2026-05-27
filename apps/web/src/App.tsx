import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import AgentConfigPage from './pages/AgentConfigPage'
import ChatPage from './pages/ChatPage'
import CodingToolsPage from './pages/CodingToolsPage'
import { DesktopAppMenu } from './components/DesktopAppMenu'
import ModelManagementPage from './pages/ModelManagementPage'
import OfficePage from './pages/OfficePage'
import SettingsPage, { SettingsSurface } from './pages/SettingsPage'
import SkillsMarketPage from './pages/SkillsMarketPage'
import OrchestratorRunsPage from './pages/OrchestratorRunsPage'
import ExecutionLogsPage from './pages/ExecutionLogsPage'
import { api } from './lib/api'
import { applyAppearanceSettings, type AppearanceSettings } from './lib/appearance'
import { openWorkspaceFolderAsSession, useAppActions } from './lib/app-actions'
import { ensureCodingToolsStartupLifecycle } from './lib/codingToolsLifecycle'
import { I18nProvider, useI18n } from './lib/i18n'
import { isDesktopApp, setDesktopWindowTitle } from './lib/native'
import { shortcutFor, shortcutMatches, useShortcutSettings, type ShortcutActionId } from './lib/shortcuts'
import { settingsDialogEvent } from './lib/settingsDialog'
import { useChatStore } from './stores/chatStore'
import { GlobalNewSessionDialog } from './components/chat/GlobalNewSessionDialog'
import { GripHorizontal, Settings2, X } from 'lucide-react'

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
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    applyAppearanceSettings(defaultAppearanceSettings)
    void ensureCodingToolsStartupLifecycle()
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

  useEffect(() => {
    const openSettings = () => setSettingsOpen(true)
    window.addEventListener(settingsDialogEvent, openSettings)
    return () => window.removeEventListener(settingsDialogEvent, openSettings)
  }, [])

  const routes = (
    <Routes>
      <Route path="/" element={<ChatPage />} />
      <Route path="/chat/:sessionId" element={<ChatPage />} />
      <Route path="/models" element={<ModelManagementPage />} />
      <Route path="/coding-tools" element={<CodingToolsPage />} />
      <Route path="/agent-config" element={<AgentConfigPage />} />
      <Route path="/agent-world" element={<Navigate to="/agent-config" replace />} />
      <Route path="/office" element={<OfficePage />} />
      <Route path="/skills" element={<SkillsMarketPage />} />
      <Route path="/orchestrator-runs" element={<OrchestratorRunsPage />} />
      <Route path="/execution-logs" element={<ExecutionLogsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )

  return (
    <div className={desktop ? 'agenthub-app-theme flex h-full flex-col' : 'agenthub-app-theme contents'}>
      <GlobalNewSessionDialog />
      <NativeDesktopBridge />
      <GlobalShortcutBridge />
      {desktop && <DesktopAppMenu />}
      <div className={desktop ? 'min-h-0 flex-1' : 'contents'}>{routes}</div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    }
  }

  function drag(event: ReactPointerEvent<HTMLDivElement>) {
    const active = dragRef.current
    if (!active || active.pointerId !== event.pointerId) return
    setOffset({
      x: active.originX + event.clientX - active.startX,
      y: active.originY + event.clientY - active.startY,
    })
  }

  function stopDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
  }

  return createPortal(
    <div className="fixed inset-0 z-[2147483647] bg-black/15 backdrop-blur-[3px]" role="dialog" aria-modal="true">
      <div
        className="absolute left-1/2 top-1/2 flex h-[min(880px,calc(100vh-2.5rem))] w-[min(1280px,calc(100vw-2.5rem))] min-w-[920px] flex-col overflow-hidden rounded-[22px] border border-neutral-200 bg-white shadow-[0_36px_120px_rgba(15,23,42,0.34)]"
        style={{ transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))` }}
      >
        <div
          className="flex h-11 shrink-0 cursor-move select-none items-center justify-between border-b border-neutral-200 bg-[#f7f7f4] px-4"
          onPointerDown={startDrag}
          onPointerMove={drag}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
        >
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-neutral-950">
            <Settings2 className="h-4 w-4 text-neutral-500" />
            <span>设置</span>
          </div>
          <div className="flex items-center gap-1">
            <GripHorizontal className="h-4 w-4 text-neutral-300" />
            <button
              type="button"
              onClick={onClose}
              className="grid h-7 w-7 cursor-default place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-200 hover:text-neutral-950"
              aria-label="关闭设置"
              title="关闭设置"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <SettingsSurface onClose={onClose} compact={false} showSidebarClose={false} />
        </div>
      </div>
    </div>,
    document.body,
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
