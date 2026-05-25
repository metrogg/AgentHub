export function isDesktopApp() {
  return Boolean('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
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

export async function notifyUser(title: string, body?: string) {
  if (!isDesktopApp()) return false
  await invokeNative('notify_user', { title, body })
  return true
}
