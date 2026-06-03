import { describe, expect, test } from 'bun:test'
import { SessionType, type Session } from '../apps/web/src/lib/api'
import { buildSessionTree } from '../apps/web/src/lib/sessionTree'

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
})
