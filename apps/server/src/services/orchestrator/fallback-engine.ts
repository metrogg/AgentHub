import type { ExecutionPlan, ExecutionTask } from './types'

export interface FallbackResult {
  action: 'retry' | 'fallback-agent' | 'fail'
  updatedTask?: ExecutionTask
  reason: string
}

export class FallbackEngine {
  handle(task: ExecutionTask, error: Error, attemptCount: number): FallbackResult {
    // Level 1: 同 Agent 重试
    if (attemptCount < task.maxRetries) {
      return {
        action: 'retry',
        reason: `第 ${attemptCount + 1} 次重试（最大 ${task.maxRetries} 次）`,
      }
    }

    // Level 2: 降级到 fallbackAgent
    if (task.fallbackAgentId) {
      return {
        action: 'fallback-agent',
        updatedTask: { ...task, agentId: task.fallbackAgentId, maxRetries: 1 },
        reason: `原 Agent 多次失败后，降级到 fallback Agent`,
      }
    }

    // Level 3: 标记失败
    return {
      action: 'fail',
      reason: `任务失败且无可降级 Agent：${error.message}`,
    }
  }
}
