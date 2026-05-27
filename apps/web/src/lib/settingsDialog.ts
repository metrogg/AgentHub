import { isDesktopApp, openSettingsWindow } from './native'

export const settingsDialogEvent = 'agenthub:settings-dialog-open'

export function requestSettingsDialog() {
  if (isDesktopApp()) {
    void openSettingsWindow().catch(() => {
      window.dispatchEvent(new Event(settingsDialogEvent))
    })
    return
  }
  window.dispatchEvent(new Event(settingsDialogEvent))
}
