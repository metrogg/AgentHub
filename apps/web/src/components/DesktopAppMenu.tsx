import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { closeDesktopWindow, isDesktopApp, openDesktopWindow, pickWorkspaceFolder } from '../lib/native'
import { useChatStore } from '../stores/chatStore'

const fileItems = [
  { id: 'close', label: 'Close', shortcut: 'Ctrl+W' },
  { id: 'new-window', label: 'New Window', shortcut: 'Ctrl+Shift+N' },
  { id: 'new-chat', label: 'New Chat', shortcut: 'Ctrl+N' },
  { id: 'quick-chat', label: 'Quick Chat', shortcut: 'Alt+Ctrl+N' },
  { id: 'open-folder', label: 'Open Folder...', shortcut: 'Ctrl+O' },
] as const

type FileItemId = (typeof fileItems)[number]['id']

export function DesktopAppMenu() {
  const navigate = useNavigate()
  const createSession = useChatStore((state) => state.createSession)
  const selectSession = useChatStore((state) => state.selectSession)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const [busyItem, setBusyItem] = useState<FileItemId | null>(null)

  const desktop = isDesktopApp()

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

  if (!desktop) return null

  async function runFileAction(id: FileItemId) {
    if (busyItem) return
    setBusyItem(id)
    try {
      if (id === 'close') {
        await closeDesktopWindow()
      } else if (id === 'new-window') {
        await openDesktopWindow()
      } else if (id === 'new-chat' || id === 'quick-chat') {
        const session = await createSession(id === 'quick-chat' ? '快速对话' : '新会话')
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

  return null
}

function workspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || '项目文件夹'
}
