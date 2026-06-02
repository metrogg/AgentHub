import { db, messages, workspaceTasks, eq, and, desc } from '@agenthub/db'
import { logger } from '../../lib/logger'
import type { AgentRunProfile, MessageRow } from '../agent-runner'
import { DEFAULT_ENV_ALLOWLIST } from './agent-execution-envelope'
import type { AgentWorkdir } from './agent-workdir'
import { TaskStatus, type TaskType } from '@agenthub/shared'
import { env } from '../../env'
import { localA2ATransport } from './local-a2a-transport'
import type { AgentHubA2AEnvelope } from '../protocols/a2a-internal'
import { buildA2AExecutionTask } from '../protocols/a2a-internal'
import { acquireExecutionSandbox } from './sandbox-provider'
import type { SandboxLease } from './sandbox-provider'
import {
  buildExecutionConfigSummary,
  type ExecutionConfigSummary,
} from './execution-config-summary'

const STRICT_TASK_TYPES = new Set<TaskType>(['code', 'test', 'verify'])

export interface TaskExecutionInput {
  taskId: string
  sessionId: string
  workspaceId: string
  profile: AgentRunProfile
  prompt: string
  taskType?: TaskType | undefined
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
  /** 内部 Agent 间通信的 A2A message/send 信封 */
  a2a?: AgentHubA2AEnvelope
  onExecutionConfigReady?: (config: ExecutionConfigSummary) => void | Promise<void>
}

export interface TaskExecutionOutput {
  status: TaskStatus
  output: string
  artifacts: Array<Record<string, unknown>>
  error?: string
  warning?: string
  durationMs: number
  /** 实际执行目录（写入型 Agent 会落在工作区下的 .agenthub/workdirs） */
  executionPath?: string | null
  executionConfig?: ExecutionConfigSummary
}

export const __taskExecutionTestHooks = {
  shouldAcceptPartialExecution,
}

/**
 * 统一任务执行服务：为单任务 dispatch 和 Orchestrator 子任务提供
 * 相同的执行目录分配、Agent 执行和 artifact 收集能力。
 */
