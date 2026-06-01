import { useEffect, useState } from 'react'
import SessionList from './SessionList'

const sessionSidebarWidth = 340
const MOBILE_BREAKPOINT = 768

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setIsMobile(e.matches)
    handler(mql)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])
  return isMobile
}

export default function CollapsibleSessionSidebar({
  collapsed: collapsedProp,
  onCollapsedChange,
}: {
  collapsed?: boolean
  onCollapsedChange?: (v: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [internalCollapsed, setInternalCollapsed] = useState(true)
  const collapsed = collapsedProp ?? internalCollapsed

  function toggle() {
    const next = !collapsed
    onCollapsedChange?.(next)
    if (collapsedProp === undefined) setInternalCollapsed(next)
  }

  // Auto-collapse on mobile breakpoint change
  useEffect(() => {
    if (isMobile && !collapsed) {
      onCollapsedChange?.(true)
      if (collapsedProp === undefined) setInternalCollapsed(true)
    }
  }, [isMobile])

  // Mobile: fixed overlay mode
  if (isMobile) {
    return (
      <>
        <div
          className={`agenthub-sidebar-backdrop ${collapsed ? '' : 'visible'}`}
          onClick={toggle}
          aria-hidden={collapsed}
        />
        <div
          aria-hidden={collapsed}
          className="fixed left-0 top-0 z-40 h-full shrink-0 overflow-hidden"
          style={{
            width: collapsed ? 0 : sessionSidebarWidth,
            transition: 'width 250ms cubic-bezier(0.4,0,0.2,1)',
          }}
        >
          <div
            className={[
              'h-full w-[340px] transform-gpu will-change-transform shadow-2xl',
              collapsed ? 'pointer-events-none -translate-x-full' : 'translate-x-0',
            ].join(' ')}
            style={{
              transition: 'transform 250ms cubic-bezier(0.4,0,0.2,1)',
            }}
          >
            <SessionList onCollapse={toggle} />
          </div>
        </div>
      </>
    )
  }

  // Desktop: inline mode (original behavior)
  return (
    <div
      aria-hidden={collapsed}
      className="h-full shrink-0 overflow-hidden"
      style={{
        width: collapsed ? 0 : sessionSidebarWidth,
        transition: 'width 300ms cubic-bezier(0.4,0,0.2,1)',
      }}
    >
      <div
        className={[
          'h-full w-[340px] transform-gpu will-change-transform',
          collapsed ? 'pointer-events-none -translate-x-full opacity-0' : 'translate-x-0 opacity-100',
        ].join(' ')}
        style={{
          transition: 'opacity 300ms cubic-bezier(0.4,0,0.2,1), transform 300ms cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        <SessionList onCollapse={toggle} />
      </div>
    </div>
  )
}
