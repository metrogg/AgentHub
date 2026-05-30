import { db, messages, workspaceTasks, eq, and, desc } from '@agenthub/db'
import { logger } from '../../lib/logger'
import { runAgentReply, type AgentRunProfile, type MessageRow } from '../agent-runner'
import { DEFAULT_ENV_ALLOWLIST } from './agent-execution-envelope'
import { prepareAgentWorkdir, type AgentWorkdir } from './agent-workdir'
import { TaskStatus } from '@agenthub/shared'

export interface TaskExecutionInput {
  taskId: string
  sessionId: string
  workspaceId: string
  profile: AgentRunProfile
  prompt: string
  projectPath?: string | null
  runId?: string
  signal?: AbortSignal
  attemptCount?: number
  /** 外部已创建的 user message（orchestrator 场景），跳过插入 */
  existingUserMessageId?: string
  /** 外部已准备的执行目录（orchestrator 场景），跳过自动分配 */
  existingWorkdir?: AgentWorkdir | null
  /** Orchestrator 场景需要等 validation / contract 后处理完成后再标记 Done */
  deferCompletionStatus?: boolean
}

export interface TaskExecutionOutput {
  status: TaskStatus
  output: string
  artifacts: Array<Record<string, unknown>>
  error?: string
  durationMs: number
  /** 实际执行目录（写入型 Agent 会落在工作区下的 .agenthub/workdirs） */
  executionPath?: string | null
}

/**
 * 统一任务执行服务：为单任务 dispatch 和 Orchestrator 子任务提供
 * 相同的执行目录分配、Agent 执行和 artifact 收集能力。
 */
export class TaskExecutionService {
  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const { taskId, sessionId, projectPath, profile, prompt, signal, attemptCount = 0 } = input

    const runId = input.runId ?? 'standalone'
    const workdir =
      input.existingWorkdir ??
      prepareAgentWorkdir({
        projectPath,
        runId,
        taskId,
        agentId: profile.id,
        agentName: profile.name,
        sandboxPolicy: profile.sandboxPolicy ?? 'workspace-write',
      })
    const executionPath = workdir?.executionPath ?? profile.projectPath ?? projectPath ?? null
    if (workdir) {
      logger.info(
        { executionPath: workdir.executionPath, relativePath: workdir.relativePath, agent: profile.name },
        'Agent workdir prepared',
      )
    }

    const executionProfile: AgentRunProfile = {
      ...profile,
      projectPath: executionPath,
      originalProjectPath: profile.projectPath ?? null,
    }

    const envelope: import('./agent-execution-envelope').AgentExecutionEnvelope = {
      runId,
      taskId,
      agentId: profile.id,
      agentName: profile.name,
      projectPath: projectPath ?? null,
      worktreePath: workdir?.executionPath ?? (profile.sandboxPolicy === 'read-only' ? null : executionPath),
      sandboxPolicy: profile.sandboxPolicy ?? 'workspace-write',
      envAllowlist: DEFAULT_ENV_ALLOWLIST,
    }

