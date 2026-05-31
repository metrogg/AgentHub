import { describe, expect, test } from 'bun:test'
import type { AgentOutputChunk, AgentProfile, AgentRuntime } from '../apps/server/src/services/runtime/agent-runtime'
import { RuntimeRegistry } from '../apps/server/src/services/runtime/runtime-registry'

function registry() {
  return new RuntimeRegistry()
    .register(fakeRuntime('llm'))
    .register(fakeRuntime('mcp'))
    .register(fakeRuntime('code-agent'))
    .register(fakeRuntime('a2a'))
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

  test('routes LLM agents with native read permissions through the agent loop runtime', () => {
    const runtime = registry().resolveForProfile(
      profile({ toolPermissions: ['chat', 'workspace:read', 'skills:read'] }),
    )
    expect(runtime.runtimeType).toBe('mcp')
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

  test('routes A2A agents to the A2A runtime instead of falling back to LLM', () => {
    const runtime = registry().resolveForProfile(
      profile({
        runtimeType: 'a2a',
        a2aEndpoint: 'http://localhost:8000/api/protocols/a2a/agent',
      }),
    )
    expect(runtime.runtimeType).toBe('a2a')
  })
})
