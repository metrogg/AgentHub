import { describe, expect, test } from 'bun:test'
import { decideOrchestratorAction } from '../apps/server/src/services/orchestrator/orchestrator-decision'
import { runtimeRegistry, type AgentOutputChunk, type AgentRuntime, type ExecutionContext } from '../apps/server/src/services/runtime'
import { CodeAgentRuntime } from '../apps/server/src/services/runtime/code-agent-runtime'

describe('orchestrator decision', () => {
  test('asks code-agent runtime for raw final output and surfaces unparsable output', async () => {
    const rawFlags: Array<boolean | undefined> = []
    runtimeRegistry.register({
      runtimeType: 'code-agent',
      displayName: 'Mock Code Agent',
      async *execute(ctx: ExecutionContext): AsyncGenerator<AgentOutputChunk> {
        rawFlags.push(ctx.rawFinalOutput)
        yield { kind: 'text', text: 'Coding Tools 已执行完成。没有检测到最终正文。' }
      },
    } satisfies AgentRuntime)

    try {
      await expect(
        decideOrchestratorAction({
          content: '做一个官网',
          agents: [
            {
              id: 'orchestrator',
              key: 'orchestrator',
              name: 'Orchestrator',
              role: '总指挥',
              roleType: 'orchestrator',
              runtimeType: 'code-agent',
              codeAgentType: 'opencode',
              capabilityTags: [],
              toolPermissions: [],
              sandboxPolicy: 'read-only',
            },
            {
              id: 'builder',
              key: 'builder',
              name: 'Builder',
              role: '工程实现',
              roleType: 'coder',
              runtimeType: 'code-agent',
              codeAgentType: 'opencode',
              capabilityTags: [],
              toolPermissions: [],
              sandboxPolicy: 'workspace-write',
            },
          ],
        }),
      ).rejects.toThrow('原始输出片段：Coding Tools 已执行完成')
      expect(rawFlags).toEqual([true])
    } finally {
      runtimeRegistry.register(new CodeAgentRuntime())
    }
  })
})