export class TaskExecutionService {
  async execute(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const { taskId, sessionId, projectPath, profile, prompt, signal, attemptCount = 0 } = input

    const runId = input.runId ?? 'standalone'
    const requestedSandboxPolicy =
      profile.sandboxPolicy === 'danger-full-access' ? 'danger-full-access' : 'workspace-write'
    const executionSandboxPolicy = requestedSandboxPolicy

    const taskStartTime = Date.now()
    let executionPath: string | null = null
    let sandboxLease: SandboxLease | null = null
    let executionConfig = await buildExecutionConfigSummary({
      profile,
      projectPath,
      requestedSandboxPolicy,
    })
    try {
      sandboxLease = await acquireExecutionSandbox({
        runId,
        taskId,
        agentId: profile.id,
        agentName: profile.name,
        projectPath,
        codeAgentType: profile.codeAgentType ?? null,
        sandboxPolicy: executionSandboxPolicy,
        existingWorkdir: input.existingWorkdir,
      })
      const workdir = sandboxLease.workdir
      executionPath = sandboxLease.cwd ?? profile.projectPath ?? projectPath ?? null
      if (workdir) {
        logger.info(
          {
            executionPath: workdir.executionPath,
            relativePath: workdir.relativePath,
            agent: profile.name,
            sandboxProvider: sandboxLease.provider,
            isolation: sandboxLease.isolation,
          },
          'Agent workdir prepared',
        )
      }

      const executionProfile: AgentRunProfile = {
        ...profile,
        projectPath: executionPath,
        originalProjectPath: profile.projectPath ?? null,
        sandboxPolicy: executionSandboxPolicy,
      }
      executionConfig = await buildExecutionConfigSummary({
        profile: executionProfile,
        projectPath,
        executionPath,
        workdir,
        sandboxLease,
        requestedSandboxPolicy,
      })
      try {
        await input.onExecutionConfigReady?.(executionConfig)
      } catch (notifyError: any) {
        logger.warn(
          { err: notifyError?.message || notifyError, taskId },
          'Failed to publish execution config summary',
        )
      }

      const envelope: import('./agent-execution-envelope').AgentExecutionEnvelope = {
        runId,
        taskId,
        agentId: profile.id,
        agentName: profile.name,
        projectPath: projectPath ?? null,
        worktreePath: workdir?.executionPath ?? executionPath,
        sandboxPolicy: executionSandboxPolicy,
        envAllowlist: DEFAULT_ENV_ALLOWLIST,
        a2a: input.a2a,
        sandboxProvider: sandboxLease.provider,
        isolation: sandboxLease.isolation,
        sandboxEnv: sandboxLease.env,
        sandboxContainer: sandboxLease.container,
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
          return { status: TaskStatus.Failed, output: '', artifacts: [], error: 'Existing user message not found', durationMs: 0, executionConfig }
        }
        userMsg = await attachA2AMetadata(existingUserMsg as MessageRow, input.a2a)
      } else {
        const [createdUserMsg] = await db
          .insert(messages)
          .values({
            sessionId,
            senderId: 'user',
            senderType: 'user',
            type: 'text',
            content: prompt,
            metadata: input.a2a ? { a2a: input.a2a } : undefined,
          })
          .returning()

        if (!createdUserMsg) {
          return { status: TaskStatus.Failed, output: '', artifacts: [], error: 'Failed to create user message', durationMs: 0, executionConfig }
        }
        userMsg = createdUserMsg as MessageRow
      }

      // 更新 task 状态
      await db
        .update(workspaceTasks)
        .set({ status: TaskStatus.Running, startedAt: new Date(), retryCount: attemptCount })
        .where(eq(workspaceTasks.id, taskId))

      const TASK_TIMEOUT_MS = env.AGENTHUB_CODE_AGENT_TIMEOUT_MS
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
        localA2ATransport.sendMessage({
          sessionId,
          userMessage: agentUserMsg,
          profile: executionProfile,
          envelope,
          a2a: input.a2a,
        }),
        timeoutPromise,
      ])

      if (signal?.aborted) {
        await db.update(workspaceTasks).set({ status: TaskStatus.Cancelled, completedAt: new Date() }).where(eq(workspaceTasks.id, taskId))
        return { status: TaskStatus.Cancelled, output: 'Task was cancelled', artifacts: [], durationMs: Date.now() - taskStartTime, executionPath, executionConfig }
      }

      if (result.cancelled) {
        await db.update(workspaceTasks).set({ status: TaskStatus.Cancelled, completedAt: new Date() }).where(eq(workspaceTasks.id, taskId))
        return { status: TaskStatus.Cancelled, output: 'Task was cancelled', artifacts: [], durationMs: Date.now() - taskStartTime, executionPath, executionConfig }
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
      await attachA2AResultMetadata({
        message: lastAgentMsg[0] as MessageRow | undefined,
        a2a: input.a2a,
        status: result.ok ? TaskStatus.Done : TaskStatus.Failed,
        output,
        artifacts,
        error: result.ok ? undefined : output.trim() || 'Agent 执行失败，请检查日志',
      })

      if (!result.ok) {
        const error = output.trim() || 'Agent 执行失败，请检查日志'
        const partialAccepted = shouldAcceptPartialExecution(input.taskType, artifacts)
        if (partialAccepted) {
          await db
            .update(workspaceTasks)
            .set({
              status: TaskStatus.Done,
              completedAt: new Date(),
              artifacts: (artifacts as unknown as import('@agenthub/db').AgentArtifact[]) ?? [],
            })
            .where(eq(workspaceTasks.id, taskId))
          return {
            status: TaskStatus.Done,
            output,
            artifacts,
            warning: error,
            durationMs: taskDuration,
            executionPath,
            executionConfig,
          }
        }
        await db
          .update(workspaceTasks)
          .set({ status: TaskStatus.Failed, completedAt: new Date(), errorLog: error.slice(0, 2000) })
          .where(eq(workspaceTasks.id, taskId))
        return { status: TaskStatus.Failed, output, artifacts, error, durationMs: taskDuration, executionPath, executionConfig }
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

      return { status: TaskStatus.Done, output, artifacts, durationMs: taskDuration, executionPath, executionConfig }
    } catch (error: any) {
      const taskDuration = Date.now() - taskStartTime
      await db
        .update(workspaceTasks)
        .set({ status: TaskStatus.Failed, completedAt: new Date(), errorLog: error?.message || 'Unknown error' })
        .where(eq(workspaceTasks.id, taskId))
      return { status: TaskStatus.Failed, output: '', artifacts: [], error: error?.message || 'Unknown error', durationMs: taskDuration, executionPath, executionConfig }
    } finally {
      if (sandboxLease) {
        try {
          await sandboxLease.cleanup()
        } catch (cleanupError: any) {
          logger.warn(
            {
              err: cleanupError?.message || cleanupError,
              sandboxProvider: sandboxLease.provider,
              sandboxRoot: sandboxLease.rootDir,
            },
            'Failed to cleanup execution sandbox',
          )
        }
      }
    }
  }
}

export const taskExecutionService = new TaskExecutionService()

export function shouldAcceptPartialExecution(
  taskType: TaskType | undefined,
  artifacts: Array<Record<string, unknown>>,
) {
  if (!taskType) return false
  if (artifacts.length === 0) return false
  return !STRICT_TASK_TYPES.has(taskType)
}

async function attachA2AMetadata(message: MessageRow, a2a?: AgentHubA2AEnvelope): Promise<MessageRow> {
  if (!a2a) return message
  const metadata = asMetadataRecord(message.metadata)
  const nextMetadata = { ...metadata, a2a }
  await db.update(messages).set({ metadata: nextMetadata }).where(eq(messages.id, message.id))
  return { ...message, metadata: nextMetadata }
}

async function attachA2AResultMetadata(params: {
  message?: MessageRow
  a2a?: AgentHubA2AEnvelope
  status: TaskStatus
  output: string
  artifacts: Array<Record<string, unknown>>
  error?: string
}) {
  if (!params.message || !params.a2a) return
  const metadata = asMetadataRecord(params.message.metadata)
  const finalTask = buildA2AExecutionTask({
    envelope: params.a2a,
    status: params.status,
    output: params.output,
    error: params.error,
    artifacts: params.artifacts,
    messageId: params.message.id,
  })
  await db
    .update(messages)
    .set({
      metadata: {
        ...metadata,
        a2a: {
          ...(asMetadataRecord(metadata.a2a)),
          runtimeTask: finalTask,
        },
      },
    })
    .where(eq(messages.id, params.message.id))
}

function asMetadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
