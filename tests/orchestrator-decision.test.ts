import { describe, expect, test } from 'bun:test'
import {
  decideOrchestratorAction,
  __orchestratorDecisionTestHooks,
} from '../apps/server/src/services/orchestrator/orchestrator-decision'
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

  test('prefers the only clarification-waiting worker as reply fallback target', () => {
    const target = __orchestratorDecisionTestHooks.chooseReplyTargetFromActiveContext({
      action: 'reply',
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
          sandboxPolicy: 'workspace-write',
        },
        {
          id: 'researcher',
          key: 'researcher',
          name: 'Researcher',
          role: '资料研究',
          roleType: 'researcher',
          runtimeType: 'code-agent',
          codeAgentType: 'opencode',
          capabilityTags: [],
          toolPermissions: [],
          sandboxPolicy: 'workspace-write',
        },
      ],
      activeTaskContext: [
        {
          taskId: 'task-1',
          taskTitle: 'Research market',
          taskStatus: 'blocked',
          taskThreadStatus: 'active',
          agentId: 'researcher',
          agentName: 'Researcher',
          awaitingClarification: true,
          progressStatus: '请确认市场范围',
        },
      ],
    })

    expect(target).toEqual({
      id: 'researcher',
      name: 'Researcher',
    })
  })

  test('does not force a fallback reply target when multiple workers are active', () => {
    const target = __orchestratorDecisionTestHooks.chooseReplyTargetFromActiveContext({
      action: 'reply',
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
          sandboxPolicy: 'workspace-write',
        },
        {
          id: 'researcher',
          key: 'researcher',
          name: 'Researcher',
          role: '资料研究',
          roleType: 'researcher',
          runtimeType: 'code-agent',
          codeAgentType: 'opencode',
          capabilityTags: [],
          toolPermissions: [],
          sandboxPolicy: 'workspace-write',
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
      activeTaskContext: [
        {
          taskId: 'task-1',
          taskTitle: 'Research market',
          taskStatus: 'running',
          taskThreadStatus: 'active',
          agentId: 'researcher',
          agentName: 'Researcher',
        },
        {
          taskId: 'task-2',
          taskTitle: 'Build page',
          taskStatus: 'running',
          taskThreadStatus: 'active',
          agentId: 'builder',
          agentName: 'Builder',
        },
      ],
    })

    expect(target).toBeNull()
  })
})
