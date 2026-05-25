import type { ExecutionTask } from './types'

type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export class TaskGraph {
  private statuses = new Map<string, TaskStatus>()

  constructor(private tasks: ExecutionTask[]) {
    for (const task of tasks) {
      this.statuses.set(task.id, 'pending')
    }
  }

  setStatus(taskId: string, status: TaskStatus) {
    this.statuses.set(taskId, status)
  }

  getStatus(taskId: string): TaskStatus {
    return this.statuses.get(taskId) ?? 'pending'
  }

  getReadyTasks(): ExecutionTask[] {
    return this.tasks.filter((task) => {
      if (this.getStatus(task.id) !== 'pending') return false
      return task.dependencies.every((depId) => this.getStatus(depId) === 'done')
    })
  }

  getRunningTasks(): ExecutionTask[] {
    return this.tasks.filter((task) => this.getStatus(task.id) === 'running')
  }

  getFailedTasks(): ExecutionTask[] {
    return this.tasks.filter((task) => this.getStatus(task.id) === 'failed')
  }

  allDone(): boolean {
    return this.tasks.every((task) => {
      const s = this.getStatus(task.id)
      return s === 'done' || s === 'failed' || s === 'cancelled'
    })
  }

  allSucceeded(): boolean {
    return this.tasks.every((task) => this.getStatus(task.id) === 'done')
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
