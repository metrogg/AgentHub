export const settingsDialogEvent = 'agenthub:settings-dialog-open'

export function requestSettingsDialog() {
  window.dispatchEvent(new Event(settingsDialogEvent))
}
