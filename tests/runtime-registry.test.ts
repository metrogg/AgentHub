import { describe, expect, test } from 'bun:test'
import type { AgentOutputChunk, AgentProfile, AgentRuntime } from '../apps/server/src/services/runtime/agent-runtime'
import { RuntimeRegistry } from '../apps/server/src/services/runtime/runtime-registry'

function registry() {
  return new RuntimeRegistry().register(fakeRuntime('code-agent'))
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
    runtimeType: 'code-agent',
    codeAgentType: 'codex',
    capabilityTags: [],
    toolPermissions: ['chat'],
    sandboxPolicy: 'workspace-write',
    contextPolicy: 'workspace-aware',
    approvalRequired: true,
    ...overrides,
  }
}

describe('runtimeRegistry.resolveForProfile (code-agent only)', () => {
  test('routes code-agent profiles through the code-agent runtime', () => {
    const runtime = registry().resolveForProfile(profile())
    expect(runtime.runtimeType).toBe('code-agent')
  })

  test('routes code-agent profiles even when CLI binding is incomplete', () => {
    const runtime = registry().resolveForProfile(profile({ codeAgentType: undefined }))
    expect(runtime.runtimeType).toBe('code-agent')
  })

  test('throws when profile is missing (LLM fallback is no longer allowed)', () => {
    expect(() => registry().resolveForProfile(undefined)).toThrow(/profile is required/)
  })

  test('throws when profile.runtimeType is not code-agent', () => {
    // Force-cast to bypass the type guard; we want to assert the runtime check
    // rejects the legacy `llm` runtimeType at the registry boundary.
    const llmProfile = { ...profile(), runtimeType: 'llm' as unknown as 'code-agent' }
    expect(() => registry().resolveForProfile(llmProfile)).toThrow(
      /AgentHub 不再支持 runtimeType=llm/,
    )
  })
})
