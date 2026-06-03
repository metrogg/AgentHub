import { describe, expect, test } from 'bun:test'

describe('task scheduler cancellation semantics', () => {
  test('preserves cancelled task results instead of coercing them into failed', async () => {
    const { TaskScheduler } = await import(
      '../apps/server/src/services/orchestrator/task-scheduler'
    )

    const scheduler = new TaskScheduler()
    const results = await scheduler.executePlan(
      {
        runId: 'run-cancelled-1',
        title: 'Cancellation plan',
        goal: 'Ensure cancelled tasks stay cancelled',
        agents: [{ id: 'agent-1', name: 'Worker', key: 'worker', role: 'coder' } as any],
        tasks: [
          {
            id: 'task-1',
            title: 'Cancelled task',
            description: 'Should remain cancelled.',
            agentId: 'agent-1',
            dependencies: [],
          },
        ],
      } as any,
      async (task) => ({
        taskId: task.id,
        agentId: task.agentId,
        agentName: 'Worker',
        status: 'cancelled',
        output: 'Task cancelled by manager.',
        artifacts: [],
      }),
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('cancelled')
    expect(results[0]?.output).toContain('cancelled')
  })
})
