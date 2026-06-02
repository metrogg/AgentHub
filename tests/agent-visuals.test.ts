import { describe, expect, test } from 'bun:test'
import {
  defaultAgentAvatarPath,
  resolveAgentAvatarSrc,
  resolveAgentColor,
} from '../apps/web/src/lib/agentVisuals'

describe('agent visuals', () => {
  test('maps known role presets to bundled avatar assets', () => {
    expect(defaultAgentAvatarPath({ roleType: 'orchestrator' })).toBe(
      '/avatars/orchestrator_avatar.png',
    )
    expect(defaultAgentAvatarPath({ roleType: 'architect' })).toBe(
      '/avatars/designer_avatar.png',
    )
    expect(defaultAgentAvatarPath({ roleType: 'researcher' })).toBe(
      '/avatars/researcher_avatar.png',
    )
    expect(defaultAgentAvatarPath({ roleType: 'coder' })).toBe('/avatars/builder_avatar.png')
    expect(defaultAgentAvatarPath({ roleType: 'reviewer' })).toBe(
      '/avatars/qa_reviewer_avatar.png',
    )
  })

  test('switches to white avatar assets in dark theme', () => {
    expect(resolveAgentAvatarSrc({ roleType: 'orchestrator' }, 'dark')).toBe(
      '/avatars/orchestrator_avatar_white.png',
    )
    expect(resolveAgentAvatarSrc({ roleType: 'coder' }, 'dark')).toBe(
      '/avatars/builder_avatar_white.png',
    )
  })

  test('replaces neutral fallback colors with preset colors', () => {
    expect(resolveAgentColor({ roleType: 'reviewer', color: '#111827' })).toBe('#ef4444')
  })
})
