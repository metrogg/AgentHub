import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  db,
  messages,
  workspaceAgents,
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
import { broadcastSessionEvent } from '../agent-runner'
import { executionBranchManager } from '../git/branch-manager'
import { shouldAcceptPartialExecution, taskExecutionService } from '../execution/task-execution-service'
import {
  buildExecutionConfigSummary,
  type ExecutionConfigSummary,
} from '../execution/execution-config-summary'
import { blackboard, Blackboard, type BlackboardRef } from '../blackboard'
import { executionTracer } from '../execution-tracer'
import { Planner } from './planner'
import { TaskScheduler, type TaskExecutor } from './task-scheduler'
import { Synthesizer } from './synthesizer'
import { ExecutionMergeResolver, type MergeReport } from './conflict-resolver'
import { ReplanningEngine } from './replanning-engine'
import { emitRunEvent } from './run-events'
import { initializeRunLedger } from './run-ledger'
import { prepareTaskRuntimeThread, updateTaskThreadStatus } from './task-thread-service'
import {
  mapSharedTaskResultStatus,
  readSharedTaskResult,
  sharedTaskResultDeliverablesToArtifacts,
  updateSharedTaskDirectoryStatus,
  type SharedTaskResultStatus,
} from './shared-task-directory'
import { registerTaskArtifact, toCanonicalArtifactRecord } from './artifact-store'
import { runController, type RunControllerRunContext } from './run-controller'
import {
  createRuntimeLease,
  failRuntimeLease,
  markRuntimeLeaseReady,
  markRuntimeLeaseRunning,
  markWorkerInstanceState,
  releaseRuntimeLease,
} from './worker-runtime-resources'
import {
  hasFatalTaskContractViolations,
  validateTaskOutputContract,
  type TaskContractResult,
} from './task-contract'
import {
  appendHumanInterruptConstraint,
  hasHumanInterruptConstraint,
  type HumanInterruptPayload,
} from './human-interrupts'
import { runTaskValidation, type TaskValidationResult } from './task-validation'
import type {
  CollaborationMode,
  ExecutionAgent,
  ExecutionPlan,
  ExecutionTask,
  TaskResult,
} from './types'
import { PolicyGuard } from '../policy-guard'
import { streamReply } from '../llm'
import { buildAgentProfile, buildAgentProfileWithExecutionDir } from '../agents/profile-builder'
import { DEFAULT_ENV_ALLOWLIST, resolveDefaultWorkDir } from '../execution/agent-execution-envelope'
import { buildA2ADispatchEnvelope, buildA2AExecutionTask } from '../protocols/a2a-internal'
import { buildAgUiTaskStatusEvent } from '../protocols'
import { runtimeRegistry, type AgentProfile } from '../runtime'
import { WsEvent, TaskStatus, OrchestratorRunStatus } from '@agenthub/shared'
import { env } from '../../env'

export { ExecutionPlan, ExecutionTask, TaskResult }

const TASK_TIMEOUT_MS = env.AGENTHUB_CODE_AGENT_TIMEOUT_MS

interface ChildSessionInfo {
  sessionId: string
  workspaceId: string
  projectPath?: string | null
  taskThreadId?: string | null
  workerInstanceId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
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
  executionConfig?: ExecutionConfigSummary
  error?: string
}

interface EnsureTaskRuntimeThreadInput {
  workspaceId: string
  workspaceName: string
  ownerId: string
  groupSessionId: string
  runId: string
  plan: ExecutionPlan
  task: ExecutionTask
  agent: ExecutionAgent | null
  projectPath?: string | null
}

interface DynamicTaskRegistration {
  task: ExecutionTask
  childInfo: ChildSessionInfo
  agentName?: string | null
  strategy: string
  reason?: string | null
  round?: number | null
  severity?: 'info' | 'warning' | 'error'
}

export class OrchestratorEngine {
  private static activeEngines = new Map<string, OrchestratorEngine>()
  private planner = new Planner()
  private scheduler = new TaskScheduler()
  private synthesizer = new Synthesizer()
  private mergeResolver = new ExecutionMergeResolver()
  private replanningEngine = new ReplanningEngine()
  private activePlan: ExecutionPlan | null = null
  private activeChildSessions = new Map<string, ChildSessionInfo>()
  private activeRunContext: RunControllerRunContext | null = null

  static cancelActiveRun(runId: string): boolean {
    const engine = OrchestratorEngine.activeEngines.get(runId)
    if (!engine) return false
    engine.scheduler.cancelRun(runId)
    return true
  }

  static getActiveRunIds() {
    return [...OrchestratorEngine.activeEngines.keys()]
  }

  static cancelAllActiveRuns() {
    const runIds = OrchestratorEngine.getActiveRunIds()
    for (const runId of runIds) {
      OrchestratorEngine.cancelActiveRun(runId)
    }
    return runIds
  }

  static applyHumanInterruptToActiveRun(
    runId: string,
    input: HumanInterruptPayload & { targetTaskIds?: string[] | null },
  ): { memoryPlanUpdated: boolean; updatedTaskIds: string[] } {
    const engine = OrchestratorEngine.activeEngines.get(runId)
    if (!engine) {
      return { memoryPlanUpdated: false, updatedTaskIds: [] }
    }

    return engine.applyHumanInterruptToPlan(input)
  }

