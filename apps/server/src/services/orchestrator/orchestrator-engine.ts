import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  db,
  messages,
  workspaceTasks,
  orchestratorRuns,
  taskClarifications,
  sessions,
  workspaces,
  eq,
  and,
  desc,
} from '@agenthub/db'
import { logger } from '../../lib/logger'
import { broadcastSessionEvent, runAgentReply } from '../agent-runner'
import { gitBranchManager } from '../git/branch-manager'
import { shouldAcceptPartialExecution, taskExecutionService } from '../execution/task-execution-service'
import { blackboard, Blackboard, type BlackboardRef } from '../blackboard'
import { executionTracer } from '../execution-tracer'
import { Planner } from './planner'
import { TaskScheduler, type TaskExecutor } from './task-scheduler'
import { Synthesizer } from './synthesizer'
import { ConflictResolver } from './conflict-resolver'
import { ReplanningEngine } from './replanning-engine'
import { emitRunEvent } from './run-events'
import { initializeRunLedger } from './run-ledger'
import { validateTaskOutputContract, type TaskContractResult } from './task-contract'
import { runTaskValidation, type TaskValidationResult } from './task-validation'
import type {
  CollaborationMode,
  ExecutionAgent,
  ExecutionPlan,
  ExecutionTask,
  TaskResult,
} from './types'
import { PolicyGuard } from '../policy-guard'
import { intentRouter } from './intent-router'
import { streamReply } from '../llm'
import { buildAgentProfileWithWorktree } from '../agents/profile-builder'
import { ensureOrchestratorTaskSession } from '../workspace/session-manager'
import { DEFAULT_ENV_ALLOWLIST, resolveDefaultWorkDir } from '../execution/agent-execution-envelope'
import { WsEvent, TaskStatus, OrchestratorRunStatus } from '@agenthub/shared'
import { env } from '../../env'

export { ExecutionPlan, ExecutionTask, TaskResult }

const TASK_TIMEOUT_MS = env.AGENTHUB_CODE_AGENT_TIMEOUT_MS

interface ChildSessionInfo {
  sessionId: string
  workspaceId: string
  projectPath?: string | null
}

interface TaskResultReport {
  schemaType: 'task_result_report'
  runId: string
  taskId: string
  taskTitle: string
  agentId: string
  agentName: string
  status: TaskStatus
  summary: string
  outputRef?: BlackboardRef
  childSessionId: string
  artifactCount: number
  artifacts: Array<Record<string, unknown>>
  validationStatus: 'passed' | 'failed' | 'skipped' | 'not_run'
  validationResults: Array<
    Pick<TaskValidationResult, 'command' | 'status' | 'durationMs' | 'outputSummary'>
  >
  contractStatus: TaskContractResult['status']
  contractViolations: TaskContractResult['violations']
  durationMs: number
  blackboardKeys: string[]
  completedAt: string
  error?: string
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

    const executor = engine.createTaskExecutor(
      runId,
      run.groupSessionId,
      run.workspaceId,
      plan,
      childSessions,
      ownerId,
    )
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

    const plan = (runRow?.plan as ExecutionPlan | undefined) ?? {
      runId,
      title: '',
      goal: '',
      agents: [],
      tasks: [task],
    }
    const [groupSession] = await db
      .select({ ownerId: sessions.ownerId })
      .from(sessions)
      .where(eq(sessions.id, groupSessionId))
      .limit(1)

    const result = await this.executeTask(
      task,
      plan,
      childSessions,
      runId,
      groupSessionId,
      workspaceId,
      this.scheduler.getRunSignal(runId) ?? new AbortController().signal,
      0,
      groupSession?.ownerId ?? 'user',
    )

