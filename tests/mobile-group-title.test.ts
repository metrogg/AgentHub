import { describe, expect, test } from 'bun:test'
import { defaultMobileGroupTitle } from '../apps/server/src/routes/mobile'

describe('mobile group title', () => {
  test('uses up to three agent names for default group titles', () => {
    expect(
      defaultMobileGroupTitle([
        { name: 'Orchestrator' } as any,
        { name: 'Researcher' } as any,
        { name: 'Builder' } as any,
      ]),
    ).toBe('Orchestrator、Researcher、Builder')
  })

  test('collapses longer agent lists into summary title', () => {
    expect(
      defaultMobileGroupTitle([
        { name: 'Orchestrator' } as any,
        { name: 'Researcher' } as any,
        { name: 'Builder' } as any,
        { name: 'Reviewer' } as any,
      ]),
    ).toBe('Orchestrator、Researcher、Builder 等 4 个 Agent')
  })

  test('falls back when the list is empty', () => {
    expect(defaultMobileGroupTitle([])).toBe('Agent 群聊')
  })
})