  static async resumeRun(runId: string): Promise<void> {
    const run = await db.query.orchestratorRuns.findFirst({
      where: eq(orchestratorRuns.id, runId),
    })
    if (!run || run.status !== 'running') {
      logger.warn({ runId, status: run?.status }, 'Cannot resume orchestrator run')
      return
    }
    const runContext: RunControllerRunContext = {
      runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
    }

    const engine = new OrchestratorEngine()

    const plan = run.plan as ExecutionPlan

    const allTasks = await db.query.workspaceTasks.findMany({
      where: eq(workspaceTasks.runId, runId),
    })

    const resumedTasks = allTasks.map((task) => ({ ...task }))
    const requeuedTaskIds = new Set(await runController.requeueRunningTasksForResume(runContext))
    for (const task of resumedTasks) {
      if (!requeuedTaskIds.has(task.id)) continue
      task.status = TaskStatus.Pending
      task.startedAt = null
      task.completedAt = null
      task.errorLog = '服务重启后恢复运行，任务已重新排队。'
      task.progressPercent = 0
      task.progressStatus = '服务重启后恢复运行，等待重新分发。'
    }

    const [workspaceRecord] = await db
      .select({ projectPath: workspaces.projectPath })
      .from(workspaces)
      .where(eq(workspaces.id, run.workspaceId))
      .limit(1)
    const projectPath = workspaceRecord?.projectPath ?? null

    const childSessions = new Map<string, ChildSessionInfo>()
    for (const task of resumedTasks) {
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
    engine.activePlan = plan
    engine.activeChildSessions = childSessions
    engine.activeRunContext = runContext

    const pendingTasks = plan.tasks.filter((t) => {
      const dbTask = resumedTasks.find((dt) => dt.id === t.id)
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
            await runController.markTaskBlocked(runContext, {
              taskId: task.id,
              title: task.title,
              agentId: task.agentId,
              error: result.error,
              reason: 'blocked_by_dependency',
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
        return
      }

      await engine.synthesizeAndReport(runId, run.groupSessionId, run.workspaceId, plan, results)
    } catch (error: any) {
      logger.error({ err: error?.message, runId }, 'Resumed scheduler execution failed')
      await runController.fail(runContext, {
        error: error?.message || 'Resumed scheduler execution failed',
        stage: 'resume-scheduler-execution',
      })
    } finally {
      if (OrchestratorEngine.activeEngines.get(runId) === engine) {
        OrchestratorEngine.activeEngines.delete(runId)
      }
      engine.activePlan = null
      engine.activeChildSessions = new Map()
      engine.activeRunContext = null
      blackboard.clearNamespace(Blackboard.namespace(run.workspaceId, runId))
    }
  }

  async retryTask(params: {
    runId: string
    groupSessionId: string
    workspaceId: string
    task: ExecutionTask
    childSessions: Map<string, ChildSessionInfo>
    run?: RunControllerRunContext
  }): Promise<TaskResult> {
    const { runId, groupSessionId, workspaceId, task, childSessions } = params
    const runContext: RunControllerRunContext =
      params.run ?? {
        runId,
        workspaceId,
        groupSessionId,
      }

    const [runRow] = await db
      .select({ plan: orchestratorRuns.plan })
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.id, runId))
      .limit(1)

    await runController.markRunning(runContext, {
      plan:
        runRow?.plan && typeof runRow.plan === 'object'
          ? (runRow.plan as Record<string, unknown>)
          : undefined,
      taskCount: 1,
    })

    const existingChild = childSessions.get(task.id)
    await runController.resetTaskForRetry(runContext, {
      taskId: task.id,
      title: task.title,
      agentId: task.agentId,
      reason: 'User triggered retry',
      attempt: 0,
      childSessionId: existingChild?.sessionId ?? null,
      taskThreadId: existingChild?.taskThreadId ?? null,
      workerInstanceId: existingChild?.workerInstanceId ?? null,
    })

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

    if (result.status === TaskStatus.Failed || result.status === TaskStatus.Blocked) {
      await runController.fail(runContext, {
        error:
          result.error ??
          result.output ??
          `Retry failed for task ${task.title}`,
        stage: 'task-retry',
      })
    } else if (result.status === TaskStatus.Cancelled) {
      await runController.cancel(runContext, {
        reason: 'task_retry_cancelled',
        summary: `Retry for task "${task.title}" was cancelled.`,
        taskErrorLog: result.error ?? 'Task retry cancelled',
        payload: {
          taskId: task.id,
        },
      })
    }

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
    run?: RunControllerRunContext
  }): Promise<void> {
    const { runId, groupSessionId, workspaceId, childSessions } = params
    const plan = initializeRunLedger(params.plan)
    OrchestratorEngine.activeEngines.set(runId, this)
    const runContext: RunControllerRunContext = params.run ?? {
      runId,
      workspaceId,
      groupSessionId,
    }
    this.activePlan = plan
    this.activeChildSessions = childSessions
    this.activeRunContext = runContext
    await runController.markRunning(runContext, {
      plan: plan as unknown as Record<string, unknown>,
      taskCount: plan.tasks.length,
    })

    const [groupSessionRecord] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, groupSessionId))
      .limit(1)
    const ownerId = groupSessionRecord?.ownerId ?? 'user'
    const orchestratorProfile = await this.loadOrchestratorProfile(workspaceId)

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
            await runController.markTaskBlocked(runContext, {
              taskId: task.id,
              title: task.title,
              agentId: task.agentId,
              error: result.error,
              reason: 'blocked_by_dependency',
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

          const needMoreTasks = await this.evaluateSupervisorNeed(
            plan.goal,
            taskOutputs,
            orchestratorProfile,
          )
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

            const registrations: DynamicTaskRegistration[] = []
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

              const childInfo = await ensureTaskRuntimeThread({
                workspaceId,
                workspaceName: plan.title,
                ownerId,
                groupSessionId,
                runId,
                plan,
                task,
                agent,
                projectPath: childSessions.get(plan.tasks[0]?.id ?? '')?.projectPath,
              })
              childSessions.set(task.id, childInfo)

              registrations.push({
                task,
                childInfo,
                strategy: 'supervisor_supplement',
                agentName: agent.name,
                round: supervisorRound,
                severity: 'info',
              })
            }

            const newTasks = await this.registerDynamicTasks(
              runContext,
              plan,
              workspaceId,
              registrations,
              { attachToActiveRun: false },
            )

            if (newTasks.length === 0) {
              break
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

      // 冲突检测与解决：遍历所有有 projectPath 的任务目录
      const projectPaths = new Set<string>()
      for (const task of plan.tasks) {
        const path = childSessions.get(task.id)?.projectPath
        if (path) projectPaths.add(path)
      }

      const mergeReports: MergeReport[] = []
      for (const projectPath of projectPaths) {
        const reports = await this.mergeResolver.detectAndResolve(results, {
          projectPath,
          baseBranch: await executionBranchManager.inferBaseBranch(projectPath),
        })
        mergeReports.push(...reports)
      }

      if (mergeReports.length > 0) {
        for (const report of mergeReports) {
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
            conflictReport: mergeReports as unknown as import('@agenthub/db').ConflictReport[],
          })
          .where(eq(orchestratorRuns.id, runId))
      }

      await this.synthesizeAndReport(
        runId,
        groupSessionId,
        workspaceId,
        plan,
        results,
        mergeReports,
        runContext,
      )
    } catch (error: any) {
      logger.error({ err: error?.message, runId }, 'Scheduler execution failed')
      await runController.fail(runContext, {
        error: error?.message || 'Scheduler execution failed',
        stage: 'scheduler-execution',
      })
    } finally {
      if (OrchestratorEngine.activeEngines.get(runId) === this) {
        OrchestratorEngine.activeEngines.delete(runId)
      }
      this.activePlan = null
      this.activeChildSessions = new Map()
      this.activeRunContext = null
      // Run 结束，清理黑板内存缓存
      blackboard.clearNamespace(Blackboard.namespace(workspaceId, runId))
    }
  }

  private async loadOrchestratorProfile(workspaceId: string): Promise<AgentProfile | null> {
    const [workspace] = await db
      .select({ projectPath: workspaces.projectPath })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
    const agents = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.workspaceId, workspaceId))
    const orchestrator = agents.find((agent) => agent.roleType === 'orchestrator')
    return orchestrator ? buildAgentProfile(orchestrator, workspace?.projectPath) : null
  }

  private ensurePlanContainsTask(plan: ExecutionPlan, task: ExecutionTask) {
    if (!plan.tasks.some((existing) => existing.id === task.id)) {
      plan.tasks.push(task)
    }

    const phaseId = task.phaseId ?? 'execution'
    if (!plan.phases) {
      plan.phases = [
        {
          id: phaseId,
          title: phaseId === 'execution' ? '执行' : phaseId,
          purpose: phaseId === 'execution' ? '完成当前协作任务' : phaseId,
          taskIds: [task.id],
        },
      ]
      return
    }

    let phase = plan.phases.find((item) => item.id === phaseId)
    if (!phase) {
      phase = {
        id: phaseId,
        title: phaseId === 'execution' ? '执行' : phaseId,
        purpose: phaseId === 'execution' ? '完成当前协作任务' : phaseId,
        taskIds: [],
      }
      plan.phases.push(phase)
    }
    if (!phase.taskIds.includes(task.id)) {
      phase.taskIds.push(task.id)
    }
  }

  private applyHumanInterruptToPlan(
    input: HumanInterruptPayload & { targetTaskIds?: string[] | null },
  ): { memoryPlanUpdated: boolean; updatedTaskIds: string[] } {
    if (!this.activePlan) {
      return { memoryPlanUpdated: false, updatedTaskIds: [] }
    }

    const targetTaskIds =
      input.targetTaskIds && input.targetTaskIds.length > 0
        ? new Set(input.targetTaskIds)
        : new Set(this.activePlan.tasks.map((task) => task.id))

    const updatedTaskIds: string[] = []
    for (const task of this.activePlan.tasks) {
      if (!targetTaskIds.has(task.id)) continue
      const nextDescription = appendHumanInterruptConstraint(task.description, input)
      if (nextDescription === task.description) continue
      task.description = nextDescription
      updatedTaskIds.push(task.id)
    }

    return {
      memoryPlanUpdated: updatedTaskIds.length > 0,
      updatedTaskIds,
    }
  }

  private async registerDynamicTasks(
    run: RunControllerRunContext,
    plan: ExecutionPlan,
    workspaceId: string,
    registrations: DynamicTaskRegistration[],
    options?: {
      attachToActiveRun?: boolean
    },
  ): Promise<ExecutionTask[]> {
    const accepted: ExecutionTask[] = []
    let nextOrderIdx = plan.tasks.length

    for (const registration of registrations) {
      if (
        accepted.some((task) => task.id === registration.task.id) ||
        plan.tasks.some((task) => task.id === registration.task.id)
      ) {
        continue
      }

      await runController.queueTask(run, {
        taskId: registration.task.id,
        workspaceId,
        agentId: registration.task.agentId,
        title: registration.task.title,
        description: registration.task.description,
        sessionId: registration.childInfo.sessionId,
        childSessionId: registration.childInfo.sessionId,
        taskThreadId: registration.childInfo.taskThreadId ?? null,
        sharedTaskRelativeRoot: registration.childInfo.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: registration.childInfo.sharedTaskSpecPath ?? null,
        workerInstanceId: registration.childInfo.workerInstanceId ?? null,
        orderIdx: nextOrderIdx,
        phaseId: registration.task.phaseId,
        dependencies: registration.task.dependencies ?? [],
        parallelGroup: registration.task.parallelGroup,
        maxRetries: registration.task.maxRetries,
        strategy: registration.strategy,
        taskType: registration.task.taskType ?? null,
        agentName: registration.agentName ?? null,
        round: registration.round ?? null,
        reason: registration.reason ?? null,
        severity: registration.severity ?? 'info',
      })

      this.ensurePlanContainsTask(plan, registration.task)
      accepted.push(registration.task)
      nextOrderIdx++
    }

    if ((options?.attachToActiveRun ?? true) && accepted.length > 0) {
      this.scheduler.addTasksToRun(run.runId, accepted)
    }

    return accepted
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
      const resumedHumanInterruptDescriptions = new Set<string>()
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
        if (result.status === TaskStatus.Done) {
          return result
        }

        if (result.status === TaskStatus.Cancelled) {
          const descriptionKey = currentTask.description ?? ''
          if (
            !signal.aborted &&
            hasHumanInterruptConstraint(descriptionKey) &&
            !resumedHumanInterruptDescriptions.has(descriptionKey)
          ) {
            resumedHumanInterruptDescriptions.add(descriptionKey)
            const childInfo = childSessions.get(currentTask.id)
            await runController.resetTaskForReplan(
              { runId, workspaceId, groupSessionId },
              {
                taskId: currentTask.id,
                title: currentTask.title,
                agentId: currentTask.agentId,
                reason: 'Manager resumed task after a human requirement interruption.',
                strategy: 'human_interrupt_resume',
                changedTaskIds: [currentTask.id],
                childSessionId: childInfo?.sessionId ?? null,
                taskThreadId: childInfo?.taskThreadId ?? null,
                workerInstanceId: childInfo?.workerInstanceId ?? null,
                retryCount: currentAttempt,
              },
            )
            await emitRunEvent({
              runId,
              workspaceId,
              groupSessionId,
              taskId: currentTask.id,
              threadId: childInfo?.taskThreadId ?? null,
              workerInstanceId: childInfo?.workerInstanceId ?? null,
              agentId: currentTask.agentId,
              type: 'manager.next_action',
              severity: 'warning',
              payload: {
                action: 'resuming_interrupted_task',
                reason: 'Manager is resuming a task that was interrupted by a human requirement update.',
                taskId: currentTask.id,
                taskTitle: currentTask.title,
                childSessionId: childInfo?.sessionId ?? null,
                taskThreadId: childInfo?.taskThreadId ?? null,
                taskThreadStatus: 'prepared',
              },
            })
            continue
          }
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
          const childInfo = childSessions.get(currentTask.id)
          await runController.resetTaskForRetry(
            { runId, workspaceId, groupSessionId },
            {
              taskId: currentTask.id,
              title: currentTask.title,
              agentId: currentTask.agentId,
              reason: replan.reason,
              attempt: currentAttempt,
              delayMs,
              childSessionId: childInfo?.sessionId ?? null,
              taskThreadId: childInfo?.taskThreadId ?? null,
              workerInstanceId: childInfo?.workerInstanceId ?? null,
            },
          )
          await new Promise((r) => setTimeout(r, delayMs))
          continue
        }

        if (replan.strategy === 'agent_substitution' && replan.updatedTask) {
          const previousAgentId = currentTask.agentId
          currentTask = replan.updatedTask
          currentAttempt = 0
          const childInfo = childSessions.get(currentTask.id)
          await runController.resetTaskForReplan(
            { runId, workspaceId, groupSessionId },
            {
              taskId: currentTask.id,
              title: currentTask.title,
              agentId: previousAgentId,
              nextAgentId: currentTask.agentId,
              reason: replan.reason,
              strategy: 'agent_substitution',
              changedTaskIds: [currentTask.id],
              childSessionId: childInfo?.sessionId ?? null,
              taskThreadId: childInfo?.taskThreadId ?? null,
              workerInstanceId: childInfo?.workerInstanceId ?? null,
              retryCount: 0,
              extraPayload: {
                fromAgentId: previousAgentId,
                toAgentId: currentTask.agentId,
              },
            },
          )
          continue
        }

        if (replan.strategy === 'local_replan' && replan.updatedTask) {
          currentTask = replan.updatedTask
          currentAttempt = 0
          const childInfo = childSessions.get(currentTask.id)
          await runController.resetTaskForReplan(
            { runId, workspaceId, groupSessionId },
            {
              taskId: currentTask.id,
              title: currentTask.title,
              agentId: currentTask.agentId,
              reason: replan.reason,
              strategy: 'local_replan',
              changedTaskIds: [currentTask.id],
              childSessionId: childInfo?.sessionId ?? null,
              taskThreadId: childInfo?.taskThreadId ?? null,
              workerInstanceId: childInfo?.workerInstanceId ?? null,
              retryCount: 0,
            },
          )
          continue
        }

        if (replan.strategy === 'task_split' && replan.newTasks && replan.newTasks.length > 0) {
          const registrations: DynamicTaskRegistration[] = []
          for (const newTask of replan.newTasks) {
            const newAgent = plan.agents.find((a) => a.id === newTask.agentId)
            const childInfo = await ensureTaskRuntimeThread({
              workspaceId,
              workspaceName: plan.title,
              ownerId,
              groupSessionId,
              runId,
              plan,
              task: newTask,
              agent: newAgent ?? null,
              projectPath: childSessions.get(currentTask.id)?.projectPath,
            })
            childSessions.set(newTask.id, childInfo)
            registrations.push({
              task: newTask,
              childInfo,
              strategy: 'task_split',
              agentName: newAgent?.name ?? newTask.agentId,
              reason: replan.reason,
              severity: 'warning',
            })
          }
          const queuedTasks = await this.registerDynamicTasks(
            { runId, workspaceId, groupSessionId },
            plan,
            workspaceId,
            registrations,
          )
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
              changedTaskIds: queuedTasks.map((t) => t.id),
            },
          })
          logger.info(
            { taskId: currentTask.id, newTaskCount: queuedTasks.length },
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
              const registrations: DynamicTaskRegistration[] = []
              for (const newTask of tasksToAdd) {
                const newAgent = plan.agents.find((a) => a.id === newTask.agentId)
                const childInfo = await ensureTaskRuntimeThread({
                  workspaceId,
                  workspaceName: plan.title,
                  ownerId,
                  groupSessionId,
                  runId,
                  plan,
                  task: newTask,
                  agent: newAgent ?? null,
                  projectPath: childSessions.get(currentTask.id)?.projectPath,
                })
                childSessions.set(newTask.id, childInfo)
                registrations.push({
                  task: newTask,
                  childInfo,
                  strategy: 'global_replan',
                  agentName: newAgent?.name ?? newTask.agentId,
                  severity: 'warning',
                })
              }
              const queuedTasks = await this.registerDynamicTasks(
                { runId, workspaceId, groupSessionId },
                plan,
                workspaceId,
                registrations,
              )
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
                  changedTaskIds: queuedTasks.map((t) => t.id),
                },
              })
              logger.info(
                { taskId: currentTask.id, addedCount: queuedTasks.length },
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
    orchestratorProfile?: AgentProfile | null,
  ): Promise<boolean> {
    const prompt = `评估以下任务产出是否充分，决定是否需要追加补充任务。

原始目标：${goal}

已完成任务产出：
${taskOutputs.map((t) => `- [${t.agentName}] ${t.taskTitle}: ${t.output.slice(0, 300)}`).join('\n')}

请只回答 "YES" 或 "NO"：
- YES：当前产出不够充分，需要追加补充任务（如缺少关键分析维度、遗漏重要方面、深度不够等）
- NO：当前产出已经充分，无需追加`

    try {
      if (orchestratorProfile?.runtimeType === 'code-agent') {
        const profile: AgentProfile = {
          ...orchestratorProfile,
          sandboxPolicy: 'workspace-write',
          toolPermissions: ['chat', 'workspace:read'],
          approvalRequired: false,
        }
        const runtime = runtimeRegistry.resolve(profile)
        let output = ''
        for await (const chunk of runtime.execute({
          sessionId: `supervisor-check-${crypto.randomUUID()}`,
          prompt: [
            '你是 AgentHub 的 Orchestrator，本次只判断是否需要追加补充任务。',
            '只回答 YES 或 NO，不要解释，不要修改文件。',
            '',
            prompt,
          ].join('\n'),
          history: [],
          profile,
          signal: new AbortController().signal,
          rawFinalOutput: true,
        })) {
          if (chunk.kind !== 'text') continue
          output += chunk.text
          if (output.length > 100) break
        }
        return output.trim().toUpperCase().includes('YES')
      }

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
    const runContext: RunControllerRunContext = {
      runId,
      workspaceId,
      groupSessionId,
    }
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
    if (agent.roleType === 'orchestrator') {
      const error = 'Planner attempted to assign executable work to Orchestrator. Orchestrator may coordinate only; worker tasks must target specialist agents.'
      await emitRunEvent({
        runId,
        workspaceId,
        groupSessionId,
        taskId: task.id,
        agentId: agent.id,
        type: 'task.failed',
        severity: 'error',
        payload: { title: task.title, agentName: agent.name, error },
      })
      return {
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        status: TaskStatus.Failed,
        output: error,
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
      childInfo = await ensureTaskRuntimeThread({
        workspaceId,
        workspaceName: plan.title || 'Agent Group',
        ownerId,
        groupSessionId,
        runId,
        plan,
        task,
        agent,
        projectPath:
          childInfo?.projectPath ?? childSessions.values().next().value?.projectPath ?? null,
      })
      childSessions.set(task.id, childInfo)
      await db
        .update(workspaceTasks)
        .set({ sessionId: childInfo.sessionId, progressStatus: 'thread-prepared' })
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
    const profile = buildAgentProfileWithExecutionDir(
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

    const prompt = await buildTaskPrompt(task, plan, blackboard, bbNamespace, {
      taskThreadId: childInfo.taskThreadId ?? null,
      sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
    })

    const userMessageId = crypto.randomUUID()
    const a2aDispatch = buildA2ADispatchEnvelope({
      task,
      plan,
      agent,
      prompt,
      workspaceId,
      groupSessionId,
      childSessionId: childInfo.sessionId,
      taskThreadId: childInfo.taskThreadId ?? null,
      sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
      userMessageId,
    })

    // 插入 A2A message/send 对应的 user message
    const [userMsg] = await db
      .insert(messages)
      .values({
        id: userMessageId,
        sessionId: childInfo.sessionId,
        senderId: 'user',
        senderType: 'user',
        type: 'text',
        content: prompt,
        metadata: { a2a: a2aDispatch },
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

    const orchestratorAgent = plan.agents.find((item) => item.roleType === 'orchestrator')
    const managerDispatchMessage = await persistThreadTransparencyMessage({
      sessionId: childInfo.sessionId,
      senderId: orchestratorAgent?.id ?? 'orchestrator',
      senderType: 'agent',
      content: buildManagerDispatchThreadMessage({
        managerName: orchestratorAgent?.name ?? 'Orchestrator',
        workerName: agent.name,
        taskTitle: task.title,
        sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
      }),
      metadata: {
        kind: 'manager-task-assigned',
        orchestratorRunId: runId,
        orchestratorTaskId: task.id,
        groupSessionId,
        taskThreadId: childInfo.taskThreadId ?? null,
        workerInstanceId: childInfo.workerInstanceId ?? null,
        managerName: orchestratorAgent?.name ?? 'Orchestrator',
        workerName: agent.name,
        sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? undefined,
        sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? undefined,
        a2aDispatch: a2aDispatch.params,
      },
    })
    await runController.markTaskAssigned(runContext, {
      taskId: task.id,
      title: task.title,
      agentId: agent.id,
      workerInstanceId: childInfo.workerInstanceId ?? null,
      childSessionId: childInfo.sessionId,
      taskThreadId: childInfo.taskThreadId ?? null,
      sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
      messageId: userMsg.id,
      extraPayload: {
        agentName: agent.name,
        sessionId: childInfo.sessionId,
        assignmentMessageId: managerDispatchMessage?.id ?? null,
      },
    })
    await this.syncSharedTaskDirectory({
      childInfo,
      status: 'assigned',
      workerInstanceId: childInfo.workerInstanceId ?? null,
      messageId: userMsg.id,
      timestamps: { assignedAt: new Date().toISOString() },
    })

    let executionConfig = await buildExecutionConfigSummary({
      profile,
      projectPath: childInfo.projectPath ?? null,
      executionPath: profile.projectPath ?? childInfo.projectPath ?? null,
      requestedSandboxPolicy: profile.sandboxPolicy,
    })
    const workerInstanceId = childInfo.workerInstanceId ?? null
    const runtimeLease = await createRuntimeLease({
      workspaceId,
      runId,
      taskId: task.id,
      workerInstanceId,
      provider: executionConfig.sandboxProvider,
      cwd: executionConfig.executionPath,
      metadata: {
        taskThreadId: childInfo.taskThreadId ?? null,
        sessionId: childInfo.sessionId,
        executionConfig,
      },
    })
    const runtimeLeaseId = runtimeLease?.id ?? null
    let runtimeLeaseFinalized = false
    const finalizeRuntimeLease = async (
      status: 'released' | 'failed',
      metadata?: Record<string, unknown>,
      error?: string | null,
    ) => {
      if (!runtimeLeaseId || runtimeLeaseFinalized) return
      runtimeLeaseFinalized = true
      if (status === 'released') {
        await releaseRuntimeLease(runtimeLeaseId, {
          workerInstanceId,
          metadata: {
            taskStatus: metadata?.taskStatus ?? TaskStatus.Done,
            executionConfig,
            ...metadata,
          },
        })
        return
      }
      await failRuntimeLease(runtimeLeaseId, {
        workerInstanceId,
        error,
        metadata: {
          taskStatus: TaskStatus.Failed,
          executionConfig,
          ...metadata,
        },
      })
    }
    await markWorkerInstanceState(workerInstanceId, 'ready', {
      message: `${agent.name} runtime lease prepared.`,
      health: {
        readinessStatus: executionConfig.readinessStatus,
        blockers: executionConfig.blockers ?? [],
      },
    })

    const initialProgressStatus = buildExecutionProgressStatus({
      agentName: agent.name,
      taskTitle: task.title,
      executionConfig,
    })
    await runController.markTaskActive(runContext, {
      taskId: task.id,
      title: task.title,
      agentId: agent.id,
      workerInstanceId,
      runtimeLeaseId,
      childSessionId: childInfo.sessionId,
      taskThreadId: childInfo.taskThreadId ?? null,
      sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
      progressPercent: 3,
      progressStatus: initialProgressStatus,
      executionConfig: executionConfig as unknown as Record<string, unknown>,
      extraPayload: {
        agentName: agent.name,
        attempt: attemptCount,
        sessionId: childInfo.sessionId,
      },
    })
    await this.syncSharedTaskDirectory({
      childInfo,
      status: 'running',
      workerInstanceId,
      runtimeLeaseId,
      executionConfig: executionConfig as unknown as Record<string, unknown>,
      timestamps: { startedAt: new Date().toISOString() },
    })
    await markRuntimeLeaseReady(runtimeLeaseId, {
      provider: executionConfig.sandboxProvider,
      cwd: executionConfig.executionPath,
      executionConfig,
    })
    await markWorkerInstanceState(workerInstanceId, 'busy', {
      message: `${agent.name} is executing "${task.title}".`,
      runtimeHome: executionConfig.sandboxHomeDir ?? null,
      runtimeConfigPath: executionConfig.sandboxConfigDir ?? null,
      health: {
        readinessStatus: executionConfig.readinessStatus,
        sandboxProvider: executionConfig.sandboxProvider,
        isolation: executionConfig.isolation,
      },
    })

    const workerAcceptedMessage = await persistThreadTransparencyMessage({
      sessionId: childInfo.sessionId,
      senderId: agent.id,
      senderType: 'agent',
      content: buildWorkerAcceptedThreadMessage({
        workerName: agent.name,
        taskTitle: task.title,
        executionConfig,
        sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
      }),
      metadata: {
        kind: 'worker-task-accepted',
        orchestratorRunId: runId,
        orchestratorTaskId: task.id,
        groupSessionId,
        taskThreadId: childInfo.taskThreadId ?? null,
        workerInstanceId,
        runtimeLeaseId,
        workerName: agent.name,
        executionConfig,
        sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? undefined,
        sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? undefined,
      },
    })
    if (workerAcceptedMessage) {
      await executionTracer.log({
        runId,
        sessionId: childInfo.sessionId,
        agentId: agent.id,
        taskId: task.id,
        type: 'tool_call',
        input: { kind: 'worker_task_accepted', messageId: workerAcceptedMessage.id },
      })
    }

    await persistThreadTransparencyMessage({
      sessionId: groupSessionId,
      senderId: agent.id,
      senderType: 'agent',
      content: buildWorkerGroupStartedMessage({
        taskTitle: task.title,
        executionConfig,
        sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
      }),
      metadata: {
        kind: 'worker-task-started',
        orchestratorRunId: runId,
        orchestratorTaskId: task.id,
        groupSessionId,
        childSessionId: childInfo.sessionId,
        taskThreadId: childInfo.taskThreadId ?? null,
        workerInstanceId,
        runtimeLeaseId,
        agentName: agent.name,
        taskStatus: TaskStatus.Running,
        taskProgressUpdate: true,
        progressPercent: 3,
        progressStatus: initialProgressStatus,
        executionConfig,
        sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? undefined,
        sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? undefined,
      },
    })

    const taskStartTime = Date.now()
    const stopHeartbeat = startTaskHeartbeat({
      runId,
      groupSessionId,
      workspaceId,
      taskId: task.id,
      childSessionId: childInfo.sessionId,
      taskThreadId: childInfo.taskThreadId ?? null,
      workerInstanceId,
      runtimeLeaseId,
      agentId: agent.id,
      agentName: agent.name,
      taskTitle: task.title,
      startedAt: taskStartTime,
      timeoutMs: TASK_TIMEOUT_MS,
      getExecutionConfig: () => executionConfig,
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
        a2a: a2aDispatch,
      onExecutionConfigReady: async (config) => {
          executionConfig = config
          await markRuntimeLeaseRunning(runtimeLeaseId, {
            provider: config.sandboxProvider,
            cwd: config.executionPath,
            executionConfig: config,
          })
          await markWorkerInstanceState(workerInstanceId, 'busy', {
            message: `${agent.name} is running in ${config.sandboxProvider ?? 'local-workdir'}.`,
            runtimeHome: config.sandboxHomeDir ?? null,
            runtimeConfigPath: config.sandboxConfigDir ?? null,
            health: {
              readinessStatus: config.readinessStatus,
              sandboxProvider: config.sandboxProvider,
              isolation: config.isolation,
              blockers: config.blockers ?? [],
            },
          })
          await this.syncSharedTaskDirectory({
            childInfo,
            status: 'running',
            workerInstanceId,
            runtimeLeaseId,
            executionConfig: config as unknown as Record<string, unknown>,
          })
          await runController.markTaskProgress(
            { runId, workspaceId, groupSessionId },
            {
              taskId: task.id,
              title: task.title,
              agentId: agent.id,
              agentName: agent.name,
              percent: 5,
              progressStatus: buildExecutionProgressStatus({
                agentName: agent.name,
                taskTitle: task.title,
                executionConfig,
              }),
              childSessionId: childInfo.sessionId,
              taskThreadId: childInfo.taskThreadId ?? null,
              workerInstanceId,
              runtimeLeaseId,
              sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
              sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
              executionConfig: config as unknown as Record<string, unknown>,
            },
          )
        },
      })
      stopHeartbeat()
      executionConfig = execResult.executionConfig ?? executionConfig

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
        sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
      })

      // Register artifacts through ArtifactController — the single convergence point.
      if (artifacts.length > 0) {
        const { registerArtifactBatch } = await import('./artifact-controller')
        registerArtifactBatch({
          workspaceId,
          runId,
          taskId: task.id,
          taskThreadId: childInfo.taskThreadId ?? null,
          workspaceAgentId: task.agentId ?? null,
          workerInstanceId: childInfo.workerInstanceId ?? null,
          groupSessionId,
          artifacts,
        }).catch(() => {})
      }

      const progressMatches = output.match(/\[PROGRESS:\s*(\d+)%\]\s*(.*)/g)
      if (progressMatches) {
        const lastProgress = progressMatches[progressMatches.length - 1]!
        const match = lastProgress.match(/\[PROGRESS:\s*(\d+)%\]\s*(.*)/)
        if (match) {
          const percent = parseInt(match[1]!, 10)
          const status = match[2]?.trim() || ''
          await runController.markTaskProgress(
            { runId, workspaceId, groupSessionId },
            {
              taskId: task.id,
              title: task.title,
              agentId: agent.id,
              agentName: agent.name,
              percent,
              progressStatus: status,
              childSessionId: childInfo.sessionId,
              taskThreadId: childInfo.taskThreadId ?? null,
              workerInstanceId,
              runtimeLeaseId,
              sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
              sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
              executionConfig: executionConfig as unknown as Record<string, unknown>,
            },
          )
        }
      }

      if (execResult.status === TaskStatus.Cancelled) {
        await finalizeRuntimeLease('released', {
          taskStatus: TaskStatus.Cancelled,
          reason: 'task_cancelled',
        })
        await runController.markTaskCancelled(runContext, {
          taskId: task.id,
          title: task.title,
          agentId: agent.id,
          reason: 'task_cancelled',
          progressStatus: 'cancelled',
          childSessionId: childInfo.sessionId,
          taskThreadId: childInfo.taskThreadId ?? null,
          workerInstanceId,
          runtimeLeaseId,
          sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
          sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
          executionConfig: executionConfig as unknown as Record<string, unknown>,
          extraPayload: {
            agentName: agent.name,
            sessionId: childInfo.sessionId,
          },
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

      await runController.markTaskProgress(
        { runId, workspaceId, groupSessionId },
        {
          taskId: task.id,
          title: task.title,
          agentId: agent.id,
          agentName: agent.name,
          percent: 95,
          progressStatus: `${agent.name} 正在整理产物与任务摘要。`,
          childSessionId: childInfo.sessionId,
          taskThreadId: childInfo.taskThreadId ?? null,
          workerInstanceId,
          runtimeLeaseId,
          sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
          sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
        },
      )

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
            senderType: 'agent',
            type: 'text',
            content: buildWorkerClarificationGroupMessage({
              question: clarification.question,
              options: clarification.options,
            }),
            metadata: {
              kind: 'worker-clarification-needed',
              clarificationTaskId: task.id,
              clarificationOptions: clarification.options,
              clarificationStatus: 'pending',
              agentName: agent.name,
              orchestratorRunId: runId,
              orchestratorTaskId: task.id,
              groupSessionId,
              childSessionId: childInfo.sessionId,
              taskThreadId: childInfo.taskThreadId ?? null,
              workerInstanceId,
              runtimeLeaseId,
              taskStatus: 'blocked',
              taskProgressUpdate: true,
              progressStatus: clarification.question,
              executionConfig,
            },
            createdAt: new Date(),
          })
          .returning()

        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          taskId: task.id,
          threadId: childInfo.taskThreadId ?? null,
          workerInstanceId,
          agentId: task.agentId,
          type: 'task.clarification_needed',
          severity: 'warning',
          payload: {
            taskId: task.id,
            agentId: task.agentId,
            agentName: agent.name,
            workerInstanceId,
            runtimeLeaseId,
            question: clarification.question,
            options: clarification.options,
            messageId: clarMsg[0]?.id,
            runId,
            childSessionId: childInfo.sessionId,
            taskThreadId: childInfo.taskThreadId ?? null,
            sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
            sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
            executionConfig,
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

        await finalizeRuntimeLease('released', {
          taskStatus: 'awaiting_clarification',
          reason: 'worker_requested_clarification',
          clarificationQuestion: clarification.question,
        })

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
          threadId: childInfo.taskThreadId ?? null,
          workerInstanceId,
          agentId: agent.id,
          type: 'task.reassigned' as any,
          severity: 'warning',
          payload: {
            taskTitle: task.title,
            agentId: agent.id,
            agentName: agent.name,
            workerInstanceId,
            runtimeLeaseId,
            reason: rejection.reason,
            suggestedAgent: rejection.suggestedAgent,
            childSessionId: childInfo.sessionId,
            taskThreadId: childInfo.taskThreadId ?? null,
            sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
            sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
            executionConfig,
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
            await finalizeRuntimeLease('released', {
              taskStatus: TaskStatus.Failed,
              reason: 'worker_rejected_reassigned',
              suggestedAgent: fallbackAgent.name,
              rejectionReason: rejection.reason,
            })
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
            await finalizeRuntimeLease('released', {
              taskStatus: TaskStatus.Failed,
              reason: 'worker_rejected_fallback',
              suggestedAgent: fallbackAgent.name,
              rejectionReason: rejection.reason,
            })
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

        await finalizeRuntimeLease('released', {
          taskStatus: TaskStatus.Failed,
          reason: 'worker_rejected',
          rejectionReason: rejection.reason,
        })
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
        await runController.markTaskProgress(
          { runId, workspaceId, groupSessionId },
          {
            taskId: task.id,
            title: task.title,
            agentId: agent.id,
            agentName: agent.name,
            percent: lastProgress.percent,
            progressStatus: lastProgress.status,
            childSessionId: childInfo.sessionId,
            taskThreadId: childInfo.taskThreadId ?? null,
            workerInstanceId,
            runtimeLeaseId,
            sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
            sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
          },
        )
        await persistThreadTransparencyMessage({
          sessionId: groupSessionId,
          senderId: agent.id,
          senderType: 'agent',
          content: buildWorkerProgressGroupMessage({
            taskTitle: task.title,
            percent: lastProgress.percent,
            status: lastProgress.status,
          }),
          metadata: {
            kind: 'worker-progress-update',
            orchestratorRunId: runId,
            orchestratorTaskId: task.id,
            groupSessionId,
            childSessionId: childInfo.sessionId,
            taskThreadId: childInfo.taskThreadId ?? null,
            workerInstanceId,
            runtimeLeaseId,
            agentName: agent.name,
            taskStatus: TaskStatus.Running,
            taskProgressUpdate: true,
            progressPercent: lastProgress.percent,
            progressStatus: lastProgress.status,
            executionConfig,
          },
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
        threadId: childInfo.taskThreadId ?? null,
        workerInstanceId,
        agentId: agent.id,
        type: 'blackboard.written',
        payload: {
          namespace: bbNamespace,
          key: `task_${task.id}_output`,
          version: outputRef.version,
          summary: summary.brief,
          agentId: agent.id,
          agentName: agent.name,
          taskTitle: task.title,
          workerInstanceId,
          runtimeLeaseId,
          childSessionId: childInfo.sessionId,
          taskThreadId: childInfo.taskThreadId ?? null,
          sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
          sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
        },
      })

      const canonicalArtifacts: Array<Record<string, unknown>> = []
      for (const artifact of artifacts) {
        const artifactId =
          typeof artifact.id === 'string' && artifact.id ? artifact.id : `artifact-${task.id}`
        const artifactKind = String(artifact.kind ?? artifact.type ?? 'artifact')
        const artifactTitle = String(artifact.title ?? artifactId)
        const registeredArtifact = await registerTaskArtifact({
          workspaceId,
          runId,
          taskId: task.id,
          taskThreadId: childInfo.taskThreadId ?? null,
          workspaceAgentId: agent.id,
          workerInstanceId,
          artifact,
          status: execResult.status === TaskStatus.Failed ? 'partial' : 'registered',
        })
        const canonicalArtifact = registeredArtifact
          ? toCanonicalArtifactRecord(registeredArtifact)
          : ({
              ...artifact,
              source: artifact.source ?? 'task',
              artifactKind,
              kind: artifact.kind ?? artifact.type ?? 'file',
              type: artifact.type ?? artifact.kind ?? 'file',
            } as Record<string, unknown>)
        canonicalArtifacts.push(canonicalArtifact)
        await blackboard.write({
          namespace: bbNamespace,
          key: `artifacts/${registeredArtifact?.id ?? artifactId}`,
          value: {
            schemaType: 'artifact_ref',
            summary: artifactTitle,
            confidence: 0.8,
            sourceAgentId: agent.id,
            taskId: task.id,
            artifactId: registeredArtifact?.id ?? artifactId,
            legacyArtifactId: artifactId,
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
          threadId: childInfo.taskThreadId ?? null,
          workerInstanceId,
          agentId: agent.id,
          type: 'artifact.created',
          payload: {
            artifactId: registeredArtifact?.id ?? artifactId,
            legacyArtifactId: artifactId,
            workerInstanceId,
            runtimeLeaseId,
            artifactKind,
            title: artifactTitle,
            filePath: artifact.filePath ?? artifact.path,
            sourcePath: registeredArtifact?.sourcePath ?? artifact.sourcePath,
            handoffPath: registeredArtifact?.handoffPath ?? artifact.handoffPath,
            handoffRelativePath: registeredArtifact?.relativePath ?? artifact.handoffRelativePath,
            url: artifact.url,
            size: artifact.size,
            source: 'task',
            artifactStatus: registeredArtifact?.status,
            taskTitle: task.title,
            childSessionId: childInfo.sessionId,
            taskThreadId: childInfo.taskThreadId ?? null,
            artifact,
            agentName: agent.name,
            agentId: agent.id,
          },
        })
      }
      artifacts.splice(0, artifacts.length, ...canonicalArtifacts)

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
          threadId: childInfo.taskThreadId ?? null,
          workerInstanceId,
          agentId: agent.id,
          type: 'blackboard.written',
          severity: validation.status === 'failed' ? 'warning' : 'info',
          payload: {
            namespace: bbNamespace,
            key: validationKey,
            schemaType: 'test_result',
            agentId: agent.id,
            agentName: agent.name,
            workerInstanceId,
            runtimeLeaseId,
            childSessionId: childInfo.sessionId,
            taskThreadId: childInfo.taskThreadId ?? null,
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
        executionPath: execResult.executionPath ?? null,
      })
      lastContractResult = contractResult
      if (contractResult.status === 'failed') {
        const fatalContractFailure = hasFatalTaskContractViolations(
          contractResult.violations,
          artifacts,
        )
        const contractError =
          `Task output contract failed: ${contractResult.violations[0]?.message ?? 'unknown violation'}`
        const failureReport = buildTaskResultReport({
          runId,
          task,
          agent,
          status: fatalContractFailure ? TaskStatus.Failed : TaskStatus.Done,
          summary,
          outputRef,
          artifacts,
          validationResults,
          contractResult,
          durationMs: Date.now() - taskStartTime,
          childSessionId: childInfo.sessionId,
          blackboardKeys: writtenBlackboardKeys,
          executionConfig,
          error: fatalContractFailure ? contractError : undefined,
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
            severity: fatalContractFailure ? 'high' : 'medium',
            mitigation:
              fatalContractFailure
                ? 'Review the task output contract, allowed paths, and produced artifacts before accepting this task.'
                : 'Produced artifacts are preserved and usable, but the planned output path contract should be reviewed.',
          },
          agentId: agent.id,
          taskId: task.id,
          tags: ['risk', 'contract_violation', `agent_${agent.id}`],
        })
        if (!fatalContractFailure) {
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: task.id,
            threadId: childInfo.taskThreadId ?? null,
            workerInstanceId,
            agentId: agent.id,
            type: 'task.progress',
            severity: 'warning',
            payload: {
              title: task.title,
              agentName: agent.name,
              workerInstanceId,
              runtimeLeaseId,
              childSessionId: childInfo.sessionId,
              taskThreadId: childInfo.taskThreadId ?? null,
              sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
              sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
              executionConfig,
              progressPercent: 95,
              progressStatus: '产物已生成，路径合约存在偏差，已转为复核警告。',
              violations: contractResult.violations,
              ...taskResultReportEventPayload(failureReport),
            },
          })
        }
        if (fatalContractFailure) {
          await emitRunEvent({
            runId,
            workspaceId,
            groupSessionId,
            taskId: task.id,
            threadId: childInfo.taskThreadId ?? null,
            workerInstanceId,
            agentId: agent.id,
            type: 'task.failed',
            severity: 'error',
            payload: {
              title: task.title,
              agentName: agent.name,
              workerInstanceId,
              runtimeLeaseId,
              childSessionId: childInfo.sessionId,
              taskThreadId: childInfo.taskThreadId ?? null,
              sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
              sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
              executionConfig,
              error: contractError,
              violations: contractResult.violations,
              ...taskResultReportEventPayload(failureReport),
            },
          })
          throw new Error(contractError)
        }
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
        executionConfig,
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
            executionConfig,
            a2a: {
              request: a2aDispatch.params,
              responseTask: buildA2AExecutionTask({
                envelope: a2aDispatch,
                status: TaskStatus.Done,
                output,
                artifacts,
              }),
            },
          },
        })
        .returning()

      if (agentResultMessage) {
        broadcastSessionEvent(groupSessionId, {
          type: WsEvent.MessageCompleted,
          payload: { sessionId: groupSessionId, message: agentResultMessage },
        })
      }

      await finalizeRuntimeLease('released', {
        taskStatus: TaskStatus.Done,
        artifactCount: artifacts.length,
        durationMs: taskDuration,
      })
      await this.syncSharedTaskDirectory({
        childInfo,
        status: 'completed',
        workerInstanceId,
        runtimeLeaseId,
        summary: summary.brief,
        artifacts,
        executionConfig: executionConfig as unknown as Record<string, unknown>,
        timestamps: { completedAt: new Date().toISOString() },
      })
      await runController.markTaskCompleted(runContext, {
        taskId: task.id,
        title: task.title,
        agentId: agent.id,
        progressStatus: 'completed',
        artifacts,
        childSessionId: childInfo.sessionId,
        taskThreadId: childInfo.taskThreadId ?? null,
        workerInstanceId,
        runtimeLeaseId,
        sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
        durationMs: taskDuration,
        executionConfig: executionConfig as unknown as Record<string, unknown>,
        extraPayload: {
          agentName: agent.name,
          sessionId: childInfo.sessionId,
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
      const failureDurationMs = Date.now() - taskStartTime
      const failureError = error?.message || 'Unknown error'
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
        durationMs: failureDurationMs,
        childSessionId: childInfo.sessionId,
        blackboardKeys: lastBlackboardKeys,
        executionConfig,
        error: failureError,
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
          durationMs: failureDurationMs,
        },
      })

      await finalizeRuntimeLease(
        'failed',
        {
          taskStatus: TaskStatus.Failed,
          partialArtifactCount: lastArtifacts.length,
          durationMs: failureDurationMs,
        },
        failureError,
      )
      await this.syncSharedTaskDirectory({
        childInfo,
        status: 'failed',
        workerInstanceId,
        runtimeLeaseId,
        error: failureError,
        summary: lastSummary?.brief,
        artifacts: lastArtifacts,
        executionConfig: executionConfig as unknown as Record<string, unknown>,
        timestamps: { failedAt: new Date().toISOString() },
      })
      await runController.markTaskFailed(runContext, {
        taskId: task.id,
        title: task.title,
        agentId: agent.id,
        error: failureError,
        progressStatus: 'failed',
        artifacts: lastArtifacts,
        childSessionId: childInfo.sessionId,
        taskThreadId: childInfo.taskThreadId ?? null,
        workerInstanceId,
        runtimeLeaseId,
        sharedTaskRelativeRoot: childInfo.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: childInfo.sharedTaskSpecPath ?? null,
        durationMs: failureDurationMs,
        executionConfig: executionConfig as unknown as Record<string, unknown>,
        extraPayload: {
          agentName: agent.name,
          sessionId: childInfo.sessionId,
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
            executionConfig,
            a2a: {
              request: a2aDispatch.params,
              responseTask: buildA2AExecutionTask({
                envelope: a2aDispatch,
                status: TaskStatus.Failed,
                output: lastAgentOutput,
                error: failureError,
                artifacts: lastArtifacts,
              }),
            },
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
        error: failureError,
      }
    } finally {
      stopHeartbeat()
    }
  }

  private async syncSharedTaskDirectory(input: {
    childInfo: ChildSessionInfo
    status: Parameters<typeof updateSharedTaskDirectoryStatus>[0]['status']
    workerInstanceId?: string | null
    runtimeLeaseId?: string | null
    messageId?: string | null
    error?: string | null
    summary?: string | null
    artifacts?: Array<Record<string, unknown>>
    executionConfig?: Record<string, unknown> | null
    timestamps?: Parameters<typeof updateSharedTaskDirectoryStatus>[0]['timestamps']
  }) {
    try {
      await updateSharedTaskDirectoryStatus({
        projectPath: input.childInfo.projectPath ?? null,
        sharedTaskRelativeRoot: input.childInfo.sharedTaskRelativeRoot ?? null,
        status: input.status,
        workerInstanceId: input.workerInstanceId ?? input.childInfo.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        messageId: input.messageId ?? null,
        error: input.error ?? null,
        summary: input.summary ?? null,
        artifacts: input.artifacts,
        executionConfig: input.executionConfig ?? null,
        timestamps: input.timestamps,
      })
    } catch (error: any) {
      logger.warn(
        {
          err: error?.message || error,
          taskThreadId: input.childInfo.taskThreadId,
          sharedTaskRelativeRoot: input.childInfo.sharedTaskRelativeRoot,
          status: input.status,
        },
        'Failed to update shared task directory status',
      )
    }
  }

  private async synthesizeAndReport(
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    plan: ExecutionPlan,
    results: TaskResult[],
    conflictReports: import('./conflict-resolver').ConflictReport[] = [],
    run?: RunControllerRunContext,
  ) {
    const runContext: RunControllerRunContext = run ?? {
      runId,
      workspaceId,
      groupSessionId,
    }
    await runController.markSynthesizing(runContext, {
      taskCount: results.length,
      summary: 'Manager 正在汇总团队产出。',
    })
    const orchestratorProfile = await this.loadOrchestratorProfile(workspaceId)

    // 从黑板读取所有产物，供 Synthesizer 使用（替代直接从 results 读取）
    const bbNamespace = Blackboard.namespace(workspaceId, runId)
    const typedBlackboardEntries = await blackboard.query({
      namespace: bbNamespace,
      orderBy: 'asc',
    })
    const bbResults = typedBlackboardEntries.filter(
      (entry) => entry.key.startsWith('task_') && entry.key.endsWith('_output'),
    )
    const snapshot = await runController.loadResourceSnapshot(runId)
    const taskThreadByTaskId = new Map(snapshot.taskThreads.map((thread) => [thread.taskId, thread]))
    const taskRowByTaskId = new Map(snapshot.tasks.map((task) => [task.id, task]))
    const enrichedResults: TaskResult[] = []
    const sharedTaskReviewIssues: Array<{
      taskId: string
      taskTitle: string
      error: string
    }> = []

    for (const r of results) {
      const bbEntry = bbResults.find((e) => e.key === `task_${r.taskId}_output`)
      let nextResult = r
      if (bbEntry) {
        const val = bbEntry.value as { output: string; artifacts: Array<Record<string, unknown>> }
        nextResult = {
          ...r,
          output: val.output,
          artifacts: val.artifacts,
          outputRef: { namespace: bbNamespace, key: bbEntry.key, version: bbEntry.version },
        }
      }

      const thread = taskThreadByTaskId.get(r.taskId)
      if (!thread?.sharedTaskRelativeRoot) {
        enrichedResults.push(nextResult)
        continue
      }

      try {
        const sharedResult = await readSharedTaskResult({
          projectPath: this.activeChildSessions.get(r.taskId)?.projectPath ?? null,
          sharedTaskRelativeRoot: thread.sharedTaskRelativeRoot,
        })
        if (sharedResult) {
          const sharedTaskStatus = mapSharedTaskResultStatus(sharedResult.result.status)
          nextResult = applySharedTaskResultContract(nextResult, {
            summary: sharedResult.result.summary,
            status: sharedResult.result.status,
            deliverables: sharedResult.result.deliverables,
            notes: sharedResult.result.notes,
            resultPath: sharedResult.resultPath,
            sharedTaskRelativeRoot: thread.sharedTaskRelativeRoot,
          })
          const task = plan.tasks.find((item) => item.id === r.taskId)
          const taskRow = taskRowByTaskId.get(r.taskId)
          if (task && taskRow?.status !== sharedTaskStatus) {
            await syncSharedTaskResultStatusToControlPlane({
              run: runContext,
              task,
              result: nextResult,
              status: sharedTaskStatus,
              summary: sharedResult.result.summary,
              sharedTaskResultStatus: sharedResult.result.status,
              childSessionId: thread.sessionId,
              taskThreadId: thread.id,
              workerInstanceId: thread.workerInstanceId ?? null,
              sharedTaskRelativeRoot: thread.sharedTaskRelativeRoot,
              sharedTaskSpecPath: thread.sharedTaskSpecPath ?? null,
            })
          }
        }
      } catch (error: any) {
        const task = plan.tasks.find((item) => item.id === r.taskId)
        const message = error?.message || 'Shared task result contract is invalid.'
        sharedTaskReviewIssues.push({
          taskId: r.taskId,
          taskTitle: task?.title ?? r.taskId,
          error: message,
        })
        await emitRunEvent({
          runId,
          workspaceId,
          groupSessionId,
          taskId: r.taskId,
          threadId: thread.id,
          workerInstanceId: thread.workerInstanceId ?? null,
          agentId: r.agentId,
          type: 'manager.reviewed',
          severity: 'warning',
          payload: {
            action: 'shared_task_result_contract_invalid',
            taskTitle: task?.title ?? r.taskId,
            sharedTaskRelativeRoot: thread.sharedTaskRelativeRoot,
            error: message,
          },
        })
        nextResult = {
          ...nextResult,
          status: TaskStatus.Failed,
          error: message,
        }
      }
      enrichedResults.push(nextResult)
    }

    const summary = await this.synthesizer.synthesize(
      plan,
      enrichedResults,
      conflictReports,
      typedBlackboardEntries,
      orchestratorProfile,
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
      conflictReports.length > 0 ||
      sharedTaskReviewIssues.length > 0
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
      ...sharedTaskReviewIssues.map((issue) => `- 结果契约异常：${issue.taskTitle}：${issue.error}`),
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

    const orchestratorSenderId = orchestratorProfile?.id ?? 'orchestrator'
    const orchestratorSenderName = orchestratorProfile?.name ?? 'Orchestrator'
    const orchestratorSenderRole = orchestratorProfile?.role ?? 'Coordinator'

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
        senderId: orchestratorSenderId,
        senderType: 'agent',
        type: 'text',
        content: finalSummary,
        metadata: {
          agentName: orchestratorSenderName,
          role: orchestratorSenderRole,
          runtimeType: orchestratorProfile?.runtimeType ?? 'llm',
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

    await runController.finish(runContext, {
      status: finalRunStatus === OrchestratorRunStatus.Failed ? 'failed' : 'completed',
      summary: finalSummary,
      summaryMessageId: summaryMsg?.id ?? null,
      conflictReport: conflictReports,
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

async function ensureTaskRuntimeThread(
  input: EnsureTaskRuntimeThreadInput,
): Promise<ChildSessionInfo> {
  const prepared = await prepareTaskRuntimeThread({
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    ownerId: input.ownerId,
    runId: input.runId,
    taskId: input.task.id,
    groupSessionId: input.groupSessionId,
    projectPath: input.projectPath ?? null,
    taskTitle: input.task.title,
    taskDescription: input.task.description,
    goal: input.plan.goal,
    agent: input.agent
      ? {
          id: input.agent.id,
          name: input.agent.name,
          role: input.agent.role,
          runtimeType: input.agent.runtimeType,
          codeAgentType: input.agent.codeAgentType,
          modelId: input.agent.modelId,
          skillIds: input.agent.roleProfile?.skillIds as string[] | undefined,
          sandboxPolicy: input.agent.sandboxPolicy,
        }
      : null,
    dependencies: input.task.dependencies ?? [],
    acceptanceCriteria: input.task.outputContract?.acceptanceCriteria,
    requiredArtifacts: input.task.outputContract?.requiredArtifacts,
  })

  return {
    sessionId: prepared.sessionId,
    workspaceId: prepared.workspaceId,
    projectPath: prepared.projectPath ?? null,
    taskThreadId: prepared.taskThreadId,
    workerInstanceId: prepared.workerInstanceId ?? null,
    sharedTaskRelativeRoot: prepared.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath: prepared.sharedTaskSpecPath ?? null,
  }
}

function startTaskHeartbeat(input: {
  runId: string
  groupSessionId: string
  workspaceId: string
  taskId: string
  childSessionId?: string | null
  taskThreadId?: string | null
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  agentId: string
  agentName: string
  taskTitle: string
  startedAt: number
  timeoutMs: number
  getExecutionConfig?: () => ExecutionConfigSummary | undefined
}) {
  let stopped = false
  let lastPersistAt = 0
  let lastRoomPulseAt = Date.now()
  const runContext: RunControllerRunContext = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    groupSessionId: input.groupSessionId,
  }

  const tick = async () => {
    if (stopped) return
    const elapsedMs = Date.now() - input.startedAt
    const percent = Math.min(90, Math.max(3, Math.round((elapsedMs / input.timeoutMs) * 100)))
    const executionConfig = input.getExecutionConfig?.()
    const status = buildExecutionProgressStatus({
      agentName: input.agentName,
      taskTitle: input.taskTitle,
      executionConfig,
      elapsedMs,
      timeoutMs: input.timeoutMs,
    })
    const persistDb = Date.now() - lastPersistAt >= 30_000
    if (persistDb) lastPersistAt = Date.now()
    const shouldPulseRoom = Date.now() - lastRoomPulseAt >= 30_000
    await runController
      .markTaskProgress(runContext, {
        taskId: input.taskId,
        title: input.taskTitle,
        agentId: input.agentId,
        agentName: input.agentName,
        percent,
        progressStatus: status,
        childSessionId: input.childSessionId ?? null,
        taskThreadId: input.taskThreadId ?? null,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        executionConfig: executionConfig as unknown as Record<string, unknown> | undefined,
        persistEvent: false,
        persistRunUpdatedAt: persistDb,
      })
      .catch((err: any) => {
        logger.warn({ err: err?.message, taskId: input.taskId }, 'Failed to persist task heartbeat')
      })

    if (shouldPulseRoom) {
      lastRoomPulseAt = Date.now()
      await persistThreadTransparencyMessage({
        sessionId: input.groupSessionId,
        senderId: input.agentId,
        senderType: 'agent',
        content: buildWorkerHeartbeatGroupMessage({
          taskTitle: input.taskTitle,
          percent,
          status,
        }),
        metadata: {
          kind: 'worker-heartbeat',
          taskProgressUpdate: true,
          orchestratorRunId: input.runId,
          orchestratorTaskId: input.taskId,
          groupSessionId: input.groupSessionId,
          childSessionId: input.childSessionId ?? null,
          taskThreadId: input.taskThreadId ?? null,
          workerInstanceId: input.workerInstanceId ?? null,
          runtimeLeaseId: input.runtimeLeaseId ?? null,
          agentName: input.agentName,
          taskStatus: TaskStatus.Running,
          progressPercent: percent,
          progressStatus: status,
          executionConfig: executionConfig,
        },
      }).catch((err: any) => {
        logger.warn({ err: err?.message, taskId: input.taskId }, 'Failed to emit worker heartbeat room message')
      })
    }
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

function buildExecutionProgressStatus(input: {
  agentName: string
  taskTitle: string
  executionConfig?: ExecutionConfigSummary
  elapsedMs?: number
  timeoutMs?: number
}) {
  const runtime =
    input.executionConfig?.adapterName ??
    input.executionConfig?.codeAgentType ??
    (input.executionConfig?.runtimeType === 'llm' ? 'LLM fallback' : 'Code Agent')
  const model = input.executionConfig?.modelLabel || input.executionConfig?.modelId
  const workdir =
    input.executionConfig?.workdirRelativePath ||
    shortPathLabel(input.executionConfig?.executionPath) ||
    shortPathLabel(input.executionConfig?.projectPath)
  const sandbox = [
    input.executionConfig?.sandboxProvider,
    input.executionConfig?.isolation,
    input.executionConfig?.sandboxPolicy,
  ]
    .filter(Boolean)
    .join('/')
  const elapsed =
    typeof input.elapsedMs === 'number' && typeof input.timeoutMs === 'number'
      ? `，已运行 ${formatDuration(input.elapsedMs)} / ${formatDuration(input.timeoutMs)}`
      : ''
  const waitHint =
    typeof input.elapsedMs === 'number' && input.elapsedMs > 30_000
      ? '，等待 CLI 输出或文件变更'
      : ''
  const detail = [
    model ? `模型 ${model}` : '',
    sandbox ? `沙箱 ${sandbox}` : '',
    workdir ? `目录 ${workdir}` : '',
  ]
    .filter(Boolean)
    .join('，')
  return `${input.agentName} 正在通过 ${runtime} 执行「${input.taskTitle}」${elapsed}${waitHint}${detail ? `（${detail}）` : ''}`
}

async function persistThreadTransparencyMessage(input: {
  sessionId: string
  senderId: string
  senderType: 'agent' | 'system'
  content: string
  metadata: Record<string, unknown>
}) {
  const [message] = await db
    .insert(messages)
    .values({
      sessionId: input.sessionId,
      senderId: input.senderId,
      senderType: input.senderType,
      type: 'text',
      content: input.content,
      metadata: {
        transparencyVisible: true,
        ...input.metadata,
      },
    })
    .returning()
  if (message) {
    broadcastSessionEvent(input.sessionId, {
      type: WsEvent.MessageCompleted,
      payload: { sessionId: input.sessionId, message },
    })
  }
  return message ?? null
}

function buildManagerDispatchThreadMessage(input: {
  managerName: string
  workerName: string
  taskTitle: string
  sharedTaskSpecPath?: string | null
}) {
  const lines = [`${input.managerName}：@${input.workerName}，请接手任务「${input.taskTitle}」。`]
  if (input.sharedTaskSpecPath) {
    lines.push(`先阅读任务说明：${input.sharedTaskSpecPath}`)
  }
  lines.push('执行过程会持续同步到这个任务线程。')
  return lines.join('\n')
}

function buildWorkerAcceptedThreadMessage(input: {
  workerName: string
  taskTitle: string
  executionConfig?: ExecutionConfigSummary
  sharedTaskRelativeRoot?: string | null
}) {
  const runtime =
    input.executionConfig?.adapterName ??
    input.executionConfig?.codeAgentType ??
    (input.executionConfig?.runtimeType === 'llm' ? 'LLM fallback' : 'Code Agent')
  const model = input.executionConfig?.modelLabel || input.executionConfig?.modelId
  const workdir =
    input.executionConfig?.workdirRelativePath ||
    shortPathLabel(input.executionConfig?.executionPath) ||
    input.sharedTaskRelativeRoot
  const lines = [`${input.workerName}：开始处理「${input.taskTitle}」。`]
  const details = [runtime, model, workdir ? `workdir=${workdir}` : null].filter(Boolean)
  if (details.length > 0) {
    lines.push(`运行环境：${details.join(' · ')}`)
  }
  return lines.join('\n')
}

function buildWorkerGroupStartedMessage(input: {
  taskTitle: string
  executionConfig?: ExecutionConfigSummary
  sharedTaskRelativeRoot?: string | null
}) {
  const runtime =
    input.executionConfig?.adapterName ??
    input.executionConfig?.codeAgentType ??
    (input.executionConfig?.runtimeType === 'llm' ? 'LLM fallback' : 'Code Agent')
  const model = input.executionConfig?.modelLabel || input.executionConfig?.modelId
  const workdir =
    input.executionConfig?.workdirRelativePath ||
    shortPathLabel(input.executionConfig?.executionPath) ||
    input.sharedTaskRelativeRoot
  const details = [runtime, model, workdir ? `目录 ${workdir}` : null].filter(Boolean).join(' · ')
  return details
    ? `开始执行「${input.taskTitle}」。${details}`
    : `开始执行「${input.taskTitle}」。`
}

function buildWorkerProgressGroupMessage(input: {
  taskTitle: string
  percent: number
  status?: string | null
}) {
  const detail = input.status?.trim()
  return detail
    ? `[进度 ${input.percent}%] ${input.taskTitle}：${detail}`
    : `[进度 ${input.percent}%] ${input.taskTitle}`
}

function buildWorkerHeartbeatGroupMessage(input: {
  taskTitle: string
  percent: number
  status?: string | null
}) {
  const detail = input.status?.trim()
  return detail
    ? `还在继续推进「${input.taskTitle}」[${input.percent}%]：${detail}`
    : `还在继续推进「${input.taskTitle}」[${input.percent}%]`
}

function buildWorkerClarificationGroupMessage(input: {
  question: string
  options?: string[]
}) {
  const options =
    Array.isArray(input.options) && input.options.length > 0
      ? `\n可选项：${input.options.join(' / ')}`
      : ''
  return `需要确认：${input.question}${options}`
}

function shortPathLabel(value?: string | null) {
  if (!value) return null
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 3) return normalized
  return `${parts[parts.length - 3]}/${parts[parts.length - 2]}/${parts[parts.length - 1]}`
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

export function applySharedTaskResultContract(
  result: TaskResult,
  contract: {
    status: SharedTaskResultStatus
    summary: string
    deliverables: string[]
    notes: string[]
    resultPath: string
    sharedTaskRelativeRoot: string
  },
): TaskResult {
  const contractStatus = mapSharedTaskResultStatus(contract.status)
  const deliverableArtifacts = sharedTaskResultDeliverablesToArtifacts({
    taskId: result.taskId,
    deliverables: contract.deliverables,
    sharedTaskRelativeRoot: contract.sharedTaskRelativeRoot,
  })
  const output = [
    result.output.trim(),
    '',
    'Shared task result contract:',
    `STATUS: ${contract.status}`,
    `SUMMARY: ${contract.summary}`,
    contract.deliverables.length > 0
      ? `DELIVERABLES:\n${contract.deliverables.map((item) => `- ${item}`).join('\n')}`
      : 'DELIVERABLES: none',
    contract.notes.length > 0
      ? `NOTES:\n${contract.notes.map((item) => `- ${item}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim()

  return {
    ...result,
    status: contractStatus,
    output,
    artifacts: mergeTaskResultArtifacts(
      result.artifacts,
      deliverableArtifacts.map((artifact) => ({ ...artifact })),
    ),
    error:
      contractStatus === TaskStatus.Done
        ? result.error
        : contract.notes[0] ?? contract.summary,
  }
}

function mergeTaskResultArtifacts(
  current: Array<Record<string, unknown>>,
  additions: Array<Record<string, unknown>>,
) {
  const merged: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const artifact of [...current, ...additions]) {
    const key = String(
      artifact.handoffRelativePath ??
        artifact.relativePath ??
        artifact.path ??
        artifact.filePath ??
        artifact.id ??
        '',
    )
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(artifact)
  }
  return merged
}

async function syncSharedTaskResultStatusToControlPlane(input: {
  run: RunControllerRunContext
  task: ExecutionTask
  result: TaskResult
  status: 'done' | 'failed' | 'cancelled' | 'blocked'
  summary: string
  sharedTaskResultStatus: SharedTaskResultStatus
  childSessionId?: string | null
  taskThreadId?: string | null
  workerInstanceId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
}) {
  const progressStatus = `shared-task-result:${input.sharedTaskResultStatus}`
  const extraPayload = {
    source: 'shared-task-result',
    sharedTaskResultStatus: input.sharedTaskResultStatus,
    summary: input.summary,
  }
  const base = {
    taskId: input.task.id,
    title: input.task.title,
    agentId: input.result.agentId,
    childSessionId: input.childSessionId ?? null,
    taskThreadId: input.taskThreadId ?? null,
    workerInstanceId: input.workerInstanceId ?? null,
    sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
    extraPayload,
  }

  if (input.status === TaskStatus.Done) {
    await runController.markTaskCompleted(input.run, {
      ...base,
      progressStatus,
      artifacts: input.result.artifacts,
    })
    return
  }

  if (input.status === TaskStatus.Blocked) {
    await runController.markTaskBlocked(input.run, {
      taskId: input.task.id,
      title: input.task.title,
      agentId: input.result.agentId,
      error: input.result.error ?? input.summary,
      reason: progressStatus,
    })
    return
  }

  if (input.status === TaskStatus.Cancelled) {
    await runController.markTaskCancelled(input.run, {
      ...base,
      reason: input.result.error ?? input.summary,
      progressStatus,
    })
    return
  }

  await runController.markTaskFailed(input.run, {
    ...base,
    error: input.result.error ?? input.summary,
    progressStatus,
    artifacts: input.result.artifacts,
    severity: 'warning',
  })
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
  threadContext?: {
    taskThreadId?: string | null
    sharedTaskRelativeRoot?: string | null
    sharedTaskSpecPath?: string | null
  },
): Promise<string> {
  const parts: string[] = []

  parts.push(`# 项目总目标\n${plan.goal}\n`)

  parts.push(`# 你的任务：${task.title}\n${task.description}\n`)

  if (threadContext?.taskThreadId || threadContext?.sharedTaskSpecPath) {
    parts.push('# 任务房间与共享任务目录')
    if (threadContext.taskThreadId) {
      parts.push(`- 当前 TaskThread：${threadContext.taskThreadId}`)
    }
    if (threadContext.sharedTaskSpecPath) {
      parts.push(`- 请先阅读任务说明：\`${threadContext.sharedTaskSpecPath}\``)
    }
    if (threadContext.sharedTaskRelativeRoot) {
      parts.push(`- 任务目录：\`${threadContext.sharedTaskRelativeRoot}\``)
      parts.push(`- 执行计划写入：\`${threadContext.sharedTaskRelativeRoot}/plan.md\``)
      parts.push(`- 最终结果摘要写入：\`${threadContext.sharedTaskRelativeRoot}/result.md\``)
      parts.push(`- 文件、报告、网页、日志等产物放入：\`${threadContext.sharedTaskRelativeRoot}/artifacts/\``)
    }
    parts.push('')
  }

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
  const brief = summary.brief.trim() || '已完成该任务。'
  const fileChangeCount = summary.filesCreated.length + summary.filesModified.length
  const details = [
    fileChangeCount > 0 ? `${fileChangeCount} 处文件变更` : null,
    summary.decisions.length > 0 ? `${summary.decisions.length} 个关键判断` : null,
    artifacts.length > 0 ? `${artifacts.length} 个产物` : null,
  ].filter(Boolean)

  return [
    `${agentName} 已完成「${taskTitle}」。`,
    brief,
    details.length > 0 ? `${details.join('，')}，详细过程见任务线程。` : '详细过程见任务线程。',
  ].join('\n')
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
  executionConfig?: ExecutionConfigSummary
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
    executionConfig: params.executionConfig,
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
    executionConfig: report.executionConfig,
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
  const reason = (error.trim() || 'Unknown error').slice(0, 280)
  const detail = output.trim()
  const detailLine =
    detail && detail !== error.trim() ? `Agent 输出摘录：${detail.slice(0, 240)}` : null
  const artifactLine = hasPartialArtifacts
    ? `已保留 ${artifacts.length} 个部分产物，可继续排查或接力。`
    : '当前没有可交付产物。'

  return [
    `${agentName} 在「${taskTitle}」上遇到问题。`,
    `失败原因：${reason}`,
    artifactLine,
    detailLine,
    '详细过程见任务线程。',
  ]
    .filter(Boolean)
    .join('\n')
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
  sharedTaskRelativeRoot?: string | null
}) {
  const sharedArtifactsRoot = params.sharedTaskRelativeRoot
    ? join(params.projectRoot, params.sharedTaskRelativeRoot, 'artifacts')
    : null
  const legacyHandoffRoot = join(params.projectRoot, '.agenthub', 'handoff', params.runId, params.taskId)
  const handoffRoot = sharedArtifactsRoot ?? legacyHandoffRoot
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
      if (sharedArtifactsRoot) {
        artifact.legacyHandoffRoot = legacyHandoffRoot
        artifact.sharedTaskArtifactPath = targetPath
      }
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
