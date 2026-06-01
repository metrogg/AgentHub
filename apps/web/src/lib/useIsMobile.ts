import { useSyncExternalStore } from 'react'

const MOBILE_BREAKPOINT = 768

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

function getServerSnapshot() {
  return false
}

let listeners: Array<() => void> = []

function subscribe(callback: () => void) {
  listeners = [...listeners, callback]
  return () => {
    listeners = listeners.filter((l) => l !== callback)
  }
}

if (typeof window !== 'undefined') {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener('change', () => {
    for (const listener of listeners) listener()
  })
}

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
