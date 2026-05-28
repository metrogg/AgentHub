import type { ExecutionTask } from './types'
import { TaskStatus } from '@agenthub/shared'

export class TaskGraph {
  private statuses = new Map<string, TaskStatus>()

  constructor(private tasks: ExecutionTask[]) {
    for (const task of tasks) {
      this.statuses.set(task.id, TaskStatus.Pending)
    }
  }

  setStatus(taskId: string, status: TaskStatus) {
    this.statuses.set(taskId, status)
  }

  getStatus(taskId: string): TaskStatus {
    return this.statuses.get(taskId) ?? TaskStatus.Pending
  }

  getReadyTasks(): ExecutionTask[] {
    return this.tasks.filter((task) => {
      if (this.getStatus(task.id) !== TaskStatus.Pending) return false
      return task.dependencies.every((depId) => {
        // 缺失的依赖视为已满足，避免任务永远挂起
        if (!this.statuses.has(depId)) return true
        return this.getStatus(depId) === TaskStatus.Done
      })
    })
  }

  getRunningTasks(): ExecutionTask[] {
    return this.tasks.filter((task) => this.getStatus(task.id) === TaskStatus.Running)
  }

  getFailedTasks(): ExecutionTask[] {
    return this.tasks.filter((task) => this.getStatus(task.id) === TaskStatus.Failed)
  }

  getBlockedTasks(): ExecutionTask[] {
    return this.tasks.filter((task) => this.getStatus(task.id) === TaskStatus.Blocked)
  }

  allDone(): boolean {
    return this.tasks.every((task) => {
      const s = this.getStatus(task.id)
      return s === TaskStatus.Done || s === TaskStatus.Failed || s === TaskStatus.Cancelled || s === TaskStatus.Blocked || s === TaskStatus.Skipped
    })
  }

  allSucceeded(): boolean {
    return this.tasks.every((task) => this.getStatus(task.id) === TaskStatus.Done)
  }

  detectCycles(): boolean {
    const visited = new Set<string>()
    const stack = new Set<string>()

    const visit = (taskId: string): boolean => {
      if (stack.has(taskId)) return true
      if (visited.has(taskId)) return false
      visited.add(taskId)
      stack.add(taskId)
      const task = this.tasks.find((t) => t.id === taskId)
      if (task) {
        for (const dep of task.dependencies) {
          if (visit(dep)) return true
        }
      }
      stack.delete(taskId)
      return false
    }

    for (const task of this.tasks) {
      if (visit(task.id)) return true
    }
    return false
  }

  addTasks(tasks: ExecutionTask[]) {
    for (const task of tasks) {
      if (!this.statuses.has(task.id)) {
        this.tasks.push(task)
        this.statuses.set(task.id, 'pending')
      }
    }
  }

  /**
   * 当上游任务失败或被取消时，递归把依赖它的 pending 任务标记为 blocked。
   * 返回被影响（新标记为 blocked）的任务列表。
   */
  markBlockedByFailedDependencies(): ExecutionTask[] {
    const blocked: ExecutionTask[] = []
    const changed = new Set<string>()

    let foundNew = true
    while (foundNew) {
      foundNew = false
      for (const task of this.tasks) {
        if (this.getStatus(task.id) !== 'pending') continue
        const hasFailedDep = task.dependencies.some((depId) => {
          const depStatus = this.getStatus(depId)
          return depStatus === 'failed' || depStatus === 'cancelled' || depStatus === 'blocked'
        })
        if (hasFailedDep && !changed.has(task.id)) {
          this.setStatus(task.id, 'blocked')
          blocked.push(task)
          changed.add(task.id)
          foundNew = true
        }
      }
    }

    return blocked
  }

  getExecutionOrder(): string[] {
    const inDegree = new Map<string, number>()
    const adj = new Map<string, string[]>()

    for (const task of this.tasks) {
      inDegree.set(task.id, 0)
      adj.set(task.id, [])
    }

    for (const task of this.tasks) {
      for (const dep of task.dependencies) {
        if (inDegree.has(dep)) {
          inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1)
          adj.get(dep)!.push(task.id)
        }
      }
    }

    const queue: string[] = []
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id)
    }

    const result: string[] = []
    while (queue.length) {
      const current = queue.shift()!
      result.push(current)
      for (const next of adj.get(current) ?? []) {
        const newDeg = (inDegree.get(next) ?? 1) - 1
        inDegree.set(next, newDeg)
        if (newDeg === 0) queue.push(next)
      }
    }

    return result
  }
}
