import { describe, expect, test } from 'bun:test'
import {
  applyTaskBoardSnapshotStatuses,
  isTerminalTaskBoardSnapshotStatus,
  normalizeTaskBoardRunStatus,
  normalizeTaskBoardTaskStatus,
  normalizeTaskBoardTaskStatusFromTaskThread,
} from '../apps/server/src/services/orchestrator/task-board-status'

describe('task board status projections', () => {
  test('normalizes task statuses already in TaskBoard vocabulary', () => {
    expect(normalizeTaskBoardTaskStatus('pending')).toBe('pending')
    expect(normalizeTaskBoardTaskStatus('assigned')).toBe('assigned')
    expect(normalizeTaskBoardTaskStatus('running')).toBe('running')
    expect(normalizeTaskBoardTaskStatus('done')).toBe('done')
    expect(normalizeTaskBoardTaskStatus('failed')).toBe('failed')
    expect(normalizeTaskBoardTaskStatus('blocked')).toBe('blocked')
    expect(normalizeTaskBoardTaskStatus('cancelled')).toBe('cancelled')
    expect(normalizeTaskBoardTaskStatus('active')).toBeNull()
    expect(normalizeTaskBoardTaskStatus(null)).toBeNull()
  })

  test('normalizes task thread statuses into TaskBoard task statuses', () => {
    expect(normalizeTaskBoardTaskStatusFromTaskThread('prepared')).toBe('pending')
    expect(normalizeTaskBoardTaskStatusFromTaskThread('assigned')).toBe('assigned')
    expect(normalizeTaskBoardTaskStatusFromTaskThread('active')).toBe('running')
    expect(normalizeTaskBoardTaskStatusFromTaskThread('completed')).toBe('done')
    expect(normalizeTaskBoardTaskStatusFromTaskThread('failed')).toBe('failed')
    expect(normalizeTaskBoardTaskStatusFromTaskThread('cancelled')).toBe('cancelled')
    expect(normalizeTaskBoardTaskStatusFromTaskThread('blocked')).toBeNull()
    expect(normalizeTaskBoardTaskStatusFromTaskThread(null)).toBeNull()
  })

  test('normalizes run statuses into TaskBoard run statuses', () => {
    expect(normalizeTaskBoardRunStatus('planning')).toBe('planning')
    expect(normalizeTaskBoardRunStatus('running')).toBe('running')
    expect(normalizeTaskBoardRunStatus('synthesizing')).toBe('synthesizing')
    expect(normalizeTaskBoardRunStatus('completed')).toBe('completed')
    expect(normalizeTaskBoardRunStatus('failed')).toBe('failed')
    expect(normalizeTaskBoardRunStatus('cancelled')).toBe('cancelled')
    expect(normalizeTaskBoardRunStatus('paused')).toBeNull()
    expect(normalizeTaskBoardRunStatus(null)).toBeNull()
  })

  test('projects phase statuses from phase task membership', () => {
    const phases = [
      { id: 'empty', title: 'Empty', purpose: '', taskIds: [], status: 'active' as const },
      { id: 'pending', title: 'Pending', purpose: '', taskIds: ['pending-task'], status: 'active' as const },
      { id: 'active', title: 'Active', purpose: '', taskIds: ['pending-task', 'running-task'], status: 'pending' as const },
      { id: 'blocked', title: 'Blocked', purpose: '', taskIds: ['blocked-task'], status: 'pending' as const },
      { id: 'completed', title: 'Completed', purpose: '', taskIds: ['done-task', 'failed-task'], status: 'pending' as const },
      { id: 'missing', title: 'Missing', purpose: '', taskIds: ['unknown-task'], status: 'active' as const },
    ]
    const tasks = [
      { id: 'pending-task', status: 'pending' },
      { id: 'running-task', status: 'running' },
      { id: 'blocked-task', status: 'blocked' },
      { id: 'done-task', status: 'done' },
      { id: 'failed-task', status: 'failed' },
    ]

    expect(applyTaskBoardSnapshotStatuses(phases, tasks).map((phase) => [phase.id, phase.status])).toEqual([
      ['empty', 'pending'],
      ['pending', 'pending'],
      ['active', 'active'],
      ['blocked', 'active'],
      ['completed', 'completed'],
      ['missing', 'pending'],
    ])
  })

  test('detects terminal task board run statuses', () => {
    expect(isTerminalTaskBoardSnapshotStatus('completed')).toBe(true)
    expect(isTerminalTaskBoardSnapshotStatus('failed')).toBe(true)
    expect(isTerminalTaskBoardSnapshotStatus('cancelled')).toBe(true)
    expect(isTerminalTaskBoardSnapshotStatus('running')).toBe(false)
    expect(isTerminalTaskBoardSnapshotStatus(null)).toBe(false)
  })
})
