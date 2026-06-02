import SessionList from './SessionList'

const sessionSidebarWidth = 340
const sessionDockWidth = 68

export default function CollapsibleSessionSidebar({
  collapsed,
  onCollapsedChange,
}: {
  collapsed: boolean
  onCollapsedChange?: (v: boolean) => void
}) {
  return (
    <div
      className="h-full shrink-0 overflow-hidden"
      style={{
        width: collapsed ? sessionDockWidth : sessionSidebarWidth,
        transition: 'width 300ms cubic-bezier(0.4,0,0.2,1)',
      }}
    >
      <div
        className="h-full w-[340px] transform-gpu will-change-transform"
      >
        <SessionList
          collapsed={collapsed}
          onCollapse={onCollapsedChange ? () => onCollapsedChange(!collapsed) : undefined}
        />
      </div>
    </div>
  )
}
