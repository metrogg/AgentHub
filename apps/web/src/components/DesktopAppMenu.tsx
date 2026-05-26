import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppActions, type AppActionId } from '../lib/app-actions'
import { useI18n } from '../lib/i18n'
import { isDesktopApp } from '../lib/native'
import { shortcutFor, useShortcutSettings } from '../lib/shortcuts'

const fileItems = [
  { id: 'new-chat', label: '新建会话', enLabel: 'New Chat', shortcut: 'Ctrl+N' },
  { id: 'quick-chat', label: '快速对话', enLabel: 'Quick Chat', shortcut: 'Alt+Ctrl+N' },
  { id: 'open-folder', label: '打开项目文件夹...', enLabel: 'Open Project Folder...', shortcut: 'Ctrl+O' },
  { type: 'separator' },
  { id: 'close-window', label: '关闭窗口', enLabel: 'Close Window', shortcut: 'Ctrl+W' },
] as const

const editItems = [
  { id: 'undo', label: '撤销', enLabel: 'Undo', shortcut: 'Ctrl+Z' },
  { type: 'separator' },
  { id: 'cut', label: '剪切', enLabel: 'Cut', shortcut: 'Ctrl+X' },
  { id: 'copy', label: '复制', enLabel: 'Copy', shortcut: 'Ctrl+C' },
  { id: 'paste', label: '粘贴', enLabel: 'Paste', shortcut: 'Ctrl+V' },
  { id: 'select-all', label: '全选', enLabel: 'Select All', shortcut: 'Ctrl+A' },
  { type: 'separator' },
  { id: 'settings', label: '设置', enLabel: 'Settings', shortcut: 'Ctrl+,' },
] as const

const windowItems = [
  { id: 'new-window', label: '新建窗口', enLabel: 'New Window', shortcut: 'Ctrl+Shift+N' },
  { id: 'reload', label: '重新加载', enLabel: 'Reload', shortcut: 'Ctrl+R' },
  { type: 'separator' },
  { id: 'minimize', label: '最小化', enLabel: 'Minimize', shortcut: 'Ctrl+M' },
  { id: 'toggle-maximize', label: '最大化 / 还原', enLabel: 'Maximize / Restore', shortcut: 'Alt+Enter' },
  { id: 'toggle-fullscreen', label: '切换全屏', enLabel: 'Toggle Full Screen', shortcut: 'F11' },
  { type: 'separator' },
  { id: 'close-window', label: '关闭窗口', enLabel: 'Close Window', shortcut: 'Ctrl+W' },
] as const

type FileItemId = Extract<(typeof fileItems)[number], { id: string }>['id']
type EditItemId = Extract<(typeof editItems)[number], { id: string }>['id']
type WindowItemId = Extract<(typeof windowItems)[number], { id: string }>['id']
type DesktopActionId = FileItemId | EditItemId | WindowItemId
type MenuId = 'file' | 'edit' | 'window'

export function DesktopAppMenu() {
  const navigate = useNavigate()
  const { language, t } = useI18n()
  const { bindings } = useShortcutSettings()
  const { busyAction, runAppAction } = useAppActions()
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null)

  const desktop = isDesktopApp()

  useEffect(() => {
    if (!desktop || !openMenu) return

    function closeMenu() {
      setOpenMenu(null)
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
  }, [desktop, openMenu])

  if (!desktop) return null

  function runEditAction(id: EditItemId) {
    setOpenMenu(null)
    if (id === 'settings') {
      navigate('/settings')
      return
    }
    void runAppAction(id)
  }

  async function runMenuAction(id: DesktopActionId) {
    setOpenMenu(null)
    if (isEditAction(id)) {
      runEditAction(id)
    } else {
      await runAppAction(id as AppActionId)
    }
  }

  return (
    <nav className="agenthub-desktop-menu" aria-label={t('应用菜单')} onPointerDown={(event) => event.stopPropagation()}>
      <div className="agenthub-desktop-menu-inner">
        <DesktopMenuButton id="file" label={t('文件')} openMenu={openMenu} setOpenMenu={setOpenMenu}>
          {fileItems.map((item, index) =>
            isSeparator(item) ? (
              <DesktopMenuSeparator key={`file-separator-${index}`} />
            ) : (
              <DesktopMenuItem
                key={item.id}
                disabled={Boolean(busyAction)}
                label={menuItemLabel(item, language, t)}
                shortcut={shortcutFor(bindings, item.id)}
                onClick={() => void runMenuAction(item.id)}
              />
            ),
          )}
        </DesktopMenuButton>

        <DesktopMenuButton id="edit" label={t('编辑')} openMenu={openMenu} setOpenMenu={setOpenMenu}>
          {editItems.map((item, index) =>
            isSeparator(item) ? (
              <DesktopMenuSeparator key={`edit-separator-${index}`} />
            ) : (
              <DesktopMenuItem
                key={item.id}
                label={menuItemLabel(item, language, t)}
                shortcut={item.shortcut}
                onClick={() => void runMenuAction(item.id)}
              />
            ),
          )}
        </DesktopMenuButton>

        <DesktopMenuButton id="window" label={t('窗口')} openMenu={openMenu} setOpenMenu={setOpenMenu}>
          {windowItems.map((item, index) =>
            isSeparator(item) ? (
              <DesktopMenuSeparator key={`window-separator-${index}`} />
            ) : (
              <DesktopMenuItem
                key={item.id}
                disabled={Boolean(busyAction)}
                label={menuItemLabel(item, language, t)}
                shortcut={shortcutFor(bindings, item.id)}
                onClick={() => void runMenuAction(item.id)}
              />
            ),
          )}
        </DesktopMenuButton>
      </div>
    </nav>
  )
}

function DesktopMenuButton({
  children,
  id,
  label,
  openMenu,
  setOpenMenu,
}: {
  children: ReactNode
  id: MenuId
  label: string
  openMenu: MenuId | null
  setOpenMenu: (menu: MenuId | null) => void
}) {
  const open = openMenu === id
  return (
    <div className="agenthub-desktop-menu-group" onPointerEnter={() => openMenu && setOpenMenu(id)}>
      <button
        type="button"
        className="agenthub-desktop-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={open}
        onClick={() => setOpenMenu(open ? null : id)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpenMenu(id)
          }
        }}
      >
        {label}
      </button>
      {open && (
        <div className="agenthub-desktop-menu-panel" role="menu">
          {children}
        </div>
      )}
    </div>
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

function isSeparator<T extends { type: 'separator' } | { id: string }>(
  item: T,
): item is Extract<T, { type: 'separator' }> {
  return 'type' in item
}

function isEditAction(id: DesktopActionId): id is EditItemId {
  return editItems.some((item) => 'id' in item && item.id === id)
}

function menuItemLabel(
  item: { label: string; enLabel?: string },
  language: string,
  t: (text: string) => string,
) {
  return language === 'en' && item.enLabel ? item.enLabel : t(item.label)
}
