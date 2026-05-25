import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { requestNewSessionDialog } from './chat/GlobalNewSessionDialog'
import { api } from '../lib/api'
import { useI18n } from '../lib/i18n'
import {
  closeDesktopWindow,
  isDesktopApp,
  minimizeDesktopWindow,
  openDesktopWindow,
  pickWorkspaceFolder,
  toggleFullscreenDesktopWindow,
  toggleMaximizeDesktopWindow,
} from '../lib/native'
import { shortcutFor, shortcutMatches, useShortcutSettings } from '../lib/shortcuts'
import { useChatStore } from '../stores/chatStore'

const fileItems = [
  { id: 'new-chat', label: '新建会话', enLabel: 'New Chat', shortcut: 'Ctrl+N' },
  { id: 'quick-chat', label: '快速对话', enLabel: 'Quick Chat', shortcut: 'Alt+Ctrl+N' },
  { id: 'open-folder', label: '打开文件夹...', enLabel: 'Open Folder...', shortcut: 'Ctrl+O' },
  { type: 'separator' },
  { id: 'close', label: '关闭窗口', enLabel: 'Close Window', shortcut: 'Ctrl+W' },
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
  { id: 'close', label: '关闭窗口', enLabel: 'Close Window', shortcut: 'Ctrl+W' },
] as const

type FileItemId = Extract<(typeof fileItems)[number], { id: string }>['id']
type EditItemId = Extract<(typeof editItems)[number], { id: string }>['id']
type WindowItemId = Extract<(typeof windowItems)[number], { id: string }>['id']
type DesktopActionId = FileItemId | EditItemId | WindowItemId
type MenuId = 'file' | 'edit' | 'window'

export function DesktopAppMenu() {
  const navigate = useNavigate()
  const location = useLocation()
  const { language, t } = useI18n()
  const { bindings } = useShortcutSettings()
  const createSession = useChatStore((state) => state.createSession)
  const selectSession = useChatStore((state) => state.selectSession)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const [busyItem, setBusyItem] = useState<DesktopActionId | null>(null)
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null)

  const desktop = isDesktopApp()

  useEffect(() => {
    if (!desktop) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      if (shortcutMatches(event, shortcutFor(bindings, 'close-window'))) {
        event.preventDefault()
        void runFileAction('close')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'new-window'))) {
        event.preventDefault()
        void runWindowAction('new-window')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'new-chat'))) {
        event.preventDefault()
        void runFileAction('new-chat')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'quick-chat'))) {
        event.preventDefault()
        void runFileAction('quick-chat')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'open-folder'))) {
        event.preventDefault()
        void runFileAction('open-folder')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'settings'))) {
        event.preventDefault()
        runEditAction('settings')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'reload'))) {
        event.preventDefault()
        void runWindowAction('reload')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'minimize'))) {
        event.preventDefault()
        void runWindowAction('minimize')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'toggle-maximize'))) {
        event.preventDefault()
        void runWindowAction('toggle-maximize')
      } else if (shortcutMatches(event, shortcutFor(bindings, 'toggle-fullscreen'))) {
        event.preventDefault()
        void runWindowAction('toggle-fullscreen')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

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

  async function runFileAction(id: FileItemId) {
    if (busyItem) return
    setBusyItem(id)
    try {
      if (id === 'close') {
        await closeDesktopWindow()
      } else if (id === 'new-chat') {
        if (location.pathname === '/' || location.pathname.startsWith('/chat/')) {
          requestNewSessionDialog()
        } else {
          navigate('/', { state: { openNewSessionDialog: true } })
        }
      } else if (id === 'quick-chat') {
        const session = await createSession(t('快速对话'))
        await selectSession(session.id)
        navigate(`/chat/${session.id}`)
      } else if (id === 'open-folder') {
        const nativePath = await pickWorkspaceFolder().catch(() => null)
        const result = await api.openWorkspaceFolder(nativePath)
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
    } finally {
      setBusyItem(null)
    }
  }

  function runEditAction(id: EditItemId) {
    setOpenMenu(null)
    if (id === 'settings') {
      navigate('/settings')
      return
    }
    void runNativeEditCommand(id)
  }

  async function runWindowAction(id: WindowItemId) {
    if (busyItem) return
    setBusyItem(id)
    try {
      if (id === 'new-window') {
        await openDesktopWindow()
      } else if (id === 'reload') {
        window.location.reload()
      } else if (id === 'minimize') {
        await minimizeDesktopWindow()
      } else if (id === 'toggle-maximize') {
        await toggleMaximizeDesktopWindow()
      } else if (id === 'toggle-fullscreen') {
        await toggleFullscreenDesktopWindow()
      } else if (id === 'close') {
        await closeDesktopWindow()
      }
    } finally {
      setBusyItem(null)
    }
  }

  async function runMenuAction(id: DesktopActionId) {
    setOpenMenu(null)
    if (isFileAction(id)) {
      await runFileAction(id)
    } else if (isEditAction(id)) {
      runEditAction(id)
    } else if (isWindowAction(id)) {
      await runWindowAction(id)
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
                disabled={Boolean(busyItem)}
                label={menuItemLabel(item, language, t)}
                shortcut={shortcutFor(bindings, item.id === 'close' ? 'close-window' : item.id)}
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
                disabled={Boolean(busyItem)}
                label={menuItemLabel(item, language, t)}
                shortcut={shortcutFor(bindings, item.id === 'close' ? 'close-window' : item.id)}
                onClick={() => void runMenuAction(item.id)}
              />
            ),
          )}
        </DesktopMenuButton>
      </div>
    </nav>
  )
}

function workspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || '项目文件夹'
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

function isFileAction(id: DesktopActionId): id is FileItemId {
  return fileItems.some((item) => 'id' in item && item.id === id)
}

function isEditAction(id: DesktopActionId): id is EditItemId {
  return editItems.some((item) => 'id' in item && item.id === id)
}

function isWindowAction(id: DesktopActionId): id is WindowItemId {
  return windowItems.some((item) => 'id' in item && item.id === id)
}

function menuItemLabel(
  item: { label: string; enLabel?: string },
  language: string,
  t: (text: string) => string,
) {
  return language === 'en' && item.enLabel ? item.enLabel : t(item.label)
}

async function runNativeEditCommand(id: Exclude<EditItemId, 'settings'>) {
  const target = getEditableTarget()
  target?.focus()
  if (id === 'select-all') {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.select()
    } else {
      document.execCommand('selectAll')
    }
    return
  }

  if (id === 'paste') {
    const pasted = await pasteFromClipboard(target)
    if (pasted) return
  }

  const commandById: Record<Exclude<EditItemId, 'settings' | 'select-all'>, string> = {
    copy: 'copy',
    cut: 'cut',
    paste: 'paste',
    undo: 'undo',
  }
  document.execCommand(commandById[id])
}

function getEditableTarget() {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return active
  if (active instanceof HTMLElement && active.isContentEditable) return active
  return null
}

async function pasteFromClipboard(target: HTMLElement | null) {
  try {
    const text = await navigator.clipboard.readText()
    if (!text) return false
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length
      const end = target.selectionEnd ?? target.value.length
      target.setRangeText(text, start, end, 'end')
      target.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    if (target?.isContentEditable) {
      document.execCommand('insertText', false, text)
      return true
    }
  } catch {
    return false
  }
  return false
}
