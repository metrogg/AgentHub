import { logger } from '../../lib/logger'
import { Semaphore } from '../concurrency'
import { TaskGraph } from './task-graph'
import type { ExecutionPlan, ExecutionTask, TaskResult } from './types'

export type TaskExecutor = (task: ExecutionTask, signal: AbortSignal) => Promise<TaskResult>

export class TaskScheduler {
  private semaphore = new Semaphore(3)
  private activeControllers = new Map<string, AbortController>()

  setConcurrency(n: number) {
    this.semaphore = new Semaphore(Math.max(1, Math.min(n, 10)))
  }

  async executePlan(plan: ExecutionPlan, executor: TaskExecutor): Promise<TaskResult[]> {
    const graph = new TaskGraph(plan.tasks)

    if (graph.detectCycles()) {
      throw new Error('Execution plan contains circular dependencies')
    }

    const results = new Map<string, TaskResult>()
    const runController = new AbortController()
    this.activeControllers.set(plan.runId, runController)

    try {
      while (!graph.allDone() && !runController.signal.aborted) {
        const readyTasks = graph.getReadyTasks()
        const runningCount = graph.getRunningTasks().length
        if (runningCount < readyTasks.length) {
          const toRun = readyTasks.filter((t) => graph.getStatus(t.id) === 'pending').slice(0, readyTasks.length - runningCount)
          for (const task of toRun) {
            graph.setStatus(task.id, 'running')
            this.runTask(task, graph, results, executor, runController.signal).catch((err) => {
              logger.error({ err, taskId: task.id }, 'Task execution error')
            })
          }
        }

        await sleep(200)
      }
    } finally {
      this.activeControllers.delete(plan.runId)
    }

    return plan.tasks.map((task) => results.get(task.id)!).filter(Boolean)
  }

  cancelRun(runId: string) {
    const controller = this.activeControllers.get(runId)
    if (controller) {
      controller.abort(new Error('Run cancelled'))
      this.activeControllers.delete(runId)
    }
  }

  private async runTask(
    task: ExecutionTask,
    graph: TaskGraph,
    results: Map<string, TaskResult>,
    executor: TaskExecutor,
    runSignal: AbortSignal,
  ) {
    const release = await this.semaphore.acquire(60000)
    const taskController = new AbortController()
    const combinedSignal = combineAbortSignals(runSignal, taskController.signal)

    try {
      const result = await executor(task, combinedSignal)

      if (combinedSignal.aborted) {
        graph.setStatus(task.id, 'cancelled')
        results.set(task.id, { ...result, status: 'cancelled' })
        return
      }

      graph.setStatus(task.id, result.status === 'done' ? 'done' : 'failed')
      results.set(task.id, result)
    } catch (error: any) {
      graph.setStatus(task.id, 'failed')
      results.set(task.id, {
        taskId: task.id,
        agentId: task.agentId,
        agentName: 'Unknown',
        status: 'failed',
        output: '',
        artifacts: [],
        error: error?.message || 'Unknown error',
      })
    } finally {
      release()
    }
  }
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  for (const signal of signals) {
    if (signal.aborted) {
      onAbort()
      return controller.signal
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
