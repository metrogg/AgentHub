import {
  emitManagerDecisionEvents,
  managerLoopStep,
  processPendingHumanInterrupts,
  startManagerLoopRun,
  type ManagerDecisionEventContext,
} from './manager-loop'
import { workerController } from './worker-controller'
import {
  artifacts,
  and,
  asc,
  db,
  eq,
  type AgentArtifact,
  type ConflictReport,
  workspaceTasks,
  orchestratorRuns,
  runtimeLeases,
  sessions,
  sql,
  taskThreads,
  workerInstances,
} from '@agenthub/db'
import { inArray } from 'drizzle-orm'
import { WsEvent } from '@agenthub/shared'
import {
  decideOrchestratorAction,
  type DecideInput,
  type OrchestratorDecision,
} from './orchestrator-decision'
import { emitRunEvent } from './run-events'
import { updateTaskThreadStatus } from './task-thread-service'
import { OrchestratorRunStatus, TaskStatus } from '@agenthub/shared'
import { broadcastSessionEvent } from '../agent-runner'
import { buildAgUiTaskStatusEvent } from '../protocols'

export interface RunControllerActor {
  id?: string | null
  name?: string | null
}

export interface RunControllerRunContext {
  runId: string
  workspaceId: string
  groupSessionId: string
  actor?: RunControllerActor | null
}

export interface RunControllerStartInput {
  workspaceId: string
  groupSessionId: string
  goal: string
  actor?: RunControllerActor | null
  decision?: ManagerDecisionEventContext | null
}

export interface RunControllerDispatchInput {
  plan?: Record<string, unknown> | null
  planMessageId?: string | null
  taskCount?: number
  agentCount?: number
  phaseCount?: number
}

export interface RunControllerQueuedTaskInput {
  taskId: string
  workspaceId: string
  agentId: string
  title: string
  description: string
  sessionId: string
  orderIdx: number
  phaseId?: string | null
  dependencies?: string[]
  parallelGroup?: string | null
  maxRetries?: number | null
  progressStatus?: string | null
  childSessionId?: string | null
  taskThreadId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  workerInstanceId?: string | null
  strategy?: string | null
  taskType?: string | null
  agentName?: string | null
  round?: number | null
  reason?: string | null
  severity?: 'info' | 'warning' | 'error'
  extraPayload?: Record<string, unknown>
}

export interface RunResourceSnapshot {
  run: typeof orchestratorRuns.$inferSelect | null
  tasks: Array<typeof workspaceTasks.$inferSelect>
  taskThreads: Array<
    typeof taskThreads.$inferSelect & {
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
    }
  >
  artifacts: Array<typeof artifacts.$inferSelect>
  runtimeLeases: Array<typeof runtimeLeases.$inferSelect>
  workerInstances: Array<typeof workerInstances.$inferSelect>
  counts: {
    tasksByStatus: Record<string, number>
    taskThreadsByStatus: Record<string, number>
    artifactsByStatus: Record<string, number>
    runtimeLeasesByStatus: Record<string, number>
    workerInstancesByState: Record<string, number>
    totalTasks: number
    totalTaskThreads: number
    totalArtifacts: number
    totalRuntimeLeases: number
    totalWorkerInstances: number
  }
}

/**
 * RunController owns Run lifecycle reconciliation for the HiClaw-lite kernel.
 *
 * ManagerLoop drives Observe -> Think -> Act, while RunController is the single
 * place callers use to mutate run/task/thread status and to resume or cancel
 * unfinished work. Old OrchestratorEngine paths must not regain ownership here.
 */
export class RunController {
  async start(input: RunControllerStartInput): Promise<RunControllerRunContext> {
    const { runId } = await startManagerLoopRun({
      workspaceId: input.workspaceId,
      groupSessionId: input.groupSessionId,
      goal: input.goal,
      orchestratorAgent: input.actor ?? null,
      decision: input.decision ?? null,
    })
    return {
      runId,
      workspaceId: input.workspaceId,
      groupSessionId: input.groupSessionId,
      actor: input.actor ?? null,
    }
  }

  async recordDecision(
    run: RunControllerRunContext,
    decision: ManagerDecisionEventContext,
  ): Promise<void> {
    await emitManagerDecisionEvents({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      actorAgentId: run.actor?.id ?? null,
      actorName: run.actor?.name ?? null,
      decision,
    })
  }

  async decideNextAction(
    run: RunControllerRunContext,
    input: DecideInput,
  ): Promise<OrchestratorDecision> {
    const decision = await decideOrchestratorAction(input)
    await this.recordDecision(run, {
      action: decision.action,
      reason: decision.reason,
      message: decision.message,
      memberProposalCount: Array.isArray(decision.memberProposals)
        ? decision.memberProposals.length
        : 0,
    })
    return decision
  }

