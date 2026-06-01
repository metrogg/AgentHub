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
