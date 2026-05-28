import { cn } from '../../lib/utils'

export interface GroupAvatarAgent {
  avatar?: string | null
  color?: string | null
  name?: string | null
}

export function GroupAvatar({
  agents = [],
  className,
  size = 'sm',
  title,
}: {
  agents?: GroupAvatarAgent[]
  className?: string
  size?: 'sm' | 'md'
  title?: string | null
}) {
  const first = agents[0] ?? { name: title, color: '#111827' }
  const second = agents[1] ?? { name: agents.length > 1 ? 'A' : '+', color: '#0ea5e9' }
  const rootSize = size === 'md' ? 'h-9 w-9' : 'h-7 w-7'
  const mainSize = size === 'md' ? 'h-6 w-6 text-[11px]' : 'h-5 w-5 text-[10px]'
  const subSize = size === 'md' ? 'h-5 w-5 text-[10px]' : 'h-4 w-4 text-[9px]'

  return (
    <span
      className={cn('relative inline-block shrink-0 rounded-xl bg-white', rootSize, className)}
      aria-hidden="true"
    >
      <GroupAvatarCell
        agent={first}
        className={cn('absolute left-0 top-0 shadow-sm', mainSize)}
        fallback={title}
      />
      <GroupAvatarCell
        agent={second}
        className={cn('absolute bottom-0 right-0 ring-2 ring-white shadow-sm', subSize)}
        fallback="+"
      />
    </span>
  )
}

function GroupAvatarCell({
  agent,
  className,
  fallback,
}: {
  agent: GroupAvatarAgent
  className?: string
  fallback?: string | null
}) {
  if (agent.avatar) {
    return (
      <img
        src={agent.avatar}
        alt=""
        className={cn('rounded-full object-cover', className)}
        decoding="async"
        draggable={false}
      />
    )
  }

  const label = (agent.name?.trim().slice(0, 1) || fallback?.trim().slice(0, 1) || '+').toUpperCase()
  return (
    <span
      className={cn(
        'grid place-items-center rounded-full font-semibold text-white',
        className,
      )}
      style={{ background: agent.color || '#111827' }}
    >
      {label}
    </span>
  )
}
