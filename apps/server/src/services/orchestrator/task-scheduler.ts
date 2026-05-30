import { logger } from '../../lib/logger'
import { Semaphore } from '../concurrency'
import { TaskGraph } from './task-graph'
import type { CollaborationMode, ExecutionPlan, ExecutionTask, TaskResult } from './types'

export type TaskExecutor = (task: ExecutionTask, signal: AbortSignal) => Promise<TaskResult>

export class TaskScheduler {
  private semaphore = new Semaphore(3)
  private aborted = false
  private additionalTasks: ExecutionTask[] = []
  private activeControllers = new Map<string, AbortController>()
  private activeGraphs = new Map<string, TaskGraph>()
  private activePlans = new Map<string, ExecutionPlan>()
  public onPhaseCompleted?: (phaseId: string, phaseTitle: string) => void

  setConcurrency(n: number) {
    this.semaphore = new Semaphore(Math.max(1, Math.min(n, 10)))
  }

  async executePlan(
    plan: ExecutionPlan,
    executor: TaskExecutor,
    collaborationMode?: CollaborationMode,
  ): Promise<TaskResult[]> {
    const graph = new TaskGraph(plan.tasks)
    const agentNameById = new Map(plan.agents.map((agent) => [agent.id, agent.name]))
    this.activeGraphs.set(plan.runId, graph)
    this.activePlans.set(plan.runId, plan)

    if (graph.detectCycles()) {
      this.activeGraphs.delete(plan.runId)
      this.activePlans.delete(plan.runId)
      throw new Error('Execution plan contains circular dependencies')
    }

    if (collaborationMode === 'pipeline') {
      this.setConcurrency(1)
    } else {
      this.setConcurrency(3)
    }

    const results = new Map<string, TaskResult>()
    const runController = new AbortController()
    this.activeControllers.set(plan.runId, runController)

    try {
      while (!graph.allDone() && !runController.signal.aborted) {
        if (collaborationMode === 'pipeline' && plan.phases && plan.phases.length > 0) {
          const activePhase = plan.phases.find((phase) =>
            phase.taskIds.some((taskId) => {
              const status = graph.getStatus(taskId)
              return status !== 'done' && status !== 'failed' && status !== 'blocked'
            }),
          )
          if (activePhase) {
            this.onPhaseCompleted?.(activePhase.id, activePhase.title)
          }
        }

        if (collaborationMode === 'supervisor' && this.additionalTasks.length > 0) {
          for (const task of this.additionalTasks) {
            graph.setStatus(task.id, 'pending')
          }
          graph.addTasks(this.additionalTasks)
          plan.tasks.push(...this.additionalTasks)
          this.additionalTasks = []
        }

        const readyTasks = graph.getReadyTasks()
        const runningCount = graph.getRunningTasks().length
        if (runningCount < readyTasks.length) {
          const toRun = readyTasks.filter((t) => graph.getStatus(t.id) === 'pending').slice(0, readyTasks.length - runningCount)
          for (const task of toRun) {
            graph.setStatus(task.id, 'running')
            this.runTask(task, graph, results, executor, runController.signal, agentNameById).catch((err) => {
              logger.error({ err, taskId: task.id }, 'Task execution error')
            })
          }
        }

        await sleep(200)
      }
    } finally {
      this.activeControllers.delete(plan.runId)
      this.activeGraphs.delete(plan.runId)
      this.activePlans.delete(plan.runId)
    }

    return plan.tasks.map((task) => results.get(task.id)!).filter(Boolean)
  }

  addTasksToRun(runId: string, tasks: import('./types').ExecutionTask[]) {
    const graph = this.activeGraphs.get(runId)
    const plan = this.activePlans.get(runId)
    if (graph && plan) {
      graph.addTasks(tasks)
      for (const task of tasks) {
        if (!plan.tasks.find((t) => t.id === task.id)) {
          plan.tasks.push(task)
        }
      }
    }
  }

  cancelRun(runId: string) {
    const controller = this.activeControllers.get(runId)
    if (controller) {
      controller.abort(new Error('Run cancelled'))
      this.activeControllers.delete(runId)
    }
  }

  getRunSignal(runId: string): AbortSignal | undefined {
    return this.activeControllers.get(runId)?.signal
  }

  private async runTask(
    task: ExecutionTask,
    graph: TaskGraph,
    results: Map<string, TaskResult>,
    executor: TaskExecutor,
    runSignal: AbortSignal,
    agentNameById: Map<string, string>,
  ) {
    const release = await this.semaphore.acquire(60000)
    const taskController = new AbortController()
    const combinedSignal = combineAbortSignals(runSignal, taskController.signal)

    const recordBlockedResults = () => {
      const blockedTasks = graph.markBlockedByFailedDependencies()
      for (const blockedTask of blockedTasks) {
        results.set(blockedTask.id, {
          taskId: blockedTask.id,
          agentId: blockedTask.agentId,
          agentName: agentNameById.get(blockedTask.agentId) ?? blockedTask.agentId,
          status: 'blocked',
          output: '',
          artifacts: [],
          error: '上游依赖任务失败，任务被阻塞',
        })
      }
    }

    try {
      const result = await executor(task, combinedSignal)

      if (combinedSignal.aborted) {
        graph.setStatus(task.id, 'cancelled')
        results.set(task.id, { ...result, status: 'cancelled' })
        recordBlockedResults()
        return
      }

      graph.setStatus(task.id, result.status === 'done' ? 'done' : 'failed')
      results.set(task.id, result)

      if (result.status !== 'done') {
        recordBlockedResults()
      }
    } catch (error: any) {
      graph.setStatus(task.id, 'failed')
      results.set(task.id, {
        taskId: task.id,
        agentId: task.agentId,
        agentName: agentNameById.get(task.agentId) ?? task.agentId,
        status: 'failed',
        output: '',
        artifacts: [],
        error: error?.message || 'Unknown error',
      })
      recordBlockedResults()
    } finally {
      release()
    }
  }
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const onAbort = () => {
    for (const signal of signals) {
      signal.removeEventListener('abort', onAbort)
    }
    controller.abort()
  }
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
