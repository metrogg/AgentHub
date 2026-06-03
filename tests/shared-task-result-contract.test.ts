import { describe, expect, test } from 'bun:test'
import {
  mapSharedTaskResultStatus,
  sharedTaskResultDeliverablesToArtifacts,
} from '../apps/server/src/services/orchestrator/shared-task-directory'

describe('shared task result contract consumption', () => {
  test('turns shared-task success deliverables into task result artifacts', () => {
    const artifacts = sharedTaskResultDeliverablesToArtifacts({
      taskId: 'task-1',
      deliverables: ['.agenthub/shared/tasks/task-1/artifacts/report.html'],
      sharedTaskRelativeRoot: '.agenthub/shared/tasks/task-1',
    })

    expect(artifacts).toEqual([
      expect.objectContaining({
        title: 'report.html',
        kind: 'file',
        path: '.agenthub/shared/tasks/task-1/artifacts/report.html',
        source: 'shared-task-result',
      }),
    ])
  })

  test('maps rework, blocked, and interrupted statuses to real task states', () => {
    expect(mapSharedTaskResultStatus('SUCCESS')).toBe('done')
    expect(mapSharedTaskResultStatus('SUCCESS_WITH_NOTES')).toBe('done')
    expect(mapSharedTaskResultStatus('REVISION_NEEDED')).toBe('failed')
    expect(mapSharedTaskResultStatus('BLOCKED')).toBe('blocked')
    expect(mapSharedTaskResultStatus('INTERRUPTED')).toBe('cancelled')
  })
})
