import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from './api'

export const settingsUpdatedEvent = 'agenthub:settings-updated'

export type ShortcutActionId =
  | 'new-chat'
  | 'quick-chat'
  | 'open-folder'
  | 'settings'
  | 'new-window'
  | 'close-window'
  | 'reload'
  | 'minimize'
  | 'toggle-maximize'
  | 'toggle-fullscreen'

export interface ShortcutBinding {
  action: ShortcutActionId
  keys: string
}

export const defaultShortcutBindings: ShortcutBinding[] = [
  { action: 'new-chat', keys: 'Ctrl+N' },
  { action: 'quick-chat', keys: 'Ctrl+Alt+N' },
  { action: 'open-folder', keys: 'Ctrl+O' },
  { action: 'settings', keys: 'Ctrl+,' },
  { action: 'new-window', keys: 'Ctrl+Shift+N' },
  { action: 'close-window', keys: 'Ctrl+W' },
  { action: 'reload', keys: 'Ctrl+R' },
  { action: 'minimize', keys: 'Ctrl+M' },
  { action: 'toggle-maximize', keys: 'Alt+Enter' },
  { action: 'toggle-fullscreen', keys: 'F11' },
]

const actionSet = new Set(defaultShortcutBindings.map((item) => item.action))

export function normalizeShortcutBindings(value: unknown): ShortcutBinding[] {
  const defaults = new Map(defaultShortcutBindings.map((item) => [item.action, item.keys]))
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const action = (item as { action?: unknown }).action
      const keys = (item as { keys?: unknown }).keys
      if (typeof action === 'string' && actionSet.has(action as ShortcutActionId) && typeof keys === 'string') {
        const normalized = normalizeShortcutText(keys)
        if (normalized) defaults.set(action as ShortcutActionId, normalized)
      }
    }
  }
  return defaultShortcutBindings.map((item) => ({
    action: item.action,
    keys: defaults.get(item.action) ?? item.keys,
  }))
}

export function shortcutFor(bindings: ShortcutBinding[], action: ShortcutActionId) {
  return bindings.find((item) => item.action === action)?.keys ?? defaultShortcutBindings.find((item) => item.action === action)?.keys ?? ''
}

export function shortcutMatches(event: KeyboardEvent | ReactKeyboardEvent, shortcut: string) {
  const target = parseShortcut(shortcut)
  if (!target) return false
  const actual = shortcutFromEvent(event)
  return actual === formatShortcut(target)
}

export function shortcutFromEvent(event: KeyboardEvent | ReactKeyboardEvent) {
  const key = normalizeKey(event.key)
  if (!key) return ''
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

export function normalizeShortcutText(value: string) {
  const parsed = parseShortcut(value)
  return parsed ? formatShortcut(parsed) : ''
}

export function shortcutFromRecordingEvent(event: KeyboardEvent | ReactKeyboardEvent) {
  if (event.key === 'Escape') return 'Escape'
  const key = normalizeKey(event.key)
  if (!key) return ''
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
  const isFunctionKey = /^F\d{1,2}$/.test(key)
  if (!hasModifier && !isFunctionKey) return ''
  return shortcutFromEvent(event)
}

export function shortcutConflict(bindings: ShortcutBinding[], action: ShortcutActionId, keys: string) {
  const normalized = normalizeShortcutText(keys)
  if (!normalized) return null
  return bindings.find((item) => item.action !== action && normalizeShortcutText(item.keys) === normalized) ?? null
}

export function sendModeShouldSubmit(sendMode: string | undefined, event: KeyboardEvent | ReactKeyboardEvent) {
  if (event.key !== 'Enter') return false
  const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event
  if ('isComposing' in nativeEvent && nativeEvent.isComposing) return false
  const mode = sendMode?.includes('Ctrl') ? 'ctrl-enter' : 'enter'
  if (mode === 'ctrl-enter') return (event.ctrlKey || event.metaKey) && !event.shiftKey
  return !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
}

export function shouldInsertNewline(sendMode: string | undefined, event: KeyboardEvent | ReactKeyboardEvent) {
  if (event.key !== 'Enter') return false
  const mode = sendMode?.includes('Ctrl') ? 'ctrl-enter' : 'enter'
  if (mode === 'ctrl-enter') return !event.ctrlKey && !event.metaKey
  return event.shiftKey
}

export function useShortcutSettings() {
  const [bindings, setBindings] = useState<ShortcutBinding[]>(defaultShortcutBindings)
  const [sendMode, setSendMode] = useState('Enter 发送')

  useEffect(() => {
    let cancelled = false
    async function load() {
      const settings: Record<string, string> = await api.getSettings().catch(() => ({}))
      if (cancelled) return
      try {
        const appSettings = settings.APP_SETTINGS ? JSON.parse(settings.APP_SETTINGS) : {}
        setBindings(normalizeShortcutBindings(appSettings.shortcuts))
        setSendMode(typeof appSettings.sendMode === 'string' ? appSettings.sendMode : 'Enter 发送')
      } catch {
        setBindings(defaultShortcutBindings)
        setSendMode('Enter 发送')
      }
    }
    void load()
    window.addEventListener(settingsUpdatedEvent, load)
    return () => {
      cancelled = true
      window.removeEventListener(settingsUpdatedEvent, load)
    }
  }, [])

  return useMemo(() => ({ bindings, sendMode }), [bindings, sendMode])
}

function parseShortcut(value: string) {
  const parts = value
    .split(/[+\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (!parts.length) return null
  const modifiers = new Set<string>()
  let key = ''
  for (const part of parts) {
    const normalized = normalizeKey(part)
    if (!normalized) continue
    if (normalized === 'Ctrl' || normalized === 'Alt' || normalized === 'Shift') {
      modifiers.add(normalized)
    } else {
      key = normalized
    }
  }
  if (!key) return null
  return { modifiers, key }
}

function formatShortcut(value: { modifiers: Set<string>; key: string }) {
  const parts: string[] = []
  if (value.modifiers.has('Ctrl')) parts.push('Ctrl')
  if (value.modifiers.has('Alt')) parts.push('Alt')
  if (value.modifiers.has('Shift')) parts.push('Shift')
  parts.push(value.key)
  return parts.join('+')
}

function normalizeKey(value: string) {
  const key = value.trim()
  if (!key) return ''
  const lower = key.toLowerCase()
  if (lower === 'control' || lower === 'ctrl' || lower === 'meta' || lower === 'cmd' || lower === 'command') return 'Ctrl'
  if (lower === 'alt' || lower === 'option') return 'Alt'
  if (lower === 'shift') return 'Shift'
  if (lower === 'escape' || lower === 'esc') return 'Esc'
  if (lower === ' ') return 'Space'
  if (lower === 'arrowup') return 'ArrowUp'
  if (lower === 'arrowdown') return 'ArrowDown'
  if (lower === 'arrowleft') return 'ArrowLeft'
  if (lower === 'arrowright') return 'ArrowRight'
  if (lower === 'enter') return 'Enter'
  if (lower === 'backspace') return 'Backspace'
  if (lower === 'delete') return 'Delete'
  if (lower === 'tab') return 'Tab'
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase()
  if (key.length === 1) return key.toUpperCase()
  return key
}
