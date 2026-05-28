import { db, messages, workspaceTasks, orchestratorRuns, sessions, eq, and, desc } from '@agenthub/db'
import { logger } from '../../lib/logger'
import { broadcastSessionEvent, runAgentReply } from '../agent-runner'
import { gitBranchManager } from '../git/branch-manager'
import { blackboard, Blackboard, type BlackboardRef } from '../blackboard'
import { executionTracer } from '../execution-tracer'
import { Planner } from './planner'
import { TaskScheduler, type TaskExecutor } from './task-scheduler'
import { Synthesizer } from './synthesizer'
import { ConflictResolver } from './conflict-resolver'
import { ReplanningEngine } from './replanning-engine'
import { emitRunEvent } from './run-events'
import { initializeRunLedger } from './run-ledger'
import { validateTaskOutputContract } from './task-contract'
import { runTaskValidation } from './task-validation'
import type { ExecutionPlan, ExecutionTask, TaskResult } from './types'

export { ExecutionPlan, ExecutionTask, TaskResult }

interface ChildSessionInfo {
  sessionId: string
  workspaceId: string
  projectPath?: string | null
}

export class OrchestratorEngine {
  private static activeEngines = new Map<string, OrchestratorEngine>()
  private planner = new Planner()
  private scheduler = new TaskScheduler()
  private synthesizer = new Synthesizer()
  private conflictResolver = new ConflictResolver()
  private replanningEngine = new ReplanningEngine()

  static cancelActiveRun(runId: string): boolean {
    const engine = OrchestratorEngine.activeEngines.get(runId)
    if (!engine) return false
    engine.scheduler.cancelRun(runId)
    return true
  }

