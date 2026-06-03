import { describe, expect, test } from 'bun:test'
import { __orchestratorDecisionTestHooks } from '../apps/server/src/services/orchestrator/orchestrator-decision'
import { selectAgentForTask } from '../apps/server/src/services/orchestrator/agent-router'
import type { ExecutionAgent } from '../apps/server/src/services/orchestrator/types'
import { __messageRouteTestHooks } from '../apps/server/src/routes/messages'

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

  test('does not use keyword heuristics when code-agent output is not parseable', () => {
    const decision = __orchestratorDecisionTestHooks.buildHeuristicDecision(
      '帮我生成一个中文 HTML 页面，展示这些项目数据',
      3,
    )

    expect(decision).toBeNull()
  })

  test('directs explicit replies to an active worker message before orchestrator routing', () => {
    const target = __messageRouteTestHooks.chooseDirectWorkerReplyTarget({
      sourceMessage: {
        id: 'msg-1',
        sessionId: 'group-1',
        senderId: 'user-1',
        senderType: 'user',
        type: 'text',
        content: '现在进展怎么样了？',
        metadata: null,
        replyToMessageId: 'worker-msg-1',
        createdAt: new Date(),
      },
      repliedToMessage: {
        id: 'worker-msg-1',
        sessionId: 'group-1',
        senderId: 'researcher',
        senderType: 'agent',
        type: 'text',
        content: '开始执行「Research market」。',
        metadata: {
          kind: 'worker-task-started',
          orchestratorTaskId: 'task-1',
          agentName: 'Researcher',
        },
        createdAt: new Date(),
      },
      agentRows: agents as any,
      activeTaskContext: [
        {
          taskId: 'task-1',
          taskTitle: 'Research market',
          taskStatus: 'running',
          taskThreadStatus: 'active',
          agentId: 'researcher',
          agentName: 'Researcher',
          progressStatus: '正在整理资料',
        },
      ],
    })

    expect(target?.id).toBe('researcher')
  })

  test('keeps ordinary in-flight room messages in the run context instead of guessing a worker target', () => {
    const target = __messageRouteTestHooks.chooseDirectWorkerReplyTarget({
      sourceMessage: {
        id: 'msg-1',
        sessionId: 'group-1',
        senderId: 'user-1',
        senderType: 'user',
        type: 'text',
        content: '补充一下：首页要优先保证首屏加载速度。',
        metadata: null,
        createdAt: new Date(),
      },
      agentRows: agents as any,
      activeTaskContext: [
        {
          taskId: 'task-1',
          taskTitle: 'Research market',
          taskStatus: 'running',
          taskThreadStatus: 'active',
          agentId: 'researcher',
          agentName: 'Researcher',
          progressStatus: '正在整理资料',
        },
      ],
    })

    expect(target).toBeNull()
  })

  test('does not bypass orchestrator when the user explicitly mentions someone', () => {
    const target = __messageRouteTestHooks.chooseDirectWorkerReplyTarget({
      sourceMessage: {
        id: 'msg-2',
        sessionId: 'group-1',
        senderId: 'user-1',
        senderType: 'user',
        type: 'text',
        content: '@Builder 你来回答一下',
        metadata: { mentions: ['builder'] },
        createdAt: new Date(),
      },
      agentRows: agents as any,
      activeTaskContext: [
        {
          taskId: 'task-1',
          taskTitle: 'Research market',
          taskStatus: 'running',
          taskThreadStatus: 'active',
          agentId: 'researcher',
          agentName: 'Researcher',
        },
      ],
    })

    expect(target).toBeNull()
  })
})
