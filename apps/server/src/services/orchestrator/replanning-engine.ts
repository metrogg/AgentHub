import { logger } from '../../lib/logger'
import type { ExecutionPlan, ExecutionTask } from './types'

export interface ReplanResult {
  strategy:
    | 'retry_with_backoff'
    | 'agent_substitution'
    | 'local_replan'
    | 'task_split'
    | 'escalate_to_user'
    | 'global_replan'
    | 'fail'
  updatedTask?: ExecutionTask
  newTasks?: ExecutionTask[] // 任务拆分后产生的新任务
  delayMs?: number // retry_with_backoff 的延迟
  reason: string
}

export interface FailureAnalysis {
  category:
    | 'transient_error' // API 超时/限流等临时错误
    | 'agent_capability_mismatch' // Agent 能力不足
    | 'dependency_conflict' // 依赖冲突
    | 'schema_mismatch' // 输出格式不符合预期
    | 'unrecoverable_error' // 不可恢复错误
    | 'timeout' // 超时
  reason: string
}

/**
 * ReplanningEngine — 动态重规划引擎
 *
 * 当任务失败时，分析失败原因并选择最佳重规划策略。
 * 相比 FallbackEngine 的固定重试逻辑，ReplanningEngine 支持：
 * - 指数退避重试（transient_error）
 * - Agent 替换（agent_capability_mismatch）
 * - 局部重规划（dependency_conflict / schema_mismatch）
 * - 任务拆分（任务过于复杂）
 * - 用户介入（unrecoverable_error）
 */
export class ReplanningEngine {
  /**
   * 分析失败原因
   */
  analyze(task: ExecutionTask, error: Error, _output?: string): FailureAnalysis {
    const msg = error.message.toLowerCase()

    // 超时（特殊处理，因为可能需要更长的 timeout）
    if (msg.includes('timed out') || msg.includes('deadline exceeded')) {
      return { category: 'timeout', reason: error.message }
    }

    // 临时错误：超时、限流、连接问题
    if (
      msg.includes('timeout') ||
      msg.includes('etimedout') ||
      msg.includes('rate limit') ||
      msg.includes('too many requests') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up')
    ) {
      return { category: 'transient_error', reason: error.message }
    }

    // 输出格式错误
    if (msg.includes('json') || msg.includes('schema') || msg.includes('parse') || msg.includes('invalid')) {
      return { category: 'schema_mismatch', reason: error.message }
    }

    // 默认：不可恢复错误
    return { category: 'unrecoverable_error', reason: error.message }
  }

  /**
   * 根据失败分析选择重规划策略
   */
  handle(
    task: ExecutionTask,
    error: Error,
    retryCount: number,
    plan: ExecutionPlan,
    _blackboardSnapshot?: unknown
  ): ReplanResult {
    const analysis = this.analyze(task, error)
    const maxRetries = task.maxRetries ?? 3

    logger.info(
      { taskId: task.id, category: analysis.category, retryCount, maxRetries },
      'ReplanningEngine analyzing failure'
    )

    switch (analysis.category) {
      case 'transient_error': {
        if (retryCount < maxRetries) {
          const delayMs = this.calculateBackoff(retryCount)
          return {
            strategy: 'retry_with_backoff',
            updatedTask: { ...task, retryCount: retryCount + 1 },
            delayMs,
            reason: `临时错误，${delayMs}ms 后第 ${retryCount + 1} 次重试`,
          }
        }
        // 重试耗尽，尝试 Agent 替换
        return this.tryAgentSubstitution(task, plan, analysis.reason)
      }

      case 'timeout': {
        if (retryCount < maxRetries) {
          // 超时重试时增加 timeout
          const updatedTask: ExecutionTask = {
            ...task,
            timeout: (task.timeout ?? 300000) * 1.5,
            retryCount: retryCount + 1,
          }
          return {
            strategy: 'local_replan',
            updatedTask,
            reason: `超时，增加 timeout 至 ${updatedTask.timeout}ms 后重试`,
          }
        }
        return this.tryAgentSubstitution(task, plan, analysis.reason)
      }

      case 'agent_capability_mismatch':
      case 'schema_mismatch': {
        // 能力不匹配或格式错误：先尝试 Agent 替换
        const subResult = this.tryAgentSubstitution(task, plan, analysis.reason)
        if (subResult.strategy !== 'fail') return subResult

        // 无备选 Agent，尝试任务拆分
        if (retryCount < 1) {
          return this.tryTaskSplit(task, plan, analysis.reason)
        }
        return {
          strategy: 'escalate_to_user',
          reason: `Agent 能力不足且无可降级 Agent，需要用户介入：${analysis.reason}`,
        }
      }

      case 'dependency_conflict': {
        // 依赖冲突：尝试局部重规划（调整依赖或重新排序）
        return {
          strategy: 'local_replan',
          reason: `依赖冲突，尝试局部重规划：${analysis.reason}`,
        }
      }

      case 'unrecoverable_error':
      default: {
        if (retryCount < 1) {
          // 第一次失败时，给一次重试机会
          return {
            strategy: 'retry_with_backoff',
            updatedTask: { ...task, retryCount: retryCount + 1 },
            delayMs: 1000,
            reason: `首次失败，给予一次重试机会：${analysis.reason}`,
          }
        }
        return {
          strategy: 'escalate_to_user',
          reason: `不可恢复错误，需要用户介入：${analysis.reason}`,
        }
      }
    }
  }

