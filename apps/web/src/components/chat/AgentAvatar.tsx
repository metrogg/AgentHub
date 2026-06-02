import type { CSSProperties } from 'react'
import {
  type AgentVisualInput,
  resolveAgentAvatarSrc,
  resolveAgentColor,
  resolveAgentInitial,
} from '../../lib/agentVisuals'
import { cn } from '../../lib/utils'

export function AgentAvatar({
  agent,
  alt,
  className,
  decorative = false,
  fallback,
  imageClassName,
  style,
  title,
  variant = 'role',
}: {
  agent: AgentVisualInput
  alt?: string
  className?: string
  decorative?: boolean
  fallback?: string | null
  imageClassName?: string
  style?: CSSProperties
  title?: string | null
  variant?: 'role' | 'soft'
}) {
  const avatar = resolveAgentAvatarSrc(agent)
  const color = resolveAgentColor(agent)
  const label = resolveAgentInitial(agent, fallback)
  const isSoft = variant === 'soft'

  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold',
        isSoft ? 'text-neutral-700 ring-1 ring-neutral-200/80' : 'text-white',
        className,
      )}
      style={{
        background: isSoft ? 'var(--agenthub-avatar-soft-bg, #f3f4f6)' : color,
        color: isSoft ? color : undefined,
        ...style,
      }}
      title={title ?? agent.name ?? undefined}
    >
      {avatar ? (
        <img
          src={avatar}
          alt={decorative ? '' : (alt ?? agent.name ?? '')}
          className={cn('h-full w-full', isSoft ? 'object-contain' : 'object-cover', imageClassName)}
          decoding="async"
          draggable={false}
        />
      ) : (
        label
      )}
    </span>
  )
}
