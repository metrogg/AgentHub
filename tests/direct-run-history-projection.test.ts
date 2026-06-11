import { describe, expect, test } from 'bun:test'
import { OrchestratorRunStatus } from '../packages/shared/src'
import {
  buildDirectRuntimeRunProjection,
  directRunArtifacts,
  directRunStatusFromMetadata,
  isDirectRuntimeTerminalEvent,
  normalizeDirectRunArtifact,
} from '../apps/server/src/services/orchestrator/direct-run-history-projection'

describe('direct run history projection', () => {
  test('detects direct runtime terminal timeline events', () => {
    expect(isDirectRuntimeTerminalEvent('worker.message', { kind: 'worker-runtime.completed' })).toBe(true)
    expect(isDirectRuntimeTerminalEvent('task.progress', { codeAgentRun: { status: 'timed-out' } })).toBe(true)
    expect(isDirectRuntimeTerminalEvent('task.progress', { kind: 'worker-runtime.progress' })).toBe(false)
    expect(isDirectRuntimeTerminalEvent('system', { kind: 'worker-runtime.completed' })).toBe(false)
  })

  test('maps direct runtime metadata into run status', () => {
    expect(directRunStatusFromMetadata({ kind: 'worker-runtime.completed' })).toBe(OrchestratorRunStatus.Completed)
    expect(directRunStatusFromMetadata({ codeAgentRun: { status: 'cancelled' } })).toBe(OrchestratorRunStatus.Cancelled)
    expect(directRunStatusFromMetadata({ codeAgentRun: { status: 'timed-out' } })).toBe(OrchestratorRunStatus.Failed)
    expect(directRunStatusFromMetadata({ codeAgentRun: { status: 'running' } })).toBe(OrchestratorRunStatus.Running)
  })

  test('projects code-agent artifacts and file changes with stable de-duping', () => {
    expect(directRunArtifacts({
      artifacts: [{ id: 'preview-1', kind: 'preview', title: 'Preview', url: 'file:///demo/index.html' }],
      files: [
        { path: 'index.html', status: 'created' },
        { path: 'index.html', status: 'modified' },
      ],
    })).toEqual([
      expect.objectContaining({
        id: 'preview-1',
        kind: 'preview',
        title: 'Preview',
        path: 'file:///demo/index.html',
      }),
      expect.objectContaining({
        id: 'code-agent-file:index.html',
        kind: 'file',
        path: 'index.html',
        status: 'created',
        source: 'codeAgentRun.files',
      }),
    ])
  })

  test('normalizes artifact records from direct code-agent metadata', () => {
    expect(normalizeDirectRunArtifact({
      artifactId: 'artifact-1',
      type: 'diff',
      relativePath: 'src/app.ts',
      summary: 'Changed app',
      size: 42,
    })).toMatchObject({
      id: 'artifact-1',
      kind: 'diff',
      title: 'app.ts',
      description: 'Changed app',
      path: 'src/app.ts',
      filePath: 'src/app.ts',
      size: 42,
    })
  })

  test('builds a direct runtime run projection consumable by run history', () => {
    const projection = buildDirectRuntimeRunProjection({
      eventId: 'event-1',
      eventType: 'worker.message',
      eventBody: '',
      eventMetadata: {
        kind: 'worker-runtime.completed',
        workspaceAgentId: 'agent-1',
        codeAgentRun: {
          status: 'completed',
          finalMessage: 'Done',
          files: [{ path: 'index.html', status: 'modified' }],
        },
      },
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
      roomId: 'room-1',
      roomTitle: 'Direct Builder',
      sessionId: 'session-1',
      sessionTitle: 'Direct Builder',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
      participantName: 'Participant Builder',
      participantWorkspaceAgentId: 'agent-from-participant',
      participantWorkerInstanceId: 'worker-1',
      workspaceAgentName: 'Builder',
    })

    expect(projection.runRow).toMatchObject({
      id: 'direct-runtime:event-1',
      status: OrchestratorRunStatus.Completed,
      groupSessionId: 'session-1',
      source: 'direct-runtime',
    })
    expect(projection.task).toMatchObject({
      id: 'direct-task:event-1',
      status: 'done',
      agentId: 'agent-1',
      title: 'Builder direct run',
      artifacts: [expect.objectContaining({ path: 'index.html' })],
    })
    expect(projection.runRow.plan.progressLedger).toMatchObject({
      status: OrchestratorRunStatus.Completed,
      completedTaskIds: ['direct-task:event-1'],
    })
  })
})
