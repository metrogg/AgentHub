import { db, messages, workspaceTasks, orchestratorRuns, sessions, eq, desc } from '@agenthub/db'
import { logger } from '../../lib/logger'
import { broadcastSessionEvent, runAgentReply } from '../agent-runner'
import { gitBranchManager } from '../git/branch-manager'
import { Planner } from './planner'
import { TaskScheduler, type TaskExecutor } from './task-scheduler'
import { Synthesizer } from './synthesizer'
import { ConflictResolver } from './conflict-resolver'
import { FallbackEngine } from './fallback-engine'
import type { ExecutionPlan, ExecutionTask, TaskResult } from './types'

export { ExecutionPlan, ExecutionTask, TaskResult }

interface ChildSessionInfo {
  sessionId: string
  workspaceId: string
  projectPath?: string | null
}

export class OrchestratorEngine {
  private planner = new Planner()
  private scheduler = new TaskScheduler()
  private synthesizer = new Synthesizer()
  private conflictResolver = new ConflictResolver()
  private fallbackEngine = new FallbackEngine()

  async createPlan(goal: string, agents: ExecutionPlan['agents']): Promise<ExecutionPlan> {
    return this.planner.createPlan({ goal, agents })
  }

  async startRun(params: {
    runId: string
    groupSessionId: string
    workspaceId: string
    plan: ExecutionPlan
    childSessions: Map<string, ChildSessionInfo>
  }): Promise<void> {
    const { runId, groupSessionId, workspaceId, plan, childSessions } = params

    await db
      .update(orchestratorRuns)
      .set({ status: 'running', plan: plan as unknown as Record<string, unknown> })
      .where(eq(orchestratorRuns.id, runId))

    const executor: TaskExecutor = async (task, signal) => {
      let currentTask = task
      let currentAttempt = 0

      while (true) {
        const result = await this.executeTask(currentTask, plan, childSessions, runId, signal, currentAttempt)
        if (result.status === 'done' || result.status === 'cancelled') {
          return result
        }

        currentAttempt++
        const fallback = this.fallbackEngine.handle(currentTask, new Error(result.error || 'Task failed'), currentAttempt)

        if (fallback.action === 'retry') {
          logger.info({ taskId: currentTask.id, attempt: currentAttempt, reason: fallback.reason }, 'Task retry scheduled')
          const childInfo = childSessions.get(currentTask.id)
          if (childInfo) {
            await db.update(workspaceTasks).set({ status: 'pending', errorLog: fallback.reason }).where(eq(workspaceTasks.id, currentTask.id))
            broadcastSessionEvent(childInfo.sessionId, {
              type: 'task:update',
              payload: { taskId: currentTask.id, status: 'pending', attempt: currentAttempt },
            })
          }
          continue
        }

        if (fallback.action === 'fallback-agent' && fallback.updatedTask) {
          logger.info({ taskId: currentTask.id, newAgentId: fallback.updatedTask.agentId, reason: fallback.reason }, 'Task fallback to new agent')
          currentTask = fallback.updatedTask
          currentAttempt = 0
          const childInfo = childSessions.get(currentTask.id)
          if (childInfo) {
            await db.update(workspaceTasks).set({ agentId: currentTask.agentId, status: 'pending', attemptCount: 0, errorLog: fallback.reason }).where(eq(workspaceTasks.id, currentTask.id))
            broadcastSessionEvent(childInfo.sessionId, {
              type: 'task:update',
              payload: { taskId: currentTask.id, status: 'pending', agentId: currentTask.agentId },
            })
          }
          continue
        }

        return result
      }
    }

    try {
      const results = await this.scheduler.executePlan(plan, executor)

      // 冲突检测与解决
      const firstPath = childSessions.get(plan.tasks[0]!.id)?.projectPath
      const conflictReports = firstPath
        ? await this.conflictResolver.detectAndResolve(results, {
            projectPath: firstPath,
            baseBranch: await gitBranchManager.inferBaseBranch(firstPath),
          })
        : []

      if (conflictReports.length > 0) {
        await db
          .update(orchestratorRuns)
          .set({ conflictReport: conflictReports as unknown as import('@agenthub/db').ConflictReport[] })
          .where(eq(orchestratorRuns.id, runId))
      }

      await this.synthesizeAndReport(runId, groupSessionId, workspaceId, plan, results, conflictReports)
    } catch (error: any) {
      logger.error({ err: error?.message, runId }, 'Scheduler execution failed')
      await db.update(orchestratorRuns).set({ status: 'failed' }).where(eq(orchestratorRuns.id, runId))
    }
  }