  // ─── 策略实现 ───────────────────────────────

  private tryAgentSubstitution(task: ExecutionTask, plan: ExecutionPlan, reason: string): ReplanResult {
    // 1. 优先使用 task.fallbackAgentId
    if (task.fallbackAgentId) {
      const updatedTask: ExecutionTask = {
        ...task,
        agentId: task.fallbackAgentId,
        maxRetries: 2,
        retryCount: 0,
      }
      return {
        strategy: 'agent_substitution',
        updatedTask,
        reason: `降级到 fallback Agent：${reason}`,
      }
    }

    // 2. 自动寻找同类型备选 Agent（相同 capabilityTags 的其他 Agent）
    const currentAgent = plan.agents.find((a) => a.id === task.agentId)
    if (currentAgent) {
      const alternatives = plan.agents.filter(
        (a) =>
          a.id !== currentAgent.id &&
          a.runtimeType === currentAgent.runtimeType &&
          a.capabilityTags.some((c) => currentAgent.capabilityTags.includes(c))
      )
      if (alternatives.length > 0) {
        const pick = alternatives[0]!
        const updatedTask: ExecutionTask = {
          ...task,
          agentId: pick.id,
          maxRetries: 2,
          retryCount: 0,
        }
        return {
          strategy: 'agent_substitution',
          updatedTask,
          reason: `自动替换为同类型备选 Agent ${pick.name}：${reason}`,
        }
      }
    }

    return {
      strategy: 'fail',
      reason: `无备选 Agent 可替换：${reason}`,
    }
  }

  private tryTaskSplit(task: ExecutionTask, _plan: ExecutionPlan, reason: string): ReplanResult {
    // 将复杂任务拆分为 2 个子任务
    const subTaskA: ExecutionTask = {
      ...task,
      id: `${task.id}_a`,
      title: `${task.title}（子任务 A：分析）`,
      description: `先进行分析阶段：${task.description}`,
      maxRetries: 2,
      retryCount: 0,
    }
    const subTaskB: ExecutionTask = {
      ...task,
      id: `${task.id}_b`,
      title: `${task.title}（子任务 B：实现）`,
      description: `基于分析结果实现：${task.description}`,
      dependencies: [...task.dependencies, subTaskA.id],
      maxRetries: 2,
      retryCount: 0,
    }

    return {
      strategy: 'task_split',
      newTasks: [subTaskA, subTaskB],
      reason: `任务过于复杂，拆分为子任务：${reason}`,
    }
  }

  private calculateBackoff(attempt: number): number {
    const base = 1000
    const max = 30000
    const delay = Math.min(base * Math.pow(2, attempt), max)
    const jitter = Math.random() * 1000
    return Math.floor(delay + jitter)
  }
}
