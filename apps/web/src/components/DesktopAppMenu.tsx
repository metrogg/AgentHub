import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FolderOpen, Menu, MessageSquarePlus, Minus, RotateCw, Square, X } from 'lucide-react'
import { useAppActions, type AppActionId } from '../lib/app-actions'
import { useI18n } from '../lib/i18n'
import {
  closeDesktopWindow,
  isDesktopApp,
  minimizeDesktopWindow,
  startDesktopWindowDrag,
  toggleMaximizeDesktopWindow,
} from '../lib/native'
import { shortcutFor, useShortcutSettings } from '../lib/shortcuts'

const menuItems = [
  { id: 'new-chat', label: '新建会话' },
  { id: 'quick-chat', label: '快速对话' },
  { id: 'open-folder', label: '打开项目文件夹...' },
  { type: 'separator' },
  { id: 'settings', label: '设置' },
  { id: 'reload', label: '重新加载' },
  { type: 'separator' },
  { id: 'new-window', label: '新建窗口' },
  { id: 'toggle-fullscreen', label: '切换全屏' },
  { id: 'close-window', label: '关闭窗口' },
] as const

const routeLabels: Record<string, string> = {
  '/': '消息',
  '/abilities': '能力商店',
  '/artifacts': '产物',
  '/agent-config': 'Agent',
  '/models': '模型管理',
  '/coding-tools': 'Coding Tools',
  '/office': '办公',
  '/profile': '个人资料',
  '/settings': '设置',
  '/skills': 'Skills 市场',
  '/orchestrator-runs': '编排运行',
  '/execution-logs': '执行日志',
}

export function DesktopAppMenu() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useI18n()
  const { bindings } = useShortcutSettings()
  const { busyAction, runAppAction } = useAppActions()
  const [menuOpen, setMenuOpen] = useState(false)
  const desktop = isDesktopApp()

  useEffect(() => {
    if (!desktop || !menuOpen) return

    function closeMenu() {
      setMenuOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu()
    }

    window.addEventListener('pointerdown', closeMenu)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', closeMenu)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [desktop, menuOpen])

  if (!desktop) return null

  async function runTopbarAction(id: AppActionId) {
    setMenuOpen(false)
    await runAppAction(id)
  }

  function reloadDesktopWindow() {
    window.location.reload()
  }

  async function dragDesktopWindow() {
    await startDesktopWindowDrag().catch(() => false)
  }

  const currentLabel = routeLabel(location.pathname)

  return (
    <header className="agenthub-desktop-titlebar" aria-label={t('窗口')}>
      <div className="agenthub-desktop-titlebar-left" aria-hidden="true">
        <span className="agenthub-mac-window-dot agenthub-mac-window-dot-close" />
        <span className="agenthub-mac-window-dot agenthub-mac-window-dot-minimize" />
        <span className="agenthub-mac-window-dot agenthub-mac-window-dot-maximize" />
      </div>

      <button type="button" className="agenthub-titlebar-center" onClick={() => navigate('/')} aria-label="AgentHub">
        <span className="agenthub-titlebar-app-name">AgentHub</span>
        <span className="agenthub-titlebar-page">{currentLabel}</span>
      </button>

      <div
        className="agenthub-desktop-titlebar-drag"
        data-tauri-drag-region
        onMouseDown={() => void dragDesktopWindow()}
        onPointerDown={() => void dragDesktopWindow()}
      />

      <div className="agenthub-desktop-titlebar-actions" onPointerDown={(event) => event.stopPropagation()}>
        <TopbarIconButton label="新建会话" disabled={Boolean(busyAction)} onClick={() => void runTopbarAction('new-chat')}>
          <MessageSquarePlus className="h-4 w-4" />
        </TopbarIconButton>
        <TopbarIconButton label="打开项目文件夹" disabled={Boolean(busyAction)} onClick={() => void runTopbarAction('open-folder')}>
          <FolderOpen className="h-4 w-4" />
        </TopbarIconButton>
        <div className="relative">
          <TopbarIconButton label="更多" pressed={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <Menu className="h-4 w-4" />
          </TopbarIconButton>
          {menuOpen && (
            <div
              className="agenthub-desktop-menu-panel agenthub-desktop-menu-panel-topbar"
              role="menu"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {menuItems.map((item, index) =>
                isSeparator(item) ? (
                  <DesktopMenuSeparator key={`separator-${index}`} />
                ) : (
                  <DesktopMenuItem
                    key={item.id}
                    disabled={Boolean(busyAction)}
                    label={t(item.label)}
                    shortcut={shortcutFor(bindings, item.id)}
                    onClick={() => void runTopbarAction(item.id)}
                  />
                ),
              )}
            </div>
          )}
        </div>
        <TopbarIconButton label="最小化" onClick={() => void minimizeDesktopWindow()}>
          <Minus className="h-4 w-4" />
        </TopbarIconButton>
        <TopbarIconButton label="最大化 / 还原" onClick={() => void toggleMaximizeDesktopWindow()}>
          <Square className="h-3.5 w-3.5" />
        </TopbarIconButton>
        <TopbarIconButton label="重新加载" onClick={reloadDesktopWindow}>
          <RotateCw className="h-4 w-4" />
        </TopbarIconButton>
        <TopbarIconButton label="关闭" danger onClick={() => void closeDesktopWindow()}>
          <X className="h-4 w-4" />
        </TopbarIconButton>
      </div>
    </header>
  )
}

function TopbarIconButton({
  children,
  danger = false,
  disabled = false,
  label,
  onClick,
  pressed = false,
}: {
  children: ReactNode
  danger?: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={danger ? 'agenthub-titlebar-button agenthub-titlebar-button-danger' : 'agenthub-titlebar-button'}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      {children}
    </button>
  )
}

function DesktopMenuItem({
  disabled = false,
  label,
  onClick,
  shortcut,
}: {
  disabled?: boolean
  label: string
  onClick: () => void
  shortcut?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className="agenthub-desktop-menu-item"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  )
}

function DesktopMenuSeparator() {
  return <div className="agenthub-desktop-menu-separator" role="separator" />
}

function isSeparator<T extends { type: 'separator' } | { id: string }>(item: T): item is Extract<T, { type: 'separator' }> {
  return 'type' in item
}

function routeLabel(pathname: string) {
  if (pathname.startsWith('/chat/')) return '消息'
  if (pathname.startsWith('/workspace/')) return '工作区'
  return routeLabels[pathname] ?? 'AgentHub'
}
