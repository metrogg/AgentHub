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
  private replanningEngine = new ReplanningEngine()

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
        const replan = this.replanningEngine.handle(currentTask, new Error(result.error || 'Task failed'), currentAttempt, plan)

        logger.info({ taskId: currentTask.id, strategy: replan.strategy, reason: replan.reason }, 'Replanning triggered')

        if (replan.strategy === 'retry_with_backoff') {
          const delayMs = replan.delayMs ?? 1000
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
          currentTask = replan.updatedTask
          currentAttempt = 0
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
              dependencies: newTask.dependencies ?? [],
              parallelGroup: newTask.parallelGroup,
              maxRetries: newTask.maxRetries ?? 2,
            })
            childSessions.set(newTask.id, { sessionId: childSession.id, workspaceId, projectPath: childSessions.get(currentTask.id)?.projectPath })
          }
          this.scheduler.addTasksToRun(runId, replan.newTasks)
          logger.info({ taskId: currentTask.id, newTaskCount: replan.newTasks.length }, 'Task split into subtasks')
          return { ...result, status: 'failed' as const, error: `任务已拆分为子任务: ${replan.reason}` }
        }

        if (replan.strategy === 'global_replan') {
          try {
            const newPlan = await this.planner.createPlan({ goal: plan.goal, agents: plan.agents })
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
                  dependencies: newTask.dependencies ?? [],
                  parallelGroup: newTask.parallelGroup,
                  maxRetries: newTask.maxRetries ?? 2,
                })
                childSessions.set(newTask.id, { sessionId: childSession.id, workspaceId, projectPath: childSessions.get(currentTask.id)?.projectPath })
              }
              this.scheduler.addTasksToRun(runId, tasksToAdd)
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
        }

        if (replan.strategy === 'fail') {
          return { ...result, error: replan.reason }
        }

        return { ...result, error: replan.reason }
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
    } finally {
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
      projectPath: branchCtx?.worktreePath ?? childInfo.projectPath ?? null,
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

    broadcastSessionEvent(groupSessionId, {
      type: 'task:update',
      payload: { taskId: task.id, status: 'running', sessionId: childInfo.sessionId },
    })

    const taskStartTime = Date.now()
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
                type: 'diff',
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

      const taskDuration = Date.now() - taskStartTime
      await executionTracer.log({
        runId,
        sessionId: childInfo.sessionId,
        agentId: agent.id,
        taskId: task.id,
        type: 'task_end',
        output: { status: 'done', outputLength: output.length, durationMs: taskDuration },
      })

      // 写入黑板：任务产出
      const outputRef = await blackboard.write({
        namespace: bbNamespace,
        key: `task_${task.id}_output`,
        value: { output, artifacts, agentId: agent.id, agentName: agent.name, taskTitle: task.title },
        agentId: agent.id,
        taskId: task.id,
        tags: ['task_output', `agent_${agent.id}`],
      })

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

    // 从黑板读取所有产物，供 Synthesizer 使用（替代直接从 results 读取）
    const bbNamespace = Blackboard.namespace(workspaceId, runId)
    const bbResults = await blackboard.query({ namespace: bbNamespace, keyPattern: 'task_%_output' })
    const enrichedResults: TaskResult[] = results.map((r) => {
      const bbEntry = bbResults.find((e) => e.key === `task_${r.taskId}_output`)
      if (bbEntry) {
        const val = bbEntry.value as { output: string; artifacts: Array<Record<string, unknown>> }
        return { ...r, output: val.output, artifacts: val.artifacts, outputRef: { namespace: bbNamespace, key: bbEntry.key, version: bbEntry.version } }
      }
      return r
    })

    const summary = await this.synthesizer.synthesize(plan, enrichedResults, conflictReports)

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

async function ensureChildSession(
  workspaceId: string,
  workspaceName: string,
  ownerId: string,
  agent: { id: string; name: string } | null,
  taskTitle?: string
) {
  if (agent) {
    const [existing] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.ownerId, ownerId),
          eq(sessions.type, 'direct'),
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.workspaceAgentId, agent.id)
        )
      )
      .orderBy(desc(sessions.updatedAt))
      .limit(1)
    if (existing) return existing
  }

  const [created] = await db
    .insert(sessions)
    .values({
      title: agent ? `${workspaceName} / ${agent.name}` : `${workspaceName} / ${taskTitle?.slice(0, 24) || 'Agent'}`,
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
      const depId = e.key.replace('task_', '').replace('_output', '')
      return task.dependencies.includes(depId)
    })

    if (relevant.length > 0) {
      upstreamContext =
        '\n\n【前置依赖产出】\n' +
        relevant
          .map((e) => {
            const val = e.value as {
              output: string
              agentName: string
              taskTitle: string
              artifacts?: Array<{ type?: string; diff?: string; filePath?: string; path?: string }>
            }
            let text = `--- 来自 ${val.agentName}（${val.taskTitle}）---\n${(val.output || '').slice(0, 2000)}`
            const codeArtifacts = val.artifacts?.filter((a) => a.type === 'diff' || a.type === 'file') ?? []
            if (codeArtifacts.length > 0) {
              text +=
                '\n\n[代码变更]\n' +
                codeArtifacts
                  .map((a) => {
                    if (a.type === 'diff' && a.diff) return `\`\`\`diff\n// ${a.filePath || 'unknown'}\n${a.diff.slice(0, 3000)}\n\`\`\``
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