    return result
  }

  async createPlan(
    goal: string,
    agents: ExecutionPlan['agents'],
    workspacePath?: string | null,
  ): Promise<ExecutionPlan> {
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
      .set({
        status: OrchestratorRunStatus.Running,
        plan: plan as unknown as Record<string, unknown>,
      })
      .where(eq(orchestratorRuns.id, runId))

    const [groupSessionRecord] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, groupSessionId))
      .limit(1)
    const ownerId = groupSessionRecord?.ownerId ?? 'user'

    const executor = this.createTaskExecutor(
      runId,
      groupSessionId,
      workspaceId,
      plan,
      childSessions,
      ownerId,
    )

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

              const childSession = await ensureOrchestratorTaskSession(
                workspaceId,
                plan.title,
                ownerId,
                agent,
                task.title,
                runId,
                task.id,
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
                sessionId: childSession.id,
                orderIdx: plan.tasks.length,
                runId,
                phaseId: task.phaseId,
                dependencies: task.dependencies,
                parallelGroup: task.parallelGroup,
                maxRetries: task.maxRetries,
              })

              await emitRunEvent({
                runId,
                workspaceId,
                groupSessionId,
                taskId: task.id,
                agentId: task.agentId,
                type: 'task.queued',
                severity: 'info',
                payload: {
                  strategy: 'supervisor_supplement',
                  title: task.title,
                  description: task.description,
                  phaseId: task.phaseId,
                  taskType: task.taskType,
                  agentName: agent.name,
                  agentId: task.agentId,
                  childSessionId: childSession.id,
                  dependencies: task.dependencies ?? [],
                  round: supervisorRound,
                },
              })

              newTasks.push(task)
            }

            for (const newTask of newTasks) {
              if (!plan.tasks.some((existing) => existing.id === newTask.id)) {
                plan.tasks.push(newTask)
              }
            }

            const supplementResults = await this.scheduler.executePlan(
              {
                runId,
                title: `Supervisor supplement: ${plan.title}`,
                goal: plan.goal,
                agents: plan.agents,
                phases: plan.phases,
                tasks: newTasks,
              },
              executor,
              mode,
            )
            results.push(...supplementResults)

            await emitRunEvent({
              runId,
              workspaceId,
              groupSessionId,
              type: 'supervisor.inject' as any,
              severity: 'info',
              payload: { round: supervisorRound, newTaskIds: newTasks.map((t) => t.id) },
            })
          } catch (err: any) {
            logger.warn(
              { err: err?.message, runId, round: supervisorRound },
              'Supervisor supplement plan failed',
            )
            break
          }
        }
      }

      // Task #37: Auto-review chain — code tasks 完成后自动注入 review 任务
      // 修复 Bug 23: 使用 scheduler 的 run signal，使 auto-review 可被取消
      const reviewSignal = this.scheduler.getRunSignal(runId) ?? new AbortController().signal
      const reviewResults = await this.injectAutoReviewTasks(
        plan,
        results,
        childSessions,
        runId,
        groupSessionId,
        workspaceId,
        ownerId,
        reviewSignal,
        executor,
      )
      if (reviewResults.length > 0) {
        results.push(...reviewResults)
      }

      // Task #8: Follow-up task detection — 团长动态交接，根据产出物类型自动创建后续任务
      const followUpResults = await this.detectAndExecuteFollowUpTasks(
        plan,
        results,
        childSessions,
        runId,
        groupSessionId,
        workspaceId,
        ownerId,
        executor,
      )
      if (followUpResults.length > 0) {
        results.push(...followUpResults)
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
              agents: report.variants.map((variant) => ({
                agentId: variant.agentId,
                agentName: variant.agentName,
              })),
            },
          })
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            type: 'conflict.resolved',
            severity: report.resolution === 'needs-human' ? 'warning' : 'info',
            payload: {
              filePath: report.filePath,
              resolution: report.resolution,
              notes: report.notes,
            },
          })
        }
        await db
          .update(orchestratorRuns)
          .set({
            conflictReport: conflictReports as unknown as import('@agenthub/db').ConflictReport[],
          })
          .where(eq(orchestratorRuns.id, runId))
      }

      await this.synthesizeAndReport(
        runId,
        groupSessionId,
        workspaceId,
        plan,
        results,
        conflictReports,
      )
    } catch (error: any) {
      logger.error({ err: error?.message, runId }, 'Scheduler execution failed')
      await db
        .update(orchestratorRuns)
        .set({ status: OrchestratorRunStatus.Failed })
        .where(eq(orchestratorRuns.id, runId))
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
          logger.error(
            { taskId: currentTask.id, elapsedMs: elapsed, runId },
            'Task exceeded total time limit, forcing failure',
          )
          return {
            taskId: currentTask.id,
            agentId: currentTask.agentId,
            agentName: 'Unknown',
            status: TaskStatus.Failed,
            output: '',
            artifacts: [],
            error: `任务执行总耗时超过系统上限（${(5 * TASK_TIMEOUT_MS) / 1000}秒），已强制终止。`,
          }
        }

        const result = await this.executeTask(
          currentTask,
          plan,
          childSessions,
          runId,
          groupSessionId,
          workspaceId,
          signal,
          currentAttempt,
          ownerId,
        )
        if (result.status === TaskStatus.Done || result.status === TaskStatus.Cancelled) {
          return result
        }

        currentAttempt++
        if (currentAttempt > 5) {
          logger.error(
            { taskId: currentTask.id, currentAttempt, runId },
            'Task exceeded maximum replan attempts, forcing failure',
          )
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

        const replan = this.replanningEngine.handle(
          currentTask,
          new Error(result.error || 'Task failed'),
          currentAttempt,
          plan,
        )

        logger.info(
          { taskId: currentTask.id, strategy: replan.strategy, reason: replan.reason },
          'Replanning triggered',
        )

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
            await db
              .update(workspaceTasks)
              .set({ status: TaskStatus.Pending, errorLog: replan.reason })
              .where(eq(workspaceTasks.id, currentTask.id))
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
            payload: {
              fromAgentId: previousAgentId,
              toAgentId: currentTask.agentId,
              reason: replan.reason,
            },
          })
          const childInfo = childSessions.get(currentTask.id)
          if (childInfo) {
            await db
              .update(workspaceTasks)
              .set({
                agentId: currentTask.agentId,
                status: TaskStatus.Pending,
                retryCount: 0,
                errorLog: replan.reason,
              })
              .where(eq(workspaceTasks.id, currentTask.id))
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
            payload: {
              strategy: 'local_replan',
              reason: replan.reason,
              changedTaskIds: [currentTask.id],
            },
          })
          const childInfo = childSessions.get(currentTask.id)
          if (childInfo) {
            await db
              .update(workspaceTasks)
              .set({ status: TaskStatus.Pending, retryCount: 0, errorLog: replan.reason })
              .where(eq(workspaceTasks.id, currentTask.id))
          }
          continue
        }

        if (replan.strategy === 'task_split' && replan.newTasks && replan.newTasks.length > 0) {
          for (const newTask of replan.newTasks) {
            const newAgent = plan.agents.find((a) => a.id === newTask.agentId)
            const childSession = await ensureOrchestratorTaskSession(
              workspaceId,
              plan.title,
              ownerId,
              newAgent ?? null,
              newTask.title,
              runId,
              newTask.id,
            )
            await db.insert(workspaceTasks).values({
              id: newTask.id,
              workspaceId,
              agentId: newTask.agentId,
              title: newTask.title,
              description: newTask.description,
              status: TaskStatus.Pending,
              sessionId: childSession.id,
              orderIdx: plan.tasks.length,
              runId,
              phaseId: newTask.phaseId,
              dependencies: newTask.dependencies ?? [],
              parallelGroup: newTask.parallelGroup,
              maxRetries: newTask.maxRetries ?? 2,
            })
            childSessions.set(newTask.id, {
              sessionId: childSession.id,
              workspaceId,
              projectPath: childSessions.get(currentTask.id)?.projectPath,
            })
            await emitRunEvent({
              runId,
              workspaceId,
              groupSessionId,
              taskId: newTask.id,
              agentId: newTask.agentId,
              type: 'task.queued',
              severity: 'warning',
              payload: {
                strategy: 'task_split',
                title: newTask.title,
                description: newTask.description,
                phaseId: newTask.phaseId,
                taskType: newTask.taskType,
                agentName: newAgent?.name ?? newTask.agentId,
                agentId: newTask.agentId,
                childSessionId: childSession.id,
                dependencies: newTask.dependencies ?? [],
                reason: replan.reason,
              },
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
            payload: {
              strategy: 'task_split',
              reason: replan.reason,
              changedTaskIds: replan.newTasks.map((t) => t.id),
            },
          })
          this.scheduler.addTasksToRun(runId, replan.newTasks)
          logger.info(
            { taskId: currentTask.id, newTaskCount: replan.newTasks.length },
            'Task split into subtasks',
          )
          return {
            ...result,
            status: TaskStatus.Failed,
            error: `任务已拆分为子任务: ${replan.reason}`,
          }
        }

        if (replan.strategy === 'global_replan') {
          try {
            const workspacePath = childSessions.get(currentTask.id)?.projectPath ?? undefined
            const newPlan = await this.planner.createPlan({
              goal: plan.goal,
              agents: plan.agents,
              workspacePath,
            })
            const existingIds = new Set(plan.tasks.map((t) => t.id))
            const tasksToAdd = newPlan.tasks.filter((t) => !existingIds.has(t.id))
            if (tasksToAdd.length > 0) {
              for (const newTask of tasksToAdd) {
                const newAgent = plan.agents.find((a) => a.id === newTask.agentId)
                const childSession = await ensureOrchestratorTaskSession(
                  workspaceId,
                  plan.title,
                  ownerId,
                  newAgent ?? null,
                  newTask.title,
                  runId,
                  newTask.id,
                )
                await db.insert(workspaceTasks).values({
                  id: newTask.id,
                  workspaceId,
                  agentId: newTask.agentId,
                  title: newTask.title,
                  description: newTask.description,
                  status: TaskStatus.Pending,
                  sessionId: childSession.id,
                  orderIdx: plan.tasks.length,
                  runId,
                  phaseId: newTask.phaseId,
                  dependencies: newTask.dependencies ?? [],
                  parallelGroup: newTask.parallelGroup,
                  maxRetries: newTask.maxRetries ?? 2,
                })
                childSessions.set(newTask.id, {
                  sessionId: childSession.id,
                  workspaceId,
                  projectPath: childSessions.get(currentTask.id)?.projectPath,
                })
                await emitRunEvent({
                  runId,
                  workspaceId,
                  groupSessionId,
                  taskId: newTask.id,
                  agentId: newTask.agentId,
                  type: 'task.queued',
                  severity: 'warning',
                  payload: {
                    strategy: 'global_replan',
                    title: newTask.title,
                    description: newTask.description,
                    phaseId: newTask.phaseId,
                    taskType: newTask.taskType,
                    agentName: newAgent?.name ?? newTask.agentId,
                    agentId: newTask.agentId,
                    childSessionId: childSession.id,
                    dependencies: newTask.dependencies ?? [],
                  },
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
                payload: {
                  strategy: 'global_replan',
                  reason: replan.reason,
                  changedTaskIds: tasksToAdd.map((t) => t.id),
                },
              })
              logger.info(
                { taskId: currentTask.id, addedCount: tasksToAdd.length },
                'Global replan added new tasks',
              )
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
            payload: {
              strategy: 'escalate_to_user',
              reason: replan.reason,
              changedTaskIds: [currentTask.id],
            },
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
      let output = ''
      for await (const delta of streamReply(
        [{ role: 'user', content: prompt }],
        '你是项目管理者。只回答 YES 或 NO。',
      )) {
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
    ownerId = 'user',
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

    let childInfo = childSessions.get(task.id)
    let shouldRepairChildSession = !childInfo
    if (childInfo) {
      const [existingChildSession] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, childInfo.sessionId))
        .limit(1)
      shouldRepairChildSession = !existingChildSession
    }

    if (shouldRepairChildSession) {
      const repairedSession = await ensureOrchestratorTaskSession(
        workspaceId,
        plan.title || 'Agent Group',
        ownerId,
        agent,
        task.title,
        runId,
        task.id,
      )
      childInfo = {
        sessionId: repairedSession.id,
        workspaceId,
        projectPath:
          childInfo?.projectPath ?? childSessions.values().next().value?.projectPath ?? null,
      }
      childSessions.set(task.id, childInfo)
      await db
        .update(workspaceTasks)
        .set({ sessionId: repairedSession.id })
        .where(eq(workspaceTasks.id, task.id))
    }

    if (!childInfo) {
      throw new Error(`Child session not found for task ${task.id}`)
    }

    // === PolicyGuard 评估 ===
    const policy = PolicyGuard.evaluate({
      roleType: agent.roleType,
      taskType: task.taskType,
    })

    const defaultCwd = childInfo.projectPath ? null : resolveDefaultWorkDir(runId)
    const profile = buildAgentProfileWithWorktree(
      agent,
      defaultCwd,
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
      payload: {
        title: task.title,
        agentName: agent.name,
        attempt: attemptCount,
        sessionId: childInfo.sessionId,
      },
    })

    const taskStartTime = Date.now()
    const stopHeartbeat = startTaskHeartbeat({
      runId,
      groupSessionId,
      workspaceId,
      taskId: task.id,
      agentId: agent.id,
      agentName: agent.name,
      taskTitle: task.title,
      startedAt: taskStartTime,
      timeoutMs: TASK_TIMEOUT_MS,
    })
    let lastAgentOutput = ''
    let lastArtifacts: Array<Record<string, unknown>> = []
    let lastSummary: TaskOutputSummary | undefined
    let lastOutputRef: BlackboardRef | undefined
    let lastValidationResults: TaskValidationResult[] = []
    let lastContractResult: TaskContractResult | undefined
    let lastBlackboardKeys: string[] = []

    const GIT_IGNORE_PATTERNS = [
      /^\.git\//,
      /^\.git$/,
      /^node_modules\//,
      /^\.agenthub\//,
      /^\.env$/,
    ]
    const beforeDirs: string[] = []
    if (childInfo.projectPath && existsSync(childInfo.projectPath)) {
      beforeDirs.push(childInfo.projectPath)
    }
    const defaultWorkDir = resolveDefaultWorkDir(runId)
    if (existsSync(defaultWorkDir)) {
      beforeDirs.push(defaultWorkDir)
    }
    const beforeFiles = new Map<string, ScannedFile>()
    for (const dir of beforeDirs) {
      for (const f of scanDirectoryFiles(dir, GIT_IGNORE_PATTERNS)) {
        beforeFiles.set(fileScanKey(dir, f.path), f)
      }
    }

    try {
      // 委托给 TaskExecutionService 执行核心逻辑
      const execResult = await taskExecutionService.execute({
        taskId: task.id,
        sessionId: childInfo.sessionId,
        workspaceId,
        profile,
        prompt,
        taskType: task.taskType,
        projectPath: childInfo.projectPath ?? undefined,
        runId,
        signal,
        attemptCount,
        existingUserMessageId: userMsg.id,
        deferCompletionStatus: true,
      })
      stopHeartbeat()

      const output = execResult.output
      const artifacts = execResult.artifacts
      lastAgentOutput = output
      lastArtifacts = artifacts
      const taskDuration = execResult.durationMs

      const afterDirs: string[] = []
      const execPath = execResult.executionPath
      if (execPath && existsSync(execPath) && !afterDirs.includes(execPath)) {
        afterDirs.push(execPath)
      }
      if (
        childInfo.projectPath &&
        existsSync(childInfo.projectPath) &&
        !afterDirs.includes(childInfo.projectPath)
      ) {
        afterDirs.push(childInfo.projectPath)
      }
      if (existsSync(defaultWorkDir) && !afterDirs.includes(defaultWorkDir)) {
        afterDirs.push(defaultWorkDir)
      }
      const seenArtifactPaths = new Set(
        artifacts
          .filter((a) => typeof a === 'object' && a !== null)
          .map(
            (a) =>
              (a as Record<string, unknown>).filePath ??
              ((a as Record<string, unknown>).path as string | undefined),
          )
          .filter(Boolean) as string[],
      )
      for (const dir of afterDirs) {
        const afterFiles = scanDirectoryFiles(dir, GIT_IGNORE_PATTERNS)
        const newFiles = computeNewFiles(beforeFiles, dir, afterFiles)
        for (const f of newFiles) {
          if (seenArtifactPaths.has(f.path)) continue
          if (isLikelySeededWorkdirFile(dir, execPath, childInfo.projectPath ?? null, f)) continue
          if (f.path.endsWith('.patch') || f.path.endsWith('.diff')) continue
          seenArtifactPaths.add(f.path)
          artifacts.push({
            id: `file-${task.id}-${f.path.replace(/[^a-zA-Z0-9._-]/g, '-')}`,
            type: 'file',
            title: f.path.split('/').pop() ?? f.path,
            description: f.path,
            path: f.path,
            status: 'created',
            size: f.size,
            source: dir,
            createdAt: new Date().toISOString(),
          })
        }
      }
      materializeArtifactHandoffs({
        runId,
        taskId: task.id,
        artifacts,
        projectRoot: childInfo.projectPath ?? defaultWorkDir,
        executionPath: execResult.executionPath ?? null,
      })

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
        return {
          taskId: task.id,
          agentId: agent.id,
          agentName: agent.name,
          status: TaskStatus.Cancelled,
          output: 'Task was cancelled',
          artifacts: [],
        }
      }

      const partialAcceptedAfterScan =
        execResult.status === TaskStatus.Failed && shouldAcceptPartialExecution(task.taskType, artifacts)
      if (execResult.status === TaskStatus.Failed && !partialAcceptedAfterScan) {
        throw new Error(execResult.error || 'Agent 执行失败')
      }

      await updateTaskProgress({
        groupSessionId,
        taskId: task.id,
        percent: 95,
        status: `${agent.name} 正在整理产物与任务摘要。`,
      })

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

        logger.info(
          { taskId: task.id, question: clarification.question },
          'Agent requested clarification',
        )

        await db
          .update(workspaceTasks)
          .set({ clarificationCount: 1 })
          .where(eq(workspaceTasks.id, task.id))

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
      lastSummary = summary

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
      lastOutputRef = outputRef

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
            executionPath: execResult.executionPath,
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
        const artifactId =
          typeof artifact.id === 'string' && artifact.id ? artifact.id : `artifact-${task.id}`
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
            filePath:
              typeof artifact.filePath === 'string'
                ? artifact.filePath
                : typeof artifact.path === 'string'
                  ? artifact.path
                  : undefined,
            sourcePath: typeof artifact.sourcePath === 'string' ? artifact.sourcePath : undefined,
            handoffPath:
              typeof artifact.handoffPath === 'string' ? artifact.handoffPath : undefined,
            handoffRelativePath:
              typeof artifact.handoffRelativePath === 'string'
                ? artifact.handoffRelativePath
                : undefined,
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
            url: artifact.url,
            size: artifact.size,
            source: 'task',
            taskTitle: task.title,
            childSessionId: childInfo.sessionId,
            artifact,
            agentName: agent.name,
            agentId: agent.id,
          },
        })
      }

      // 修复 Bug 24: 没有有效项目路径时跳过 validation，避免在服务器 CWD 执行
      const validationCwd = execResult.executionPath ?? childInfo.projectPath ?? null
      const validationResults = validationCwd
        ? await runTaskValidation({
            commands: task.validation?.commands ?? [],
            cwd: validationCwd,
          })
        : []
      lastValidationResults = validationResults
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

      const writtenBlackboardKeys = [
        `task_${task.id}_output`,
        ...summary.decisions.map((_, index) => `decisions/${task.id}/${index + 1}`),
        ...(changedFiles.length > 0 ? [`diffs/${task.id}`] : []),
        ...artifacts.map((artifact) => {
          const artifactId =
            typeof artifact.id === 'string' && artifact.id ? artifact.id : `artifact-${task.id}`
          return `artifacts/${artifactId}`
        }),
        ...validationResults.map((_, index) => `tests/${task.id}/${index + 1}`),
      ]
      lastBlackboardKeys = writtenBlackboardKeys
      const contractResult = validateTaskOutputContract({
        task,
        artifacts,
        writtenBlackboardKeys,
      })
      lastContractResult = contractResult
      if (contractResult.status === 'failed') {
        const failureReport = buildTaskResultReport({
          runId,
          task,
          agent,
          status: TaskStatus.Failed,
          summary,
          outputRef,
          artifacts,
          validationResults,
          contractResult,
          durationMs: Date.now() - taskStartTime,
          childSessionId: childInfo.sessionId,
          blackboardKeys: writtenBlackboardKeys,
          error: `Task output contract failed: ${contractResult.violations[0]?.message ?? 'unknown violation'}`,
        })
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
            mitigation:
              'Review the task output contract, allowed paths, and produced artifacts before accepting this task.',
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
            ...taskResultReportEventPayload(failureReport),
          },
        })
        throw new Error(
          `Task output contract failed: ${contractResult.violations[0]?.message ?? 'unknown violation'}`,
        )
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

      const taskResultReport = buildTaskResultReport({
        runId,
        task,
        agent,
        status: TaskStatus.Done,
        summary,
        outputRef,
        artifacts,
        validationResults,
        contractResult,
        durationMs: taskDuration,
        childSessionId: childInfo.sessionId,
        blackboardKeys: writtenBlackboardKeys,
      })

      const [agentResultMessage] = await db
        .insert(messages)
        .values({
          sessionId: groupSessionId,
          senderId: agent.id,
          senderType: 'agent',
          type: 'text',
          content: buildAgentGroupResultContent(agent.name, task.title, summary, artifacts),
          metadata: {
            agentName: agent.name,
            role: agent.role,
            runtimeType: agent.runtimeType,
            orchestratorRunId: runId,
            orchestratorTaskId: task.id,
            childSessionId: childInfo.sessionId,
            taskResult: true,
            taskResultReport,
            taskStatus: TaskStatus.Done,
            outputRef,
            artifacts,
          },
        })
        .returning()

      if (agentResultMessage) {
        broadcastSessionEvent(groupSessionId, {
          type: WsEvent.MessageCompleted,
          payload: { sessionId: groupSessionId, message: agentResultMessage },
        })
      }

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
          ...taskResultReportEventPayload(taskResultReport),
        },
      })

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
      const failureReport = buildTaskResultReport({
        runId,
        task,
        agent,
        status: TaskStatus.Failed,
        summary: lastSummary,
        outputRef: lastOutputRef,
        artifacts: lastArtifacts,
        validationResults: lastValidationResults,
        contractResult: lastContractResult,
        durationMs: Date.now() - taskStartTime,
        childSessionId: childInfo.sessionId,
        blackboardKeys: lastBlackboardKeys,
        error: error?.message || 'Unknown error',
      })
      await executionTracer.log({
        runId,
        sessionId: childInfo.sessionId,
        agentId: agent.id,
        taskId: task.id,
        type: 'error',
        output: {
          taskTitle: task.title,
          error: error?.message,
          durationMs: Date.now() - taskStartTime,
        },
      })
      // TaskExecutionService 已更新 task 状态，此处只处理 post-processing 错误
      // 如果是 post-processing 错误，需要手动更新状态
      const existingTask = await db
        .select()
        .from(workspaceTasks)
        .where(eq(workspaceTasks.id, task.id))
        .limit(1)
      if (existingTask[0]?.status !== TaskStatus.Failed) {
        await db
          .update(workspaceTasks)
          .set({
            status: TaskStatus.Failed,
            completedAt: new Date(),
            errorLog: error?.message || 'Unknown error',
          })
          .where(eq(workspaceTasks.id, task.id))
      }

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
          ...taskResultReportEventPayload(failureReport),
        },
      })

      const [agentFailureMessage] = await db
        .insert(messages)
        .values({
          sessionId: groupSessionId,
          senderId: agent.id,
          senderType: 'agent',
          type: 'text',
          content: buildAgentGroupFailureContent(
            agent.name,
            task.title,
            error?.message || 'Unknown error',
            lastAgentOutput,
            lastArtifacts,
          ),
          metadata: {
            agentName: agent.name,
            role: agent.role,
            runtimeType: agent.runtimeType,
            orchestratorRunId: runId,
            orchestratorTaskId: task.id,
            childSessionId: childInfo.sessionId,
            taskResult: true,
            taskStatus: TaskStatus.Failed,
            taskResultReport: failureReport,
            artifacts: lastArtifacts,
            partialArtifacts: lastArtifacts.length > 0,
          },
        })
        .returning()

      if (agentFailureMessage) {
        broadcastSessionEvent(groupSessionId, {
          type: WsEvent.MessageCompleted,
          payload: { sessionId: groupSessionId, message: agentFailureMessage },
        })
      }

      return {
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        status: TaskStatus.Failed,
        output: lastAgentOutput,
        artifacts: lastArtifacts,
        error: error?.message || 'Unknown error',
      }
    } finally {
      stopHeartbeat()
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
    const verifierAgent =
      plan.agents.find((a) => a.roleType === 'verifier') ??
      plan.agents.find((a) =>
        a.capabilityTags.some((t) => ['verify', 'test', 'build'].includes(t.toLowerCase())),
      )

    // Find reviewer agent (prefer roleType='reviewer')
    const firstCodeTask = codeTasksNeedingReview[0]!
    const reviewerAgent =
      plan.agents.find((a) => a.roleType === 'reviewer') ??
      plan.agents.find((a) => {
        const text = [a.name, a.role, a.description, ...(a.capabilityTags ?? [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return text.includes('review') || text.includes('审查')
      }) ??
      plan.agents.find((a) => a.id !== firstCodeTask.agentId) ??
      plan.agents[0]

    const autoReviewTasks: ExecutionTask[] = []

    for (const codeTask of codeTasksNeedingReview) {
      let verifyTaskId: string | null = null

      // === Step 1: Verifier ===
      if (verifierAgent) {
        verifyTaskId = `verify-${codeTask.id}`
        if (
          !plan.tasks.some((t) => t.id === verifyTaskId) &&
          !autoReviewTasks.some((t) => t.id === verifyTaskId)
        ) {
          const verifyTask: ExecutionTask = {
            id: verifyTaskId,
            title: `验证 ${codeTask.title}`,
            description: `在沙箱中运行「${codeTask.title}」的测试、构建和类型检查命令，验证代码变更是否通过自动化检查。`,
            agentId: verifierAgent.id,
            dependencies: [codeTask.id],
            taskType: 'test',
            phaseId: codeTask.phaseId ?? 'verification',
            maxRetries: 1,
          }

          const verifySession = await ensureOrchestratorTaskSession(
            workspaceId,
            plan.title,
            ownerId,
            verifierAgent,
            verifyTask.title,
            runId,
            verifyTaskId,
          )
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
            sessionId: verifySession.id,
            orderIdx: plan.tasks.length,
            runId,
            phaseId: verifyTask.phaseId,
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
            payload: {
              title: verifyTask.title,
              description: verifyTask.description,
              phaseId: verifyTask.phaseId ?? codeTask.phaseId ?? 'verification',
              taskType: verifyTask.taskType,
              agentName: verifierAgent.name,
              agentId: verifierAgent.id,
              childSessionId: verifySession.id,
              reason: 'Auto-verify after code task',
              parentTaskId: codeTask.id,
            },
          })
        }
      }

      // === Step 2: Reviewer (depends on verifier if present, otherwise code task) ===
      if (!reviewerAgent) continue

      const reviewTaskId = `review-${codeTask.id}`
      if (
        plan.tasks.some((t) => t.id === reviewTaskId) ||
        autoReviewTasks.some((t) => t.id === reviewTaskId)
      )
        continue

      const reviewTask: ExecutionTask = {
        id: reviewTaskId,
        title: `审查 ${codeTask.title}`,
        description: `审查「${codeTask.title}」的代码变更质量、安全性和最佳实践。关注：代码风格一致性、潜在bug、安全漏洞、性能问题。`,
        agentId: reviewerAgent.id,
        dependencies: verifyTaskId ? [verifyTaskId] : [codeTask.id],
        taskType: 'review',
        phaseId: codeTask.phaseId ?? 'verification',
        maxRetries: 1,
      }

      const reviewSession = await ensureOrchestratorTaskSession(
        workspaceId,
        plan.title,
        ownerId,
        reviewerAgent,
        reviewTask.title,
        runId,
        reviewTaskId,
      )
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
        sessionId: reviewSession.id,
        orderIdx: plan.tasks.length,
        runId,
        phaseId: reviewTask.phaseId,
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
        payload: {
          title: reviewTask.title,
          description: reviewTask.description,
          phaseId: reviewTask.phaseId ?? codeTask.phaseId ?? 'verification',
          taskType: reviewTask.taskType,
          agentName: reviewerAgent.name,
          agentId: reviewerAgent.id,
          childSessionId: reviewSession.id,
          reason: 'Auto-review after code task',
          parentTaskId: codeTask.id,
        },
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
            payload: {
              title: codeTask?.title ?? '',
              reason: 'Verification failed, skipping review',
              verifyTaskId: result.taskId,
            },
          })
        }

        logger.info(
          { taskId: result.taskId, codeTaskId, status: result.status },
          'Auto-review task completed',
        )
      }
    }

    return chainResults
  }

  /**
   * Task #8: 团长动态交接 — 根据已完成任务的产出物类型，自动创建后续任务
   *
   * 规则引擎（非 LLM），按以下规则决策：
   * 1. 代码文件产出 + 无 QA 任务 → 创建 QA 审查任务
   * 2. Markdown 文档产出 + 无编辑任务 → 创建润色/校对任务
   * 3. 代码 + 测试文件产出 + 无 Reviewer 任务 → 创建 Reviewer 任务
   *
   * 去重：已有同类 follow-up 任务则跳过
   */
  private async detectAndExecuteFollowUpTasks(
    plan: ExecutionPlan,
    results: TaskResult[],
    childSessions: Map<string, ChildSessionInfo>,
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    ownerId: string,
    executor: TaskExecutor,
  ): Promise<TaskResult[]> {
    const followUpTasks: ExecutionTask[] = []

    for (const result of results) {
      if (result.status !== TaskStatus.Done || result.artifacts.length === 0) continue
      const completedTask = plan.tasks.find((t) => t.id === result.taskId)
      if (!completedTask) continue

      const newTasks = await this.buildFollowUpTasks(
        completedTask,
        result.artifacts,
        plan,
        childSessions,
        runId,
        groupSessionId,
        workspaceId,
        ownerId,
      )
      followUpTasks.push(...newTasks)
    }

    if (followUpTasks.length === 0) return []

    this.scheduler.addTasksToRun(runId, followUpTasks)

    broadcastSessionEvent(groupSessionId, {
      type: 'task_board:plan_ready',
      payload: {
        runId,
        plan: {
          runId,
          title: plan.title,
          goal: plan.goal,
          collaborationMode: plan.collaborationMode || 'mapreduce',
          phases: plan.phases || [],
          tasks: plan.tasks.map((t) => ({
            id: t.id,
            phaseId: t.phaseId || '',
            title: t.title,
            description: t.description,
            agentId: t.agentId,
            agentKey: plan.agents.find((a) => a.id === t.agentId)?.key || t.agentId,
            agentName: plan.agents.find((a) => a.id === t.agentId)?.name || t.agentId,
            dependencies: t.dependencies || [],
            taskType: t.taskType,
            childSessionId: childSessions.get(t.id)?.sessionId ?? null,
          })),
          agents: plan.agents,
        },
        sessionId: groupSessionId,
      },
    })

    logger.info(
      { runId, followUpCount: followUpTasks.length },
      'Detected follow-up tasks, dispatching',
    )

    const followUpPlan: ExecutionPlan = {
      runId,
      title: `Follow-up: ${plan.title}`,
      goal: plan.goal,
      agents: plan.agents,
      tasks: followUpTasks,
    }

    const followUpResults = await this.scheduler.executePlan(followUpPlan, executor)

    for (const fr of followUpResults) {
      logger.info({ taskId: fr.taskId, status: fr.status }, 'Follow-up task completed')
    }

    return followUpResults
  }

  private async buildFollowUpTasks(
    completedTask: ExecutionTask,
    artifacts: Array<Record<string, unknown>>,
    plan: ExecutionPlan,
    childSessions: Map<string, ChildSessionInfo>,
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    ownerId: string,
  ): Promise<ExecutionTask[]> {
    const newTasks: ExecutionTask[] = []

    const filePaths: string[] = []
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object') continue
      const rec = artifact as Record<string, unknown>
      const fp = (rec.filePath as string) ?? (rec.path as string) ?? (rec.title as string) ?? ''
      if (!fp) continue
      filePaths.push(fp.toLowerCase())
    }
    if (filePaths.length === 0) return newTasks

    const extSet = (fp: string) => (fp.includes('.') ? (fp.split('.').pop() ?? '') : '')

    const codeExtensions = new Set([
      'html',
      'css',
      'js',
      'ts',
      'jsx',
      'tsx',
      'py',
      'java',
      'go',
      'rs',
      'cpp',
      'c',
      'rb',
      'php',
      'swift',
      'kt',
      'dart',
      'vue',
      'svelte',
      'json',
      'yaml',
      'yml',
      'toml',
      'xml',
      'scss',
      'less',
      'sass',
      'lua',
      'r',
      'm',
      'mm',
      'sh',
      'bash',
      'ps1',
      'bat',
      'cmd',
      'sql',
      'graphql',
      'proto',
      'tf',
      'hcl',
    ])

    const docExtensions = new Set(['md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'org'])

    const isTestFile = (fp: string): boolean => {
      const name = fp.split('/').pop() ?? fp
      return (
        name.includes('.test.') ||
        name.includes('_test.') ||
        name.includes('.spec.') ||
        name.includes('_spec.') ||
        fp.includes('/test_') ||
        fp.startsWith('test/') ||
        fp.startsWith('tests/') ||
        fp.startsWith('spec/') ||
        fp.startsWith('__tests__/') ||
        name.endsWith('_test.py') ||
        name.endsWith('_test.go') ||
        name.endsWith('_test.rb') ||
        name.endsWith('_spec.rb') ||
        name.endsWith('Test.java') ||
        name.endsWith('Tests.java')
      )
    }

    const hasCodeFiles = filePaths.some((fp) => codeExtensions.has(extSet(fp)))
    const hasDocFiles = filePaths.some((fp) => docExtensions.has(extSet(fp)))
    const hasTestFiles = filePaths.some((fp) => isTestFile(fp))

    const taskExistsForRun = (keywords: string[]): boolean => {
      return plan.tasks.some((t) => {
        if (t.id.startsWith('qa-') || t.id.startsWith('polish-') || t.id.startsWith('review-')) {
          return keywords.some((kw) => t.title.toLowerCase().includes(kw))
        }
        const combined = (t.title + ' ' + t.description).toLowerCase()
        return keywords.some((kw) => combined.includes(kw))
      })
    }

    // Rule 1: 代码文件产出 + 无 QA 任务 → 创建 QA 审查任务
    if (hasCodeFiles && !taskExistsForRun(['qa', '测试', '审查'])) {
      const qaAgent = findFollowUpAgent(
        plan,
        completedTask.agentId,
        ['reviewer', 'verifier'],
        ['qa', 'test', 'review', '测试', '审查'],
      )
      if (qaAgent) {
        const task = await this.createFollowUpTask({
          prefix: 'qa',
          parentTask: completedTask,
          title: `QA 审查 ${completedTask.title}`,
          description: `对「${completedTask.title}」产出的代码文件进行质量审查。检查：代码规范、边界情况、错误处理、异常安全、性能问题。`,
          agent: qaAgent,
          taskType: 'review',
          plan,
          childSessions,
          runId,
          groupSessionId,
          workspaceId,
          ownerId,
        })
        if (task) newTasks.push(task)
      }
    }

    // Rule 2: Markdown 文档产出 + 无编辑任务 → 创建润色任务
    if (hasDocFiles && !taskExistsForRun(['润色', '编辑', '校对', 'polish', 'edit'])) {
      const editorAgent = findFollowUpAgent(
        plan,
        completedTask.agentId,
        ['reviewer', 'integrator', 'custom'],
        ['edit', 'polish', '文档', '写作', 'write', '润色', '校对'],
      )
      if (editorAgent) {
        const task = await this.createFollowUpTask({
          prefix: 'polish',
          parentTask: completedTask,
          title: `润色 ${completedTask.title}`,
          description: `对「${completedTask.title}」产出的文档进行润色和校对。检查：逻辑连贯性、表述清晰度、格式一致性、错别字和语法。`,
          agent: editorAgent,
          taskType: 'review',
          plan,
          childSessions,
          runId,
          groupSessionId,
          workspaceId,
          ownerId,
        })
        if (task) newTasks.push(task)
      }
    }

    // Rule 3: 代码 + 测试文件产出 + 无 Reviewer 任务 → 创建 Reviewer 任务
    if (hasCodeFiles && hasTestFiles && !taskExistsForRun(['review', '审查', 'code review'])) {
      const reviewerAgent = findFollowUpAgent(
        plan,
        completedTask.agentId,
        ['reviewer', 'verifier'],
        ['review', '审查', 'code review'],
      )
      if (reviewerAgent) {
        const task = await this.createFollowUpTask({
          prefix: 'review',
          parentTask: completedTask,
          title: `代码审查 ${completedTask.title}`,
          description: `审查「${completedTask.title}」的代码变更和测试覆盖率。关注：代码风格一致性、架构合理性、潜在安全漏洞、测试充分度。`,
          agent: reviewerAgent,
          taskType: 'review',
          plan,
          childSessions,
          runId,
          groupSessionId,
          workspaceId,
          ownerId,
        })
        if (task) newTasks.push(task)
      }
    }

    return newTasks
  }

  private async createFollowUpTask(params: {
    prefix: string
    parentTask: ExecutionTask
    title: string
    description: string
    agent: ExecutionAgent
    taskType: string
    plan: ExecutionPlan
    childSessions: Map<string, ChildSessionInfo>
    runId: string
    groupSessionId: string
    workspaceId: string
    ownerId: string
  }): Promise<ExecutionTask | null> {
    const {
      prefix,
      parentTask,
      title,
      description,
      agent,
      taskType,
      plan,
      childSessions,
      runId,
      groupSessionId,
      workspaceId,
      ownerId,
    } = params

    const taskId = `${prefix}-${parentTask.id}`

    if (plan.tasks.some((t) => t.id === taskId)) return null

    const task: ExecutionTask = {
      id: taskId,
      title,
      description,
      agentId: agent.id,
      dependencies: [],
      taskType: taskType as ExecutionTask['taskType'],
      phaseId: parentTask.phaseId ?? 'followup',
      maxRetries: 1,
    }

    const childSession = await ensureOrchestratorTaskSession(
      workspaceId,
      plan.title,
      ownerId,
      agent,
      task.title,
      runId,
      taskId,
    )
    childSessions.set(taskId, {
      sessionId: childSession.id,
      workspaceId,
      projectPath: childSessions.get(parentTask.id)?.projectPath,
    })

    await db.insert(workspaceTasks).values({
      id: taskId,
      workspaceId,
      agentId: agent.id,
      title: task.title,
      description: task.description,
      status: TaskStatus.Pending,
      sessionId: childSession.id,
      orderIdx: plan.tasks.length,
      runId,
      phaseId: task.phaseId,
      dependencies: task.dependencies,
      maxRetries: task.maxRetries,
    })

    plan.tasks.push(task)

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      taskId: task.id,
      agentId: agent.id,
      type: 'task.queued',
      severity: 'info',
      payload: {
        title: task.title,
        description: task.description,
        phaseId: task.phaseId ?? parentTask.phaseId ?? 'followup',
        taskType: task.taskType,
        agentName: agent.name,
        agentId: agent.id,
        childSessionId: childSession.id,
        reason: `团长动态交接: 基于 "${parentTask.title}" 产出自动创建`,
        parentTaskId: parentTask.id,
      },
    })

    logger.info(
      { taskId: task.id, parentTaskId: parentTask.id, agentName: agent.name },
      'Follow-up task created via rule engine',
    )

    return task
  }

  private async synthesizeAndReport(
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    plan: ExecutionPlan,
    results: TaskResult[],
    conflictReports: import('./conflict-resolver').ConflictReport[] = [],
  ) {
    await db
      .update(orchestratorRuns)
      .set({ status: 'synthesizing' })
      .where(eq(orchestratorRuns.id, runId))
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
    const typedBlackboardEntries = await blackboard.query({
      namespace: bbNamespace,
      orderBy: 'asc',
    })
    const bbResults = typedBlackboardEntries.filter(
      (entry) => entry.key.startsWith('task_') && entry.key.endsWith('_output'),
    )
    const enrichedResults: TaskResult[] = results.map((r) => {
      const bbEntry = bbResults.find((e) => e.key === `task_${r.taskId}_output`)
      if (bbEntry) {
        const val = bbEntry.value as { output: string; artifacts: Array<Record<string, unknown>> }
        return {
          ...r,
          output: val.output,
          artifacts: val.artifacts,
          outputRef: { namespace: bbNamespace, key: bbEntry.key, version: bbEntry.version },
        }
      }
      return r
    })

    const summary = await this.synthesizer.synthesize(
      plan,
      enrichedResults,
      conflictReports,
      typedBlackboardEntries,
    )

    // 检查是否有失败、阻塞或缺失结果，最终状态必须反映真实执行情况。
    const failedReviews = enrichedResults.filter(
      (r) =>
        r.taskId.startsWith('review-') &&
        (r.status === TaskStatus.Failed || r.status === TaskStatus.Blocked),
    )
    const failedValidations = enrichedResults.filter(
      (r) => r.status === TaskStatus.Failed && r.error?.includes('Validation'),
    )
    const failedTasks = enrichedResults.filter((r) => r.status === TaskStatus.Failed)
    const blockedTasks = enrichedResults.filter((r) => r.status === TaskStatus.Blocked)
    const cancelledTasks = enrichedResults.filter((r) => r.status === TaskStatus.Cancelled)
    const skippedTasks = enrichedResults.filter((r) => r.status === TaskStatus.Skipped)
    const missingTasks = plan.tasks.filter(
      (task) => !enrichedResults.some((r) => r.taskId === task.id),
    )
    const hasBlockingFailures =
      failedTasks.length > 0 ||
      blockedTasks.length > 0 ||
      cancelledTasks.length > 0 ||
      skippedTasks.length > 0 ||
      missingTasks.length > 0 ||
      conflictReports.length > 0
    const successfulResults = enrichedResults.filter((result) => result.status === TaskStatus.Done)
    const unsuccessfulResults = enrichedResults.filter(
      (result) => result.status !== TaskStatus.Done,
    )
    const finalArtifacts = collectResultArtifacts(successfulResults)
    const diagnosticArtifacts = collectResultArtifacts(unsuccessfulResults)
    const artifactNotice =
      finalArtifacts.length > 0
        ? `

---
📦 **交付产物**

本次运行收集到 ${finalArtifacts.length} 个已通过任务产物，已在下方产物卡中汇总。可直接打开文件、查看 Diff 或预览网页。
${diagnosticArtifacts.length > 0 ? `\n另有 ${diagnosticArtifacts.length} 个未通过任务的中间产物保留在对应成员消息中，仅用于排查，不作为本次正式交付。` : ''}
`
        : diagnosticArtifacts.length > 0
          ? `

---
🧭 **中间产物**

本次运行产生了 ${diagnosticArtifacts.length} 个中间产物，但相关任务未通过校验或被阻塞。这些内容保留在对应成员消息中用于排查，不作为正式交付。
`
          : ''

    const taskById = new Map(plan.tasks.map((task) => [task.id, task]))
    const issueLines = [
      ...failedTasks.map((result) => {
        const task = taskById.get(result.taskId)
        return `- 失败：${task?.title ?? result.taskId}${result.agentName ? `（${result.agentName}）` : ''}${result.error ? `：${result.error}` : ''}`
      }),
      ...blockedTasks.map((result) => {
        const task = taskById.get(result.taskId)
        return `- 阻塞：${task?.title ?? result.taskId}${result.agentName ? `（${result.agentName}）` : ''}${result.error ? `：${result.error}` : ''}`
      }),
      ...cancelledTasks.map((result) => {
        const task = taskById.get(result.taskId)
        return `- 取消：${task?.title ?? result.taskId}${result.agentName ? `（${result.agentName}）` : ''}`
      }),
      ...skippedTasks.map((result) => {
        const task = taskById.get(result.taskId)
        return `- 跳过：${task?.title ?? result.taskId}${result.agentName ? `（${result.agentName}）` : ''}`
      }),
      ...missingTasks.map((task) => `- 未返回结果：${task.title}`),
    ].slice(0, 12)

    const mergeNotice = hasBlockingFailures
      ? `

---
⚠️ **交付需复核**

本次运行没有完整成功，以下事项需要复核：
${issueLines.length > 0 ? `${issueLines.join('\n')}\n` : ''}${failedReviews.length > 0 ? `- ${failedReviews.length} 个审查任务未通过\n` : ''}${failedValidations.length > 0 ? `- ${failedValidations.length} 个验证任务失败\n` : ''}${conflictReports.length > 0 ? `- 检测到 ${conflictReports.length} 个文件冲突未解决\n` : ''}
请先查看对应成员子对话和产物卡，确认问题后再决定是否重试、调整 Agent 配置或继续推进。
`
      : `

---
✅ **交付已收口**

所有已完成任务的产出已汇总到主对话。成员执行细节保留在各自子对话中，文件产物写入工作区下的 Agent 工作目录。
`

    const finalSummary = summary + artifactNotice + mergeNotice

    const fileArtifacts = finalArtifacts.filter((a) => {
      const t = (a as Record<string, unknown>).type
      return t === 'file'
    })

    // 匹配 workspace 中的 orchestrator agent，避免 senderId 与前端头像对不上
    const orchestratorAgent = plan.agents.find(
      (a) =>
        a.roleType === 'orchestrator' ||
        a.key === 'orchestrator' ||
        a.name.toLowerCase().includes('orchestrator'),
    )

    const qaResult = extractQAResult(enrichedResults)
    const deliveryFiles = finalArtifacts.map((a) => {
      const rec = a as Record<string, unknown>
      const fileName = (rec.title as string) ?? (rec.path as string)?.split('/').pop() ?? 'unknown'
      const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
      return {
        name: fileName,
        size: typeof rec.size === 'number' ? rec.size : undefined,
        type: ext,
      }
    })
    const deliveryChecklist = plan.tasks.map((t) => {
      const result = enrichedResults.find((r) => r.taskId === t.id)
      return {
        item: t.title,
        done: result?.status === TaskStatus.Done,
      }
    })

    const completedTaskCount = enrichedResults.filter((r) => r.status === TaskStatus.Done).length
    const finalRunStatus = hasBlockingFailures
      ? OrchestratorRunStatus.Failed
      : OrchestratorRunStatus.Completed
    const deliveryStatus = hasBlockingFailures
      ? completedTaskCount > 0
        ? 'partial'
        : 'failed'
      : 'completed'

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
          artifacts: finalArtifacts,
          file_card:
            fileArtifacts.length > 0
              ? {
                  files: fileArtifacts.map((a) => {
                    const rec = a as Record<string, unknown>
                    const fileName =
                      (rec.title as string) ?? (rec.path as string)?.split('/').pop() ?? 'unknown'
                    return {
                      fileName,
                      filePath: (rec.path as string) ?? fileName,
                      fileSize: rec.size as number | undefined,
                      runId,
                    }
                  }),
                }
              : undefined,
          orchestratorSummary: {
            dispatchId: runId,
            taskIds: plan.tasks.map((t) => t.id),
            workspaceId,
            artifactCount: finalArtifacts.length,
            mergeBlocked: hasBlockingFailures,
            failedTaskCount: failedTasks.length,
            blockedTaskCount: blockedTasks.length,
            cancelledTaskCount: cancelledTasks.length,
            skippedTaskCount: skippedTasks.length,
            missingTaskCount: missingTasks.length,
            failedReviewCount: failedReviews.length,
            failedValidationCount: failedValidations.length,
            unresolvedConflictCount: conflictReports.length,
          },
          delivery_report: {
            status: deliveryStatus,
            runId,
            qaResult,
            files: deliveryFiles,
            checklist: deliveryChecklist,
          },
        },
      })
      .returning()

    await db
      .update(orchestratorRuns)
      .set({ status: finalRunStatus, summaryMessageId: summaryMsg?.id ?? null })
      .where(eq(orchestratorRuns.id, runId))

    broadcastSessionEvent(groupSessionId, {
      type: 'task_board:run_completed',
      payload: {
        runId,
        status: finalRunStatus,
      },
    })

    await emitRunEvent({
      runId,
      workspaceId,
      groupSessionId,
      type: finalRunStatus === OrchestratorRunStatus.Failed ? 'run.failed' : 'run.completed',
      severity: finalRunStatus === OrchestratorRunStatus.Failed ? 'warning' : 'info',
      payload: {
        summaryMessageId: summaryMsg?.id ?? null,
        taskCount: plan.tasks.length,
        completedTaskCount,
        failedTaskCount: failedTasks.length,
        blockedTaskCount: blockedTasks.length,
        cancelledTaskCount: cancelledTasks.length,
        missingTaskCount: missingTasks.length,
      },
    })

    broadcastSessionEvent(groupSessionId, {
      type: WsEvent.MessageCompleted,
      payload: { sessionId: groupSessionId, message: summaryMsg },
    })
  }
}

