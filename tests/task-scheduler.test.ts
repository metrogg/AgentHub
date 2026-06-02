import { describe, expect, test } from 'bun:test'
import { TaskScheduler } from '../apps/server/src/services/orchestrator/task-scheduler'
import type {
  ExecutionAgent,
  ExecutionPlan,
  ExecutionTask,
} from '../apps/server/src/services/orchestrator/types'

const agent: ExecutionAgent = {
  id: 'agent-1',
  key: 'agent-1',
  name: 'Agent One',
  role: 'Worker',
  runtimeType: 'code-agent',
  codeAgentType: 'opencode',
  capabilityTags: ['code'],
  toolPermissions: ['chat', 'workspace:read', 'workspace:write'],
  sandboxPolicy: 'workspace-write',
}

function task(overrides: Partial<ExecutionTask>): ExecutionTask {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    description: overrides.description ?? 'Run task',
    agentId: overrides.agentId ?? agent.id,
    dependencies: overrides.dependencies ?? [],
    maxRetries: overrides.maxRetries ?? 1,
    phaseId: overrides.phaseId,
    taskType: overrides.taskType,
  }
}

function plan(tasks: ExecutionTask[]): ExecutionPlan {
  return {
    runId: 'run-1',
    title: 'Pipeline plan',
    goal: 'Verify scheduler',
    collaborationMode: 'pipeline',
    agents: [agent],
    phases: [
      {
        id: 'phase-1',
        title: 'First phase',
        purpose: 'First work',
        taskIds: tasks.filter((item) => item.phaseId === 'phase-1').map((item) => item.id),
      },
      {
        id: 'phase-2',
        title: 'Second phase',
        purpose: 'Second work',
        taskIds: tasks.filter((item) => item.phaseId === 'phase-2').map((item) => item.id),
      },
    ],
    tasks,
  }
}

describe('TaskScheduler', () => {
  test('pipeline mode starts only one ready task at a time', async () => {
    const scheduler = new TaskScheduler()
    const firstTask = task({ id: 'task-1', title: 'First', phaseId: 'phase-1' })
    const secondTask = task({ id: 'task-2', title: 'Second', phaseId: 'phase-1' })
    const started: string[] = []
    let releaseFirst: (() => void) | null = null
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const run = scheduler.executePlan(
      plan([firstTask, secondTask]),
      async (currentTask) => {
        started.push(currentTask.id)
        if (currentTask.id === 'task-1') {
          await firstCanFinish
        }
        return {
          taskId: currentTask.id,
          agentId: currentTask.agentId,
          agentName: agent.name,
          status: 'done',
          output: currentTask.title,
          artifacts: [],
        }
      },
      'pipeline',
    )

    await sleep(350)
    expect(started).toEqual(['task-1'])

    releaseFirst?.()
    const results = await run

    expect(started).toEqual(['task-1', 'task-2'])
    expect(results.map((result) => result.taskId)).toEqual(['task-1', 'task-2'])
  })

  test('emits each phase completion once after all phase tasks are terminal', async () => {
    const scheduler = new TaskScheduler()
    const phaseEvents: string[] = []
    scheduler.onPhaseCompleted = (phaseId) => {
      phaseEvents.push(phaseId)
    }

    const firstTask = task({ id: 'task-1', title: 'First', phaseId: 'phase-1' })
    const secondTask = task({
      id: 'task-2',
      title: 'Second',
      phaseId: 'phase-2',
      dependencies: ['task-1'],
    })

    const results = await scheduler.executePlan(
      plan([firstTask, secondTask]),
      async (currentTask) => ({
        taskId: currentTask.id,
        agentId: currentTask.agentId,
        agentName: agent.name,
        status: 'done',
        output: currentTask.title,
        artifacts: [],
      }),
      'pipeline',
    )

    expect(results.map((result) => result.taskId)).toEqual(['task-1', 'task-2'])
    expect(phaseEvents).toEqual(['phase-1', 'phase-2'])
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
