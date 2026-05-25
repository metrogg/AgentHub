import SessionList from './SessionList'

export default function CollapsibleSessionSidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      aria-hidden={collapsed}
      className="h-full shrink-0 overflow-hidden"
      style={{
        width: collapsed ? 0 : 256,
        transition: 'width 300ms cubic-bezier(0.4,0,0.2,1)',
      }}
    >
      <div
        className={[
          'h-full w-64 transform-gpu will-change-transform',
          collapsed ? 'pointer-events-none -translate-x-full opacity-0' : 'translate-x-0 opacity-100',
        ].join(' ')}
        style={{
          transition: 'opacity 300ms cubic-bezier(0.4,0,0.2,1), transform 300ms cubic-bezier(0.4,0,0.2,1)',
        }}
      >
        <SessionList />
      </div>
    </div>
  )
}
