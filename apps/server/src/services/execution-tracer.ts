import { db, executionLogs, eq, and } from '@agenthub/db'
import { logger } from '../lib/logger'

export interface TraceEntry {
  runId: string
  sessionId: string
  agentId: string
  taskId?: string
  type: 'llm_call' | 'tool_call' | 'blackboard_read' | 'blackboard_write' | 'error' | 'task_start' | 'task_end'
  input?: unknown
  output?: unknown
  durationMs?: number
  tokenUsage?: { promptTokens: number; completionTokens: number }
}

/**
 * ExecutionTracer — 执行追踪日志
 *
 * 记录每个 Agent 的输入、输出、工具调用、黑板操作、耗时和 Token 用量。
 * 存储在 SQLite execution_logs 表中，支持按 run/session/agent/task 过滤查询。
 */
export class ExecutionTracer {
  async log(entry: TraceEntry): Promise<void> {
    try {
      await db.insert(executionLogs).values({
        id: crypto.randomUUID(),
        runId: entry.runId,
        sessionId: entry.sessionId,
        agentId: entry.agentId,
        taskId: entry.taskId ?? null,
        type: entry.type,
        input: entry.input as Record<string, unknown> | undefined,
        output: entry.output as Record<string, unknown> | undefined,
        durationMs: entry.durationMs ?? null,
        tokenUsage: entry.tokenUsage as Record<string, unknown> | undefined,
        createdAt: new Date(),
      })
    } catch (err) {
      logger.error({ err, entry }, 'ExecutionTracer log failed')
    }
  }

  async query(filters: {
    runId?: string
    sessionId?: string
    agentId?: string
    taskId?: string
    limit?: number
  }): Promise<typeof executionLogs.$inferSelect[]> {
    let q = db.select().from(executionLogs).$dynamic()
    const conditions = []

    if (filters.runId) {
      // @ts-ignore drizzle dynamic query
      conditions.push(eq(executionLogs.runId, filters.runId))
    }
    if (filters.sessionId) {
      // @ts-ignore
      conditions.push(eq(executionLogs.sessionId, filters.sessionId))
    }
    if (filters.agentId) {
      // @ts-ignore
      conditions.push(eq(executionLogs.agentId, filters.agentId))
    }
    if (filters.taskId) {
      // @ts-ignore
      conditions.push(eq(executionLogs.taskId, filters.taskId))
    }

    if (conditions.length > 0) {
      // @ts-ignore
      q = q.where(and(...conditions))
    }

    if (filters.limit) {
      q = q.limit(filters.limit)
    }

    return q.orderBy(executionLogs.createdAt)
  }
}

export const executionTracer = new ExecutionTracer()
