import { describe, expect, test } from 'bun:test'
import {
  buildRuntimeActivitySnapshot,
  deriveRuntimeActivityFromAgUiEvents,
} from '../apps/server/src/services/orchestrator/runtime-activity-snapshot'

describe('runtime activity snapshot projection', () => {
  test('terminal task board status stops activity even when stale task data says running', () => {
    expect(buildRuntimeActivitySnapshot({
      taskBoardSnapshot: {
        sessionId: 'session-1',
        status: 'completed',
        tasks: [{ status: 'running', agentId: 'agent-1', agentName: 'Builder' }],
      },
    })).toEqual({
      agentTyping: false,
      agentActivity: null,
      source: 'task-board',
    })
  })

  test('running task board task projects executing activity', () => {
    expect(buildRuntimeActivitySnapshot({
      taskBoardSnapshot: {
        sessionId: 'session-1',
        status: 'running',
        tasks: [{ status: 'running', agentId: 'agent-1', agentName: 'Builder' }],
      },
    })).toEqual({
      agentTyping: true,
      agentActivity: {
        sessionId: 'session-1',
        agentId: 'agent-1',
        agentName: 'Builder',
        phase: 'executing',
        startedAt: null,
      },
      source: 'task-board',
    })
  })

  test('task board planning and synthesizing statuses project Orchestrator activity', () => {
    expect(buildRuntimeActivitySnapshot({
      taskBoardSnapshot: { sessionId: 'session-1', status: 'planning', tasks: [] },
    }).agentActivity).toMatchObject({
      sessionId: 'session-1',
      agentName: 'Orchestrator',
      phase: 'planning',
    })
    expect(buildRuntimeActivitySnapshot({
      taskBoardSnapshot: { sessionId: 'session-1', status: 'synthesizing', tasks: [] },
    }).agentActivity).toMatchObject({
      sessionId: 'session-1',
      agentName: 'Orchestrator',
      phase: 'synthesizing',
    })
  })

  test('AG-UI task status projects the latest assigned or running worker activity', () => {
    expect(deriveRuntimeActivityFromAgUiEvents([
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        value: {
          status: 'assigned',
          agentId: 'agent-1',
          agentName: 'Planner',
        },
      },
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        value: {
          status: 'running',
          agentId: 'agent-2',
          agentName: 'Builder',
        },
      },
    ], 'session-1')).toEqual({
      agentTyping: true,
      agentActivity: {
        sessionId: 'session-1',
        agentId: 'agent-2',
        agentName: 'Builder',
        phase: 'executing',
        startedAt: null,
      },
      source: 'ag-ui',
    })
  })

  test('AG-UI terminal events stop activity', () => {
    expect(deriveRuntimeActivityFromAgUiEvents([
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        value: { status: 'running', agentId: 'agent-1', agentName: 'Builder' },
      },
      { type: 'RUN_FINISHED' },
    ], 'session-1')).toEqual({
      agentTyping: false,
      agentActivity: null,
      source: 'ag-ui',
    })
  })
})
