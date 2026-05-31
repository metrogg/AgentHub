import { describe, expect, test } from 'bun:test'
import type { AgentOutputChunk, AgentProfile, AgentRuntime } from '../apps/server/src/services/runtime/agent-runtime'
import { RuntimeRegistry } from '../apps/server/src/services/runtime/runtime-registry'

function registry() {
  return new RuntimeRegistry()
    .register(fakeRuntime('llm'))
    .register(fakeRuntime('code-agent'))
}

function fakeRuntime(runtimeType: string): AgentRuntime {
  return {
    runtimeType,
    displayName: runtimeType,
    async *execute(): AsyncGenerator<AgentOutputChunk> {},
  }
}

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'agent-1',
    name: 'Agent',
    runtimeType: 'llm',
    capabilityTags: [],
    toolPermissions: ['chat'],
    sandboxPolicy: 'read-only',
    contextPolicy: 'workspace-aware',
    approvalRequired: true,
    ...overrides,
  }
}

describe('runtimeRegistry.resolveForProfile', () => {
  test('keeps plain chat LLM agents on the streaming LLM runtime', () => {
    const runtime = registry().resolveForProfile(profile())
    expect(runtime.runtimeType).toBe('llm')
  })

  test('does not promote LLM agents to another runtime just because tools are readable', () => {
    const runtime = registry().resolveForProfile(
      profile({ toolPermissions: ['chat', 'workspace:read', 'skills:read'] }),
    )
    expect(runtime.runtimeType).toBe('llm')
  })

  test('does not steal code agents just because they can read the workspace', () => {
    const runtime = registry().resolveForProfile(
      profile({
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
        toolPermissions: ['chat', 'workspace:read', 'workspace:write'],
        sandboxPolicy: 'workspace-write',
      }),
    )
    expect(runtime.runtimeType).toBe('code-agent')
  })

  test('routes code agents through the coding agent runtime even if the CLI binding is incomplete', () => {
    const runtime = registry().resolveForProfile(
      profile({
        runtimeType: 'code-agent',
        codeAgentType: undefined,
      }),
    )
    expect(runtime.runtimeType).toBe('code-agent')
  })
})
