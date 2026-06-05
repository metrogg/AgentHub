import { describe, expect, test } from 'bun:test'
import {
  normalizePlannerOutput,
  validateRealWorkerAssignments,
} from '../apps/server/src/services/orchestrator/plan-utils'
import type { CollaborationContract } from '../apps/server/src/services/orchestrator/collaboration-contract'
import type { ExecutionAgent } from '../apps/server/src/services/orchestrator/types'

const baseAgents: ExecutionAgent[] = [
  {
    id: 'orchestrator',
    key: 'orchestrator',
    name: 'Orchestrator',
    role: '协调者',
    roleType: 'orchestrator',
    runtimeType: 'code-agent',
    codeAgentType: 'opencode',
    capabilityTags: ['orchestrate'],
    toolPermissions: ['chat', 'workspace:read'],
    sandboxPolicy: 'read-only',
  },
  {
    id: 'researcher',
    key: 'researcher',
    name: 'Researcher',
    role: '研究员',
    roleType: 'researcher',
    runtimeType: 'code-agent',
    codeAgentType: 'opencode',
    capabilityTags: ['research'],
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
    codeAgentType: 'opencode',
    capabilityTags: ['code'],
    toolPermissions: ['chat', 'workspace:read', 'workspace:write'],
    sandboxPolicy: 'workspace-write',
  },
]

const deliveryContract: CollaborationContract = {
  id: 'delivery',
  name: '交付契约',
  scope: {
    description: '限制交付路径',
    allowedPaths: ['docs/**'],
    forbiddenPaths: ['.env'],
  },
  outputs: {
    requiredArtifacts: ['report.pdf'],
    requiredBlackboardWrites: [],
  },
  quality: {
    acceptanceCriteria: ['说明来源'],
  },
  capabilities: {
    preferredSkills: ['research'],
    requiredTools: ['workspace:read'],
    requiredMcpServers: [],
    rules: ['code-quality'],
  },
}

describe('planner normalization', () => {
  test('rejects executable tasks assigned to Orchestrator', () => {
    const result = normalizePlannerOutput('run-1', '调研并输出网页', {
      title: '调研并输出网页',
      tasks: [
        {
          id: 't1',
          title: '完成全部任务',
          description: '调研、实现和总结',
          agentKey: 'orchestrator',
          taskType: 'code',
          dependencies: [],
        },
      ],
    }, baseAgents)

    expect(result.plan).toBeNull()
    expect(result.error).toContain('Orchestrator')
  })

  test('rejects single-worker plans when multiple workers are available', () => {
    const result = normalizePlannerOutput('run-1', '调研并输出网页', {
      title: '调研并输出网页',
      tasks: [
        {
          id: 't1',
          title: '调研与实现',
          description: '由一个 Agent 完成所有工作',
          agentKey: 'builder',
          taskType: 'code',
          dependencies: [],
        },
      ],
    }, baseAgents)

    expect(result.plan).toBeNull()
    expect(result.error).toContain('At least two different worker agents')
  })

  test('accepts plans that use two real worker agents and remaps dependencies', () => {
    const result = normalizePlannerOutput('run-1', '调研并输出网页', {
      title: '调研并输出网页',
      phases: [
        { id: 'analysis', title: '分析', purpose: '资料研究', taskIds: ['research'] },
        { id: 'implementation', title: '实现', purpose: '生成网页', taskIds: ['build'] },
      ],
      tasks: [
        {
          id: 'research',
          title: '调研主流工具',
          description: '收集事实、链接和对比维度',
          agentKey: 'researcher',
          taskType: 'research',
          dependencies: [],
        },
        {
          id: 'build',
          title: '生成交付网页',
          description: '基于研究结果生成 HTML 产物',
          agentKey: 'builder',
          taskType: 'code',
          dependencies: ['research'],
        },
      ],
    }, baseAgents)

    expect(result.plan).not.toBeNull()
    expect(new Set(result.plan!.tasks.map((task) => task.agentId))).toEqual(
      new Set(['researcher', 'builder']),
    )
    expect(result.plan!.tasks[1]?.dependencies).toEqual([result.plan!.tasks[0]!.id])
    expect(result.plan!.phases?.flatMap((phase) => phase.taskIds).sort()).toEqual(
      result.plan!.tasks.map((task) => task.id).sort(),
    )
  })

  test('applies explicit contract defaults onto task output contracts', () => {
    const result = normalizePlannerOutput('run-1', '调研并输出网页', {
      title: '调研并输出网页',
      tasks: [
        {
          id: 'research',
          title: '调研主流工具',
          description: '收集事实、链接和对比维度',
          agentKey: 'researcher',
          taskType: 'research',
          dependencies: [],
          outputContract: {
            requiredBlackboardWrites: [],
            requiredArtifacts: ['report.pdf'],
            allowedPaths: [],
            acceptanceCriteria: [],
          },
        },
        {
          id: 'build',
          title: '生成交付网页',
          description: '基于研究结果生成 HTML 产物',
          agentKey: 'builder',
          taskType: 'code',
          dependencies: ['research'],
          outputContract: {
            requiredBlackboardWrites: [],
            requiredArtifacts: ['index.html'],
            allowedPaths: [],
            acceptanceCriteria: [],
          },
        },
      ],
    }, baseAgents, [deliveryContract])

    expect(result.plan).not.toBeNull()
    for (const task of result.plan!.tasks) {
      expect(task.outputContract?.allowedPaths).toContain('docs/**')
      expect(task.outputContract?.acceptanceCriteria).toContain('说明来源')
    }
  })
})

describe('real worker assignment validation', () => {
  test('allows one worker only when the team has one worker', () => {
    const error = validateRealWorkerAssignments({
      agents: baseAgents.filter((agent) => agent.id !== 'researcher'),
      tasks: [{ agentId: 'builder', title: '实现任务' }],
    })

    expect(error).toBeNull()
  })
})
