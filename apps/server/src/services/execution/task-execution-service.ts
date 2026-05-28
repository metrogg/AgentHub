import { db, messages, workspaceTasks, eq, desc } from '@agenthub/db'
import { logger } from '../../lib/logger'
import { runAgentReply, type AgentRunProfile } from '../agent-runner'
import { gitBranchManager, type BranchContext } from '../git/branch-manager'
import { DEFAULT_ENV_ALLOWLIST, ensureNoProjectExecutionDir } from './agent-execution-envelope'

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
}

export interface TaskExecutionOutput {
  status: 'done' | 'failed' | 'cancelled'
  output: string
  artifacts: Array<Record<string, unknown>>
  error?: string
  durationMs: number
}

/**
 * 统一任务执行服务：为单任务 dispatch 和 Orchestrator 子任务提供
 * 相同的 Git 分支隔离、Agent 执行、artifact 收集和清理能力。
 */
export class TaskExecutionService {
  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const { taskId, sessionId, projectPath, profile, prompt, signal, attemptCount = 0 } = input

    // === Git 分支隔离 ===
    let branchCtx: BranchContext | null = null
    const needBranch = profile.sandboxPolicy !== 'read-only' && projectPath

    if (needBranch) {
      try {
        branchCtx = await gitBranchManager.prepareBranch(
          projectPath!,
          input.runId ?? 'standalone',
          profile.name || profile.id,
          taskId,
        )
        logger.info({ branch: branchCtx.branch, agent: profile.name }, 'Agent branch prepared')
      } catch (err: any) {
        logger.error({ err: err?.message, projectPath, agent: profile.name }, 'Failed to prepare agent branch')
        await db
          .update(workspaceTasks)
          .set({ status: 'failed', completedAt: new Date(), errorLog: `Git worktree 创建失败：${err?.message || '未知错误'}` })
          .where(eq(workspaceTasks.id, taskId))
        return { status: 'failed', output: '', artifacts: [], error: `Git worktree 创建失败：${err?.message || '未知错误'}`, durationMs: 0 }
      }
    }

    // 若未提供 projectPath 或 worktree 创建失败，降级为 read-only 避免 validateEnvelope 报错
    const effectiveSandboxPolicy: AgentRunProfile['sandboxPolicy'] =
      branchCtx?.worktreePath ? (profile.sandboxPolicy ?? 'workspace-write') : 'read-only'

    const executionProfile: AgentRunProfile = {
      ...profile,
      sandboxPolicy: effectiveSandboxPolicy,
      projectPath: branchCtx?.worktreePath ?? profile.projectPath ?? null,
      originalProjectPath: profile.projectPath ?? null,
    }

    const envelope: import('./agent-execution-envelope').AgentExecutionEnvelope = {
      runId,
      taskId,
      agentId: profile.id,
      agentName: profile.name,
      projectPath: projectPath ?? null,
      worktreePath: branchCtx?.worktreePath ?? null,
      sandboxPolicy: effectiveSandboxPolicy,
      envAllowlist: DEFAULT_ENV_ALLOWLIST,
    }

    // 插入 user message
    const [userMsg] = await db
      .insert(messages)
      .values({
        sessionId,
        senderId: 'user',
        senderType: 'user',
        type: 'text',
        content: prompt,
      })
      .returning()

    if (!userMsg) {
      if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
      return { status: 'failed', output: '', artifacts: [], error: 'Failed to create user message', durationMs: 0 }
    }

    // 更新 task 状态
    await db
      .update(workspaceTasks)
      .set({ status: 'running', startedAt: new Date(), retryCount: attemptCount })
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

      const result = await Promise.race([runAgentReply(sessionId, userMsg, executionProfile, envelope), timeoutPromise])

      if (signal?.aborted) {
        await db.update(workspaceTasks).set({ status: 'cancelled', completedAt: new Date() }).where(eq(workspaceTasks.id, taskId))
        if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
        return { status: 'cancelled', output: 'Task was cancelled', artifacts: [], durationMs: Date.now() - taskStartTime }
      }

      if (!result.ok) {
        throw new Error(result.cancelled ? '任务被取消' : 'Agent 执行失败，请检查日志')
      }

      if (result.cancelled) {
        await db.update(workspaceTasks).set({ status: 'cancelled', completedAt: new Date() }).where(eq(workspaceTasks.id, taskId))
        if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
        return { status: 'cancelled', output: 'Task was cancelled', artifacts: [], durationMs: Date.now() - taskStartTime }
      }

      // 收集 output
      const lastAgentMsg = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(desc(messages.createdAt))
        .limit(1)

      const output = lastAgentMsg[0]?.content ?? ''
      const artifacts: Array<Record<string, unknown>> = []

      // 收集 Git diff artifact
      if (branchCtx) {
        try {
          const changedFiles = await gitBranchManager.collectChangedFiles(branchCtx.projectPath, branchCtx.branch)
          if (changedFiles.length > 0) {
            for (const filePath of changedFiles) {
              const fileDiff = await gitBranchManager.collectFileDiff(branchCtx.projectPath, filePath, branchCtx.branch)
              const status = await gitBranchManager.getFileStatus(branchCtx.projectPath, filePath, branchCtx.branch)
              artifacts.push({
                id: `diff-${filePath.replace(/[^a-z0-9]/gi, '-')}`,
                kind: 'diff',
                title: `${profile.name} 修改了 ${filePath}`,
                filePath,
                status,
                diff: fileDiff,
                source: profile.name,
              })
            }
          }
        } catch (err: any) {
          logger.error({ err: err?.message, taskId }, 'Failed to collect git diff')
        }
      }

      // 合并 message metadata 中的 artifacts
      const msgArtifacts = (lastAgentMsg[0]?.metadata as Record<string, unknown> | null)?.artifacts as
        | Array<Record<string, unknown>>
        | undefined
      if (msgArtifacts) artifacts.push(...msgArtifacts)

      const taskDuration = Date.now() - taskStartTime

      // 更新 task 状态
      await db
        .update(workspaceTasks)
        .set({
          status: 'done',
          completedAt: new Date(),
          artifacts: (artifacts as unknown as import('@agenthub/db').AgentArtifact[]) ?? [],
        })
        .where(eq(workspaceTasks.id, taskId))

      if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)

      return { status: 'done', output, artifacts, durationMs: taskDuration }
    } catch (error: any) {
      const taskDuration = Date.now() - taskStartTime
      await db
        .update(workspaceTasks)
        .set({ status: 'failed', completedAt: new Date(), errorLog: error?.message || 'Unknown error' })
        .where(eq(workspaceTasks.id, taskId))
      if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
      return { status: 'failed', output: '', artifacts: [], error: error?.message || 'Unknown error', durationMs: taskDuration }
    }
  }
}

export const taskExecutionService = new TaskExecutionService()
