import { describe, expect, test } from 'bun:test'
import { selectAgentForTask } from '../apps/server/src/services/orchestrator/agent-router'
import type { ExecutionAgent } from '../apps/server/src/services/orchestrator/types'

const agents: ExecutionAgent[] = [
  {
    id: 'orchestrator',
    key: 'orchestrator',
    name: 'Orchestrator',
    role: '总指挥',
    roleType: 'orchestrator',
    runtimeType: 'llm',
    capabilityTags: ['orchestrate', 'synthesize'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
  },
  {
    id: 'researcher',
    key: 'researcher',
    name: 'Researcher',
    role: '资料与素材研究',
    roleType: 'researcher',
    runtimeType: 'code-agent',
    capabilityTags: ['research', 'sources'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
  },
  {
    id: 'designer',
    key: 'designer',
    name: 'Designer',
    role: '产品与视觉设计',
    roleType: 'architect',
    runtimeType: 'code-agent',
    capabilityTags: ['design', 'ux'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
  },
  {
    id: 'builder',
    key: 'builder',
    name: 'Builder',
    role: '工程实现',
    roleType: 'coder',
    runtimeType: 'code-agent',
    capabilityTags: ['code', 'implementation', 'workspace-write'],
    toolPermissions: ['chat', 'workspace:read', 'workspace:write'],
    sandboxPolicy: 'workspace-write',
  },
]

describe('orchestrator routing', () => {
  test('preserves explicit Orchestrator assignment instead of keyword rerouting', () => {
    const selection = selectAgentForTask({
      task: {
        id: 'task-build',
        title: '实现官网页面',
        description: '创建 index.html、css/style.css 和 js/main.js',
        agentId: 'orchestrator',
        taskType: 'code',
        dependencies: [],
        maxRetries: 2,
      },
      agents,
    })

    expect(selection.selectedAgentKey).toBe('orchestrator')
    expect(selection.rationale).toContain('Using Orchestrator-provided assignment')
  })

  test('returns empty selection when the planned agent does not exist', () => {
    const selection = selectAgentForTask({
      task: {
        id: 'task-synthesize',
        title: '汇总交付结果',
        description: '整合各 Agent 的产出并给出最终交付说明',
        agentId: 'missing-agent',
        taskType: 'synthesize',
        dependencies: [],
        maxRetries: 1,
      },
      agents,
    })

    expect(selection.selectedAgentKey).toBe('')
    expect(selection.score).toBe(0)
  })
})