    // 插入 user message（orchestrator 可能已预创建）
    let userMsg: MessageRow | undefined
    if (input.existingUserMessageId) {
      const [existingUserMsg] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, input.existingUserMessageId))
        .limit(1)
      if (!existingUserMsg) {
        return { status: TaskStatus.Failed, output: '', artifacts: [], error: 'Existing user message not found', durationMs: 0 }
      }
      userMsg = existingUserMsg as MessageRow
    } else {
      const [createdUserMsg] = await db
        .insert(messages)
        .values({
          sessionId,
          senderId: 'user',
          senderType: 'user',
          type: 'text',
          content: prompt,
        })
        .returning()

      if (!createdUserMsg) {
        return { status: TaskStatus.Failed, output: '', artifacts: [], error: 'Failed to create user message', durationMs: 0 }
      }
      userMsg = createdUserMsg as MessageRow
    }

    // 更新 task 状态
    await db
      .update(workspaceTasks)
      .set({ status: TaskStatus.Running, startedAt: new Date(), retryCount: attemptCount })
      .where(eq(workspaceTasks.id, taskId))

    const taskStartTime = Date.now()
    try {
      const TASK_TIMEOUT_MS = 300_000
      const effectiveSignal = signal ?? new AbortController().signal

      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`任务执行超时（${TASK_TIMEOUT_MS / 1000}秒）`)), TASK_TIMEOUT_MS)
        effectiveSignal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('任务已取消'))
        }, { once: true })
      })

      const agentUserMsg = userMsg
      if (!agentUserMsg) {
        throw new Error('Failed to prepare user message')
      }
      const result = await Promise.race([
        runAgentReply(sessionId, agentUserMsg, executionProfile, envelope),
        timeoutPromise,
      ])

      if (signal?.aborted) {
        await db.update(workspaceTasks).set({ status: TaskStatus.Cancelled, completedAt: new Date() }).where(eq(workspaceTasks.id, taskId))
        return { status: TaskStatus.Cancelled, output: 'Task was cancelled', artifacts: [], durationMs: Date.now() - taskStartTime, executionPath }
      }

      if (result.cancelled) {
        await db.update(workspaceTasks).set({ status: TaskStatus.Cancelled, completedAt: new Date() }).where(eq(workspaceTasks.id, taskId))
        return { status: TaskStatus.Cancelled, output: 'Task was cancelled', artifacts: [], durationMs: Date.now() - taskStartTime, executionPath }
      }

      // 收集 output：优先使用 runAgentReply 返回的 agent messageId，避免同毫秒写入时误取 user prompt。
      let lastAgentMsg = result.messageId
        ? await db.select().from(messages).where(eq(messages.id, result.messageId)).limit(1)
        : []
      if (!lastAgentMsg[0]) {
        lastAgentMsg = await db
          .select()
          .from(messages)
          .where(and(eq(messages.sessionId, sessionId), eq(messages.senderType, 'agent')))
          .orderBy(desc(messages.createdAt))
          .limit(1)
      }

      const output = lastAgentMsg[0]?.content ?? ''
      const artifacts: Array<Record<string, unknown>> = []

      // 合并 message metadata 中的 artifacts
      const msgArtifacts = (lastAgentMsg[0]?.metadata as Record<string, unknown> | null)?.artifacts as
        | Array<Record<string, unknown>>
        | undefined
      if (msgArtifacts) artifacts.push(...msgArtifacts)

      const taskDuration = Date.now() - taskStartTime

      if (!result.ok) {
        const error = output.trim() || 'Agent 执行失败，请检查日志'
        await db
          .update(workspaceTasks)
          .set({ status: TaskStatus.Failed, completedAt: new Date(), errorLog: error.slice(0, 2000) })
          .where(eq(workspaceTasks.id, taskId))
        return { status: TaskStatus.Failed, output, artifacts, error, durationMs: taskDuration, executionPath }
      }

      if (!input.deferCompletionStatus) {
        await db
          .update(workspaceTasks)
          .set({
            status: TaskStatus.Done,
            completedAt: new Date(),
            artifacts: (artifacts as unknown as import('@agenthub/db').AgentArtifact[]) ?? [],
          })
          .where(eq(workspaceTasks.id, taskId))
      }

      return { status: TaskStatus.Done, output, artifacts, durationMs: taskDuration, executionPath }
    } catch (error: any) {
      const taskDuration = Date.now() - taskStartTime
      await db
        .update(workspaceTasks)
        .set({ status: TaskStatus.Failed, completedAt: new Date(), errorLog: error?.message || 'Unknown error' })
        .where(eq(workspaceTasks.id, taskId))
      return { status: TaskStatus.Failed, output: '', artifacts: [], error: error?.message || 'Unknown error', durationMs: taskDuration, executionPath }
    }
  }
}

export const taskExecutionService = new TaskExecutionService()