  async requestApproval(
    run: RunControllerRunContext,
    input: {
      kind: 'member_proposal' | 'plan_confirmation' | 'user_clarification'
      messageId?: string | null
      reason?: string | null
      memberProposalCount?: number
      goal?: string | null
    },
  ): Promise<void> {
    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      agentId: run.actor?.id ?? null,
      type: 'approval.requested',
      payload: {
        kind: input.kind,
        messageId: input.messageId ?? null,
        reason: input.reason ?? null,
        memberProposalCount: input.memberProposalCount ?? 0,
        goal: input.goal ?? null,
        status: 'awaiting_user',
      },
    })
  }

  async prepareForDispatch(
    run: RunControllerRunContext,
    input: RunControllerDispatchInput = {},
  ): Promise<void> {
    await this.upsertRunRecord(run, {
      status: OrchestratorRunStatus.Planning,
      plan: input.plan,
      planMessageId: input.planMessageId,
    })
    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      agentId: run.actor?.id ?? null,
      type: 'manager.next_action',
      payload: {
        action: 'dispatching',
        phase: 'dispatching',
        reason: 'Manager prepared the run plan and is wiring task resources.',
        planMessageId: input.planMessageId ?? null,
        taskCount: input.taskCount ?? null,
        agentCount: input.agentCount ?? null,
        phaseCount: input.phaseCount ?? null,
      },
    })
  }

  async markRunning(
    run: RunControllerRunContext,
    input: {
      plan?: Record<string, unknown> | null
      taskCount?: number
    } = {},
  ): Promise<void> {
    await this.upsertRunRecord(run, {
      status: OrchestratorRunStatus.Running,
      plan: input.plan,
    })
    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      agentId: run.actor?.id ?? null,
      type: 'manager.next_action',
      payload: {
        action: 'executing',
        phase: 'executing',
        reason: 'Manager handed work to the execution runtime and is now supervising task progress.',
        taskCount: input.taskCount ?? null,
      },
    })
  }

  async markSynthesizing(
    run: RunControllerRunContext,
    input: {
      artifactCount?: number
      taskCount?: number
      summary?: string | null
    } = {},
  ): Promise<void> {
    await this.upsertRunRecord(run, {
      status: OrchestratorRunStatus.Synthesizing,
    })
    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      agentId: run.actor?.id ?? null,
      type: 'run.synthesizing',
      payload: {
        artifactCount: input.artifactCount ?? null,
        taskCount: input.taskCount ?? null,
        summary: input.summary ?? null,
      },
    })
  }

  async finish(
    run: RunControllerRunContext,
    input: {
      status: 'completed' | 'cancelled' | 'failed'
      summary?: string | null
      summaryMessageId?: string | null
      payload?: Record<string, unknown>
      conflictReport?: ConflictReport[] | null
    },
  ): Promise<void> {
    await this.upsertRunRecord(run, {
      status: input.status,
      summaryMessageId: input.summaryMessageId,
      conflictReport: input.conflictReport,
    })
    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      agentId: run.actor?.id ?? null,
      type:
        input.status === 'completed'
          ? 'run.completed'
          : input.status === 'cancelled'
            ? 'run.cancelled'
            : 'run.failed',
      severity: input.status === 'failed' ? 'warning' : input.status === 'cancelled' ? 'warning' : 'info',
      payload: {
        summary: input.summary ?? null,
        summaryMessageId: input.summaryMessageId ?? null,
        status: input.status,
        ...(input.payload ?? {}),
      },
    })
  }

  async loadResourceSnapshot(runId: string): Promise<RunResourceSnapshot> {
    const [run] = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.id, runId))
      .limit(1)
    const tasks = await db
      .select()
      .from(workspaceTasks)
      .where(eq(workspaceTasks.runId, runId))
      .orderBy(asc(workspaceTasks.orderIdx), asc(workspaceTasks.createdAt))
    const threads = await db
      .select({
        id: taskThreads.id,
        workspaceId: taskThreads.workspaceId,
        runId: taskThreads.runId,
        taskId: taskThreads.taskId,
        groupSessionId: taskThreads.groupSessionId,
        workspaceAgentId: taskThreads.workspaceAgentId,
        workerInstanceId: taskThreads.workerInstanceId,
        sessionId: taskThreads.sessionId,
        status: taskThreads.status,
        lastEventId: taskThreads.lastEventId,
        createdAt: taskThreads.createdAt,
        updatedAt: taskThreads.updatedAt,
        sessionMetadata: sessions.metadata,
      })
      .from(taskThreads)
      .leftJoin(sessions, eq(sessions.id, taskThreads.sessionId))
      .where(eq(taskThreads.runId, runId))
      .orderBy(asc(taskThreads.createdAt))
    const taskThreadResources = threads.map((thread) => ({
      id: thread.id,
      workspaceId: thread.workspaceId,
      runId: thread.runId,
      taskId: thread.taskId,
      groupSessionId: thread.groupSessionId,
      workspaceAgentId: thread.workspaceAgentId,
      workerInstanceId: thread.workerInstanceId,
      sessionId: thread.sessionId,
      status: thread.status,
      lastEventId: thread.lastEventId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      sharedTaskRelativeRoot: stringValue(thread.sessionMetadata?.sharedTaskRelativeRoot),
      sharedTaskSpecPath: stringValue(thread.sessionMetadata?.sharedTaskSpecPath),
    }))
    const artifactRows = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(asc(artifacts.createdAt))
    const leases = await db
      .select()
      .from(runtimeLeases)
      .where(eq(runtimeLeases.runId, runId))
      .orderBy(asc(runtimeLeases.createdAt))
    const workerInstanceIds = new Set(
      [
        ...taskThreadResources.map((thread) => thread.workerInstanceId),
        ...leases.map((lease) => lease.workerInstanceId),
        ...artifactRows.map((artifact) => artifact.workerInstanceId),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
    const workers =
      workerInstanceIds.size === 0
        ? []
        : (await db.select().from(workerInstances)).filter((worker) =>
            workerInstanceIds.has(worker.id),
          )

    return {
      run: run ?? null,
      tasks,
      taskThreads: taskThreadResources,
      artifacts: artifactRows,
      runtimeLeases: leases,
      workerInstances: workers,
      counts: {
        tasksByStatus: countBy(tasks, (task) => task.status),
        taskThreadsByStatus: countBy(taskThreadResources, (thread) => thread.status),
        artifactsByStatus: countBy(artifactRows, (artifact) => artifact.status),
        runtimeLeasesByStatus: countBy(leases, (lease) => lease.status),
        workerInstancesByState: countBy(workers, (worker) => worker.observedState),
        totalTasks: tasks.length,
        totalTaskThreads: taskThreadResources.length,
        totalArtifacts: artifactRows.length,
        totalRuntimeLeases: leases.length,
        totalWorkerInstances: workers.length,
      },
    }
  }

  async reconcile(run: RunControllerRunContext): Promise<RunResourceSnapshot> {
    const snapshot = await this.loadResourceSnapshot(run.runId)

    // Reconcile each worker instance that needs attention
    const busyOrFailedWorkers = snapshot.workerInstances.filter(
      (w) => w.observedState === 'busy' || w.observedState === 'failed' || w.observedState === 'provisioning',
    )
    for (const worker of busyOrFailedWorkers) {
      await workerController.reconcile(worker.id, {
        workspaceId: run.workspaceId,
        groupSessionId: run.groupSessionId,
        runId: run.runId,
        actorId: run.actor?.id ?? null,
      })
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      agentId: run.actor?.id ?? null,
      type: 'manager.next_action',
      payload: {
        action: 'observe_resources',
        reason: 'RunController reconciled the current Run resource snapshot.',
        resourceSnapshot: {
          runStatus: snapshot.run?.status ?? null,
          counts: snapshot.counts,
          taskThreads: snapshot.taskThreads.map((thread) => ({
            id: thread.id,
            taskId: thread.taskId,
            sessionId: thread.sessionId,
            workspaceAgentId: thread.workspaceAgentId,
            workerInstanceId: thread.workerInstanceId,
            status: thread.status,
            sharedTaskRelativeRoot: thread.sharedTaskRelativeRoot ?? null,
            sharedTaskSpecPath: thread.sharedTaskSpecPath ?? null,
          })),
          runtimeLeases: snapshot.runtimeLeases.map((lease) => ({
            id: lease.id,
            taskId: lease.taskId,
            workerInstanceId: lease.workerInstanceId,
            provider: lease.provider,
            status: lease.status,
            cwd: lease.cwd,
            homeDir: lease.homeDir,
            configDir: lease.configDir,
            cacheDir: lease.cacheDir,
            tmpDir: lease.tmpDir,
          })),
          artifacts: snapshot.artifacts.map((artifact) => ({
            id: artifact.id,
            taskId: artifact.taskId,
            taskThreadId: artifact.taskThreadId,
            title: artifact.title,
            kind: artifact.kind,
            status: artifact.status,
            handoffPath: artifact.handoffPath,
            relativePath: artifact.relativePath,
          })),
          workerInstances: snapshot.workerInstances.map((worker) => ({
            id: worker.id,
            workspaceAgentId: worker.workspaceAgentId,
            runtimeFamily: worker.runtimeFamily,
            runtimeBase: worker.runtimeBase,
            observedState: worker.observedState,
            desiredState: worker.desiredState,
          })),
        },
      },
    })
    await processPendingHumanInterrupts({ run })

    // Run ManagerLoop.step() to drive the Observe → Think → Act cycle.
    // This is the HiClaw pattern: after every reconcile, the Manager decides
    // what needs to happen next — dispatch, review, or synthesize.
    managerLoopStep(run.runId).catch(() => {})

    return snapshot
  }

  async complete(
    run: RunControllerRunContext,
    input: {
      status?: 'completed' | 'cancelled'
      summary?: string | null
    } = {},
  ): Promise<void> {
    await this.finish(run, {
      status: input.status ?? 'completed',
      summary: input.summary ?? null,
    })
  }

  async requeueRunningTasksForResume(
    run: RunControllerRunContext,
    input: {
      reason?: string
      progressStatus?: string
    } = {},
  ): Promise<string[]> {
    const reason = input.reason ?? '服务重启后恢复运行，任务已重新排队。'
    const progressStatus = input.progressStatus ?? '服务重启后恢复运行，等待重新分发。'

    const runningTasks = await db
      .select({
        id: workspaceTasks.id,
        agentId: workspaceTasks.agentId,
        title: workspaceTasks.title,
        sessionId: workspaceTasks.sessionId,
      })
      .from(workspaceTasks)
      .where(
        and(
          eq(workspaceTasks.runId, run.runId),
          eq(workspaceTasks.status, TaskStatus.Running),
        ),
      )

    if (!runningTasks.length) return []

    const resetIds = runningTasks.map((task) => task.id)
    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Pending,
        startedAt: null,
        completedAt: null,
        errorLog: reason,
        progressPercent: 0,
        progressStatus,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceTasks.runId, run.runId),
          inArray(workspaceTasks.id, resetIds),
        ),
      )

    const relatedThreads = await db
      .select({
        id: taskThreads.id,
        taskId: taskThreads.taskId,
        sessionId: taskThreads.sessionId,
        workerInstanceId: taskThreads.workerInstanceId,
      })
      .from(taskThreads)
      .where(
        and(
          eq(taskThreads.runId, run.runId),
          inArray(taskThreads.taskId, resetIds),
        ),
      )

    const threadByTaskId = new Map(relatedThreads.map((thread) => [thread.taskId, thread] as const))
    for (const thread of relatedThreads) {
      await updateTaskThreadStatus(thread.id, 'prepared')
    }

    for (const task of runningTasks) {
      const thread = threadByTaskId.get(task.id)
      await emitRunEvent({
        runId: run.runId,
        workspaceId: run.workspaceId,
        groupSessionId: run.groupSessionId,
        taskId: task.id,
        threadId: thread?.id ?? null,
        workerInstanceId: thread?.workerInstanceId ?? null,
        agentId: task.agentId ?? null,
        type: 'task.queued',
        payload: {
          title: task.title,
          taskTitle: task.title,
          childSessionId: thread?.sessionId ?? task.sessionId ?? null,
          taskThreadId: thread?.id ?? null,
          taskThreadStatus: 'prepared',
          reason: 'resume_requeue',
          progressStatus,
        },
      })
    }

    return resetIds
  }

  async markTaskBlocked(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      error?: string | null
      reason?: string | null
    },
  ): Promise<void> {
    const completedAt = new Date()
    const error = input.error ?? 'Blocked by dependency failure'
    const reason = input.reason ?? 'blocked_by_dependency'

    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Blocked,
        completedAt,
        errorLog: error,
        progressStatus: reason,
        updatedAt: completedAt,
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = await db
      .select({
        id: taskThreads.id,
        sessionId: taskThreads.sessionId,
        workerInstanceId: taskThreads.workerInstanceId,
      })
      .from(taskThreads)
      .where(
        and(
          eq(taskThreads.runId, run.runId),
          eq(taskThreads.taskId, input.taskId),
        ),
      )
      .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'failed')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? null,
      workerInstanceId: thread?.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: 'task.failed',
      severity: 'warning',
      payload: {
        title: input.title ?? input.taskId,
        taskTitle: input.title ?? input.taskId,
        error,
        reason,
        childSessionId: thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? null,
        taskThreadStatus: 'failed',
      },
    })
  }

  async markTaskFailed(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      error?: string | null
      progressStatus?: string | null
      artifacts?: Array<Record<string, unknown>> | null
      childSessionId?: string | null
      taskThreadId?: string | null
      workerInstanceId?: string | null
      runtimeLeaseId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
      durationMs?: number | null
      executionConfig?: Record<string, unknown> | null
      extraPayload?: Record<string, unknown>
      severity?: 'info' | 'warning' | 'error'
    },
  ): Promise<void> {
    const completedAt = new Date()
    const error = input.error ?? 'Unknown error'

    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Failed,
        completedAt,
        errorLog: error,
        progressStatus: input.progressStatus ?? 'failed',
        artifacts: ((input.artifacts ?? []) as unknown as AgentArtifact[]) ?? [],
        updatedAt: completedAt,
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = input.taskThreadId
      ? await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(eq(taskThreads.id, input.taskThreadId))
          .limit(1)
      : await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(
            and(
              eq(taskThreads.runId, run.runId),
              eq(taskThreads.taskId, input.taskId),
            ),
          )
          .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'failed')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: 'task.failed',
      severity: input.severity ?? 'error',
      payload: {
        title: input.title ?? input.taskId,
        taskTitle: input.title ?? input.taskId,
        error,
        childSessionId: input.childSessionId ?? thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? input.taskThreadId ?? null,
        taskThreadStatus: 'failed',
        workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        durationMs: input.durationMs ?? null,
        executionConfig: input.executionConfig ?? null,
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async markTaskCompleted(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      progressStatus?: string | null
      artifacts?: Array<Record<string, unknown>> | null
      childSessionId?: string | null
      taskThreadId?: string | null
      workerInstanceId?: string | null
      runtimeLeaseId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
      durationMs?: number | null
      executionConfig?: Record<string, unknown> | null
      extraPayload?: Record<string, unknown>
    },
  ): Promise<void> {
    const completedAt = new Date()

    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Done,
        completedAt,
        errorLog: null,
        progressStatus: input.progressStatus ?? 'completed',
        artifacts: ((input.artifacts ?? []) as unknown as AgentArtifact[]) ?? [],
        updatedAt: completedAt,
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = input.taskThreadId
      ? await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(eq(taskThreads.id, input.taskThreadId))
          .limit(1)
      : await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(
            and(
              eq(taskThreads.runId, run.runId),
              eq(taskThreads.taskId, input.taskId),
            ),
          )
          .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'completed')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: 'task.completed',
      payload: {
        title: input.title ?? input.taskId,
        taskTitle: input.title ?? input.taskId,
        childSessionId: input.childSessionId ?? thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? input.taskThreadId ?? null,
        taskThreadStatus: 'completed',
        workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        durationMs: input.durationMs ?? null,
        artifactCount: input.artifacts?.length ?? 0,
        executionConfig: input.executionConfig ?? null,
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async markTaskAssigned(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      workerInstanceId?: string | null
      childSessionId?: string | null
      taskThreadId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
      messageId?: string | null
      extraPayload?: Record<string, unknown>
    },
  ): Promise<void> {
    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Pending,
        progressStatus: 'thread-assigned',
        updatedAt: new Date(),
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = input.taskThreadId
      ? await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(eq(taskThreads.id, input.taskThreadId))
          .limit(1)
      : await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(
            and(
              eq(taskThreads.runId, run.runId),
              eq(taskThreads.taskId, input.taskId),
            ),
          )
          .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'assigned')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: 'worker.message.sent',
      payload: {
        title: input.title ?? input.taskId,
        taskTitle: input.title ?? input.taskId,
        messageId: input.messageId ?? null,
        childSessionId: input.childSessionId ?? thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? input.taskThreadId ?? null,
        taskThreadStatus: 'assigned',
        workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async markTaskProgress(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      agentName?: string | null
      percent?: number | null
      progressStatus?: string | null
      childSessionId?: string | null
      taskThreadId?: string | null
      workerInstanceId?: string | null
      runtimeLeaseId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
      executionConfig?: Record<string, unknown> | null
      severity?: 'info' | 'warning' | 'error'
      persistEvent?: boolean
      persistRunUpdatedAt?: boolean
      extraPayload?: Record<string, unknown>
    },
  ): Promise<void> {
    const payload = {
      title: input.title ?? input.taskId,
      taskTitle: input.title ?? input.taskId,
      agentName: input.agentName ?? null,
      percent: input.percent ?? null,
      progressPercent: input.percent ?? null,
      status: input.progressStatus ?? null,
      progressStatus: input.progressStatus ?? null,
      childSessionId: input.childSessionId ?? null,
      taskThreadId: input.taskThreadId ?? null,
      taskThreadStatus: 'active',
      workerInstanceId: input.workerInstanceId ?? null,
      runtimeLeaseId: input.runtimeLeaseId ?? null,
      sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
      sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
      executionConfig: input.executionConfig ?? null,
      ...(input.extraPayload ?? {}),
    }

    await db
      .update(workspaceTasks)
      .set({
        progressPercent: input.percent ?? 0,
        progressStatus: input.progressStatus ?? null,
        updatedAt: new Date(),
      })
      .where(eq(workspaceTasks.id, input.taskId))

    if (input.persistRunUpdatedAt) {
      await db
        .update(orchestratorRuns)
        .set({ updatedAt: new Date() })
        .where(eq(orchestratorRuns.id, run.runId))
    }

    if (input.persistEvent === false) {
      broadcastSessionEvent(run.groupSessionId, {
        type: WsEvent.AgUiEvent,
        payload: buildAgUiTaskStatusEvent({
          runId: run.runId,
          threadId: run.groupSessionId,
          taskId: input.taskId,
          taskTitle: input.title ?? input.taskId,
          childSessionId: input.childSessionId ?? undefined,
          taskThreadId: input.taskThreadId ?? null,
          agentId: input.agentId ?? null,
          agentName: input.agentName ?? undefined,
          workerInstanceId: input.workerInstanceId ?? null,
          runtimeLeaseId: input.runtimeLeaseId ?? null,
          status: 'running',
          progressPercent: input.percent ?? undefined,
          progressStatus: input.progressStatus ?? undefined,
          executionConfig: input.executionConfig ?? undefined,
        }),
      })
      return
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: 'task.progress',
      severity: input.severity ?? 'info',
      payload,
    })
  }

  async queueTask(
    run: RunControllerRunContext,
    input: RunControllerQueuedTaskInput,
  ): Promise<void> {
    await db.insert(workspaceTasks).values({
      id: input.taskId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      title: input.title,
      description: input.description,
      status: TaskStatus.Pending,
      sessionId: input.sessionId,
      progressStatus: input.progressStatus ?? 'thread-prepared',
      orderIdx: input.orderIdx,
      runId: run.runId,
      phaseId: input.phaseId ?? null,
      dependencies: input.dependencies ?? [],
      parallelGroup: input.parallelGroup ?? null,
      maxRetries: input.maxRetries ?? 2,
    })

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      agentId: input.agentId,
      type: 'task.queued',
      severity: input.severity ?? 'info',
      payload: {
        strategy: input.strategy ?? null,
        title: input.title,
        taskTitle: input.title,
        description: input.description,
        phaseId: input.phaseId ?? null,
        taskType: input.taskType ?? null,
        agentName: input.agentName ?? null,
        agentId: input.agentId,
        childSessionId: input.childSessionId ?? input.sessionId,
        taskThreadId: input.taskThreadId ?? null,
        taskThreadStatus: 'prepared',
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        dependencies: input.dependencies ?? [],
        round: input.round ?? null,
        reason: input.reason ?? null,
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async resetTaskForRetry(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      reason?: string | null
      attempt?: number | null
      delayMs?: number | null
      childSessionId?: string | null
      taskThreadId?: string | null
      workerInstanceId?: string | null
      retryCount?: number | null
      preserveAgentId?: string | null
      extraPayload?: Record<string, unknown>
    },
  ): Promise<void> {
    await db
      .update(workspaceTasks)
      .set({
        agentId: input.preserveAgentId ?? undefined,
        status: TaskStatus.Pending,
        completedAt: null,
        startedAt: null,
        errorLog: input.reason ?? null,
        progressPercent: 0,
        progressStatus: 'thread-prepared',
        retryCount: input.retryCount ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = input.taskThreadId
      ? await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(eq(taskThreads.id, input.taskThreadId))
          .limit(1)
      : await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(
            and(
              eq(taskThreads.runId, run.runId),
              eq(taskThreads.taskId, input.taskId),
            ),
          )
          .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'prepared')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
      agentId: input.agentId ?? input.preserveAgentId ?? null,
      type: 'task.retrying',
      severity: 'warning',
      payload: {
        title: input.title ?? input.taskId,
        taskTitle: input.title ?? input.taskId,
        reason: input.reason ?? null,
        attempt: input.attempt ?? null,
        delayMs: input.delayMs ?? null,
        childSessionId: input.childSessionId ?? thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? input.taskThreadId ?? null,
        taskThreadStatus: 'prepared',
        workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async resetTaskForReplan(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      nextAgentId?: string | null
      reason?: string | null
      strategy?: string | null
      changedTaskIds?: string[] | null
      childSessionId?: string | null
      taskThreadId?: string | null
      workerInstanceId?: string | null
      retryCount?: number | null
      extraPayload?: Record<string, unknown>
    },
  ): Promise<void> {
    await db
      .update(workspaceTasks)
      .set({
        agentId: input.nextAgentId ?? undefined,
        status: TaskStatus.Pending,
        completedAt: null,
        startedAt: null,
        errorLog: input.reason ?? null,
        progressPercent: 0,
        progressStatus: 'thread-prepared',
        retryCount: input.retryCount ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = input.taskThreadId
      ? await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(eq(taskThreads.id, input.taskThreadId))
          .limit(1)
      : await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(
            and(
              eq(taskThreads.runId, run.runId),
              eq(taskThreads.taskId, input.taskId),
            ),
          )
          .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'prepared')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
      agentId: input.nextAgentId ?? input.agentId ?? null,
      type: 'run.replanned',
      severity: 'warning',
      payload: {
        strategy: input.strategy ?? null,
        reason: input.reason ?? null,
        changedTaskIds: input.changedTaskIds ?? [input.taskId],
        taskTitle: input.title ?? input.taskId,
        childSessionId: input.childSessionId ?? thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? input.taskThreadId ?? null,
        taskThreadStatus: 'prepared',
        workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async markTaskActive(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      workerInstanceId?: string | null
      runtimeLeaseId?: string | null
      childSessionId?: string | null
      taskThreadId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
      progressPercent?: number | null
      progressStatus?: string | null
      executionConfig?: Record<string, unknown> | null
      extraPayload?: Record<string, unknown>
    },
  ): Promise<void> {
    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Running,
        startedAt: new Date(),
        completedAt: null,
        errorLog: null,
        progressPercent: input.progressPercent ?? 3,
        progressStatus: input.progressStatus ?? 'running',
        updatedAt: new Date(),
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = input.taskThreadId
      ? await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(eq(taskThreads.id, input.taskThreadId))
          .limit(1)
      : await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(
            and(
              eq(taskThreads.runId, run.runId),
              eq(taskThreads.taskId, input.taskId),
            ),
          )
          .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'active')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: 'task.started',
      payload: {
        title: input.title ?? input.taskId,
        taskTitle: input.title ?? input.taskId,
        childSessionId: input.childSessionId ?? thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? input.taskThreadId ?? null,
        taskThreadStatus: 'active',
        workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        progressPercent: input.progressPercent ?? 3,
        progressStatus: input.progressStatus ?? 'running',
        executionConfig: input.executionConfig ?? null,
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async markTaskWaitingForHuman(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      question?: string | null
      clarificationId?: string | null
      childSessionId?: string | null
      taskThreadId?: string | null
      workerInstanceId?: string | null
      runtimeLeaseId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
      artifacts?: Array<Record<string, unknown>> | null
      extraPayload?: Record<string, unknown>
    },
  ): Promise<void> {
    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Blocked,
        completedAt: null,
        errorLog: input.question ?? 'Waiting for human clarification.',
        progressPercent: 50,
        progressStatus: 'awaiting_human_clarification',
        artifacts: ((input.artifacts ?? []) as unknown as AgentArtifact[]) ?? [],
        updatedAt: new Date(),
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = input.taskThreadId
      ? await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(eq(taskThreads.id, input.taskThreadId))
          .limit(1)
      : await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(
            and(
              eq(taskThreads.runId, run.runId),
              eq(taskThreads.taskId, input.taskId),
            ),
          )
          .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'waiting_for_human')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: 'approval.requested',
      severity: 'warning',
      payload: {
        kind: 'worker_clarification',
        title: input.title ?? input.taskId,
        taskTitle: input.title ?? input.taskId,
        question: input.question ?? null,
        clarificationId: input.clarificationId ?? null,
        childSessionId: input.childSessionId ?? thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? input.taskThreadId ?? null,
        taskThreadStatus: 'waiting_for_human',
        workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        progressPercent: 50,
        progressStatus: 'awaiting_human_clarification',
        artifactCount: input.artifacts?.length ?? 0,
        status: 'awaiting_user',
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async markTaskCancelled(
    run: RunControllerRunContext,
    input: {
      taskId: string
      title?: string | null
      agentId?: string | null
      reason?: string | null
      progressStatus?: string | null
      childSessionId?: string | null
      taskThreadId?: string | null
      workerInstanceId?: string | null
      runtimeLeaseId?: string | null
      sharedTaskRelativeRoot?: string | null
      sharedTaskSpecPath?: string | null
      executionConfig?: Record<string, unknown> | null
      extraPayload?: Record<string, unknown>
    },
  ): Promise<void> {
    const completedAt = new Date()
    const reason = input.reason ?? 'task_cancelled'

    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Cancelled,
        completedAt,
        errorLog: reason,
        progressStatus: input.progressStatus ?? 'cancelled',
        updatedAt: completedAt,
      })
      .where(eq(workspaceTasks.id, input.taskId))

    const [thread] = input.taskThreadId
      ? await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(eq(taskThreads.id, input.taskThreadId))
          .limit(1)
      : await db
          .select({
            id: taskThreads.id,
            sessionId: taskThreads.sessionId,
            workerInstanceId: taskThreads.workerInstanceId,
          })
          .from(taskThreads)
          .where(
            and(
              eq(taskThreads.runId, run.runId),
              eq(taskThreads.taskId, input.taskId),
            ),
          )
          .limit(1)

    if (thread?.id) {
      await updateTaskThreadStatus(thread.id, 'cancelled')
    }

    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      taskId: input.taskId,
      threadId: thread?.id ?? input.taskThreadId ?? null,
      workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: 'task.cancelled',
      severity: 'warning',
      payload: {
        title: input.title ?? input.taskId,
        taskTitle: input.title ?? input.taskId,
        reason,
        childSessionId: input.childSessionId ?? thread?.sessionId ?? null,
        taskThreadId: thread?.id ?? input.taskThreadId ?? null,
        taskThreadStatus: 'cancelled',
        workerInstanceId: input.workerInstanceId ?? thread?.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: input.sharedTaskSpecPath ?? null,
        executionConfig: input.executionConfig ?? null,
        ...(input.extraPayload ?? {}),
      },
    })
  }

  async cancel(
    run: RunControllerRunContext,
    input: {
      reason: string
      summary?: string | null
      taskErrorLog?: string | null
      activeRunCancelled?: boolean
      payload?: Record<string, unknown>
    },
  ): Promise<void> {
    const completedAt = new Date()
    const affectedTasks = await db
      .select({
        id: workspaceTasks.id,
        title: workspaceTasks.title,
        agentId: workspaceTasks.agentId,
        sessionId: workspaceTasks.sessionId,
      })
      .from(workspaceTasks)
      .where(
        and(
          eq(workspaceTasks.runId, run.runId),
          sql`${workspaceTasks.status} in ('pending', 'running', 'blocked')`,
        ),
      )

    await db
      .update(workspaceTasks)
      .set({
        status: TaskStatus.Cancelled,
        completedAt,
        progressStatus: 'cancelled',
        errorLog: input.taskErrorLog ?? input.reason,
      })
      .where(
        and(
          eq(workspaceTasks.runId, run.runId),
          sql`${workspaceTasks.status} in ('pending', 'running', 'blocked')`,
        ),
      )

    const taskIds = affectedTasks.map((task) => task.id)
    if (taskIds.length > 0) {
      const relatedThreads = await db
        .select({
          id: taskThreads.id,
          taskId: taskThreads.taskId,
          sessionId: taskThreads.sessionId,
          workerInstanceId: taskThreads.workerInstanceId,
        })
        .from(taskThreads)
        .where(
          and(
            eq(taskThreads.runId, run.runId),
            inArray(taskThreads.taskId, taskIds),
          ),
        )
      const threadByTaskId = new Map(
        relatedThreads.map((thread) => [thread.taskId, thread] as const),
      )
      for (const thread of relatedThreads) {
        await updateTaskThreadStatus(thread.id, 'cancelled')
      }
      for (const task of affectedTasks) {
        const thread = threadByTaskId.get(task.id)
        await emitRunEvent({
          runId: run.runId,
          workspaceId: run.workspaceId,
          groupSessionId: run.groupSessionId,
          taskId: task.id,
          threadId: thread?.id ?? null,
          workerInstanceId: thread?.workerInstanceId ?? null,
          agentId: task.agentId ?? null,
          type: 'task.cancelled',
          severity: 'warning',
          payload: {
            title: task.title,
            taskTitle: task.title,
            reason: input.reason,
            childSessionId: thread?.sessionId ?? task.sessionId ?? null,
            taskThreadId: thread?.id ?? null,
            taskThreadStatus: 'cancelled',
            workerInstanceId: thread?.workerInstanceId ?? null,
          },
        })
      }
    }

    await this.finish(run, {
      status: 'cancelled',
      summary: input.summary ?? null,
      payload: {
        reason: input.reason,
        activeRunCancelled: input.activeRunCancelled ?? false,
        ...(input.payload ?? {}),
      },
    })
  }

  async fail(
    run: RunControllerRunContext,
    input: {
      error: string
      stage?: string
    },
  ): Promise<void> {
    await this.upsertRunRecord(run, {
      status: OrchestratorRunStatus.Failed,
    })
    await emitRunEvent({
      runId: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      agentId: run.actor?.id ?? null,
      type: 'run.failed',
      severity: 'error',
      payload: {
        error: input.error,
        stage: input.stage ?? null,
      },
    })
  }

  private async upsertRunRecord(
    run: RunControllerRunContext,
    input: {
      status?: typeof OrchestratorRunStatus[keyof typeof OrchestratorRunStatus]
      plan?: Record<string, unknown> | null
      planMessageId?: string | null
      summaryMessageId?: string | null
      conflictReport?: ConflictReport[] | null
    },
  ): Promise<void> {
    const [existing] = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.id, run.runId))
      .limit(1)

    const payload: Partial<typeof orchestratorRuns.$inferInsert> = {
      updatedAt: new Date(),
    }
    if (input.status !== undefined) payload.status = input.status
    if (input.plan !== undefined) payload.plan = input.plan
    if (input.planMessageId !== undefined) payload.planMessageId = input.planMessageId
    if (input.summaryMessageId !== undefined) payload.summaryMessageId = input.summaryMessageId
    if (input.conflictReport !== undefined) payload.conflictReport = input.conflictReport

    if (existing) {
      await db.update(orchestratorRuns).set(payload).where(eq(orchestratorRuns.id, run.runId))
      return
    }

    await db.insert(orchestratorRuns).values({
      id: run.runId,
      workspaceId: run.workspaceId,
      groupSessionId: run.groupSessionId,
      status: input.status ?? OrchestratorRunStatus.Planning,
      plan: input.plan ?? null,
      planMessageId: input.planMessageId ?? null,
      summaryMessageId: input.summaryMessageId ?? null,
      conflictReport: input.conflictReport ?? null,
    })
  }
}

export const runController = new RunController()

function countBy<T>(items: T[], pick: (item: T) => string | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = pick(item) ?? 'unknown'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
