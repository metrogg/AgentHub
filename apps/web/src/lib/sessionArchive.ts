export type SessionListPrefs = {
  pinned: string[]
  archived: string[]
}

export const sessionListPrefsKey = 'agenthub:session-list-prefs'
export const sessionArchiveChangeEvent = 'agenthub:session-archive-change'

export function loadSessionListPrefs(): SessionListPrefs {
  if (typeof window === 'undefined') return { pinned: [], archived: [] }
  try {
    return normalizeSessionListPrefs(JSON.parse(window.localStorage.getItem(sessionListPrefsKey) ?? '{}'))
  } catch {
    return { pinned: [], archived: [] }
  }
}

export function saveSessionListPrefs(prefs: SessionListPrefs) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(sessionListPrefsKey, JSON.stringify(normalizeSessionListPrefs(prefs)))
  window.dispatchEvent(new CustomEvent(sessionArchiveChangeEvent))
}

export function updateSessionListPrefs(updater: (current: SessionListPrefs) => SessionListPrefs) {
  const next = normalizeSessionListPrefs(updater(loadSessionListPrefs()))
  saveSessionListPrefs(next)
  return next
}

export function normalizeSessionListPrefs(value: unknown): SessionListPrefs {
  const candidate = value as Partial<SessionListPrefs> | null
  return {
    pinned: uniqueStrings(candidate?.pinned),
    archived: uniqueStrings(candidate?.archived),
  }
}

export function uniqueStrings(value: unknown) {
  return Array.from(new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []))
}
