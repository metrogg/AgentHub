import { useEffect, useState } from 'react'
import { api } from './api'
import { settingsUpdatedEvent } from './shortcuts'

export type MessageStyleMode = 'bubble' | 'flat'

export const messageStyleOptions = ['气泡模式', '平铺模式']

export function normalizeMessageStyleMode(value: unknown): MessageStyleMode {
  if (value === '平铺模式' || value === '平铺' || value === 'flat') return 'flat'
  return 'bubble'
}

export function messageStyleSettingValue(mode: MessageStyleMode) {
  return mode === 'flat' ? '平铺模式' : '气泡模式'
}

export function normalizeMessageStyleSetting(value: unknown) {
  return messageStyleSettingValue(normalizeMessageStyleMode(value))
}

let cachedMode: MessageStyleMode = 'bubble'
let hasLoaded = false
let loadingPromise: Promise<void> | null = null
let settingsListenerRegistered = false
const listeners = new Set<(mode: MessageStyleMode) => void>()

function updateCachedMode(mode: MessageStyleMode) {
  hasLoaded = true
  cachedMode = mode
  listeners.forEach((listener) => listener(mode))
}

async function loadMessageStyleMode() {
  const settings: Record<string, string> = await api.getSettings().catch(() => ({}))
  try {
    const appSettings = settings.APP_SETTINGS ? JSON.parse(settings.APP_SETTINGS) : {}
    updateCachedMode(normalizeMessageStyleMode(appSettings.bubbleStyle))
  } catch {
    updateCachedMode('bubble')
  }
}

function refreshMessageStyleMode() {
  loadingPromise = loadMessageStyleMode().finally(() => {
    loadingPromise = null
  })
  return loadingPromise
}

export function useMessageStyleMode() {
  const [mode, setMode] = useState<MessageStyleMode>(cachedMode)

  useEffect(() => {
    listeners.add(setMode)
    setMode(cachedMode)

    if (typeof window !== 'undefined' && !settingsListenerRegistered) {
      window.addEventListener(settingsUpdatedEvent, refreshMessageStyleMode)
      settingsListenerRegistered = true
    }

    if (!hasLoaded && !loadingPromise) void refreshMessageStyleMode()

    return () => {
      listeners.delete(setMode)
    }
  }, [])

  return mode
}
