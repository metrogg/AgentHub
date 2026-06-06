import { describe, expect, test } from 'bun:test'

describe('mobile agent library runtimeType normalization', () => {
  test('coerces legacy AGENT_LIBRARY entries into code-agent workspace payloads', async () => {
    const { __mobileRoutesTestHooks } = await import('../apps/server/src/routes/mobile')

    const normalized = __mobileRoutesTestHooks.normalizeSavedAgent({
      id: 'orchestrator-team-builder',
      name: 'Orchestrator / Team Builder',
      role: '群聊总指挥',
      roleType: 'orchestrator',
      description: '',
      systemPrompt: '',
      roleProfile: {
        expertProfileId: 'orchestrator-team-builder',
        managerRuntimeType: 'openclaw',
      },
      color: '#7c3aed',
      modelId: 'ccswitch-Xiaomi MiMo',
      runtimeType: 'llm',
      codeAgentType: 'openclaw',
      capabilityTags: ['orchestrate'],
      skillIds: ['zoom-out'],
      toolPermissions: ['chat', 'workspace:read'],
      sandboxPolicy: 'workspace-write',
      contextPolicy: 'workspace-aware',
      autoInvoke: true,
      approvalRequired: true,
    })

    expect(normalized?.runtimeType).toBe('code-agent')
    expect(normalized?.codeAgentType).toBe('codex')

    const workspaceValues = __mobileRoutesTestHooks.savedAgentWorkspaceValues(normalized!)
    expect(workspaceValues.runtimeType).toBe('code-agent')
    expect(workspaceValues.codeAgentType).toBe('codex')
    expect(workspaceValues.approvalRequired).toBe(false)
  })
})
