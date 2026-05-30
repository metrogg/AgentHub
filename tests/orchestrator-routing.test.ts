import { describe, expect, test } from 'bun:test'
import { intentRouter } from '../apps/server/src/services/orchestrator/intent-router'
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
  test('routes artifact-producing group requests to orchestration', () => {
    const samples = [
      '帮我开发一个深圳技术大学的学校官网',
      '对目前全球AI主流编程工具进行调研分析，并输出一份PDF文档和一个HTML网页',
      '写个介绍深圳技术大学的网站',
      '开发一个坦克大战',
      '做个俄罗斯方块',
    ]

    for (const content of samples) {
      expect(intentRouter.route({ content, hasOrchestrator: true, mentionCount: 0 }).decision).toBe(
        'OrchestratorPlan',
      )
    }
  })

  test('keeps casual group chat on the conversation loop', () => {
    expect(intentRouter.route({ content: '你好，在吗', hasOrchestrator: true, mentionCount: 0 }).decision).toBe(
      'ConversationLoop',
    )
  })

  test('does not assign execution tasks to orchestrator', () => {
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

    expect(selection.selectedAgentKey).toBe('builder')
  })

  test('does not assign synthesis tasks to orchestrator either', () => {
    const selection = selectAgentForTask({
      task: {
        id: 'task-synthesize',
        title: '汇总交付结果',
        description: '整合各 Agent 的产出并给出最终交付说明',
        agentId: 'orchestrator',
        taskType: 'synthesize',
        dependencies: [],
        maxRetries: 1,
      },
      agents,
    })

    expect(selection.selectedAgentKey).not.toBe('orchestrator')
  })
})
