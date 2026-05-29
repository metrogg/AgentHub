import { db, messages, workspaceTasks, orchestratorRuns, taskClarifications, sessions, workspaces, eq, and, desc } from '@agenthub/db'
import { logger } from '../../lib/logger'
import { broadcastSessionEvent, runAgentReply } from '../agent-runner'
import { gitBranchManager } from '../git/branch-manager'
import { taskExecutionService } from '../execution/task-execution-service'
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
import type { CollaborationMode, ExecutionPlan, ExecutionTask, TaskResult } from './types'
import { PolicyGuard } from '../policy-guard'
import { intentRouter } from './intent-router'
import { streamReply } from '../llm'
import { buildAgentProfileWithWorktree } from '../agents/profile-builder'
import { createOrchestratorChildSession } from '../workspace/session-manager'
import { DEFAULT_ENV_ALLOWLIST } from '../execution/agent-execution-envelope'
import { WsEvent, TaskStatus, OrchestratorRunStatus } from '@agenthub/shared'

export { ExecutionPlan, ExecutionTask, TaskResult }

const TASK_TIMEOUT_MS = 300_000

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

  static async resumeRun(runId: string): Promise<void> {
    const run = await db.query.orchestratorRuns.findFirst({
      where: eq(orchestratorRuns.id, runId),
    })
    if (!run || run.status !== 'running') {
      console.warn(`[OrchestratorEngine] Cannot resume run ${runId}: status=${run?.status}`)
      return
    }

    const engine = new OrchestratorEngine()

    const plan = run.plan as ExecutionPlan

    const allTasks = await db.query.workspaceTasks.findMany({
      where: eq(workspaceTasks.runId, runId),
    })

    for (const task of allTasks) {
      if (task.status === 'running') {
        await db
          .update(workspaceTasks)
          .set({ status: 'pending' })
          .where(eq(workspaceTasks.id, task.id))
      }
    }

    const [workspaceRecord] = await db
      .select({ projectPath: workspaces.projectPath })
      .from(workspaces)
      .where(eq(workspaces.id, run.workspaceId))
      .limit(1)
    const projectPath = workspaceRecord?.projectPath ?? null

    const childSessions = new Map<string, ChildSessionInfo>()
    for (const task of allTasks) {
      if (task.sessionId) {
        childSessions.set(task.id, {
          sessionId: task.sessionId,
          workspaceId: run.workspaceId,
          projectPath,
        })
      }
    }

    const [groupSessionRecord] = await db
      .select({ ownerId: sessions.ownerId })
      .from(sessions)
      .where(eq(sessions.id, run.groupSessionId))
      .limit(1)
    const ownerId = groupSessionRecord?.ownerId ?? 'user'

    OrchestratorEngine.activeEngines.set(runId, engine)

    const pendingTasks = plan.tasks.filter((t) => {
      const dbTask = allTasks.find((dt) => dt.id === t.id)
      return dbTask && dbTask.status === 'pending'
    })

    if (pendingTasks.length === 0) {
      await engine.synthesizeAndReport(runId, run.groupSessionId, run.workspaceId, plan, [])
      return
    }

    const executor = engine.createTaskExecutor(runId, run.groupSessionId, run.workspaceId, plan, childSessions, ownerId)
    const mode: CollaborationMode = plan.collaborationMode ?? 'mapreduce'

    try {
      engine.scheduler.onPhaseCompleted = (phaseId: string, phaseTitle: string) => {
        emitRunEvent({
          runId,
          workspaceId: run.workspaceId,
          groupSessionId: run.groupSessionId,
          type: 'phase.completed' as any,
          severity: 'info',
          payload: { phaseId, phaseTitle },
        }).catch(() => {})
        broadcastSessionEvent(run.groupSessionId, {
          type: 'phase:completed' as any,
          payload: { runId, phaseId, phaseTitle, sessionId: run.groupSessionId },
        })
      }

      const results = await engine.scheduler.executePlan(
        { ...plan, tasks: pendingTasks },
        executor,
        mode,
      )

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
              workspaceId: run.workspaceId,
              groupSessionId: run.groupSessionId,
              taskId: task.id,
              agentId: task.agentId,
              type: 'task.failed',
              severity: 'warning',
              payload: { title: task.title, error: result.error, reason: 'blocked_by_dependency' },
            })
            broadcastSessionEvent(run.groupSessionId, {
              type: WsEvent.TaskUpdate,
              payload: { taskId: task.id, status: 'blocked', error: result.error, sessionId: run.groupSessionId },
            })
          }
        }
      }

      const [currentRun] = await db
        .select({ status: orchestratorRuns.status })
        .from(orchestratorRuns)
        .where(eq(orchestratorRuns.id, runId))
        .limit(1)
      if (currentRun?.status === OrchestratorRunStatus.Cancelled) {
        logger.info({ runId }, 'Orchestrator run cancelled before synthesis (resumed)')
        broadcastSessionEvent(run.groupSessionId, {
          type: 'task_board:run_completed',
          payload: {
            runId,
            status: OrchestratorRunStatus.Cancelled,
          },
        })
        return
      }

      await engine.synthesizeAndReport(runId, run.groupSessionId, run.workspaceId, plan, results)
    } catch (error: any) {
      logger.error({ err: error?.message, runId }, 'Resumed scheduler execution failed')
      await db
        .update(orchestratorRuns)
        .set({ status: OrchestratorRunStatus.Failed })
        .where(eq(orchestratorRuns.id, runId))
      broadcastSessionEvent(run.groupSessionId, {
        type: 'task_board:run_completed',
        payload: {
          runId,
          status: OrchestratorRunStatus.Failed,
        },
      })
      await emitRunEvent({
        runId,
        workspaceId: run.workspaceId,
        groupSessionId: run.groupSessionId,
        type: 'run.failed',
        severity: 'error',
        payload: { error: error?.message || 'Resumed scheduler execution failed' },
      })
    } finally {
      if (OrchestratorEngine.activeEngines.get(runId) === engine) {
        OrchestratorEngine.activeEngines.delete(runId)
      }
      blackboard.clearNamespace(Blackboard.namespace(run.workspaceId, runId))
    }
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
      .set({ status: TaskStatus.Pending, completedAt: null, errorLog: null })
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

    const result = await this.executeTask(
      task, plan, childSessions, runId, groupSessionId, workspaceId,
      this.scheduler.getRunSignal(runId) ?? new AbortController().signal,
      0,
    )

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
      .set({ status: OrchestratorRunStatus.Running, plan: plan as unknown as Record<string, unknown> })
      .where(eq(orchestratorRuns.id, runId))

    const [groupSessionRecord] = await db.select().from(sessions).where(eq(sessions.id, groupSessionId)).limit(1)
    const ownerId = groupSessionRecord?.ownerId ?? 'user'

    const executor = this.createTaskExecutor(runId, groupSessionId, workspaceId, plan, childSessions, ownerId)

    try {
      this.scheduler.onPhaseCompleted = (phaseId: string, phaseTitle: string) => {
        emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          type: 'phase.completed' as any,
          severity: 'info',
          payload: { phaseId, phaseTitle },
        }).catch(() => {})
        broadcastSessionEvent(groupSessionId, {
          type: 'phase:completed' as any,
          payload: { runId, phaseId, phaseTitle, sessionId: groupSessionId },
        })
      }

      const mode: CollaborationMode = plan.collaborationMode ?? 'mapreduce'
      const results = await this.scheduler.executePlan(plan, executor, mode)

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
              type: WsEvent.TaskUpdate,
              payload: { taskId: task.id, status: 'blocked', error: result.error, sessionId: groupSessionId },
            })
          }
        }
      }

      const [currentRun] = await db
        .select({ status: orchestratorRuns.status })
        .from(orchestratorRuns)
        .where(eq(orchestratorRuns.id, runId))
        .limit(1)
      if (currentRun?.status === OrchestratorRunStatus.Cancelled) {
        logger.info({ runId }, 'Orchestrator run cancelled before synthesis')
        broadcastSessionEvent(groupSessionId, {
          type: 'task_board:run_completed',
          payload: {
            runId,
            status: OrchestratorRunStatus.Cancelled,
          },
        })
        return
      }

      if (mode === 'supervisor') {
        let supervisorRound = 0
        const maxRounds = 3
        const bbSupervisorNs = Blackboard.namespace(workspaceId, runId)

        while (supervisorRound < maxRounds) {
          supervisorRound++

          const [runCheck] = await db
            .select({ status: orchestratorRuns.status })
            .from(orchestratorRuns)
            .where(eq(orchestratorRuns.id, runId))
            .limit(1)
          if (runCheck?.status === OrchestratorRunStatus.Cancelled) break

          const taskOutputs: { taskTitle: string; agentName: string; output: string }[] = []
          for (const task of plan.tasks) {
            const taskResult = results.find((r) => r.taskId === task.id)
            if (!taskResult || taskResult.status !== TaskStatus.Done) continue
            const agent = plan.agents.find((a) => a.id === task.agentId)
            try {
              const entry = await blackboard.read(bbSupervisorNs, `task_${task.id}_output`)
              if (entry) {
                const val = entry as { output: string }
                taskOutputs.push({
                  taskTitle: task.title,
                  agentName: agent?.name ?? task.agentId,
                  output: val.output,
                })
              }
            } catch {
              // Blackboard read skipped
            }
          }

          if (taskOutputs.length === 0) break

          const needMoreTasks = await this.evaluateSupervisorNeed(plan.goal, taskOutputs)
          if (!needMoreTasks) break

          const supplementPrompt = plan.tasks
            .filter((t) => results.find((r) => r.taskId === t.id && r.status === TaskStatus.Done))
            .map((t) => {
              const found = taskOutputs.find((o) => o.taskTitle === t.title)
              return `- ${t.title}: ${found?.output?.slice(0, 200) ?? 'completed'}`
            })
            .join('\n')

          const supplementGoal = `${plan.goal}\n\n已完成工作:\n${supplementPrompt}\n\n请根据已完成产出，生成 1-2 个补充任务，填补缺失或不足的部分。`

          try {
            const { buildDynamicOrchestratorPlan } = await import('./plan-generator')
            const supplementPlan = await buildDynamicOrchestratorPlan(
              supplementGoal,
              plan.agents as any,
              'supplement-' + runId,
            )

            if (!supplementPlan || !supplementPlan.tasks.length) break

            const newTasks: ExecutionTask[] = []
            for (const pt of supplementPlan.tasks) {
              const agent = plan.agents.find((a) => a.key === pt.agentKey)
              if (!agent) continue

              const task: ExecutionTask = {
                id: pt.id,
                title: pt.title,
                description: pt.description,
                agentId: agent.id,
                dependencies: pt.dependencies ?? [],
                taskType: pt.taskType,
                parallelGroup: pt.parallelGroup,
                maxRetries: pt.maxRetries ?? 2,
                phaseId: pt.phaseId,
              }

              const childSession = await createOrchestratorChildSession(
                workspaceId,
                plan.title,
                ownerId,
                agent,
                task.title,
              )
              childSessions.set(task.id, {
                sessionId: childSession.id,
                workspaceId,
                projectPath: childSessions.get(plan.tasks[0]?.id ?? '')?.projectPath,
              })

              await db.insert(workspaceTasks).values({
                id: task.id,
                workspaceId,
                agentId: task.agentId,
                title: task.title,
                description: task.description,
                status: TaskStatus.Pending,
                orderIdx: plan.tasks.length,
                runId,
                phaseId: task.phaseId,
                dependencies: task.dependencies,
                parallelGroup: task.parallelGroup,
                maxRetries: task.maxRetries,
              })

              newTasks.push(task)
            }

            this.scheduler.addTasksToRun(runId, newTasks)
            plan.tasks.push(...newTasks)

            await emitRunEvent({
              runId,
              workspaceId,
              groupSessionId,
              type: 'supervisor.inject' as any,
              severity: 'info',
              payload: { round: supervisorRound, newTaskIds: newTasks.map((t) => t.id) },
            })
          } catch (err: any) {
            logger.warn({ err: err?.message, runId, round: supervisorRound }, 'Supervisor supplement plan failed')
            break
          }
        }
      }

      // Task #37: Auto-review chain — code tasks 完成后自动注入 review 任务
      // 修复 Bug 23: 使用 scheduler 的 run signal，使 auto-review 可被取消
      const reviewSignal = this.scheduler.getRunSignal(runId) ?? new AbortController().signal
      const reviewResults = await this.injectAutoReviewTasks(
        plan, results, childSessions, runId, groupSessionId, workspaceId, ownerId, reviewSignal, executor,
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
      await db.update(orchestratorRuns).set({ status: OrchestratorRunStatus.Failed }).where(eq(orchestratorRuns.id, runId))
      broadcastSessionEvent(groupSessionId, {
        type: 'task_board:run_completed',
        payload: {
          runId,
          status: OrchestratorRunStatus.Failed,
        },
      })
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

  private createTaskExecutor(
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    plan: ExecutionPlan,
    childSessions: Map<string, ChildSessionInfo>,
    ownerId: string,
  ): TaskExecutor {
    return async (task, signal) => {
      let currentTask = task
      let currentAttempt = 0
      const taskExecutionStartedAt = Date.now()

      while (true) {
        const elapsed = Date.now() - taskExecutionStartedAt
        if (elapsed > 5 * TASK_TIMEOUT_MS) {
          logger.error({ taskId: currentTask.id, elapsedMs: elapsed, runId }, 'Task exceeded total time limit, forcing failure')
          return {
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            agentName: 'Unknown',
            status: TaskStatus.Failed,
            output: '',
            artifacts: [],
            error: `任务执行总耗时超过系统上限（${5 * TASK_TIMEOUT_MS / 1000}秒），已强制终止。`,
          }
        }

        const result = await this.executeTask(currentTask, plan, childSessions, runId, groupSessionId, workspaceId, signal, currentAttempt)
        if (result.status === TaskStatus.Done || result.status === TaskStatus.Cancelled) {
          return result
        }

        currentAttempt++
        if (currentAttempt > 5) {
          logger.error({ taskId: currentTask.id, currentAttempt, runId }, 'Task exceeded maximum replan attempts, forcing failure')
          return {
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            agentName: 'Unknown',
            status: TaskStatus.Failed,
            output: '',
            artifacts: [],
            error: '任务重试次数超过系统上限（5次），已强制终止。',
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
            await db.update(workspaceTasks).set({ status: TaskStatus.Pending, errorLog: replan.reason }).where(eq(workspaceTasks.id, currentTask.id))
            broadcastSessionEvent(groupSessionId, {
              type: WsEvent.TaskUpdate,
              payload: { taskId: currentTask.id, status: TaskStatus.Pending, attempt: currentAttempt, strategy: 'retry', sessionId: groupSessionId },
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
            await db.update(workspaceTasks).set({ agentId: currentTask.agentId, status: TaskStatus.Pending, retryCount: 0, errorLog: replan.reason }).where(eq(workspaceTasks.id, currentTask.id))
            broadcastSessionEvent(groupSessionId, {
              type: WsEvent.TaskUpdate,
              payload: { taskId: currentTask.id, status: TaskStatus.Pending, agentId: currentTask.agentId, strategy: 'agent_substitution', sessionId: groupSessionId },
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
            await db.update(workspaceTasks).set({ status: TaskStatus.Pending, retryCount: 0, errorLog: replan.reason }).where(eq(workspaceTasks.id, currentTask.id))
            broadcastSessionEvent(groupSessionId, {
              type: WsEvent.TaskUpdate,
              payload: { taskId: currentTask.id, status: TaskStatus.Pending, strategy: 'local_replan', sessionId: groupSessionId },
            })
          }
          continue
        }

        if (replan.strategy === 'task_split' && replan.newTasks && replan.newTasks.length > 0) {
          for (const newTask of replan.newTasks) {
            const newAgent = plan.agents.find((a) => a.id === newTask.agentId)
            const childSession = await createOrchestratorChildSession(workspaceId, plan.title, ownerId, newAgent ?? null, newTask.title)
            await db.insert(workspaceTasks).values({
              id: newTask.id,
              workspaceId,
              agentId: newTask.agentId,
              title: newTask.title,
              description: newTask.description,
              status: TaskStatus.Pending,
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
          return { ...result, status: TaskStatus.Failed, error: `任务已拆分为子任务: ${replan.reason}` }
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
                const childSession = await createOrchestratorChildSession(workspaceId, plan.title, ownerId, newAgent ?? null, newTask.title)
                await db.insert(workspaceTasks).values({
                  id: newTask.id,
                  workspaceId,
                  agentId: newTask.agentId,
                  title: newTask.title,
                  description: newTask.description,
                  status: TaskStatus.Pending,
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
  }

  private async evaluateSupervisorNeed(
    goal: string,
    taskOutputs: { taskTitle: string; agentName: string; output: string }[],
  ): Promise<boolean> {
    const prompt = `评估以下任务产出是否充分，决定是否需要追加补充任务。

原始目标：${goal}

已完成任务产出：
${taskOutputs.map((t) => `- [${t.agentName}] ${t.taskTitle}: ${t.output.slice(0, 300)}`).join('\n')}

请只回答 "YES" 或 "NO"：
- YES：当前产出不够充分，需要追加补充任务（如缺少关键分析维度、遗漏重要方面、深度不够等）
- NO：当前产出已经充分，无需追加`

    try {
<<<<<<< HEAD
      let output = ''
      for await (const delta of streamReply([{ role: 'user', content: prompt }], '你是项目管理者。只回答 YES 或 NO。')) {
        output += delta
        if (output.length > 100) break
=======
      this.scheduler.onPhaseCompleted = (phaseId: string, phaseTitle: string) => {
        emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          type: 'phase.completed' as any,
          severity: 'info',
          payload: { phaseId, phaseTitle },
        }).catch(() => {})
        broadcastSessionEvent(groupSessionId, {
          type: 'phase:completed' as any,
          payload: { runId, phaseId, phaseTitle, sessionId: groupSessionId },
        })
      }

      const mode: CollaborationMode = plan.collaborationMode ?? 'mapreduce'
      const results = await this.scheduler.executePlan(plan, executor, mode)

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
              type: WsEvent.TaskUpdate,
              payload: { taskId: task.id, status: 'blocked', error: result.error, sessionId: groupSessionId },
            })
          }
        }
>>>>>>> 8441a42 (feat: 新增三种协作模式并集成到执行引擎中)
      }
<<<<<<< HEAD
      return output.trim().toUpperCase().includes('YES')
    } catch {
      return false
=======

      const [currentRun] = await db
        .select({ status: orchestratorRuns.status })
        .from(orchestratorRuns)
        .where(eq(orchestratorRuns.id, runId))
        .limit(1)
      if (currentRun?.status === OrchestratorRunStatus.Cancelled) {
        logger.info({ runId }, 'Orchestrator run cancelled before synthesis')
        return
      }

      if (mode === 'supervisor') {
        let supervisorRound = 0
        const maxRounds = 3
        const bbSupervisorNs = Blackboard.namespace(workspaceId, runId)

        while (supervisorRound < maxRounds) {
          supervisorRound++

          const [runCheck] = await db
            .select({ status: orchestratorRuns.status })
            .from(orchestratorRuns)
            .where(eq(orchestratorRuns.id, runId))
            .limit(1)
          if (runCheck?.status === OrchestratorRunStatus.Cancelled) break

          const taskOutputs: { taskTitle: string; agentName: string; output: string }[] = []
          for (const task of plan.tasks) {
            const taskResult = results.find((r) => r.taskId === task.id)
            if (!taskResult || taskResult.status !== TaskStatus.Done) continue
            const agent = plan.agents.find((a) => a.id === task.agentId)
            try {
              const entry = await blackboard.read(bbSupervisorNs, `task_${task.id}_output`)
              if (entry) {
                const val = entry as { output: string }
                taskOutputs.push({
                  taskTitle: task.title,
                  agentName: agent?.name ?? task.agentId,
                  output: val.output,
                })
              }
            } catch {
              // Blackboard read skipped
            }
          }

          if (taskOutputs.length === 0) break

          const needMoreTasks = await this.evaluateSupervisorNeed(plan.goal, taskOutputs)
          if (!needMoreTasks) break

          const supplementPrompt = plan.tasks
            .filter((t) => results.find((r) => r.taskId === t.id && r.status === TaskStatus.Done))
            .map((t) => {
              const found = taskOutputs.find((o) => o.taskTitle === t.title)
              return `- ${t.title}: ${found?.output?.slice(0, 200) ?? 'completed'}`
            })
            .join('\n')

          const supplementGoal = `${plan.goal}\n\n已完成工作:\n${supplementPrompt}\n\n请根据已完成产出，生成 1-2 个补充任务，填补缺失或不足的部分。`

          try {
            const { buildDynamicOrchestratorPlan } = await import('./plan-generator')
            const supplementPlan = await buildDynamicOrchestratorPlan(
              supplementGoal,
              plan.agents as any,
              'supplement-' + runId,
            )

            if (!supplementPlan || !supplementPlan.tasks.length) break

            const newTasks: ExecutionTask[] = []
            for (const pt of supplementPlan.tasks) {
              const agent = plan.agents.find((a) => a.key === pt.agentKey)
              if (!agent) continue

              const task: ExecutionTask = {
                id: pt.id,
                title: pt.title,
                description: pt.description,
                agentId: agent.id,
                dependencies: pt.dependencies ?? [],
                taskType: pt.taskType,
                parallelGroup: pt.parallelGroup,
                maxRetries: pt.maxRetries ?? 2,
                phaseId: pt.phaseId,
              }

              const childSession = await createOrchestratorChildSession(
                workspaceId,
                plan.title,
                ownerId,
                agent,
                task.title,
              )
              childSessions.set(task.id, {
                sessionId: childSession.id,
                workspaceId,
                projectPath: childSessions.get(plan.tasks[0]?.id ?? '')?.projectPath,
              })

              await db.insert(workspaceTasks).values({
                id: task.id,
                workspaceId,
                agentId: task.agentId,
                title: task.title,
                description: task.description,
                status: TaskStatus.Pending,
                orderIdx: plan.tasks.length,
                runId,
                phaseId: task.phaseId,
                dependencies: task.dependencies,
                parallelGroup: task.parallelGroup,
                maxRetries: task.maxRetries,
              })

              newTasks.push(task)
            }

            this.scheduler.addTasksToRun(runId, newTasks)
            plan.tasks.push(...newTasks)

            await emitRunEvent({
              runId,
              workspaceId,
              groupSessionId,
              type: 'supervisor.inject' as any,
              severity: 'info',
              payload: { round: supervisorRound, newTaskIds: newTasks.map((t) => t.id) },
            })
          } catch (err: any) {
            logger.warn({ err: err?.message, runId, round: supervisorRound }, 'Supervisor supplement plan failed')
            break
          }
        }
      }

      // Task #37: Auto-review chain — code tasks 完成后自动注入 review 任务
      // 修复 Bug 23: 使用 scheduler 的 run signal，使 auto-review 可被取消
      const reviewSignal = this.scheduler.getRunSignal(runId) ?? new AbortController().signal
      const reviewResults = await this.injectAutoReviewTasks(
        plan, results, childSessions, runId, groupSessionId, workspaceId, ownerId, reviewSignal, executor,
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
      await db.update(orchestratorRuns).set({ status: OrchestratorRunStatus.Failed }).where(eq(orchestratorRuns.id, runId))
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
>>>>>>> 67a6346 (feat(orchestration): 统一多Agent编排流程，新增IntentRouter)
    }
  }

  private async evaluateSupervisorNeed(
    goal: string,
    taskOutputs: { taskTitle: string; agentName: string; output: string }[],
  ): Promise<boolean> {
    const prompt = `评估以下任务产出是否充分，决定是否需要追加补充任务。

原始目标：${goal}

已完成任务产出：
${taskOutputs.map((t) => `- [${t.agentName}] ${t.taskTitle}: ${t.output.slice(0, 300)}`).join('\n')}

请只回答 "YES" 或 "NO"：
- YES：当前产出不够充分，需要追加补充任务（如缺少关键分析维度、遗漏重要方面、深度不够等）
- NO：当前产出已经充分，无需追加`

    try {
      let output = ''
      for await (const delta of streamReply([{ role: 'user', content: prompt }], '你是项目管理者。只回答 YES 或 NO。')) {
        output += delta
        if (output.length > 100) break
      }
      return output.trim().toUpperCase().includes('YES')
    } catch {
      return false
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
        status: TaskStatus.Failed,
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
        status: TaskStatus.Failed,
        output: `Child session not found for task ${task.id}`,
        artifacts: [],
      }
    }

    // === PolicyGuard 评估 + Git 分支隔离 ===
    const policy = PolicyGuard.evaluate({
      roleType: agent.roleType,
      taskType: task.taskType,
    })
    let branchCtx: import('../git/branch-manager').BranchContext | null = null
    const projectPath = childInfo.projectPath ?? undefined
    const needBranch = PolicyGuard.needsBranchIsolation(policy.sandboxPolicy) && projectPath

    if (needBranch) {
      try {
        branchCtx = await gitBranchManager.prepareBranch(projectPath, runId, agent.key || agent.id, task.id)
        logger.info({ branch: branchCtx.branch, agent: agent.name }, 'Agent branch prepared')
      } catch (err: any) {
        logger.error({ err: err?.message, projectPath, agent: agent.name }, 'Failed to prepare agent branch')
        await db
          .update(workspaceTasks)
          .set({ status: TaskStatus.Failed, completedAt: new Date(), errorLog: `Git worktree 创建失败：${err?.message || '未知错误'}` })
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
          type: WsEvent.TaskUpdate,
          payload: { taskId: task.id, status: TaskStatus.Failed, error: `Git worktree 创建失败：${err?.message || '未知错误'}`, sessionId: groupSessionId },
        })
        return {
          taskId: task.id,
          agentId: agent.id,
          agentName: agent.name,
          status: TaskStatus.Failed,
          output: '',
          artifacts: [],
          error: `Git worktree 创建失败：${err?.message || '未知错误'}`,
        }
      }
    }

    const profile = buildAgentProfileWithWorktree(
      agent,
      branchCtx?.worktreePath ?? null,
      childInfo.projectPath ?? null,
      {
        toolPermissions: policy.toolPermissions,
        sandboxPolicy: policy.sandboxPolicy,
        contextPolicy: 'workspace-aware',
        approvalRequired: policy.approvalRequired,
      },
    )

    const bbNamespace = Blackboard.namespace(workspaceId, runId)

    await executionTracer.log({
      runId,
      sessionId: childInfo.sessionId,
      agentId: agent.id,
      taskId: task.id,
      type: 'task_start',
      input: { taskTitle: task.title, attemptCount },
    })

    const prompt = await buildTaskPrompt(task, plan, blackboard, bbNamespace)

    // 插入 user message
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
        status: TaskStatus.Failed,
        output: 'Failed to create user message in child session',
        artifacts: [],
      }
    }

    // 发送 orchestrator 特有的事件
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
      type: WsEvent.TaskUpdate,
      payload: { taskId: task.id, status: TaskStatus.Running, sessionId: groupSessionId },
    })

    const taskStartTime = Date.now()

    try {
      // 委托给 TaskExecutionService 执行核心逻辑
      const execResult = await taskExecutionService.execute({
        taskId: task.id,
        sessionId: childInfo.sessionId,
        workspaceId,
        profile,
        prompt,
        projectPath: childInfo.projectPath ?? undefined,
        runId,
        signal,
        attemptCount,
        existingUserMessageId: userMsg.id,
        existingBranchContext: branchCtx,
        deferCompletionStatus: true,
      })

      const output = execResult.output
      const artifacts = execResult.artifacts
      const taskDuration = execResult.durationMs

      const progressMatches = output.match(/\[PROGRESS:\s*(\d+)%\]\s*(.*)/g)
      if (progressMatches) {
        const lastProgress = progressMatches[progressMatches.length - 1]!
        const match = lastProgress.match(/\[PROGRESS:\s*(\d+)%\]\s*(.*)/)
        if (match) {
          const percent = parseInt(match[1]!, 10)
          const status = match[2]?.trim() || ''
          await db
            .update(workspaceTasks)
            .set({ progressPercent: percent, progressStatus: status })
            .where(eq(workspaceTasks.id, task.id))
          broadcastSessionEvent(groupSessionId, {
            type: 'task_board:task_progress',
            payload: { taskId: task.id, percent, status },
          })
        }
      }

      if (execResult.status === TaskStatus.Cancelled) {
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
          status: TaskStatus.Cancelled,
          output: 'Task was cancelled',
          artifacts: [],
        }
      }

      if (execResult.status === TaskStatus.Failed) {
        throw new Error(execResult.error || 'Agent 执行失败')
      }

      const signals = parseAgentAutonomySignals(output)

      if (signals.clarifications.length > 0) {
        const clarification = signals.clarifications[0]!

        await db.insert(taskClarifications).values({
          id: crypto.randomUUID(),
          runId,
          taskId: task.id,
          agentId: agent.id,
          question: clarification.question,
          options: clarification.options,
          status: 'pending',
          createdAt: new Date(),
        })

        const clarMsg = await db
          .insert(messages)
          .values({
            sessionId: groupSessionId,
            senderId: agent.id,
            senderType: 'system',
            type: 'text',
            content: `❓ **${agent.name} 需要确认**：${clarification.question}`,
            metadata: {
              clarificationTaskId: task.id,
              clarificationOptions: clarification.options,
              clarificationStatus: 'pending',
              agentName: agent.name,
            },
            createdAt: new Date(),
          })
          .returning()

        broadcastSessionEvent(groupSessionId, {
          type: 'task_board:clarification_needed',
          payload: {
            taskId: task.id,
            agentId: task.agentId,
            question: clarification.question,
            options: clarification.options,
            messageId: clarMsg[0]?.id,
            runId,
          },
        })

        logger.info({ taskId: task.id, question: clarification.question }, 'Agent requested clarification')

        await db
          .update(workspaceTasks)
          .set({ clarificationCount: 1 })
          .where(eq(workspaceTasks.id, task.id))

        if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)

        /**
         * Clarification 处理策略：
         * 当前将 Task 标记为 Done，task output 中带有 [AWAITING_CLARIFICATION] 标记。
         * 下游 synthesizer 应识别此标记，而非将任务产出视为最终结果。
         *
         * 用户通过群聊回答后，后续消息中包含 clarification metadata，
         * Orchestrator 会检测并将回答注入新的 task rerun 流程。
         *
         * TODO (@agenthub/issue-32): 实现 task 暂停/恢复机制
         * 1. Session 层：在 messages 路由中监听用户回答消息中的 clarification metadata
         * 2. Engine 层：为 paused task 提供 rerun 入口，注入用户回答作为上下文
         * 3. Scheduler 层：支持 paused 状态的 task，等待用户回答后重新调度执行
         * 参考 issue #32
         */
        return {
          taskId: task.id,
          agentId: task.agentId,
          agentName: agent.name,
          status: TaskStatus.Done,
          output: `[AWAITING_CLARIFICATION] ${clarification.question}`,
          artifacts: [],
        }
      }

      if (signals.rejections.length > 0) {
        const rejection = signals.rejections[0]!

        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          taskId: task.id,
          type: 'task.reassigned' as any,
          severity: 'warning',
          payload: {
            reason: rejection.reason,
            suggestedAgent: rejection.suggestedAgent,
          },
        })

        if (rejection.suggestedAgent) {
          const fallbackAgent = plan.agents.find(
            (a) => a.key === rejection.suggestedAgent || a.name === rejection.suggestedAgent,
          )
          if (fallbackAgent && fallbackAgent.id !== task.agentId) {
            task.agentId = fallbackAgent.id
            logger.info(
              { taskId: task.id, reason: rejection.reason, newAgent: fallbackAgent.name },
              'Task rejected and reassigned to suggested agent',
            )
            if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
            return {
              taskId: task.id,
              agentId: task.agentId,
              agentName: agent.name,
              status: TaskStatus.Failed,
              output: '',
              error: `Agent rejected task: ${rejection.reason} — reassigned to ${fallbackAgent.name}`,
              artifacts: [],
            }
          }
        }

        if (task.fallbackAgentId) {
          const fallbackAgent = plan.agents.find((a) => a.id === task.fallbackAgentId)
          if (fallbackAgent && fallbackAgent.id !== task.agentId) {
            task.agentId = fallbackAgent.id
            logger.info(
              { taskId: task.id, reason: rejection.reason, fallbackAgent: fallbackAgent.name },
              'Task rejected and reassigned to fallback agent',
            )
            if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
            return {
              taskId: task.id,
              agentId: task.agentId,
              agentName: agent.name,
              status: TaskStatus.Failed,
              output: '',
              error: `Agent rejected task: ${rejection.reason} — reassigned to fallback ${fallbackAgent.name}`,
              artifacts: [],
            }
          }
        }

        if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)
        return {
          taskId: task.id,
          agentId: task.agentId,
          agentName: agent.name,
          status: TaskStatus.Failed,
          output: '',
          error: `Agent rejected task: ${rejection.reason}`,
          artifacts: [],
        }
      }

      if (signals.progressReports.length > 0) {
        const lastProgress = signals.progressReports[signals.progressReports.length - 1]!
        await db
          .update(workspaceTasks)
          .set({ progressPercent: lastProgress.percent, progressStatus: lastProgress.status })
          .where(eq(workspaceTasks.id, task.id))
        broadcastSessionEvent(groupSessionId, {
          type: 'task_board:task_progress',
          payload: { taskId: task.id, percent: lastProgress.percent, status: lastProgress.status },
        })
      }

      await executionTracer.log({
        runId,
        sessionId: childInfo.sessionId,
        agentId: agent.id,
        taskId: task.id,
        type: 'task_end',
        output: { status: TaskStatus.Done, outputLength: output.length, durationMs: taskDuration },
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
          status: TaskStatus.Done,
          completedAt: new Date(),
          artifacts: (artifacts as unknown as import('@agenthub/db').AgentArtifact[]) ?? [],
        })
        .where(eq(workspaceTasks.id, task.id))

      broadcastSessionEvent(groupSessionId, {
        type: WsEvent.TaskUpdate,
        payload: { taskId: task.id, status: TaskStatus.Done, sessionId: groupSessionId, agentId: agent.id, agentName: agent.name },
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
      // TaskExecutionService 已更新 task 状态，此处只处理 post-processing 错误
      // 如果是 post-processing 错误，需要手动更新状态
      const existingTask = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, task.id)).limit(1)
      if (existingTask[0]?.status !== TaskStatus.Failed) {
        await db
          .update(workspaceTasks)
          .set({ status: TaskStatus.Failed, completedAt: new Date(), errorLog: error?.message || 'Unknown error' })
          .where(eq(workspaceTasks.id, task.id))
      }

      broadcastSessionEvent(groupSessionId, {
        type: WsEvent.TaskUpdate,
        payload: { taskId: task.id, status: TaskStatus.Failed, sessionId: groupSessionId, agentId: agent.id, agentName: agent.name, error: error?.message || 'Unknown error' },
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
        status: TaskStatus.Failed,
        output: '',
        artifacts: [],
        error: error?.message || 'Unknown error',
      }
    }
  }

  /**
   * Auto-review chain: Coder -> Verifier -> Reviewer
   * 为 code 类型且 requiresReview 的已完成任务自动注入验证和审查任务
   * 所有 verify/review 任务作为 DAG 节点并行调度
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
    executor: TaskExecutor,
  ): Promise<TaskResult[]> {
    const chainResults: TaskResult[] = []
    const codeTasksNeedingReview = plan.tasks.filter((task) => {
      if (task.taskType !== 'code' || !task.validation?.requiresReview) return false
      const result = results.find((r) => r.taskId === task.id)
      return result?.status === TaskStatus.Done && result.output
    })

    if (codeTasksNeedingReview.length === 0) return chainResults

    // Find verifier agent (prefer roleType='verifier')
    const verifierAgent = plan.agents.find((a) => a.roleType === 'verifier')
      ?? plan.agents.find((a) => a.capabilityTags.some((t) => ['verify', 'test', 'build'].includes(t.toLowerCase())))

    // Find reviewer agent (prefer roleType='reviewer')
    const firstCodeTask = codeTasksNeedingReview[0]!
    const reviewerAgent = plan.agents.find((a) => a.roleType === 'reviewer')
      ?? plan.agents.find((a) => {
        const text = [a.name, a.role, a.description, ...(a.capabilityTags ?? [])].filter(Boolean).join(' ').toLowerCase()
        return text.includes('review') || text.includes('审查')
      }) ?? plan.agents.find((a) => a.id !== firstCodeTask.agentId) ?? plan.agents[0]

    const autoReviewTasks: ExecutionTask[] = []

    for (const codeTask of codeTasksNeedingReview) {
      let verifyTaskId: string | null = null

      // === Step 1: Verifier ===
      if (verifierAgent) {
        verifyTaskId = `verify-${codeTask.id}`
        if (!plan.tasks.some((t) => t.id === verifyTaskId) && !autoReviewTasks.some((t) => t.id === verifyTaskId)) {
          const verifyTask: ExecutionTask = {
            id: verifyTaskId,
            title: `验证 ${codeTask.title}`,
            description: `在沙箱中运行「${codeTask.title}」的测试、构建和类型检查命令，验证代码变更是否通过自动化检查。`,
            agentId: verifierAgent.id,
            dependencies: [codeTask.id],
            taskType: 'test',
            maxRetries: 1,
          }

          const verifySession = await createOrchestratorChildSession(workspaceId, plan.title, ownerId, verifierAgent, verifyTask.title)
          childSessions.set(verifyTaskId, {
            sessionId: verifySession.id,
            workspaceId,
            projectPath: childSessions.get(codeTask.id)?.projectPath,
          })

          await db.insert(workspaceTasks).values({
            id: verifyTaskId,
            workspaceId,
            agentId: verifierAgent.id,
            title: verifyTask.title,
            description: verifyTask.description,
            status: 'pending',
            orderIdx: plan.tasks.length,
            runId,
            dependencies: [codeTask.id],
            maxRetries: 1,
          })

          plan.tasks.push(verifyTask)
          autoReviewTasks.push(verifyTask)

          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: verifyTaskId,
            agentId: verifierAgent.id,
            type: 'task.queued',
            severity: 'info',
            payload: { title: verifyTask.title, reason: 'Auto-verify after code task', parentTaskId: codeTask.id },
          })
        }
      }

      // === Step 2: Reviewer (depends on verifier if present, otherwise code task) ===
      if (!reviewerAgent) continue

      const reviewTaskId = `review-${codeTask.id}`
      if (plan.tasks.some((t) => t.id === reviewTaskId) || autoReviewTasks.some((t) => t.id === reviewTaskId)) continue

      const reviewTask: ExecutionTask = {
        id: reviewTaskId,
        title: `审查 ${codeTask.title}`,
        description: `审查「${codeTask.title}」的代码变更质量、安全性和最佳实践。关注：代码风格一致性、潜在bug、安全漏洞、性能问题。`,
        agentId: reviewerAgent.id,
        dependencies: verifyTaskId ? [verifyTaskId] : [codeTask.id],
        taskType: 'review',
        maxRetries: 1,
      }

      const reviewSession = await createOrchestratorChildSession(workspaceId, plan.title, ownerId, reviewerAgent, reviewTask.title)
      childSessions.set(reviewTaskId, {
        sessionId: reviewSession.id,
        workspaceId,
        projectPath: childSessions.get(codeTask.id)?.projectPath,
      })

      await db.insert(workspaceTasks).values({
        id: reviewTaskId,
        workspaceId,
        agentId: reviewerAgent.id,
        title: reviewTask.title,
        description: reviewTask.description,
        status: 'pending',
        orderIdx: plan.tasks.length,
        runId,
        dependencies: verifyTaskId ? [verifyTaskId] : [codeTask.id],
        maxRetries: 1,
      })

      plan.tasks.push(reviewTask)
      autoReviewTasks.push(reviewTask)

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
    }

    // 通过 DAG 调度器并行执行所有 auto-review 任务
    if (autoReviewTasks.length > 0) {
      const autoReviewPlan: ExecutionPlan = {
        runId,
        title: `Auto-Review: ${plan.title}`,
        goal: plan.goal,
        agents: plan.agents,
        tasks: autoReviewTasks,
      }

      const reviewResults = await this.scheduler.executePlan(autoReviewPlan, executor)

      for (const result of reviewResults) {
        chainResults.push(result)

        const codeTaskId = result.taskId.replace(/^(verify-|review-)/, '')
        const codeTask = codeTasksNeedingReview.find((t) => t.id === codeTaskId)

        if (result.taskId.startsWith('verify-') && result.status !== 'done') {
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: codeTaskId,
            agentId: codeTask?.agentId ?? '',
            type: 'task.failed',
            severity: 'warning',
            payload: { title: codeTask?.title ?? '', reason: 'Verification failed, skipping review', verifyTaskId: result.taskId },
          })
        }

        logger.info({ taskId: result.taskId, codeTaskId, status: result.status }, 'Auto-review task completed')
      }
    }

    return chainResults
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
        succeeded: results.filter((result) => result.status === TaskStatus.Done).length,
        failed: results.filter((result) => result.status === TaskStatus.Failed).length,
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
      (r) => r.taskId.startsWith('review-') && (r.status === TaskStatus.Failed || r.status === TaskStatus.Blocked)
    )
    const failedValidations = enrichedResults.filter(
      (r) => r.status === TaskStatus.Failed && r.error?.includes('Validation')
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

    // 匹配 workspace 中的 orchestrator agent，避免 senderId 与前端头像对不上
    const orchestratorAgent = plan.agents.find(
      (a) =>
        a.roleType === 'orchestrator' ||
        a.key === 'orchestrator' ||
        a.name.toLowerCase().includes('orchestrator'),
    )

    const [summaryMsg] = await db
      .insert(messages)
      .values({
        sessionId: groupSessionId,
        senderId: orchestratorAgent?.id ?? 'orchestrator',
        senderType: 'agent',
        type: 'text',
        content: finalSummary,
        metadata: {
          agentName: orchestratorAgent?.name ?? 'Orchestrator',
          role: orchestratorAgent?.role ?? 'Coordinator',
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

    broadcastSessionEvent(groupSessionId, {
      type: 'task_board:run_completed',
      payload: {
        runId,
        status: 'completed',
      },
    })

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      type: 'run.completed',
      payload: { summaryMessageId: summaryMsg?.id ?? null, taskCount: results.length },
    })

    broadcastSessionEvent(groupSessionId, {
      type: WsEvent.MessageCompleted,
      payload: { sessionId: groupSessionId, message: summaryMsg },
    })
  }
}

<<<<<<< HEAD
function buildAutonomyInstructions(): string {
  return [
    '\n## 自主行为指令',
    '作为智能 Agent，你在执行任务时拥有以下自主权：',
    '',
    '1. **提问权**：如果任务描述不够清晰、缺少关键信息，请向用户提问。',
    '   回复格式：`[CLARIFY] 你的问题`',
    '   示例：`[CLARIFY] 网站需要支持移动端响应式吗？请选择：A) 需要 B) 不需要`',
    '',
    '2. **拒绝权**：如果任务明显超出你的能力范围，可以拒绝并建议其他 Agent。',
    '   回复格式：`[REJECT] 拒绝原因 | 建议Agent: agentName`',
    '   示例：`[REJECT] 我的专长是代码审查，不适合前端开发 | 建议Agent: Coder`',
    '',
    '3. **进度报告**：执行长任务时，请定期报告进度。',
    '   回复格式：`[PROGRESS: N%] 当前状态`',
    '   示例：`[PROGRESS: 60%] HTML结构已完成，正在编写CSS样式`',
    '',
    '4. **求助权**：遇到无法独立解决的问题时，可请求其他 Agent 帮助。',
    '   回复格式：`[HELP agentName] 请求内容`',
    '   示例：`[HELP Designer] 需要配色方案建议，主色调应该用什么？`',
    '',
    '注意：正常执行时不需要使用以上格式，直接输出工作成果即可。只有当你确实需要澄清、拒绝、报告进度或求助时才使用。',
  ].join('\n')
}

interface AgentAutonomySignals {
  clarifications: Array<{ question: string; options?: string[] }>
  rejections: Array<{ reason: string; suggestedAgent?: string }>
  progressReports: Array<{ percent: number; status: string }>
  helpRequests: Array<{ targetAgent: string; request: string }>
}
=======
async function buildTaskPrompt(task: ExecutionTask, plan: ExecutionPlan, bbNamespace: string): Promise<string> {
  const agent = plan.agents.find((a) => a.id === task.agentId)
>>>>>>> b1ef3ac (refactor: 统一代码代理元数据与代理配置构建逻辑)

function parseAgentAutonomySignals(output: string): AgentAutonomySignals {
  const result: AgentAutonomySignals = {
    clarifications: [],
    rejections: [],
    progressReports: [],
    helpRequests: [],
  }

  const clarifyRegex = /\[CLARIFY\]\s*(.+?)(?=\[CLARIFY\]|\[REJECT\]|\[PROGRESS|\[HELP|$)/gs
  let match
  while ((match = clarifyRegex.exec(output)) !== null) {
    const question = match[1]?.trim()
    if (question) {
      const optionsMatch = question.match(/^(.+?)\s*[（(]?([A-Z])\)\s*(.+?)(?:\s+[（(]?[A-Z]\)|$)/)
      if (optionsMatch) {
        const allOptions = question.match(/[（(]?([A-Z])\)\s*(.+?)(?=\s+[（(]?[A-Z]\)|$)/g)
        result.clarifications.push({
          question: question.split(/[（(]?[A-Z]\)/)[0]?.trim() || question,
          options: allOptions?.map(o => o.replace(/^[（(]?[A-Z]\)\s*/, '').trim()),
        })
      } else {
        result.clarifications.push({ question })
      }
    }
  }

  const rejectRegex = /\[REJECT\]\s*(.+?)(?=\[CLARIFY\]|\[REJECT\]|\[PROGRESS|\[HELP|$)/gs
  while ((match = rejectRegex.exec(output)) !== null) {
    const content = match[1]?.trim()
    if (content) {
      const parts = content.split('|').map(s => s.trim())
      const reason = parts[0] || content
      const suggestedPart = parts.find(p => p.includes('建议Agent:') || p.includes('建议agent:'))
      const suggestedAgent = suggestedPart?.split(':')[1]?.trim()
      result.rejections.push({ reason, suggestedAgent })
    }
  }

  const progressRegex = /\[PROGRESS:\s*(\d+)%\]\s*(.*?)(?=\[CLARIFY\]|\[REJECT\]|\[PROGRESS|\[HELP|$)/g
  while ((match = progressRegex.exec(output)) !== null) {
    const percent = parseInt(match[1]!, 10)
    const status = match[2]?.trim() || ''
    result.progressReports.push({ percent, status })
  }

  const helpRegex = /\[HELP\s+(\S+)\]\s*(.+?)(?=\[CLARIFY\]|\[REJECT\]|\[PROGRESS|\[HELP|$)/gs
  while ((match = helpRegex.exec(output)) !== null) {
    result.helpRequests.push({
      targetAgent: match[1] || '',
      request: match[2]?.trim() || '',
    })
  }

  return result
}

async function buildTaskPrompt(
  task: ExecutionTask,
  plan: ExecutionPlan,
  blackboard: Blackboard,
  bbNamespace: string,
): Promise<string> {
  const parts: string[] = []

  parts.push(`# 项目总目标\n${plan.goal}\n`)

  parts.push(`# 你的任务：${task.title}\n${task.description}\n`)

  if (task.outputContract) {
    parts.push('# 交付要求')
    if (task.outputContract.acceptanceCriteria && task.outputContract.acceptanceCriteria.length > 0) {
      parts.push('验收标准：')
      for (const criteria of task.outputContract.acceptanceCriteria) {
        parts.push(`- ${criteria}`)
      }
    }
    if (task.outputContract.requiredArtifacts && task.outputContract.requiredArtifacts.length > 0) {
      parts.push(`需要产出：${task.outputContract.requiredArtifacts.join('、')}`)
    }
    parts.push('')
  }

  if (task.dependencies && task.dependencies.length > 0) {
    parts.push('# 上游 Agent 的产出\n')
    for (const depId of task.dependencies) {
      const depTask = plan.tasks.find((t) => t.id === depId)
      if (!depTask) continue

      const depAgent = plan.agents.find((a) => a.id === depTask.agentId)
      const agentName = depAgent?.name || depTask.agentId

      try {
        const entries = await blackboard.query({
          namespace: bbNamespace,
          keyPattern: `task_${depId}%`,
          limit: 10,
        })

        if (entries.length > 0) {
          parts.push(`## ${agentName} 完成了 "${depTask.title}"`)
          for (const entry of entries) {
            const summary =
              typeof entry.value === 'object' && entry.value !== null && 'summary' in entry.value
                ? String((entry.value as Record<string, unknown>).summary).slice(0, 500)
                : JSON.stringify(entry.value).slice(0, 500)
            parts.push(`- ${summary}`)
          }
          parts.push('')
        }
      } catch {
        // Blackboard read may fail; skip upstream context gracefully
      }
    }
  }

  try {
    const decisions = await blackboard.query({
      namespace: bbNamespace,
      keyPattern: 'decisions/%',
      limit: 10,
    })
    if (decisions.length > 0) {
      parts.push('# 关键决策\n')
      for (const d of decisions) {
        const val =
          typeof d.value === 'object'
            ? JSON.stringify(d.value).slice(0, 200)
            : String(d.value).slice(0, 200)
        parts.push(`- ${val}`)
      }
      parts.push('')
    }
  } catch {
    // Skip decisions if unavailable
  }

  const agentProfile = plan.agents.find((a) => a.id === task.agentId)
  if (agentProfile?.systemPrompt) {
    parts.push(`# 角色说明\n${agentProfile.systemPrompt.slice(0, 1000)}\n`)
  }

  parts.push('请先给出简短工作计划，再产出结果。遇到需要其他 Agent 配合的内容，请在结尾用「需协作:」列出。')

  if (agentProfile) {
    parts.push(buildAutonomyInstructions())
  }

  return parts.join('\n\n')
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
