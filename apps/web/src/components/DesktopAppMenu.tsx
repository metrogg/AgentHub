import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Bot, FolderOpen, Menu, MessageSquarePlus, Minus, RotateCw, Square, X } from 'lucide-react'
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
  { id: 'new-chat', label: '新建会话', shortcut: 'Ctrl+N' },
  { id: 'quick-chat', label: '快速对话', shortcut: 'Alt+Ctrl+N' },
  { id: 'open-folder', label: '打开项目文件夹...', shortcut: 'Ctrl+O' },
  { type: 'separator' },
  { id: 'settings', label: '设置', shortcut: 'Ctrl+,' },
  { id: 'reload', label: '重新加载', shortcut: 'Ctrl+R' },
  { type: 'separator' },
  { id: 'new-window', label: '新建窗口', shortcut: 'Ctrl+Shift+N' },
  { id: 'toggle-fullscreen', label: '切换全屏', shortcut: 'F11' },
  { id: 'close-window', label: '关闭窗口', shortcut: 'Ctrl+W' },
] as const

const routeLabels: Record<string, string> = {
  '/': '消息',
  '/agent-config': 'Agent',
  '/coding-tools': 'Coding Tools',
  '/office': '办公',
  '/settings': '设置',
  '/skills': 'Skills 市场',
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
    await runAppAction(id as AppActionId)
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
      <div className="agenthub-desktop-titlebar-left" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" className="agenthub-titlebar-brand" onClick={() => navigate('/')} aria-label="AgentHub">
          <span className="agenthub-titlebar-brand-icon">
            <Bot className="h-4 w-4" />
          </span>
          <span className="font-semibold">AgentHub</span>
        </button>
        <div className="agenthub-titlebar-divider" />
        <span className="agenthub-titlebar-location">{currentLabel}</span>
      </div>

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
            <div className="agenthub-desktop-menu-panel agenthub-desktop-menu-panel-topbar" role="menu">
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
        <div className="agenthub-titlebar-divider" />
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
    <button type="button" role="menuitem" disabled={disabled} className="agenthub-desktop-menu-item" onClick={onClick}>
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
  return routeLabels[pathname] ?? 'AgentHub'
}
