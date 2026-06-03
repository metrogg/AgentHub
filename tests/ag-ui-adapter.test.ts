import { describe, expect, test } from 'bun:test'
import { buildAgUiEventsFromRunEvent } from '../apps/server/src/services/protocols/ag-ui-adapter'

describe('ag-ui adapter', () => {
  test('maps task.progress to agenthub.task.status', () => {
    const events = buildAgUiEventsFromRunEvent({
      runId: 'run-1',
      groupSessionId: 'group-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      type: 'task.progress',
      payload: {
        taskTitle: '研究资料',
        agentName: 'Researcher',
        percent: 66,
        status: '收集资料中',
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('CUSTOM')
    const event = events[0] as { name?: string; value?: Record<string, unknown> }
    expect(event.name).toBe('agenthub.task.status')
    expect(event.value?.progressPercent).toBe(66)
    expect(event.value?.status).toBe('running')
  })

  test('maps thread.prepared to task status with stable task thread projection ids', () => {
    const events = buildAgUiEventsFromRunEvent({
      runId: 'run-1',
      groupSessionId: 'group-1',
      taskId: 'task-1',
      threadId: 'thread-1',
      type: 'thread.prepared',
      payload: {
        taskId: 'task-1',
        taskTitle: 'Market research',
        taskThreadId: 'thread-1',
        sessionId: 'session-1',
        childSessionId: 'session-1',
        groupSessionId: 'group-1',
        status: 'prepared',
      },
    })

    expect(events).toHaveLength(1)
    const event = events[0] as { name?: string; value?: Record<string, unknown> }
    expect(event.name).toBe('agenthub.task.status')
    expect(event.value?.status).toBe('pending')
    expect(event.value?.taskThreadStatus).toBe('prepared')
    expect(event.value?.taskThreadId).toBe('thread-1')
    expect(event.value?.childSessionId).toBe('session-1')
    expect(event.value?.threadId).toBe('group-1')
  })

  test('maps task.started to task status with active task thread semantics', () => {
    const events = buildAgUiEventsFromRunEvent({
      runId: 'run-1',
      groupSessionId: 'group-1',
      taskId: 'task-1',
      threadId: 'thread-1',
      workerInstanceId: 'worker-1',
      agentId: 'agent-1',
      type: 'task.started',
      payload: {
        taskId: 'task-1',
        taskTitle: 'Implement page',
        taskThreadId: 'thread-1',
        childSessionId: 'session-1',
        agentName: 'Builder',
      },
    })

    expect(events).toHaveLength(2)
    const event = events[1] as { name?: string; value?: Record<string, unknown> }
    expect(event.name).toBe('agenthub.task.status')
    expect(event.value).toMatchObject({
      status: 'running',
      taskThreadStatus: 'active',
      taskThreadId: 'thread-1',
      childSessionId: 'session-1',
      workerInstanceId: 'worker-1',
    })
  })

  test('maps task.clarification_needed to clarification event', () => {
    const events = buildAgUiEventsFromRunEvent({
      runId: 'run-1',
      groupSessionId: 'group-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      type: 'task.clarification_needed',
      payload: {
        taskTitle: '研究资料',
        agentName: 'Researcher',
        question: '请确认资料来源范围',
        options: ['仅官方文档', '官方文档 + 博客'],
      },
    })

    expect(events).toHaveLength(1)
    const event = events[0] as { name?: string; value?: Record<string, unknown> }
    expect(event.name).toBe('agenthub.task.clarification_needed')
    expect(event.value?.question).toBe('请确认资料来源范围')
  })
})
