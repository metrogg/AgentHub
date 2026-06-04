import { describe, expect, test } from 'bun:test'
import { SessionType, type Session } from '../apps/web/src/lib/api'
import {
  buildSessionTree,
  classifyAgentSession,
  isAgentDirectSession,
  isOrchestratorTaskSession,
  isStableOrchestratorTaskSession,
} from '../apps/web/src/lib/sessionTree'

function session(partial: Partial<Session> & Pick<Session, 'id' | 'title' | 'type'>): Session {
  return {
    ownerId: 'user-1',
    workspaceId: null,
    workspaceAgentId: null,
    metadata: null,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    ...partial,
  }
}

describe('session tree', () => {
  test('treats prepared orchestrator task sessions as stable before agent assignment', () => {
    const preparedThread = session({
      id: 'thread-session-1',
      title: 'Research group / Market task',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: null,
      metadata: {
        kind: 'orchestrator-task',
        groupSessionId: 'group-1',
        orchestratorRunId: 'run-1',
        orchestratorTaskId: 'task-1',
        taskThreadId: 'thread-1',
        taskThreadStatus: 'prepared',
      },
    })

    expect(isStableOrchestratorTaskSession(preparedThread)).toBe(true)
    expect(isOrchestratorTaskSession(preparedThread)).toBe(true)
    expect(classifyAgentSession(preparedThread)).toBe('orchestrator-task')
  })

  test('classifies saved agent direct sessions as top-level private agent chats', () => {
    const direct = session({
      id: 'agent-direct-1',
      title: 'Frontend Expert',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
      metadata: {
        kind: 'agent-direct',
        savedAgentId: 'saved-agent-1',
      },
    })

    expect(isAgentDirectSession(direct)).toBe(true)
    expect(classifyAgentSession(direct)).toBe('agent-direct')
  })

  test('shows prepared orchestrator task threads under their group without requiring an agent id', () => {
    const group = session({
      id: 'group-1',
      title: 'Research group',
      type: SessionType.Group,
      workspaceId: 'workspace-1',
    })
    const preparedThread = session({
      id: 'thread-session-1',
      title: 'Research group / Market task',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: null,
      metadata: {
        kind: 'orchestrator-task',
        groupSessionId: 'group-1',
        orchestratorRunId: 'run-1',
        orchestratorTaskId: 'task-1',
        taskThreadId: 'thread-1',
        taskThreadStatus: 'prepared',
      },
    })
    const incompleteLegacyThread = session({
      id: 'legacy-thread-session',
      title: 'Legacy task',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: null,
      metadata: {
        kind: 'orchestrator-task',
        orchestratorRunId: 'run-1',
        orchestratorTaskId: 'task-legacy',
      },
    })

    const tree = buildSessionTree([group, preparedThread, incompleteLegacyThread])

    expect(tree).toHaveLength(1)
    expect(tree[0]?.parent.id).toBe('group-1')
    expect(tree[0]?.children.map((child) => child.id)).toEqual(['thread-session-1'])
  })

  test('does not attach a task thread to another group in the same workspace', () => {
    const groupA = session({
      id: 'group-a',
      title: 'Group A',
      type: SessionType.Group,
      workspaceId: 'workspace-1',
      updatedAt: '2026-06-03T00:00:02.000Z',
    })
    const groupB = session({
      id: 'group-b',
      title: 'Group B',
      type: SessionType.Group,
      workspaceId: 'workspace-1',
      updatedAt: '2026-06-03T00:00:01.000Z',
    })
    const taskThread = session({
      id: 'thread-session-1',
      title: 'Group B / Task',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
      metadata: {
        kind: 'orchestrator-task',
        groupSessionId: 'group-b',
        orchestratorRunId: 'run-1',
        orchestratorTaskId: 'task-1',
        taskThreadId: 'thread-1',
      },
    })

    const tree = buildSessionTree([groupA, groupB, taskThread])
    const byParentId = new Map(tree.map((group) => [group.parent.id, group.children]))

    expect(byParentId.get('group-a')?.map((child) => child.id)).toEqual([])
    expect(byParentId.get('group-b')?.map((child) => child.id)).toEqual(['thread-session-1'])
  })

  test('keeps metadata.kind boundaries between groups, agent direct chats and task children', () => {
    const group = session({
      id: 'group-1',
      title: 'Product launch',
      type: SessionType.Group,
      workspaceId: 'workspace-1',
      updatedAt: '2026-06-03T00:00:03.000Z',
    })
    const agentDirect = session({
      id: 'agent-direct-1',
      title: 'Frontend Expert',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
      metadata: {
        kind: 'agent-direct',
        savedAgentId: 'saved-agent-1',
      },
      updatedAt: '2026-06-03T00:00:02.000Z',
    })
    const taskChild = session({
      id: 'task-child-1',
      title: 'Product launch / Build landing page',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
      metadata: {
        kind: 'orchestrator-task',
        groupSessionId: 'group-1',
        orchestratorRunId: 'run-1',
        orchestratorTaskId: 'task-1',
        taskThreadId: 'thread-1',
      },
      updatedAt: '2026-06-03T00:00:01.000Z',
    })
    const legacyWorkspaceDirect = session({
      id: 'legacy-workspace-direct',
      title: 'Old workspace child',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
      metadata: {
        kind: 'workspace-agent-child',
      },
    })
    const incompleteTask = session({
      id: 'incomplete-task',
      title: 'Incomplete task',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
      metadata: {
        kind: 'orchestrator-task',
        groupSessionId: 'group-1',
        orchestratorRunId: 'run-1',
      },
    })

    const tree = buildSessionTree([legacyWorkspaceDirect, incompleteTask, taskChild, agentDirect, group])

    expect(tree.map((item) => item.parent.id)).toEqual(['group-1', 'agent-direct-1'])
    expect(tree.find((item) => item.parent.id === 'group-1')?.children.map((child) => child.id)).toEqual([
      'task-child-1',
    ])
    expect(tree.find((item) => item.parent.id === 'agent-direct-1')?.children).toEqual([])
    expect(tree.some((item) => item.parent.id === 'legacy-workspace-direct')).toBe(false)
    expect(tree.some((item) => item.parent.id === 'incomplete-task')).toBe(false)
  })
})