  private async executeTask(
    task: ExecutionTask,
    plan: ExecutionPlan,
    childSessions: Map<string, ChildSessionInfo>,
    runId: string,
    signal: AbortSignal,
    attemptCount = 0,
  ): Promise<TaskResult> {
    const agent = plan.agents.find((a) => a.id === task.agentId)
    if (!agent) {
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
        // 分支准备失败时，继续执行（降级到直接在原分支上运行）
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
      approvalRequired: true,
      projectPath: childInfo.projectPath ?? null,
    }

    const prompt = buildTaskPrompt(task, plan)

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
      .set({ status: 'running', startedAt: new Date(), attemptCount })
      .where(eq(workspaceTasks.id, task.id))

    broadcastSessionEvent(childInfo.sessionId, {
      type: 'task:update',
      payload: { taskId: task.id, status: 'running' },
    })

    try {
      const result = await runAgentReply(childInfo.sessionId, userMsg, profile)

      if (signal.aborted || result.cancelled) {
        await db
          .update(workspaceTasks)
          .set({ status: 'cancelled', completedAt: new Date() })
          .where(eq(workspaceTasks.id, task.id))
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
      if (branchCtx) {
        try {
          const diff = await gitBranchManager.collectDiff(branchCtx.projectPath, branchCtx.branch)
          const changedFiles = await gitBranchManager.collectChangedFiles(branchCtx.projectPath, branchCtx.branch)

          if (diff.trim()) {
            for (const filePath of changedFiles) {
              const status = await gitBranchManager.getFileStatus(branchCtx.projectPath, filePath, branchCtx.branch)
              artifacts.push({
                id: `diff-${filePath.replace(/[^a-z0-9]/gi, '-')}`,
                kind: 'diff',
                title: `${agent.name} 修改了 ${filePath}`,
                filePath,
                status,
                diff,
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

      await db
        .update(workspaceTasks)
        .set({
          status: 'done',
          completedAt: new Date(),
          artifacts: (artifacts as unknown as import('@agenthub/db').AgentArtifact[]) ?? [],
        })
        .where(eq(workspaceTasks.id, task.id))

      if (branchCtx) await gitBranchManager.cleanupBranch(branchCtx)

      return {
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        status: 'done',
        output,
        artifacts,
      }
    } catch (error: any) {
      await db
        .update(workspaceTasks)
        .set({ status: 'failed', completedAt: new Date(), errorLog: error?.message || 'Unknown error' })
        .where(eq(workspaceTasks.id, task.id))
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

  private async synthesizeAndReport(
    runId: string,
    groupSessionId: string,
    workspaceId: string,
    plan: ExecutionPlan,
    results: TaskResult[],
    conflictReports: import('./conflict-resolver').ConflictReport[] = [],
  ) {
    await db.update(orchestratorRuns).set({ status: 'synthesizing' }).where(eq(orchestratorRuns.id, runId))

    const summary = await this.synthesizer.synthesize(plan, results, conflictReports)

    const [summaryMsg] = await db
      .insert(messages)
      .values({
        sessionId: groupSessionId,
        senderId: 'orchestrator',
        senderType: 'agent',
        type: 'text',
        content: summary,
        metadata: {
          agentName: 'Orchestrator',
          role: 'Coordinator',
          runtimeType: 'llm',
          orchestratorSummary: {
            dispatchId: runId,
            taskIds: plan.tasks.map((t) => t.id),
            workspaceId,
          },
        },
      })
      .returning()

    await db
      .update(orchestratorRuns)
      .set({ status: 'completed', summaryMessageId: summaryMsg?.id ?? null })
      .where(eq(orchestratorRuns.id, runId))

    broadcastSessionEvent(groupSessionId, {
      type: 'message:completed',
      payload: { sessionId: groupSessionId, message: summaryMsg },
    })
  }
}

function buildTaskPrompt(task: ExecutionTask, plan: ExecutionPlan): string {
  const agent = plan.agents.find((a) => a.id === task.agentId)
  return [
    agent ? `你是 ${agent.name}(${agent.role})。${agent.systemPrompt || ''}` : '你是 AgentHub 协作 Agent。',
    `\n协作目标: ${plan.goal}`,
    `\n当前子任务: ${task.title}`,
    `\n任务说明: ${task.description}`,
    task.dependencies.length ? `\n前置依赖任务: ${task.dependencies.join(', ')}` : '',
    '\n请先给出简短工作计划，再产出结果。遇到需要其他 Agent 配合的内容，请在结尾用「需协作:」列出。',
  ]
    .filter(Boolean)
    .join('')
}
