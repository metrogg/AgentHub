import { describe, expect, test } from 'bun:test'
import { resolveAgentAvatarSrc, resolveAgentColor, resolveAgentInitial } from '../apps/web/src/lib/agentVisuals'

describe('agent visuals', () => {
  test('returns the configured avatar as-is', () => {
    expect(resolveAgentAvatarSrc({ roleType: 'coder', avatar: '/avatars/my.png' })).toBe(
      '/avatars/my.png',
    )
    expect(resolveAgentAvatarSrc({ roleType: 'orchestrator' })).toBe(null)
    expect(resolveAgentAvatarSrc({ roleType: 'researcher', avatar: '' })).toBe(null)
  })

  test('resolves agent initials from name', () => {
    expect(resolveAgentInitial({ name: 'Orchestrator' })).toBe('O')
    expect(resolveAgentInitial({ name: '' })).toBe('+')
    expect(resolveAgentInitial({ name: '' }, 'D')).toBe('D')
  })

  test('replaces neutral fallback colors with preset colors', () => {
    expect(resolveAgentColor({ roleType: 'reviewer', color: '#111827' })).toBe('#ef4444')
  })
})