function startTaskHeartbeat(input: {
  runId: string
  groupSessionId: string
  workspaceId: string
  taskId: string
  agentId: string
  agentName: string
  taskTitle: string
  startedAt: number
  timeoutMs: number
}) {
  let stopped = false
  let lastPersistAt = 0

  const tick = async () => {
    if (stopped) return
    const elapsedMs = Date.now() - input.startedAt
    const percent = Math.min(90, Math.max(3, Math.round((elapsedMs / input.timeoutMs) * 100)))
    const status = `${input.agentName} 正在执行「${input.taskTitle}」，已运行 ${formatDuration(elapsedMs)} / ${formatDuration(input.timeoutMs)}。`

    broadcastSessionEvent(input.groupSessionId, {
      type: WsEvent.TaskBoardTaskProgress,
      payload: {
        taskId: input.taskId,
        percent,
        status,
        runId: input.runId,
        agentId: input.agentId,
        agentName: input.agentName,
        sessionId: input.groupSessionId,
      },
    })

    if (Date.now() - lastPersistAt < 30_000) return
    lastPersistAt = Date.now()
    await db
      .update(workspaceTasks)
      .set({ progressPercent: percent, progressStatus: status })
      .where(eq(workspaceTasks.id, input.taskId))
      .catch((err: any) => {
        logger.warn({ err: err?.message, taskId: input.taskId }, 'Failed to persist task heartbeat')
      })
  }

  tick().catch((err: any) => {
    logger.warn({ err: err?.message, taskId: input.taskId }, 'Failed to emit task heartbeat')
  })
  const timer = setInterval(() => {
    tick().catch((err: any) => {
      logger.warn({ err: err?.message, taskId: input.taskId }, 'Failed to emit task heartbeat')
    })
  }, 10_000)

  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}

