import { describe, expect, test } from 'bun:test'
import { buildCapabilityCards } from '../apps/web/src/pages/AbilitiesPage'
import type { SkillSummary } from '../apps/web/src/lib/api'

function skill(input: Partial<SkillSummary> & Pick<SkillSummary, 'id' | 'name'>): SkillSummary {
  return {
    description: input.description ?? '',
    rootPath: input.rootPath ?? `F:/skills/${input.id}`,
    skillPath: input.skillPath ?? `F:/skills/${input.id}`,
    source: input.source ?? 'Agents 项目',
    ...input,
  }
}

describe('abilities page card projection', () => {
  test('dedupes skills from multiple local roots and keeps render keys unique', () => {
    const cards = buildCapabilityCards({
      adapters: [],
      agents: [],
      settingsInfo: null,
      skills: [
        skill({
          id: 'diagnose',
          name: 'diagnose',
          description: 'Diagnose bugs',
          source: 'Agents 项目',
        }),
        skill({
          id: 'diagnose',
          name: 'diagnose',
          description: 'Diagnose bugs',
          source: 'Claude 项目',
        }),
        skill({
          id: 'tdd',
          name: 'tdd',
          description: 'Test-driven development',
          source: 'Agents 项目',
        }),
      ],
    })

    const skillCards = cards.filter((card) => card.kind === 'skill')
    expect(skillCards.map((card) => card.id).sort()).toEqual(['diagnose', 'tdd'])
    expect(skillCards.find((card) => card.id === 'diagnose')?.source).toBe('Agents 项目 / Claude 项目')

    const keys = cards.map((card) => card.renderKey)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