  async retryTask(params: {
    runId: string
    groupSessionId: string
    workspaceId: string
    task: ExecutionTask
    childSessions: Map<string, ChildSessionInfo>
  }): Promise<TaskResult> {
    const { runId, groupSessionId, workspaceId, task, childSessions } = params

    await db
      .update(workspaceTasks)
      .set({ status: 'pending', completedAt: null, errorLog: null })
      .where(eq(workspaceTasks.id, task.id))

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      taskId: task.id,
      agentId: task.agentId,
      type: 'task.retrying',
      severity: 'warning',
      payload: { title: task.title, reason: 'User triggered retry' },
    })

    const [runRow] = await db
      .select({ plan: orchestratorRuns.plan })
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.id, runId))
      .limit(1)

    const plan = (runRow?.plan as ExecutionPlan | undefined) ?? { runId, title: '', goal: '', agents: [], tasks: [task] }

    const result = await this.executeTask(task, plan, childSessions, runId, groupSessionId, workspaceId, new AbortController().signal, 0)

    return result
  }

  async createPlan(goal: string, agents: ExecutionPlan['agents'], workspacePath?: string | null): Promise<ExecutionPlan> {
    return this.planner.createPlan({ goal, agents, workspacePath })
  }

  async startRun(params: {
    runId: string
    groupSessionId: string
    workspaceId: string
    plan: ExecutionPlan
    childSessions: Map<string, ChildSessionInfo>
  }): Promise<void> {
    const { runId, groupSessionId, workspaceId, childSessions } = params
    const plan = initializeRunLedger(params.plan)
    OrchestratorEngine.activeEngines.set(runId, this)

    await db
      .update(orchestratorRuns)
      .set({ status: 'running', plan: plan as unknown as Record<string, unknown> })
      .where(eq(orchestratorRuns.id, runId))

    const [groupSessionRecord] = await db.select().from(sessions).where(eq(sessions.id, groupSessionId)).limit(1)
    const ownerId = groupSessionRecord?.ownerId ?? 'user'

    const executor: TaskExecutor = async (task, signal) => {
      let currentTask = task
      let currentAttempt = 0

      while (true) {
        const result = await this.executeTask(currentTask, plan, childSessions, runId, groupSessionId, workspaceId, signal, currentAttempt)
        if (result.status === 'done' || result.status === 'cancelled') {
          return result
        }

        currentAttempt++
        if (currentAttempt > 20) {
          logger.error({ taskId: currentTask.id, currentAttempt, runId }, 'Task exceeded maximum replan attempts, forcing failure')
          return {
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            agentName: 'Unknown',
            status: 'failed',
            output: '',
            artifacts: [],
            error: '任务重试次数超过系统上限（20次），已强制终止。',
          }
        }

        const replan = this.replanningEngine.handle(currentTask, new Error(result.error || 'Task failed'), currentAttempt, plan)

        logger.info({ taskId: currentTask.id, strategy: replan.strategy, reason: replan.reason }, 'Replanning triggered')

        if (replan.strategy === 'retry_with_backoff') {
          const delayMs = replan.delayMs ?? 1000
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            type: 'task.retrying',
            severity: 'warning',
            payload: { attempt: currentAttempt, delayMs, reason: replan.reason },
          })
          await new Promise((r) => setTimeout(r, delayMs))
          const childInfo = childSessions.get(currentTask.id)
          if (childInfo) {
            await db.update(workspaceTasks).set({ status: 'pending', errorLog: replan.reason }).where(eq(workspaceTasks.id, currentTask.id))
            broadcastSessionEvent(groupSessionId, {
              type: 'task:update',
              payload: { taskId: currentTask.id, status: 'pending', attempt: currentAttempt, strategy: 'retry', sessionId: childInfo.sessionId },
            })
          }
          continue
        }

        if (replan.strategy === 'agent_substitution' && replan.updatedTask) {
          const previousAgentId = currentTask.agentId
          currentTask = replan.updatedTask
          currentAttempt = 0
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            type: 'task.reassigned',
            severity: 'warning',
            payload: { fromAgentId: previousAgentId, toAgentId: currentTask.agentId, reason: replan.reason },
          })
          const childInfo = childSessions.get(currentTask.id)
          if (childInfo) {
            await db.update(workspaceTasks).set({ agentId: currentTask.agentId, status: 'pending', retryCount: 0, errorLog: replan.reason }).where(eq(workspaceTasks.id, currentTask.id))
            broadcastSessionEvent(groupSessionId, {
              type: 'task:update',
              payload: { taskId: currentTask.id, status: 'pending', agentId: currentTask.agentId, strategy: 'agent_substitution', sessionId: childInfo.sessionId },
            })
          }
          continue
        }

        if (replan.strategy === 'local_replan' && replan.updatedTask) {
          currentTask = replan.updatedTask
          currentAttempt = 0
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            type: 'run.replanned',
            severity: 'warning',
            payload: { strategy: 'local_replan', reason: replan.reason, changedTaskIds: [currentTask.id] },
          })
          const childInfo = childSessions.get(currentTask.id)
          if (childInfo) {
            await db.update(workspaceTasks).set({ status: 'pending', retryCount: 0, errorLog: replan.reason }).where(eq(workspaceTasks.id, currentTask.id))
            broadcastSessionEvent(groupSessionId, {
              type: 'task:update',
              payload: { taskId: currentTask.id, status: 'pending', strategy: 'local_replan', sessionId: childInfo.sessionId },
            })
          }
          continue
        }

        if (replan.strategy === 'task_split' && replan.newTasks && replan.newTasks.length > 0) {
          for (const newTask of replan.newTasks) {
            const newAgent = plan.agents.find((a) => a.id === newTask.agentId)
            const childSession = await ensureChildSession(workspaceId, plan.title, ownerId, newAgent ?? null, newTask.title)
            await db.insert(workspaceTasks).values({
              id: newTask.id,
              workspaceId,
              agentId: newTask.agentId,
              title: newTask.title,
              description: newTask.description,
              status: 'pending',
              orderIdx: plan.tasks.length,
              runId,
              phaseId: newTask.phaseId,
              dependencies: newTask.dependencies ?? [],
              parallelGroup: newTask.parallelGroup,
              maxRetries: newTask.maxRetries ?? 2,
            })
            childSessions.set(newTask.id, { sessionId: childSession.id, workspaceId, projectPath: childSessions.get(currentTask.id)?.projectPath })
            await emitRunEvent({
              runId,
              workspaceId,
              groupSessionId,
              taskId: newTask.id,
              agentId: newTask.agentId,
              type: 'task.queued',
              severity: 'warning',
              payload: { strategy: 'task_split', title: newTask.title, phaseId: newTask.phaseId, reason: replan.reason },
            })
          }
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            type: 'run.replanned',
            severity: 'warning',
            payload: { strategy: 'task_split', reason: replan.reason, changedTaskIds: replan.newTasks.map((t) => t.id) },
          })
          this.scheduler.addTasksToRun(runId, replan.newTasks)
          logger.info({ taskId: currentTask.id, newTaskCount: replan.newTasks.length }, 'Task split into subtasks')
          return { ...result, status: 'failed' as const, error: `任务已拆分为子任务: ${replan.reason}` }
        }

        if (replan.strategy === 'global_replan') {
          try {
            const workspacePath = childSessions.get(currentTask.id)?.projectPath ?? undefined
            const newPlan = await this.planner.createPlan({ goal: plan.goal, agents: plan.agents, workspacePath })
            const existingIds = new Set(plan.tasks.map((t) => t.id))
            const tasksToAdd = newPlan.tasks.filter((t) => !existingIds.has(t.id))
            if (tasksToAdd.length > 0) {
              for (const newTask of tasksToAdd) {
                const newAgent = plan.agents.find((a) => a.id === newTask.agentId)
                const childSession = await ensureChildSession(workspaceId, plan.title, ownerId, newAgent ?? null, newTask.title)
                await db.insert(workspaceTasks).values({
                  id: newTask.id,
                  workspaceId,
                  agentId: newTask.agentId,
                  title: newTask.title,
                  description: newTask.description,
                  status: 'pending',
                  orderIdx: plan.tasks.length,
                  runId,
                  phaseId: newTask.phaseId,
                  dependencies: newTask.dependencies ?? [],
                  parallelGroup: newTask.parallelGroup,
                  maxRetries: newTask.maxRetries ?? 2,
                })
                childSessions.set(newTask.id, { sessionId: childSession.id, workspaceId, projectPath: childSessions.get(currentTask.id)?.projectPath })
                await emitRunEvent({
                  runId,
                  workspaceId,
                  groupSessionId,
                  taskId: newTask.id,
                  agentId: newTask.agentId,
                  type: 'task.queued',
                  severity: 'warning',
                  payload: { strategy: 'global_replan', title: newTask.title, phaseId: newTask.phaseId },
                })
              }
              this.scheduler.addTasksToRun(runId, tasksToAdd)
              await emitRunEvent({
                runId,
                workspaceId,
                groupSessionId,
                taskId: currentTask.id,
                agentId: currentTask.agentId,
                type: 'run.replanned',
                severity: 'warning',
                payload: { strategy: 'global_replan', reason: replan.reason, changedTaskIds: tasksToAdd.map((t) => t.id) },
              })
              logger.info({ taskId: currentTask.id, addedCount: tasksToAdd.length }, 'Global replan added new tasks')
              continue
            }
          } catch (err: any) {
            logger.error({ err: err?.message, taskId: currentTask.id }, 'Global replan failed')
          }
          return { ...result, error: replan.reason }
        }

        if (replan.strategy === 'escalate_to_user') {
          const bbNamespace = Blackboard.namespace(workspaceId, runId)
          await blackboard.write({
            namespace: bbNamespace,
            key: `task_${currentTask.id}_escalation`,
            value: { reason: replan.reason, taskId: currentTask.id, agentId: currentTask.agentId },
            agentId: 'orchestrator',
            taskId: currentTask.id,
            tags: ['escalation', 'needs_user_action'],
          })
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            type: 'run.replanned',
            severity: 'warning',
            payload: { strategy: 'escalate_to_user', reason: replan.reason, changedTaskIds: [currentTask.id] },
          })
        }

        if (replan.strategy === 'fail') {
          return { ...result, error: replan.reason }
        }

        return { ...result, error: replan.reason }
      }
    }

    try {
      const results = await this.scheduler.executePlan(plan, executor)

      // 为因上游失败而被阻塞的任务写入状态并广播事件
      for (const result of results) {
        if (result.status === 'blocked') {
          const task = plan.tasks.find((t) => t.id === result.taskId)
          if (task) {
            await db
              .update(workspaceTasks)
              .set({ status: 'blocked', completedAt: new Date(), errorLog: result.error })
              .where(eq(workspaceTasks.id, task.id))
            await emitRunEvent({
              runId,
              workspaceId,
              groupSessionId,
              taskId: task.id,
              agentId: task.agentId,
              type: 'task.failed',
              severity: 'warning',
              payload: { title: task.title, error: result.error, reason: 'blocked_by_dependency' },
            })
            broadcastSessionEvent(groupSessionId, {
              type: 'task:update',
              payload: { taskId: task.id, status: 'blocked', error: result.error },
            })
          }
        }
      }

      const [currentRun] = await db
        .select({ status: orchestratorRuns.status })
        .from(orchestratorRuns)
        .where(eq(orchestratorRuns.id, runId))
        .limit(1)
      if (currentRun?.status === 'cancelled') {
        logger.info({ runId }, 'Orchestrator run cancelled before synthesis')
        return
      }

      // Task #37: Auto-review chain — code tasks 完成后自动注入 review 任务
      // 修复 Bug 23: 使用 scheduler 的 run signal，使 auto-review 可被取消
      const reviewSignal = this.scheduler.getRunSignal(runId) ?? new AbortController().signal
      const reviewResults = await this.injectAutoReviewTasks(
        plan, results, childSessions, runId, groupSessionId, workspaceId, ownerId, reviewSignal,
      )
      if (reviewResults.length > 0) {
        results.push(...reviewResults)
      }

      // 冲突检测与解决：遍历所有有 projectPath 的任务目录
      const projectPaths = new Set<string>()
      for (const task of plan.tasks) {
        const path = childSessions.get(task.id)?.projectPath
        if (path) projectPaths.add(path)
      }

      const conflictReports: import('./conflict-resolver').ConflictReport[] = []
      for (const projectPath of projectPaths) {
        const reports = await this.conflictResolver.detectAndResolve(results, {
          projectPath,
          baseBranch: await gitBranchManager.inferBaseBranch(projectPath),
        })
        conflictReports.push(...reports)
      }

      if (conflictReports.length > 0) {
        for (const report of conflictReports) {
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            type: 'conflict.detected',
            severity: report.resolution === 'needs-human' ? 'warning' : 'info',
            payload: {
              filePath: report.filePath,
              resolution: report.resolution,
              agents: report.variants.map((variant) => ({ agentId: variant.agentId, agentName: variant.agentName })),
            },
          })
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            type: 'conflict.resolved',
            severity: report.resolution === 'needs-human' ? 'warning' : 'info',
            payload: { filePath: report.filePath, resolution: report.resolution, notes: report.notes },
          })
        }
        await db
          .update(orchestratorRuns)
          .set({ conflictReport: conflictReports as unknown as import('@agenthub/db').ConflictReport[] })
          .where(eq(orchestratorRuns.id, runId))
      }

      await this.synthesizeAndReport(runId, groupSessionId, workspaceId, plan, results, conflictReports)
    } catch (error: any) {
      logger.error({ err: error?.message, runId }, 'Scheduler execution failed')
      await db.update(orchestratorRuns).set({ status: 'failed' }).where(eq(orchestratorRuns.id, runId))
      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        type: 'run.failed',
        severity: 'error',
        payload: { error: error?.message || 'Scheduler execution failed' },
      })
    } finally {
      if (OrchestratorEngine.activeEngines.get(runId) === this) {
        OrchestratorEngine.activeEngines.delete(runId)
      }
      // Run 结束，清理黑板内存缓存
      blackboard.clearNamespace(Blackboard.namespace(workspaceId, runId))
    }
  }

  private async executeTask(
    task: ExecutionTask,
    plan: ExecutionPlan,
    childSessions: Map<string, ChildSessionInfo>,
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    signal: AbortSignal,
    attemptCount = 0,
  ): Promise<TaskResult> {
    const agent = plan.agents.find((a) => a.id === task.agentId)
    if (!agent) {
      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        taskId: task.id,
        agentId: task.agentId,
        type: 'task.failed',
        severity: 'error',
        payload: { title: task.title, error: `Agent ${task.agentId} not found in plan` },
      })
      return {
        taskId: task.id,
        agentId: task.agentId,
        agentName: 'Unknown',
        status: 'failed',
        output: `Agent ${task.agentId} not found in plan`,
        artifacts: [],
      }
    }

    const childInfo = childSessions.get(task.id)
    if (!childInfo) {
      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        taskId: task.id,
        agentId: agent.id,
        type: 'task.failed',
        severity: 'error',
        payload: { title: task.title, error: `Child session not found for task ${task.id}` },
      })
      return {
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        status: 'failed',
        output: `Child session not found for task ${task.id}`,
        artifacts: [],
      }
    }

    // === Git 分支隔离 ===
    let branchCtx: import('../git/branch-manager').BranchContext | null = null
    const projectPath = childInfo.projectPath ?? undefined
    const needBranch = agent.sandboxPolicy !== 'read-only' && projectPath

    if (needBranch) {
      try {
        branchCtx = await gitBranchManager.prepareBranch(projectPath, runId, agent.key || agent.id, task.id)
        logger.info({ branch: branchCtx.branch, agent: agent.name }, 'Agent branch prepared')
      } catch (err: any) {
        logger.error({ err: err?.message, projectPath, agent: agent.name }, 'Failed to prepare agent branch')
        await db
          .update(workspaceTasks)
          .set({ status: 'failed', completedAt: new Date(), errorLog: `Git worktree 创建失败：${err?.message || '未知错误'}` })
          .where(eq(workspaceTasks.id, task.id))
        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          taskId: task.id,
          agentId: agent.id,
          type: 'task.failed',
          severity: 'error',
          payload: { title: task.title, error: `Git worktree 创建失败：${err?.message || '未知错误'}` },
        })
        broadcastSessionEvent(groupSessionId, {
          type: 'task:update',
          payload: { taskId: task.id, status: 'failed', error: `Git worktree 创建失败：${err?.message || '未知错误'}` },
        })
        return {
          taskId: task.id,
          agentId: agent.id,
          agentName: agent.name,
          status: 'failed',
          output: '',
          artifacts: [],
          error: `Git worktree 创建失败：${err?.message || '未知错误'}`,
        }
      }
    }

    const profile = {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      color: agent.color,
      modelId: agent.modelId,
      runtimeType: agent.runtimeType,
      codeAgentType: agent.codeAgentType,
      capabilityTags: agent.capabilityTags,
      toolPermissions: agent.toolPermissions,
      sandboxPolicy: agent.sandboxPolicy,
      contextPolicy: 'workspace-aware' as const,
      approvalRequired: agent.sandboxPolicy === 'danger-full-access',
      projectPath: branchCtx?.worktreePath ?? childInfo.projectPath ?? null,
      originalProjectPath: childInfo.projectPath ?? null,
    }

    const bbNamespace = Blackboard.namespace(workspaceId, runId)

    await executionTracer.log({
      runId,
      sessionId: childInfo.sessionId,
      agentId: agent.id,
      taskId: task.id,
      type: 'task_start',
      input: { taskTitle: task.title, attemptCount },
    })

    const prompt = await buildTaskPrompt(task, plan, bbNamespace)

    const [userMsg] = await db
      .insert(messages)
      .values({
        sessionId: childInfo.sessionId,
        senderId: 'user',
        senderType: 'user',
        type: 'text',
        content: prompt,
      })
      .returning()

    if (!userMsg) {
      if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
      return {
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        status: 'failed',
        output: 'Failed to create user message in child session',
        artifacts: [],
      }
    }

    await db
      .update(workspaceTasks)
      .set({ status: 'running', startedAt: new Date(), retryCount: attemptCount })
      .where(eq(workspaceTasks.id, task.id))

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      taskId: task.id,
      agentId: agent.id,
      type: 'task.started',
      payload: { title: task.title, agentName: agent.name, attempt: attemptCount, sessionId: childInfo.sessionId },
    })

    broadcastSessionEvent(groupSessionId, {
      type: 'task:update',
      payload: { taskId: task.id, status: 'running', sessionId: childInfo.sessionId },
    })

    const taskStartTime = Date.now()

    // 构造 AgentExecutionEnvelope，强制追踪每次执行上下文
    const envelope: import('../execution/agent-execution-envelope').AgentExecutionEnvelope = {
      runId,
      taskId: task.id,
      agentId: agent.id,
      agentName: agent.name,
      projectPath: childInfo.projectPath ?? null,
      worktreePath: branchCtx?.worktreePath ?? null,
      sandboxPolicy: agent.sandboxPolicy,
      envAllowlist: [], // 使用 code-agent-adapter.ts 中的 DEFAULT_ENV_ALLOWLIST
    }

    try {
      // 修复 Bug 8: LLM 任务添加超时，防止死锁
      const TASK_TIMEOUT_MS = 300_000 // 5 分钟
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`任务执行超时（${TASK_TIMEOUT_MS / 1000}秒）`)), TASK_TIMEOUT_MS)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('任务已取消')) }, { once: true })
      })
      const result = await Promise.race([runAgentReply(childInfo.sessionId, userMsg, profile, envelope), timeoutPromise])

      // 修复 Bug 7: 检查 Agent 执行结果，如果失败则抛出错误
      if (!result.ok) {
        throw new Error(result.cancelled ? '任务被取消' : 'Agent 执行失败，请检查日志')
      }

      if (signal.aborted || result.cancelled) {
        await db
          .update(workspaceTasks)
          .set({ status: 'cancelled', completedAt: new Date() })
          .where(eq(workspaceTasks.id, task.id))
        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          taskId: task.id,
          agentId: agent.id,
          type: 'task.cancelled',
          severity: 'warning',
          payload: { title: task.title, agentName: agent.name, sessionId: childInfo.sessionId },
        })
        if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
        return {
          taskId: task.id,
          agentId: agent.id,
          agentName: agent.name,
          status: 'cancelled',
          output: 'Task was cancelled',
          artifacts: [],
        }
      }

      const lastAgentMsg = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, childInfo.sessionId))
        .orderBy(desc(messages.createdAt))
        .limit(1)

      const output = lastAgentMsg[0]?.content ?? ''
      const artifacts: Array<Record<string, unknown>> = []

      // 收集 Git 变更作为 artifact
      // 修复 Bug 21: 按文件获取 diff，避免全仓库 diff 重复
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
                title: `${agent.name} 修改了 ${filePath}`,
                filePath,
                status,
                diff: fileDiff,
                source: agent.name,
              })
            }
          }
        } catch (err: any) {
          logger.error({ err: err?.message, taskId: task.id }, 'Failed to collect git diff')
        }
      }

      // 合并已有 artifacts
      const msgArtifacts = (lastAgentMsg[0]?.metadata as Record<string, unknown> | null)?.artifacts as Array<Record<string, unknown>> | undefined
      if (msgArtifacts) {
        artifacts.push(...msgArtifacts)
      }

      const taskDuration = Date.now() - taskStartTime
      await executionTracer.log({
        runId,
        sessionId: childInfo.sessionId,
        agentId: agent.id,
        taskId: task.id,
        type: 'task_end',
        output: { status: 'done', outputLength: output.length, durationMs: taskDuration },
      })

      // 生成结构化摘要（接口契约），供下游任务高效引用
      const summary = await summarizeTaskOutput(output, artifacts, agent.name, task.title)

      // 写入黑板：任务产出（含结构化摘要）
      const outputRef = await blackboard.write({
        namespace: bbNamespace,
        key: `task_${task.id}_output`,
        value: {
          schemaType: 'task_output',
          summary: summary.brief || `${task.title} completed`,
          confidence: 0.8,
          sourceAgentId: agent.id,
          taskId: task.id,
          output,
          summaryData: summary,
          artifacts,
          agentId: agent.id,
          agentName: agent.name,
          taskTitle: task.title,
        },
        agentId: agent.id,
        taskId: task.id,
        tags: ['task_output', `agent_${agent.id}`],
      })

      for (const [index, decision] of summary.decisions.entries()) {
        await blackboard.write({
          namespace: bbNamespace,
          key: `decisions/${task.id}/${index + 1}`,
          value: {
            schemaType: 'decision',
            summary: decision.slice(0, 180),
            confidence: 0.7,
            sourceAgentId: agent.id,
            taskId: task.id,
            decision,
            rationale: `Extracted from ${agent.name}'s task output.`,
            alternatives: [],
          },
          agentId: agent.id,
          taskId: task.id,
          tags: ['decision', `agent_${agent.id}`],
        })
      }

      const changedFiles = [...new Set([...summary.filesCreated, ...summary.filesModified])]
      if (changedFiles.length > 0) {
        await blackboard.write({
          namespace: bbNamespace,
          key: `diffs/${task.id}`,
          value: {
            schemaType: 'diff_summary',
            summary: `${agent.name} changed ${changedFiles.length} file(s).`,
            confidence: 0.8,
            sourceAgentId: agent.id,
            taskId: task.id,
            changedFiles,
            branchName: branchCtx?.branch,
          },
          agentId: agent.id,
          taskId: task.id,
          tags: ['diff_summary', `agent_${agent.id}`],
        })
      }

      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        taskId: task.id,
        agentId: agent.id,
        type: 'blackboard.written',
        payload: {
          namespace: bbNamespace,
          key: `task_${task.id}_output`,
          version: outputRef.version,
          summary: summary.brief,
          agentName: agent.name,
          taskTitle: task.title,
        },
      })

      for (const artifact of artifacts) {
        const artifactId = typeof artifact.id === 'string' && artifact.id ? artifact.id : `artifact-${task.id}`
        const artifactKind = String(artifact.kind ?? artifact.type ?? 'artifact')
        const artifactTitle = String(artifact.title ?? artifactId)
        await blackboard.write({
          namespace: bbNamespace,
          key: `artifacts/${artifactId}`,
          value: {
            schemaType: 'artifact_ref',
            summary: artifactTitle,
            confidence: 0.8,
            sourceAgentId: agent.id,
            taskId: task.id,
            artifactId,
            artifactKind,
            title: artifactTitle,
            filePath: typeof artifact.filePath === 'string' ? artifact.filePath : typeof artifact.path === 'string' ? artifact.path : undefined,
          },
          agentId: agent.id,
          taskId: task.id,
          tags: ['artifact_ref', `agent_${agent.id}`],
        })
        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          taskId: task.id,
          agentId: agent.id,
          type: 'artifact.created',
          payload: {
            artifactId,
            artifactKind,
            title: artifactTitle,
            filePath: artifact.filePath ?? artifact.path,
            agentName: agent.name,
          },
        })
      }

      // 修复 Bug 24: 没有有效项目路径时跳过 validation，避免在服务器 CWD 执行
      const validationCwd = branchCtx?.worktreePath ?? childInfo.projectPath ?? null
      const validationResults = validationCwd
        ? await runTaskValidation({
            commands: task.validation?.commands ?? [],
            cwd: validationCwd,
          })
        : []
      for (const [index, validation] of validationResults.entries()) {
        const validationKey = `tests/${task.id}/${index + 1}`
        await blackboard.write({
          namespace: bbNamespace,
          key: validationKey,
          value: {
            schemaType: 'test_result',
            summary: `${validation.command}: ${validation.status}`,
            confidence: 1,
            sourceAgentId: agent.id,
            taskId: task.id,
            command: validation.command,
            status: validation.status,
            outputSummary: validation.outputSummary,
          },
          agentId: agent.id,
          taskId: task.id,
          tags: ['test_result', `agent_${agent.id}`],
        })
        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          taskId: task.id,
          agentId: agent.id,
          type: 'blackboard.written',
          severity: validation.status === 'failed' ? 'warning' : 'info',
          payload: {
            namespace: bbNamespace,
            key: validationKey,
            schemaType: 'test_result',
            command: validation.command,
            status: validation.status,
            durationMs: validation.durationMs,
          },
        })
      }
      const failedValidation = validationResults.find((result) => result.status === 'failed')
      if (failedValidation) {
        throw new Error(`Validation failed: ${failedValidation.command}`)
      }

      const contractResult = validateTaskOutputContract({
        task,
        artifacts,
        writtenBlackboardKeys: [
          `task_${task.id}_output`,
          ...summary.decisions.map((_, index) => `decisions/${task.id}/${index + 1}`),
          ...(changedFiles.length > 0 ? [`diffs/${task.id}`] : []),
          ...artifacts.map((artifact) => {
            const artifactId = typeof artifact.id === 'string' && artifact.id ? artifact.id : `artifact-${task.id}`
            return `artifacts/${artifactId}`
          }),
          ...validationResults.map((_, index) => `tests/${task.id}/${index + 1}`),
        ],
      })
      if (contractResult.status === 'failed') {
        await blackboard.write({
          namespace: bbNamespace,
          key: `risks/${task.id}/contract`,
          value: {
            schemaType: 'risk',
            summary: `Task contract failed with ${contractResult.violations.length} violation(s).`,
            confidence: 1,
            sourceAgentId: agent.id,
            taskId: task.id,
            risk: contractResult.violations.map((violation) => violation.message).join('\n'),
            severity: 'high',
            mitigation: 'Review the task output contract, allowed paths, and produced artifacts before accepting this task.',
          },
          agentId: agent.id,
          taskId: task.id,
          tags: ['risk', 'contract_violation', `agent_${agent.id}`],
        })
        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          taskId: task.id,
          agentId: agent.id,
          type: 'task.failed',
          severity: 'error',
          payload: {
            title: task.title,
            agentName: agent.name,
            error: `Task output contract failed: ${contractResult.violations[0]?.message ?? 'unknown violation'}`,
            violations: contractResult.violations,
          },
        })
        throw new Error(`Task output contract failed: ${contractResult.violations[0]?.message ?? 'unknown violation'}`)
      }

      // 广播黑板更新到群聊会话
      broadcastSessionEvent(groupSessionId, {
        type: 'blackboard:update',
        payload: {
          namespace: bbNamespace,
          key: `task_${task.id}_output`,
          version: outputRef.version,
          agentId: agent.id,
          agentName: agent.name,
          taskId: task.id,
          taskTitle: task.title,
          summary: output.slice(0, 200),
        },
      })

      await db
        .update(workspaceTasks)
        .set({
          status: 'done',
          completedAt: new Date(),
          artifacts: (artifacts as unknown as import('@agenthub/db').AgentArtifact[]) ?? [],
        })
        .where(eq(workspaceTasks.id, task.id))

      broadcastSessionEvent(groupSessionId, {
        type: 'task:update',
        payload: { taskId: task.id, status: 'done', sessionId: childInfo.sessionId, agentId: agent.id, agentName: agent.name },
      })

      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        taskId: task.id,
        agentId: agent.id,
        type: 'task.completed',
        payload: {
          title: task.title,
          agentName: agent.name,
          sessionId: childInfo.sessionId,
          durationMs: taskDuration,
          artifactCount: artifacts.length,
        },
      })

      if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)

      return {
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        status: 'done',
        output,
        artifacts,
        outputRef,
      }
    } catch (error: any) {
      await executionTracer.log({
        runId,
        sessionId: childInfo.sessionId,
        agentId: agent.id,
        taskId: task.id,
        type: 'error',
        output: { taskTitle: task.title, error: error?.message, durationMs: Date.now() - taskStartTime },
      })
      await db
        .update(workspaceTasks)
        .set({ status: 'failed', completedAt: new Date(), errorLog: error?.message || 'Unknown error' })
        .where(eq(workspaceTasks.id, task.id))

      broadcastSessionEvent(groupSessionId, {
        type: 'task:update',
        payload: { taskId: task.id, status: 'failed', sessionId: childInfo.sessionId, agentId: agent.id, agentName: agent.name, error: error?.message || 'Unknown error' },
      })

      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        taskId: task.id,
        agentId: agent.id,
        type: 'task.failed',
        severity: 'error',
        payload: {
          title: task.title,
          agentName: agent.name,
          sessionId: childInfo.sessionId,
          error: error?.message || 'Unknown error',
          durationMs: Date.now() - taskStartTime,
        },
      })

      if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
      return {
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        status: 'failed',
        output: '',
        artifacts: [],
        error: error?.message || 'Unknown error',
      }
    }
  }

  /**
   * Auto-review chain: 为 code 类型且 requiresReview 的已完成任务自动注入 review 任务
   */
  private async injectAutoReviewTasks(
    plan: ExecutionPlan,
    results: TaskResult[],
    childSessions: Map<string, ChildSessionInfo>,
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<TaskResult[]> {
    const reviewResults: TaskResult[] = []
    const codeTasksNeedingReview = plan.tasks.filter((task) => {
      if (task.taskType !== 'code' || !task.validation?.requiresReview) return false
      const result = results.find((r) => r.taskId === task.id)
      return result?.status === 'done' && result.output
    })

    if (codeTasksNeedingReview.length === 0) return reviewResults

    // Find a reviewer agent (prefer one with 'review' in role/tags)
    const firstCodeTask = codeTasksNeedingReview[0]!
    const reviewedBy = plan.agentRelations?.find((relation) =>
      relation.sourceAgentId === firstCodeTask.agentId && relation.relationType === 'reviewed_by'
    )
    const reviewerAgent = (reviewedBy ? plan.agents.find((agent) => agent.id === reviewedBy.targetAgentId) : undefined)
      ?? plan.agents.find((agent) => agent.roleType === 'reviewer')
      ?? plan.agents.find((a) => {
      const text = [a.name, a.role, a.description, ...(a.capabilityTags ?? [])].filter(Boolean).join(' ').toLowerCase()
      return text.includes('review') || text.includes('审查') || text.includes('test')
    }) ?? plan.agents.find((a) => a.id !== firstCodeTask.agentId) ?? plan.agents[0]

    if (!reviewerAgent) return reviewResults

    for (const codeTask of codeTasksNeedingReview) {
      const codeResult = results.find((r) => r.taskId === codeTask.id)
      if (!codeResult) continue

      const reviewTaskId = `review-${codeTask.id}`
      // Skip if already exists
      if (plan.tasks.some((t) => t.id === reviewTaskId)) continue

      // Create review task
      const reviewTask: ExecutionTask = {
        id: reviewTaskId,
        title: `审查 ${codeTask.title}`,
        description: `审查「${codeTask.title}」的代码变更质量、安全性和最佳实践。关注：代码风格一致性、潜在bug、安全漏洞、性能问题。`,
        agentId: reviewerAgent.id,
        dependencies: [codeTask.id],
        taskType: 'review',
        maxRetries: 1,
      }

      // Create child session for review
      const reviewSession = await ensureChildSession(workspaceId, plan.title, ownerId, reviewerAgent, reviewTask.title)
      childSessions.set(reviewTaskId, {
        sessionId: reviewSession.id,
        workspaceId,
        projectPath: childSessions.get(codeTask.id)?.projectPath,
      })

      // Insert into DB
      await db.insert(workspaceTasks).values({
        id: reviewTaskId,
        workspaceId,
        agentId: reviewerAgent.id,
        title: reviewTask.title,
        description: reviewTask.description,
        status: 'pending',
        orderIdx: plan.tasks.length,
        runId,
        dependencies: [codeTask.id],
        maxRetries: 1,
      })

      plan.tasks.push(reviewTask)

      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        taskId: reviewTaskId,
        agentId: reviewerAgent.id,
        type: 'task.queued',
        severity: 'info',
        payload: { title: reviewTask.title, reason: 'Auto-review after code task', parentTaskId: codeTask.id },
      })

      // Execute the review task
      const reviewResult = await this.executeTask(reviewTask, plan, childSessions, runId, groupSessionId, workspaceId, signal, 0)
      reviewResults.push(reviewResult)

      logger.info({ reviewTaskId, codeTaskId: codeTask.id, status: reviewResult.status }, 'Auto-review task completed')
    }

    return reviewResults
  }

  private async synthesizeAndReport(
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    plan: ExecutionPlan,
    results: TaskResult[],
    conflictReports: import('./conflict-resolver').ConflictReport[] = [],
  ) {
    await db.update(orchestratorRuns).set({ status: 'synthesizing' }).where(eq(orchestratorRuns.id, runId))
    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      type: 'run.synthesizing',
      payload: {
        taskCount: results.length,
        succeeded: results.filter((result) => result.status === 'done').length,
        failed: results.filter((result) => result.status === 'failed').length,
      },
    })

    // 从黑板读取所有产物，供 Synthesizer 使用（替代直接从 results 读取）
    const bbNamespace = Blackboard.namespace(workspaceId, runId)
    const typedBlackboardEntries = await blackboard.query({ namespace: bbNamespace, orderBy: 'asc' })
    const bbResults = typedBlackboardEntries.filter((entry) => entry.key.startsWith('task_') && entry.key.endsWith('_output'))
    const enrichedResults: TaskResult[] = results.map((r) => {
      const bbEntry = bbResults.find((e) => e.key === `task_${r.taskId}_output`)
      if (bbEntry) {
        const val = bbEntry.value as { output: string; artifacts: Array<Record<string, unknown>> }
        return { ...r, output: val.output, artifacts: val.artifacts, outputRef: { namespace: bbNamespace, key: bbEntry.key, version: bbEntry.version } }
      }
      return r
    })

    const summary = await this.synthesizer.synthesize(plan, enrichedResults, conflictReports, typedBlackboardEntries)

    // 检查是否有未通过的 review 或 validation，决定是否允许合并提示
    const failedReviews = enrichedResults.filter(
      (r) => r.taskId.startsWith('review-') && (r.status === 'failed' || r.status === 'blocked')
    )
    const failedValidations = enrichedResults.filter(
      (r) => r.status === 'failed' && r.error?.includes('Validation')
    )
    const hasPendingMergeBlockers = failedReviews.length > 0 || failedValidations.length > 0 || conflictReports.length > 0

    const mergeNotice = hasPendingMergeBlockers
      ? `

---
⚠️ **代码尚未合并到主分支**

当前代码变更仅存在于隔离分支（Git worktree）中，尚未自动合并回原项目目录。原因：
${failedReviews.length > 0 ? `- ${failedReviews.length} 个审查任务未通过\n` : ''}${failedValidations.length > 0 ? `- ${failedValidations.length} 个验证任务失败\n` : ''}${conflictReports.length > 0 ? `- 检测到 ${conflictReports.length} 个文件冲突未解决\n` : ''}
请先解决上述问题后，在「运行历史」页面手动确认应用变更。
`
      : `

---
✅ **代码已审查通过，可手动合并**

所有审查和验证任务已完成。代码变更仍保留在隔离分支中，尚未自动合并。
如需应用变更，请前往「运行历史」页面手动确认。
`

    const finalSummary = summary + mergeNotice

    const [summaryMsg] = await db
      .insert(messages)
      .values({
        sessionId: groupSessionId,
        senderId: 'orchestrator',
        senderType: 'agent',
        type: 'text',
        content: finalSummary,
        metadata: {
          agentName: 'Orchestrator',
          role: 'Coordinator',
          runtimeType: 'llm',
          orchestratorSummary: {
            dispatchId: runId,
            taskIds: plan.tasks.map((t) => t.id),
            workspaceId,
            mergeBlocked: hasPendingMergeBlockers,
            failedReviewCount: failedReviews.length,
            failedValidationCount: failedValidations.length,
            unresolvedConflictCount: conflictReports.length,
          },
        },
      })
      .returning()

    await db
      .update(orchestratorRuns)
      .set({ status: 'completed', summaryMessageId: summaryMsg?.id ?? null })
      .where(eq(orchestratorRuns.id, runId))

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      type: 'run.completed',
      payload: { summaryMessageId: summaryMsg?.id ?? null, taskCount: results.length },
    })

    broadcastSessionEvent(groupSessionId, {
      type: 'message:completed',
      payload: { sessionId: groupSessionId, message: summaryMsg },
    })
  }
}

