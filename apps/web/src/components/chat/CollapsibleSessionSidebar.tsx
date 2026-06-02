import SessionList from './SessionList'

const sessionSidebarWidth = 340

export default function CollapsibleSessionSidebar({
  collapsed,
  onCollapsedChange,
}: {
  collapsed: boolean
  onCollapsedChange?: (v: boolean) => void
}) {
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
        <SessionList onCollapse={onCollapsedChange ? () => onCollapsedChange(!collapsed) : undefined} />
      </div>
    </div>
  )
}
