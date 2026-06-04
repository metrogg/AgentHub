import { describe, expect, test } from 'bun:test'

describe('OpenClaw agent catalog', () => {
  test('normalizes local OpenClaw agents into AgentHub code-agent drafts', async () => {
    const { __openClawAgentsTestHooks } = await import(
      '../apps/server/src/services/openclaw-agents'
    )

    const [agent] = __openClawAgentsTestHooks.normalizeOpenClawAgents([
      {
        id: 'main',
        workspace: 'C:\\Users\\Mozero\\.openclaw\\workspace',
        agentDir: 'C:\\Users\\Mozero\\.openclaw\\agents\\main\\agent',
        bindings: 0,
        isDefault: true,
        routes: ['default (no explicit rules)'],
      },
      {
        id: 'MAIN',
        workspace: 'duplicate',
      },
    ])

    expect(agent?.id).toBe('main')
    expect(agent?.agentHubDraft.runtimeType).toBe('code-agent')
    expect(agent?.agentHubDraft.codeAgentType).toBe('openclaw')
    expect(agent?.agentHubDraft.modelId).toBeNull()
    expect(agent?.agentHubDraft.roleProfile.source).toBe('openclaw')
    expect(agent?.agentHubDraft.roleProfile.openclawAgentId).toBe('main')
    expect(agent?.agentHubDraft.roleProfile.openclawDefault).toBe(true)

    const normalized = __openClawAgentsTestHooks.normalizeOpenClawAgents([
      { id: 'main' },
      { id: 'MAIN' },
      { id: 'ops' },
    ])
    expect(normalized.map((item) => item.id)).toEqual(['main', 'ops'])
  })

  test('parses OpenClaw JSON output even when stderr warnings are appended to diagnostics', async () => {
    const { __openClawAgentsTestHooks } = await import(
      '../apps/server/src/services/openclaw-agents'
    )

    const output = [
      JSON.stringify([{ id: 'main', identityName: 'ClawX', isDefault: true }], null, 2),
      '[state-migrations] Legacy state migration warnings:',
      "- Failed archiving task registry sidecar C:\\Users\\Mozero\\.openclaw\\tasks\\runs.sqlite",
    ].join('\n')

    const parsed = __openClawAgentsTestHooks.parseOpenClawJsonOutput(output)
    const [agent] = __openClawAgentsTestHooks.normalizeOpenClawAgents(parsed)

    expect(agent?.id).toBe('main')
    expect(agent?.name).toBe('ClawX')
    expect(agent?.agentHubDraft.roleProfile.openclawIdentityName).toBe('ClawX')
  })
})