async function ensureChildSession(
  workspaceId: string,
  workspaceName: string,
  ownerId: string,
  agent: { id: string; name: string } | null,
  taskTitle?: string
) {
  // Orchestrator 场景下不复用已有 session，每个任务独立上下文
  const [created] = await db
    .insert(sessions)
    .values({
      title: agent ? `${workspaceName} / ${agent.name} / ${taskTitle?.slice(0, 24) || 'Task'}` : `${workspaceName} / ${taskTitle?.slice(0, 24) || 'Agent'}`,
      type: 'direct',
      ownerId,
      workspaceId,
      workspaceAgentId: agent?.id ?? null,
    })
    .returning()
  if (!created) throw new Error('Failed to create agent child session')
  return created
}

async function buildTaskPrompt(task: ExecutionTask, plan: ExecutionPlan, bbNamespace: string): Promise<string> {
  const agent = plan.agents.find((a) => a.id === task.agentId)

  // 从黑板读取上游任务的产出，作为上下文注入
  let upstreamContext = ''
  if (task.dependencies.length > 0) {
    const upstreamEntries = await blackboard.query({
      namespace: bbNamespace,
      keyPattern: 'task_%_output',
    })
    const relevant = upstreamEntries.filter((e) => {
      const depId = e.key.replace(/^task_/, '').replace(/_output$/, '')
      return task.dependencies.includes(depId)
    })

    if (relevant.length > 0) {
      upstreamContext =
        '\n\n【前置依赖产出】\n' +
        relevant
          .map((e) => {
            const val = e.value as {
              output: string
              summary?: TaskOutputSummary | string
              summaryData?: TaskOutputSummary
              agentName: string
              taskTitle: string
              artifacts?: Array<{ type?: string; diff?: string; filePath?: string; path?: string }>
            }
            // 优先使用结构化摘要，信息密度更高；回退到截断原文
            let text = `--- 来自 ${val.agentName}（${val.taskTitle}）---\n`
            const summaryData = val.summaryData ?? (typeof val.summary === 'object' ? val.summary : undefined)
            if (summaryData) {
              text += formatSummary(summaryData)
            } else {
              text += (val.output || '').slice(0, 4000)
            }
            const codeArtifacts = val.artifacts?.filter((a) => isArtifactKind(a, 'diff') || isArtifactKind(a, 'file')) ?? []
            if (codeArtifacts.length > 0) {
              text +=
                '\n\n[代码变更]\n' +
                codeArtifacts
                  .map((a) => {
                    if (isArtifactKind(a, 'diff') && a.diff) return `\`\`\`diff\n// ${a.filePath || 'unknown'}\n${a.diff.slice(0, 3000)}\n\`\`\``
                    return `// ${a.path || a.filePath || 'unknown'}`
                  })
                  .join('\n\n')
            }
            return text
          })
          .join('\n\n') +
        '\n【前置依赖结束】\n'
    }
  }

  return [
    agent ? `你是 ${agent.name}(${agent.role})。${agent.systemPrompt || ''}` : '你是 AgentHub 协作 Agent。',
    `\n协作目标: ${plan.goal}`,
    `\n当前子任务: ${task.title}`,
    `\n任务说明: ${task.description}`,
    task.dependencies.length ? `\n前置依赖任务: ${task.dependencies.join(', ')}` : '',
    upstreamContext,
    '\n请先给出简短工作计划，再产出结果。遇到需要其他 Agent 配合的内容，请在结尾用「需协作:」列出。',
  ]
    .filter(Boolean)
    .join('')
}

