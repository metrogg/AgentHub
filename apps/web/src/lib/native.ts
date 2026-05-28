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

export async function openExternalUrl(url: string) {
  if (!isDesktopApp()) return false
  await invokeNative('open_external_url', { url })
  return true
}

export interface NativeDownloadResult {
  fileName: string
  path: string
  folder: string
}

export async function downloadExternalUrl(url: string, fileName: string) {
  return invokeNative<NativeDownloadResult>('download_external_url', { url, fileName })
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
  if (await tryWindowApi(async (window) => window.close())) return true
  return invokeDesktopCommand('close_desktop_window')
}

export async function openDesktopWindow() {
  if (!isDesktopApp()) return false
  await invokeNative('open_desktop_window')
  return true
}

export async function openUrlWindow(url: string) {
  if (!isDesktopApp()) return false
  await invokeNative('open_url_window', { url })
  return true
}

export async function openSettingsWindow() {
  if (!isDesktopApp()) return false
  await invokeNative('open_settings_window')
  return true
}

export async function minimizeDesktopWindow() {
  if (!isDesktopApp()) return false
  if (await tryWindowApi(async (window) => window.minimize())) return true
  return invokeDesktopCommand('minimize_desktop_window')
}

export async function startDesktopWindowDrag() {
  if (!isDesktopApp()) return false
  if (await tryWindowApi(async (window) => window.startDragging())) return true
  return invokeDesktopCommand('start_desktop_window_drag')
}

export async function toggleMaximizeDesktopWindow() {
  if (!isDesktopApp()) return false
  if (
    await tryWindowApi(async (window) => {
      if (await window.isMaximized()) {
        await window.unmaximize()
      } else {
        await window.maximize()
      }
    })
  ) {
    return true
  }
  return invokeDesktopCommand('toggle_maximize_desktop_window')
}

export async function toggleFullscreenDesktopWindow() {
  if (!isDesktopApp()) return false
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const currentWindow = getCurrentWindow()
  await currentWindow.setFullscreen(!(await currentWindow.isFullscreen()))
  return true
}

export async function setDesktopWindowTitle(title: string) {
  document.title = title
  if (!isDesktopApp()) return false
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  await getCurrentWindow().setTitle(title)
  return true
}

async function tryWindowApi(action: (window: any) => Promise<void>) {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const window = getCurrentWindow()
    await action(window)
    return true
  } catch (error) {
    console.warn('[AgentHub] Tauri window API failed, falling back to native command:', error)
    return false
  }
}

async function invokeDesktopCommand(command: string) {
  try {
    await invokeNative(command)
    return true
  } catch (error) {
    console.error(`[AgentHub] Native command failed: ${command}`, error)
    return false
  }
}
