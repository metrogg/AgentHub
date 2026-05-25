import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { closeDesktopWindow, isDesktopApp, openDesktopWindow, pickWorkspaceFolder } from '../lib/native'
import { useChatStore } from '../stores/chatStore'

const fileItems = [
  { id: 'new-chat', label: '新建会话', shortcut: 'Ctrl+N' },
  { id: 'quick-chat', label: '快速对话', shortcut: 'Alt+Ctrl+N' },
  { id: 'open-folder', label: '打开文件夹...', shortcut: 'Ctrl+O' },
  { id: 'close', label: '关闭窗口', shortcut: 'Ctrl+W' },
] as const

type FileItemId = (typeof fileItems)[number]['id']
type DesktopActionId = FileItemId | 'new-window'
type MenuId = 'file' | 'edit' | 'window'

export function DesktopAppMenu() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const createSession = useChatStore((state) => state.createSession)
  const selectSession = useChatStore((state) => state.selectSession)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const [busyItem, setBusyItem] = useState<DesktopActionId | null>(null)
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null)

  const desktop = isDesktopApp()
  const windowItems = useMemo(() => [{ id: 'new-window' as const, label: t('新建窗口'), shortcut: 'Ctrl+Shift+N' }], [t])

  useEffect(() => {
    if (!desktop) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return
      const key = event.key.toLowerCase()
      const hasCtrl = event.ctrlKey || event.metaKey
      if (hasCtrl && !event.shiftKey && !event.altKey && key === 'w') {
        event.preventDefault()
        void runFileAction('close')
      } else if (hasCtrl && event.shiftKey && !event.altKey && key === 'n') {
        event.preventDefault()
        void runFileAction('new-window')
      } else if (hasCtrl && !event.shiftKey && !event.altKey && key === 'n') {
        event.preventDefault()
        void runFileAction('new-chat')
      } else if (hasCtrl && event.altKey && !event.shiftKey && key === 'n') {
        event.preventDefault()
        void runFileAction('quick-chat')
      } else if (hasCtrl && !event.shiftKey && !event.altKey && key === 'o') {
        event.preventDefault()
        void runFileAction('open-folder')
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

  async function runFileAction(id: DesktopActionId) {
    if (busyItem) return
    setBusyItem(id)
    try {
      if (id === 'close') {
        await closeDesktopWindow()
      } else if (id === 'new-window') {
        await openDesktopWindow()
      } else if (id === 'new-chat' || id === 'quick-chat') {
        const session = await createSession(id === 'quick-chat' ? t('快速对话') : t('新会话'))
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

  async function runMenuAction(id: DesktopActionId) {
    setOpenMenu(null)
    await runFileAction(id)
  }

  return (
    <nav className="agenthub-desktop-menu" aria-label={t('应用菜单')} onPointerDown={(event) => event.stopPropagation()}>
      <div className="agenthub-desktop-menu-inner">
        <DesktopMenuButton id="file" label={t('文件')} openMenu={openMenu} setOpenMenu={setOpenMenu}>
          {fileItems.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={Boolean(busyItem)}
              className="agenthub-desktop-menu-item"
              onClick={() => void runMenuAction(item.id)}
            >
              <span>{t(item.label)}</span>
              <kbd>{item.shortcut}</kbd>
            </button>
          ))}
        </DesktopMenuButton>

        <DesktopMenuButton id="edit" label={t('编辑')} openMenu={openMenu} setOpenMenu={setOpenMenu} compact>
          <button type="button" className="agenthub-desktop-menu-item" onClick={() => {
            setOpenMenu(null)
            navigate('/settings')
          }}>
            <span>{t('设置')}</span>
            <kbd>Ctrl+,</kbd>
          </button>
        </DesktopMenuButton>

        <DesktopMenuButton id="window" label={t('窗口')} openMenu={openMenu} setOpenMenu={setOpenMenu} compact>
          {windowItems.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={Boolean(busyItem)}
              className="agenthub-desktop-menu-item"
              onClick={() => void runMenuAction(item.id)}
            >
              <span>{item.label}</span>
              <kbd>{item.shortcut}</kbd>
            </button>
          ))}
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
  compact = false,
  id,
  label,
  openMenu,
  setOpenMenu,
}: {
  children: ReactNode
  compact?: boolean
  id: MenuId
  label: string
  openMenu: MenuId | null
  setOpenMenu: (menu: MenuId | null) => void
}) {
  const open = openMenu === id
  return (
    <div className="agenthub-desktop-menu-group">
      <button
        type="button"
        className="agenthub-desktop-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={open}
        onClick={() => setOpenMenu(open ? null : id)}
      >
        {label}
      </button>
      {open && (
        <div className={compact ? 'agenthub-desktop-menu-panel agenthub-desktop-menu-panel-compact' : 'agenthub-desktop-menu-panel'} role="menu">
          {children}
        </div>
      )}
    </div>
  )
}