interface TaskOutputSummary {
  filesCreated: string[]
  filesModified: string[]
  interfaces: Array<{ file: string; name: string; signature: string }>
  dependencies: string[]
  decisions: string[]
  brief: string
}

function formatSummary(s: TaskOutputSummary): string {
  const parts: string[] = [s.brief]
  if (s.filesCreated.length) parts.push(`新建文件: ${s.filesCreated.join(', ')}`)
  if (s.filesModified.length) parts.push(`修改文件: ${s.filesModified.join(', ')}`)
  if (s.interfaces.length) {
    parts.push('关键接口:\n' + s.interfaces.map((i) => `  - ${i.name} (${i.file})`).join('\n'))
  }
  if (s.dependencies.length) parts.push(`依赖: ${s.dependencies.join(', ')}`)
  if (s.decisions.length) parts.push(`设计决策:\n` + s.decisions.map((d) => `  - ${d}`).join('\n'))
  return parts.join('\n')
}

async function summarizeTaskOutput(
  output: string,
  artifacts: Array<Record<string, unknown>>,
  agentName: string,
  taskTitle: string,
): Promise<TaskOutputSummary> {
  // 短产出直接回退，避免不必要的 LLM 调用
  if (output.length < 2000 && artifacts.length === 0) {
    return {
      filesCreated: [],
      filesModified: [],
      interfaces: [],
      dependencies: [],
      decisions: [],
      brief: output.slice(0, 600),
    }
  }

  // 从 artifacts 提取文件变更
  const codeArtifacts = artifacts.filter((a) => isArtifactKind(a, 'diff') || isArtifactKind(a, 'file'))
  const filesCreated: string[] = []
  const filesModified: string[] = []
  for (const a of codeArtifacts) {
    const fp = (a.filePath || a.path) as string | undefined
    if (!fp) continue
    const status = a.status as string | undefined
    if (status === 'created') filesCreated.push(fp)
    else if (status === 'modified') filesModified.push(fp)
    else if (!status && isArtifactKind(a, 'diff')) {
      const diff = (a.diff as string) || ''
      if (/^---\s+\/dev\/null/m.test(diff)) filesCreated.push(fp)
      else filesModified.push(fp)
    } else {
      filesModified.push(fp)
    }
  }

  // 如果产出不长，直接提取关键信息，不走 LLM
  if (output.length < 4000) {
    const lines = output.split('\n')
    const decisions = lines
      .filter((l) => /^[\s]*[-*]\s+(决定|采用|选择|使用|方案|设计|决策)/i.test(l) || /^(决定|采用|选择|使用|方案|设计|决策)/i.test(l))
      .map((l) => l.trim().replace(/^[\s]*[-*]\s*/, ''))
      .slice(0, 6)
    const interfaces: Array<{ file: string; name: string; signature: string }> = []
    const ifaceRegex = /(?:export\s+)?(?:interface|class|function|type|const|let|var)\s+(\w+)/g
    const codeBlocks = output.match(/```[\w]*\n([\s\S]*?)```/g) || []
    for (const block of codeBlocks) {
      let m: RegExpExecArray | null
      while ((m = ifaceRegex.exec(block)) !== null) {
        interfaces.push({ file: '', name: m[1] || '', signature: m[0] || '' })
      }
    }
    return {
      filesCreated: [...new Set(filesCreated)],
      filesModified: [...new Set(filesModified)],
      interfaces: interfaces.slice(0, 10),
      dependencies: [],
      decisions,
      brief: output.slice(0, 600),
    }
  }

  // 长产出调用 LLM 生成结构化摘要
  try {
    const { streamReply } = await import('../llm')
    const artifactFiles = codeArtifacts.map((a) => a.filePath || a.path || 'unknown').join('\n')
    const prompt = `请分析以下 Agent 任务产出，提取关键结构化信息。

任务: ${taskTitle} (${agentName})

原始产出摘要:
${output.slice(0, 8000)}

代码变更文件:
${artifactFiles || '无'}

请返回 JSON（不要 Markdown 代码块）：
{
  "filesCreated": ["文件路径"],
  "filesModified": ["文件路径"],
  "interfaces": [{"file": "文件路径", "name": "接口名", "signature": "签名"}],
  "dependencies": ["依赖模块"],
  "decisions": ["设计决策"],
  "brief": "200字以内的任务总结"
}`
    let llmOutput = ''
    for await (const delta of streamReply([{ role: 'user', content: prompt }], '你是代码分析助手，擅长从文本中提取结构化信息。')) {
      llmOutput += delta
      if (llmOutput.length > 6000) break
    }
    const jsonText = extractJsonObject(llmOutput)
    if (jsonText) {
      const parsed = JSON.parse(jsonText) as Partial<TaskOutputSummary>
      return {
        filesCreated: parsed.filesCreated ?? filesCreated,
        filesModified: parsed.filesModified ?? filesModified,
        interfaces: parsed.interfaces ?? [],
        dependencies: parsed.dependencies ?? [],
        decisions: parsed.decisions ?? [],
        brief: parsed.brief ?? output.slice(0, 600),
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, agentName, taskTitle }, 'Failed to summarize task output via LLM')
  }

  // 回退：返回基于 artifacts 的摘要
  return {
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    interfaces: [],
    dependencies: [],
    decisions: [],
    brief: output.slice(0, 600),
  }
}

function extractJsonObject(value: string) {
  const cleaned = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}

function isArtifactKind(a: Record<string, unknown>, kind: string): boolean {
  return (a.kind as string | undefined) === kind || (a.type as string | undefined) === kind
}