async function updateTaskProgress(input: {
  groupSessionId: string
  taskId: string
  percent: number
  status: string
}) {
  await db
    .update(workspaceTasks)
    .set({ progressPercent: input.percent, progressStatus: input.status })
    .where(eq(workspaceTasks.id, input.taskId))
  broadcastSessionEvent(input.groupSessionId, {
    type: WsEvent.TaskBoardTaskProgress,
    payload: {
      taskId: input.taskId,
      percent: input.percent,
      status: input.status,
      sessionId: input.groupSessionId,
    },
  })
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) return `${seconds}秒`
  return `${minutes}分${seconds.toString().padStart(2, '0')}秒`
}

function extractQAResult(
  results: TaskResult[],
): { passed: boolean; critical: number; major: number; minor: number } | undefined {
  const qaTasks = results.filter(
    (r) =>
      r.taskId.toLowerCase().includes('qa') ||
      r.taskId.toLowerCase().includes('review') ||
      r.taskId.toLowerCase().includes('test') ||
      (r.agentName &&
        (r.agentName.toLowerCase().includes('qa') || r.agentName.toLowerCase().includes('测试'))),
  )
  if (qaTasks.length === 0) return undefined

  let critical = 0
  let major = 0
  let minor = 0
  let passed = true

  for (const qa of qaTasks) {
    if (qa.status === TaskStatus.Failed) passed = false
    const output = qa.output ?? ''
    const crMatch = output.match(/严重[：:]\s*(\d+)/)
    const majorMatch = output.match(/主要[：:]\s*(\d+)/)
    const minorMatch = output.match(/次要[：:]\s*(\d+)/)
    if (crMatch) critical += parseInt(crMatch[1] ?? '0', 10)
    if (majorMatch) major += parseInt(majorMatch[1] ?? '0', 10)
    if (minorMatch) minor += parseInt(minorMatch[1] ?? '0', 10)
  }

  return { passed, critical, major, minor }
}

