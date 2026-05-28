import { useState } from 'react'
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { workspaceNameFromPath } from '@agenthub/shared'
import { requestNewSessionDialog } from '../components/chat/GlobalNewSessionDialog'
import { useChatStore } from '../stores/chatStore'
import { api } from './api'
import { useI18n } from './i18n'
import { requestSettingsDialog } from './settingsDialog'
import {
  closeDesktopWindow,
  minimizeDesktopWindow,
  openDesktopWindow,
  pickWorkspaceFolder,
  toggleFullscreenDesktopWindow,
  toggleMaximizeDesktopWindow,
} from './native'
import type { ShortcutActionId } from './shortcuts'

export type EditCommandId = 'undo' | 'cut' | 'copy' | 'paste' | 'select-all'
export type AppActionId = ShortcutActionId | EditCommandId

interface OpenWorkspaceFolderOptions {
  projectPath?: string | null
  fetchSessions: () => Promise<void>
  selectSession: (id: string) => Promise<void> | void
  navigate: NavigateFunction
}

export async function openWorkspaceFolderAsSession({
  projectPath,
  fetchSessions,
  navigate,
  selectSession,
}: OpenWorkspaceFolderOptions) {
  const result = await api.openWorkspaceFolder(projectPath)
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
  const { session } = await api.openWorkspaceGroupSession(workspace.id, [])
  await fetchSessions()
  await selectSession(session.id)
  navigate(`/chat/${session.id}`)
}

export function useAppActions() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useI18n()
  const createSession = useChatStore((state) => state.createSession)
  const fetchSessions = useChatStore((state) => state.fetchSessions)
  const selectSession = useChatStore((state) => state.selectSession)
  const [busyAction, setBusyAction] = useState<AppActionId | null>(null)

  async function runAppAction(action: AppActionId) {
    if (busyAction) return
    setBusyAction(action)
    try {
      if (action === 'new-chat') {
        if (location.pathname === '/' || location.pathname.startsWith('/chat/')) {
          requestNewSessionDialog()
        } else {
          navigate('/', { state: { openNewSessionDialog: true } })
        }
      } else if (action === 'quick-chat') {
        const session = await createSession(t('快速对话'))
        await selectSession(session.id)
        navigate(`/chat/${session.id}`)
      } else if (action === 'open-folder') {
        const nativePath = await pickWorkspaceFolder().catch(() => null)
        await openWorkspaceFolderAsSession({
          projectPath: nativePath,
          fetchSessions,
          selectSession,
          navigate,
        })
      } else if (action === 'settings') {
        requestSettingsDialog()
      } else if (action === 'new-window') {
        await openDesktopWindow()
      } else if (action === 'close-window') {
        await closeDesktopWindow()
      } else if (action === 'reload') {
        window.location.reload()
      } else if (action === 'minimize') {
        await minimizeDesktopWindow()
      } else if (action === 'toggle-maximize') {
        await toggleMaximizeDesktopWindow()
      } else if (action === 'toggle-fullscreen') {
        await toggleFullscreenDesktopWindow()
      } else {
        await runNativeEditCommand(action)
      }
    } finally {
      setBusyAction(null)
    }
  }

  return { busyAction, runAppAction }
}

export { workspaceNameFromPath }

async function runNativeEditCommand(id: EditCommandId) {
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

  const commandById: Record<Exclude<EditCommandId, 'select-all'>, string> = {
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
