export function isDesktopApp() {
  return Boolean(
    '__TAURI_INTERNALS__' in window ||
      '__TAURI__' in window ||
      document.documentElement.classList.contains('agenthub-desktop-shell')
  )
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>) {
  if (!isDesktopApp()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export async function pickWorkspaceFolder() {
  return invokeNative<string | null>('pick_workspace_folder')
}

export async function openInEditor(path: string, line?: number) {
  if (!isDesktopApp()) return false
  await invokeNative('open_in_editor', { path, line })
  return true
}

export async function openPath(path: string) {
  if (!isDesktopApp()) return false
  await invokeNative('open_path', { path })
  return true
}

export async function getDesktopInfo() {
  return invokeNative<{ app_data_dir: string; config_dir: string; log_dir: string }>('desktop_info')
}

export async function notifyUser(title: string, body?: string) {
  if (!isDesktopApp()) return false
  await invokeNative('notify_user', { title, body })
  return true
}

export async function closeDesktopWindow() {
  if (!isDesktopApp()) return false
  await invokeNative('close_desktop_window')
  return true
}

export async function openDesktopWindow() {
  if (!isDesktopApp()) return false
  await invokeNative('open_desktop_window')
  return true
}

export async function setDesktopWindowTitle(title: string) {
  document.title = title
  if (!isDesktopApp()) return false
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().setTitle(title)
  return true
}