function collectResultArtifacts(results: TaskResult[]) {
  const artifacts: Array<Record<string, unknown>> = []
  const seen = new Set<string>()

  for (const result of results) {
    for (const artifact of result.artifacts ?? []) {
      if (!artifact || typeof artifact !== 'object') continue
      const key = [
        artifact.id,
        artifact.type ?? artifact.kind,
        artifact.path ?? artifact.filePath,
        artifact.url,
      ]
        .filter(Boolean)
        .join('|')
      if (!key || seen.has(key)) continue
      seen.add(key)
      artifacts.push({
        ...artifact,
        sourceAgentId: artifact.sourceAgentId ?? result.agentId,
        sourceAgentName: artifact.sourceAgentName ?? result.agentName,
      })
      if (artifacts.length >= 80) return artifacts
    }
  }

  return artifacts
}

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
          options: allOptions?.map((o) => o.replace(/^[（(]?[A-Z]\)\s*/, '').trim()),
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
      const parts = content.split('|').map((s) => s.trim())
      const reason = parts[0] || content
      const suggestedPart = parts.find((p) => p.includes('建议Agent:') || p.includes('建议agent:'))
      const suggestedAgent = suggestedPart?.split(':')[1]?.trim()
      result.rejections.push({ reason, suggestedAgent })
    }
  }

  const progressRegex =
    /\[PROGRESS:\s*(\d+)%\]\s*(.*?)(?=\[CLARIFY\]|\[REJECT\]|\[PROGRESS|\[HELP|$)/g
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
    if (
      task.outputContract.acceptanceCriteria &&
      task.outputContract.acceptanceCriteria.length > 0
    ) {
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
    parts.push(
      '以下内容来自 Orchestrator 黑板。上游文件如果提供了 handoffPath，才代表你当前可以直接读取；如果只有 filePath/path，请把它当作上游记录的文件名或来源路径，不要假设它存在于你的当前执行目录。',
    )
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
            parts.push(formatBlackboardEntryForPrompt(entry.value))
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

  parts.push(
    '请先给出简短工作计划，再产出结果。需要引用上游产物时优先读取 handoffPath；没有 handoffPath 时只能依据黑板摘要接力，不要读取自己目录下臆造的相对路径。遇到需要其他 Agent 配合的内容，请在结尾用「需协作:」列出。',
  )

  if (agentProfile) {
    parts.push(buildAutonomyInstructions())
  }

  return parts.join('\n\n')
}

function formatBlackboardEntryForPrompt(value: unknown) {
  if (!value || typeof value !== 'object') return `- ${String(value).slice(0, 500)}`
  const record = value as Record<string, unknown>
  const lines: string[] = []
  const summary = typeof record.summary === 'string' ? record.summary : ''
  if (summary) lines.push(`- 摘要：${summary.slice(0, 600)}`)

  const artifacts = Array.isArray(record.artifacts)
    ? (record.artifacts as Array<Record<string, unknown>>)
    : []
  const visibleArtifacts = artifacts.slice(0, 8)
  for (const artifact of visibleArtifacts) {
    const title = String(artifact.title ?? artifact.filePath ?? artifact.path ?? '未命名产物')
    const handoffPath =
      typeof artifact.handoffPath === 'string' && artifact.handoffPath
        ? artifact.handoffPath
        : null
    const sourcePath =
      typeof artifact.sourcePath === 'string' && artifact.sourcePath ? artifact.sourcePath : null
    if (handoffPath) {
      lines.push(`  - 可读取产物：${title}，handoffPath=${handoffPath}`)
    } else if (sourcePath) {
      lines.push(`  - 上游来源：${title}，sourcePath=${sourcePath}`)
    } else {
      const filePath =
        typeof artifact.filePath === 'string'
          ? artifact.filePath
          : typeof artifact.path === 'string'
            ? artifact.path
            : ''
      lines.push(`  - 上游记录：${title}${filePath ? `，filePath=${filePath}` : ''}`)
    }
  }

  if (lines.length > 0) return lines.join('\n')
  return `- ${JSON.stringify(record).slice(0, 600)}`
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

function buildAgentGroupResultContent(
  agentName: string,
  taskTitle: string,
  summary: TaskOutputSummary,
  artifacts: Array<Record<string, unknown>>,
): string {
  const lines = [`**${agentName} / ${taskTitle}**`, '', summary.brief.trim() || '已完成该任务。']

  const files = [
    ...summary.filesCreated.map((file) => ({ file, label: '新建' })),
    ...summary.filesModified.map((file) => ({ file, label: '修改' })),
  ].slice(0, 8)

  if (files.length > 0) {
    lines.push('', '**文件变更**')
    for (const item of files) lines.push(`- ${item.label}：${item.file}`)
  }

  if (summary.decisions.length > 0) {
    lines.push('', '**关键判断**')
    for (const decision of summary.decisions.slice(0, 5)) lines.push(`- ${decision}`)
  }

  if (artifacts.length > 0) {
    lines.push('', `已附带 ${artifacts.length} 个产物，可在消息产物卡或任务看板中查看。`)
  }

  return lines.join('\n')
}

export function buildTaskResultReport(params: {
  runId: string
  task: ExecutionTask
  agent: ExecutionAgent
  status: TaskStatus
  summary?: TaskOutputSummary
  outputRef?: BlackboardRef
  artifacts: Array<Record<string, unknown>>
  validationResults: TaskValidationResult[]
  contractResult?: TaskContractResult
  durationMs: number
  childSessionId: string
  blackboardKeys: string[]
  error?: string
}): TaskResultReport {
  const validationStatus =
    params.validationResults.length === 0
      ? 'not_run'
      : params.validationResults.some((result) => result.status === 'failed')
        ? 'failed'
        : params.validationResults.some((result) => result.status === 'passed')
          ? 'passed'
          : 'skipped'

  return {
    schemaType: 'task_result_report',
    runId: params.runId,
    taskId: params.task.id,
    taskTitle: params.task.title,
    agentId: params.agent.id,
    agentName: params.agent.name,
    status: params.status,
    summary: params.summary?.brief?.trim() || params.error || '任务已完成。',
    outputRef: params.outputRef,
    childSessionId: params.childSessionId,
    artifactCount: params.artifacts.length,
    artifacts: params.artifacts,
    validationStatus,
    validationResults: params.validationResults.map((result) => ({
      command: result.command,
      status: result.status,
      durationMs: result.durationMs,
      outputSummary: result.outputSummary,
    })),
    contractStatus: params.contractResult?.status ?? 'passed',
    contractViolations: params.contractResult?.violations ?? [],
    durationMs: params.durationMs,
    blackboardKeys: params.blackboardKeys,
    completedAt: new Date().toISOString(),
    ...(params.error ? { error: params.error } : {}),
  }
}

export function taskResultReportEventPayload(report: TaskResultReport): Record<string, unknown> {
  return {
    taskResultReport: report,
    artifactCount: report.artifactCount,
    childSessionId: report.childSessionId,
    outputRef: report.outputRef,
    summary: report.summary,
    validationStatus: report.validationStatus,
    validationResults: report.validationResults,
    contractStatus: report.contractStatus,
    contractViolations: report.contractViolations,
    blackboardKeys: report.blackboardKeys,
    durationMs: report.durationMs,
    error: report.error,
  }
}

function buildAgentGroupFailureContent(
  agentName: string,
  taskTitle: string,
  error: string,
  output: string,
  artifacts: Array<Record<string, unknown>>,
): string {
  const hasPartialArtifacts = artifacts.length > 0
  const lines = [
    `**${agentName} / ${taskTitle}**`,
    '',
    hasPartialArtifacts
      ? '该任务执行失败，最终结果未确认；已保留执行过程中产生的部分产物与文件变更，供排查或后续接力使用。'
      : '该任务执行失败，未产生可交付结果。',
  ]
  lines.push('', '**失败原因**', error.trim() || 'Unknown error')

  const detail = output.trim()
  if (detail && detail !== error.trim()) {
    lines.push('', '**Agent 输出摘录**', detail.slice(0, 1200))
  }

  if (hasPartialArtifacts) {
    lines.push('', `已保留 ${artifacts.length} 个部分产物，可在消息产物卡或任务看板中查看。`)
  }

  return lines.join('\n')
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
  const codeArtifacts = artifacts.filter(
    (a) => isArtifactKind(a, 'diff') || isArtifactKind(a, 'file'),
  )
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
      .filter(
        (l) =>
          /^[\s]*[-*]\s+(决定|采用|选择|使用|方案|设计|决策)/i.test(l) ||
          /^(决定|采用|选择|使用|方案|设计|决策)/i.test(l),
      )
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
    for await (const delta of streamReply(
      [{ role: 'user', content: prompt }],
      '你是代码分析助手，擅长从文本中提取结构化信息。',
    )) {
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
    logger.warn(
      { err: err?.message, agentName, taskTitle },
      'Failed to summarize task output via LLM',
    )
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
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return cleaned
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : null
}

function isArtifactKind(a: Record<string, unknown>, kind: string): boolean {
  return (a.kind as string | undefined) === kind || (a.type as string | undefined) === kind
}

function materializeArtifactHandoffs(params: {
  runId: string
  taskId: string
  artifacts: Array<Record<string, unknown>>
  projectRoot: string
  executionPath: string | null
}) {
  const handoffRoot = join(params.projectRoot, '.agenthub', 'handoff', params.runId, params.taskId)
  for (const artifact of params.artifacts) {
    const rawPath =
      typeof artifact.filePath === 'string'
        ? artifact.filePath
        : typeof artifact.path === 'string'
          ? artifact.path
          : ''
    if (!rawPath) continue

    const sourcePath = resolveArtifactSourcePath(rawPath, artifact, params.executionPath)
    if (!sourcePath || !existsSync(sourcePath)) continue

    let stat
    try {
      stat = statSync(sourcePath)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) continue

    const relativeTarget = sanitizeHandoffRelativePath(rawPath)
    const targetPath = join(handoffRoot, relativeTarget)
    try {
      mkdirSync(dirname(targetPath), { recursive: true })
      copyFileSync(sourcePath, targetPath)
      artifact.sourcePath = sourcePath
      artifact.handoffPath = targetPath
      artifact.handoffRelativePath = relative(params.projectRoot, targetPath).replace(/\\/g, '/')
    } catch (error: any) {
      logger.warn(
        { err: error?.message, taskId: params.taskId, sourcePath, targetPath },
        'Failed to materialize artifact handoff',
      )
    }
  }
}

function resolveArtifactSourcePath(
  rawPath: string,
  artifact: Record<string, unknown>,
  executionPath: string | null,
) {
  if (isAbsolute(rawPath)) return rawPath
  const sourceRoot =
    typeof artifact.source === 'string' && artifact.source ? artifact.source : executionPath
  return sourceRoot ? resolve(sourceRoot, rawPath) : null
}

function sanitizeHandoffRelativePath(rawPath: string) {
  const normalized = rawPath.replace(/\\/g, '/')
  const parts = normalized
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'file')
  return parts.length > 0 ? join(...parts) : basename(rawPath) || 'artifact'
}

interface ScannedFile {
  path: string
  size: number
  mtimeMs: number
}

function scanDirectoryFiles(dir: string, ignorePatterns: RegExp[] = []): ScannedFile[] {
  const results: ScannedFile[] = []
  if (!existsSync(dir)) return results

  const rootWithSep = dir.endsWith(sep) ? dir : `${dir}${sep}`

  function walk(currentDir: string) {
    let entries: string[]
    try {
      entries = readdirSync(currentDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === '.' || entry === '..') continue
      const fullPath = join(currentDir, entry)
      const relPath = relative(rootWithSep, fullPath).replace(/\\/g, '/')
      if (ignorePatterns.some((p) => p.test(relPath) || p.test(entry))) continue

      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isFile()) {
        results.push({ path: relPath, size: stat.size, mtimeMs: stat.mtimeMs })
      } else if (stat.isDirectory()) {
        walk(fullPath)
      }
    }
  }

  walk(dir)
  return results
}

function fileScanKey(dir: string, path: string) {
  return `${dir}::${path}`
}

function computeNewFiles(
  before: Map<string, ScannedFile>,
  dir: string,
  after: ScannedFile[],
): ScannedFile[] {
  return after.filter((f) => {
    const prev = before.get(fileScanKey(dir, f.path))
    if (!prev) return true
    return f.mtimeMs > prev.mtimeMs + 1000
  })
}

function isLikelySeededWorkdirFile(
  scannedDir: string,
  executionPath: string | null | undefined,
  projectPath: string | null,
  file: ScannedFile,
) {
  if (!executionPath || !projectPath || scannedDir !== executionPath) return false
  const originalPath = join(projectPath, file.path)
  if (!existsSync(originalPath)) return false
  try {
    const original = statSync(originalPath)
    return original.isFile() && original.size === file.size
  } catch {
    return false
  }
}

/**
 * Task #8: 为 follow-up 任务匹配合适的 Agent
 * 优先按 roleType 匹配，其次按 capabilityTags，最后按名称/描述
 * 排除已完成任务的原 Agent，避免自己审查自己
 */
function findFollowUpAgent(
  plan: ExecutionPlan,
  excludeAgentId: string,
  preferredRoleTypes: string[],
  capabilityKeywords: string[],
): ExecutionAgent | undefined {
  const candidates = plan.agents.filter((a) => a.id !== excludeAgentId)

  const byRoleType = candidates.find((a) => preferredRoleTypes.includes(a.roleType ?? ''))
  if (byRoleType) return byRoleType

  const byCapability = candidates.find((a) =>
    a.capabilityTags.some((tag) => capabilityKeywords.some((kw) => tag.toLowerCase().includes(kw))),
  )
  if (byCapability) return byCapability

  const byName = candidates.find((a) => {
    const text = [a.name, a.role, a.description ?? ''].join(' ').toLowerCase()
    return capabilityKeywords.some((kw) => text.includes(kw))
  })
  return byName
}
