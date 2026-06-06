import { describe, expect, test } from 'bun:test'
import { createSavedAgent, toAgentConfigInput, type SavedAgentConfig } from '../apps/web/src/lib/agentLibrary'
import { presetForRole } from '../apps/web/src/lib/agentRolePresets'

describe('agent library runtimeType normalization', () => {
  test('coerces legacy llm runtimeType to code-agent when creating a saved agent', () => {
    const agent = createSavedAgent({
      name: 'Legacy',
      role: 'Clarifier',
      runtimeType: 'llm' as never,
    })

    expect(agent.runtimeType).toBe('code-agent')
  })

  test('coerces legacy llm runtimeType to code-agent when preparing workspace payloads', () => {
    const agent: SavedAgentConfig = {
      id: 'agent-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      name: 'Legacy',
      role: 'Clarifier',
      roleType: 'clarifier',
      description: '',
      avatar: null,
      systemPrompt: '',
      roleProfile: null,
      color: '#111827',
      modelId: null,
      runtimeType: 'llm' as never,
      codeAgentType: null,
      capabilityTags: [],
      skillIds: [],
      toolPermissions: ['chat'],
      sandboxPolicy: 'workspace-write',
      contextPolicy: 'workspace-aware',
      autoInvoke: true,
      approvalRequired: true,
    }

    expect(toAgentConfigInput(agent).runtimeType).toBe('code-agent')
  })

  test('role presets no longer expose llm', () => {
    expect(presetForRole('clarifier')?.runtimeType).toBe('code-agent')
  })

  test('coerces OpenClaw catalog agents to a supported workspace CLI type when creating a saved agent', () => {
    const agent = createSavedAgent({
      name: 'OpenClaw Imported',
      role: 'Local OpenClaw identity',
      runtimeType: 'code-agent',
      codeAgentType: 'openclaw' as never,
      roleProfile: { source: 'openclaw', openclawAgentId: 'main' },
    })

    expect(agent.runtimeType).toBe('code-agent')
    expect(agent.codeAgentType).toBe('codex')
    expect(agent.roleProfile?.source).toBe('openclaw')
    expect(agent.roleProfile?.openclawAgentId).toBe('main')
  })

  test('coerces saved OpenClaw agents before preparing workspace payloads', () => {
    const agent: SavedAgentConfig = {
      id: 'openclaw-main',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      name: 'OpenClaw Main',
      role: 'Local OpenClaw identity',
      roleType: 'custom',
      description: '',
      avatar: null,
      systemPrompt: '',
      roleProfile: { source: 'openclaw', openclawAgentId: 'main' },
      color: '#111827',
      modelId: null,
      runtimeType: 'code-agent',
      codeAgentType: 'openclaw' as never,
      capabilityTags: [],
      skillIds: [],
      toolPermissions: ['chat'],
      sandboxPolicy: 'workspace-write',
      contextPolicy: 'workspace-aware',
      autoInvoke: true,
      approvalRequired: false,
    }

    const payload = toAgentConfigInput(agent)

    expect(payload.codeAgentType).toBe('codex')
    expect(payload.roleProfile?.source).toBe('openclaw')
    expect(payload.roleProfile?.openclawAgentId).toBe('main')
  })
})
