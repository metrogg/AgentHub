import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  and,
  db,
  desc,
  eq,
  sessions,
  roomParticipants,
  rooms,
  runtimeLeases,
  taskThreads,
  workerInstances,
  workspaceTasks,
  workspaceAgents,
  workspaces,
} from '@agenthub/db'
import { AppError, AppErrorCodes } from '../../lib/error'
import { logger } from '../../lib/logger'
import { registerTaskArtifact, toCanonicalArtifactRecord } from '../orchestrator/artifact-store'
import { runController } from '../orchestrator/run-controller'
import { runtimeLeaseController } from '../orchestrator/runtime-lease-controller'
import { updateSharedTaskDirectoryStatus } from '../orchestrator/shared-task-directory'
import { markWorkerInstanceState } from '../orchestrator/worker-runtime-resources'
import { roomService } from '../rooms'
import { ensureManagerParticipantForRoom } from '../rooms/manager-participant'
import { ensureWorkerAgentContractFromController, touchWorkerAgentContractHeartbeat } from '../agent-contract'
import { EphemeralCodeAgentWorkerRuntime } from './local-worker-runtime'
import { ResidentRoomWorkerRuntime } from './resident-worker-runtime'
import { answerPendingTaskClarification, createTaskClarification } from './task-clarification-store'
import type { WorkerRuntime, WorkerRuntimeEvent, WorkerRuntimeResult } from './types'

function buildSandboxEnvFromLease(lease: typeof runtimeLeases.$inferSelect | undefined): Record<string, string> | undefined {
  if (!lease) return undefined
  const env: Record<string, string> = {}
  if (lease.homeDir) env.HOME = lease.homeDir
  if (lease.configDir) {
    env.XDG_CONFIG_HOME = lease.configDir
    // Codex uses CODEX_HOME, Claude Code uses ~/.claude under HOME
    env.CODEX_HOME = lease.configDir
  }
  if (lease.cacheDir) env.XDG_CACHE_HOME = lease.cacheDir
  if (lease.dataDir) env.XDG_DATA_HOME = lease.dataDir
  if (lease.tmpDir) {
    env.TMPDIR = lease.tmpDir
    env.TEMP = lease.tmpDir
    env.TMP = lease.tmpDir
  }
  if (Object.keys(env).length === 0) return undefined
  return env
}

export interface RunTaskRoomInput {
  roomId: string
  ownerId: string
  workspaceAgentId?: string | null
  prompt?: string | null
  runtime?: WorkerRuntime
  source?: string
  signal?: AbortSignal
  heartbeatIntervalMs?: number
  resumeSessionId?: string
  continueSession?: boolean
}

export interface RunTaskRoomResult extends WorkerRuntimeResult {
  roomId: string
  workerParticipantId: string
  appendedEventIds: string[]
}

export interface ResumeTaskRoomAfterHumanAnswerInput {
  roomId: string
  ownerId: string
  sourceMessageId?: string
  sourceEventId?: string
  answer: string
  runtime?: WorkerRuntime
  runAfterResume?: boolean
  signal?: AbortSignal
}

export interface ResumeTaskRoomAfterHumanAnswerResult {
  roomId: string
  consumed: boolean
  reason: string
  resumed: boolean
  appendedEventIds: string[]
}

export interface DenyTaskRoomClarificationInput {
  roomId: string
  ownerId: string
  sourceMessageId?: string
  sourceEventId?: string
  reason: string
}

export interface DenyTaskRoomClarificationResult {
  roomId: string
  consumed: boolean
  reason: string
  denied: boolean
  appendedEventIds: string[]
}

export interface RerunTaskRoomInput {
  roomId: string
  ownerId: string
  workspaceAgentId?: string | null
  prompt?: string | null
  runtime?: WorkerRuntime
  source?: string
  signal?: AbortSignal
  heartbeatIntervalMs?: number
}

export interface RunGroupMentionRoomInput {
  roomId: string
  ownerId: string
  workspaceAgentId: string
  sourceEventId: string
  prompt: string
  signal?: AbortSignal
}

export interface RunGroupMentionRoomResult {
  roomId: string
  appendedEventIds: string[]
  status: 'completed' | 'failed' | 'waiting_for_human' | 'cancelled'
}

export class WorkerRuntimeService {
  private readonly runningControllers = new Map<string, AbortController>()
  private readonly roomRuntimeKind = new Map<string, import('./types').WorkerRuntimeKind>()

  isRoomRunning(roomId: string): boolean {
    return this.runningControllers.has(roomId)
  }

  async stopTaskRoom(roomId: string): Promise<boolean> {
    const kind = this.roomRuntimeKind.get(roomId)
    if (kind === 'resident-openclaw' || kind === 'resident-qwenpaw') {
      await roomService.appendTimelineEvent({
        roomId,
        senderType: 'system',
        type: 'task.progress',
        body: '已请求停止 Resident Worker。',
        metadata: { kind: 'matrix.control.stop.resident-requested', workerKind: kind },
      })
      this.roomRuntimeKind.delete(roomId)
      return true
    }
    const controller = this.runningControllers.get(roomId)
    if (!controller) return false
    controller.abort()
    this.roomRuntimeKind.delete(roomId)
    return true
  }
  /**
   * Run Agent in a direct room (agent-direct session).
   * This is the HiClaw-style worker execution for private chats:
   * the worker listens to the room timeline and executes autonomously.
   */
  async runDirectRoom(input: {
    roomId: string
    ownerId: string
    workspaceAgentId: string
    prompt?: string
    signal?: AbortSignal
    overrides?: { sandboxPolicy?: string; approvalRequired?: boolean }
  }): Promise<{ roomId: string; appendedEventIds: string[] }> {
    const room = await roomService.getRoomForOwner(input.roomId, input.ownerId)
    if (room.kind !== 'direct') {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'WorkerRuntime 只能从 direct room 执行私聊')
    }

    const [session] = room.sessionId
      ? await db.select().from(sessions).where(eq(sessions.id, room.sessionId)).limit(1)
      : []
    const effectiveWorkspaceAgentId = input.workspaceAgentId || session?.workspaceAgentId || null
    if (!effectiveWorkspaceAgentId) {
      throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Direct room 还没有绑定 Agent')
    }

    const workerParticipant = await findWorkerParticipant(room.id, effectiveWorkspaceAgentId)
    if (!workerParticipant?.workspaceAgentId) {
      throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Direct room 还没有 Agent participant')
    }

    if (this.runningControllers.has(room.id)) {
      logger.info({ roomId: room.id }, 'Direct room already has a running worker; skipping duplicate execution')
      return { roomId: room.id, appendedEventIds: [] }
    }

    const [agentRow] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.id, workerParticipant.workspaceAgentId))
      .limit(1)
    if (!agentRow) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Agent 不存在')

    // Apply safetyMode overrides if provided
    const agent = input.overrides
      ? {
          ...agentRow,
          sandboxPolicy: (input.overrides.sandboxPolicy as typeof agentRow.sandboxPolicy) ?? agentRow.sandboxPolicy,
          approvalRequired: input.overrides.approvalRequired ?? agentRow.approvalRequired,
        }
      : agentRow

    const [workspace] = room.workspaceId
      ? await db.select().from(workspaces).where(eq(workspaces.id, room.workspaceId)).limit(1)
      : []
    const [workerInstance] = workerParticipant.workerInstanceId
      ? await db.select().from(workerInstances).where(eq(workerInstances.id, workerParticipant.workerInstanceId)).limit(1)
      : []

    const timeline = await roomService.listTimelineEvents({ roomId: room.id, limit: 100 })
    const prompt = input.prompt?.trim() || latestHumanMessageBody(timeline) || room.title

    const runtime =
      workerInstance?.runtimeBase === 'openclaw' || workerInstance?.runtimeBase === 'copaw' || workerInstance?.runtimeBase === 'qwenpaw'
        ? new ResidentRoomWorkerRuntime({
            runtimeType: workerInstance.runtimeBase === 'openclaw' ? 'openclaw' : 'qwenpaw',
            workerParticipantId: workerParticipant.id,
          })
        : new EphemeralCodeAgentWorkerRuntime(agent)
    this.roomRuntimeKind.set(room.id, runtime.kind)

    const abortController = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) {
        abortController.abort()
      } else {
        input.signal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
    }
    this.runningControllers.set(room.id, abortController)

    const appendedEventIds: string[] = []
    try {
      const iterator = runtime.executeTask(
        {
          roomId: room.id,
          sessionId: room.sessionId ?? room.id,
          workspaceId: room.workspaceId ?? agent.workspaceId,
          workspaceAgentId: agent.id,
          workerInstanceId: null,
          taskId: null,
          taskThreadId: null,
          runId: null,
          prompt,
          history: timeline.map((event) => ({
            senderType: event.senderType,
            type: event.type,
            body: event.body,
          })),
          workspacePath: workspace?.projectPath ?? null,
        },
        abortController.signal,
      )

      let next = await iterator.next()
      while (!next.done) {
        const event = next.value
        if (event.type === 'message') {
          next = await iterator.next()
          continue
        }
        const timelineEvent = await roomService.appendTimelineEvent({
          roomId: room.id,
          senderParticipantId: workerParticipant.id,
          senderType: 'worker',
          type: 'task.progress',
          body: event.message ?? '',
          metadata: {
            kind: `worker-runtime.${event.type}`,
            workspaceAgentId: agent.id,
            runtimeType: runtime.runtimeType,
            hiddenFromChat: true,
            ...(event.type === 'progress'
              ? { progressPercent: event.progressPercent }
              : event.type === 'artifact'
                ? { artifact: event.artifact }
                : {}),
          },
        })
        appendedEventIds.push(timelineEvent.id)
        next = await iterator.next()
      }

      // Final result event
      const result = next.value
      const resultEvent = await roomService.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: workerParticipant.id,
        senderType: 'worker',
        type: result.status === 'completed' || result.status === 'failed' ? 'worker.message' : 'task.progress',
        body: result.message ?? (result.status === 'completed' ? '执行完成。' : '执行失败。'),
        metadata: {
          kind: 'worker-runtime.completed',
          status: result.status,
          workspaceAgentId: agent.id,
          runtimeType: runtime.runtimeType,
          artifacts: result.artifacts ?? [],
          ...(result.status === 'waiting_for_human' ? { hiddenFromChat: true } : {}),
        },
      })
      appendedEventIds.push(resultEvent.id)
    } catch (error: any) {
      logger.error({ err: error?.message, roomId: room.id, agentId: agent.id }, 'Direct room execution failed')
      const failEvent = await roomService.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: workerParticipant.id,
        senderType: 'worker',
        type: 'task.progress',
        body: `[错误：${error?.message || '执行失败'}]`,
        metadata: {
          kind: 'worker-runtime.failed',
          workspaceAgentId: agent.id,
          runtimeType: runtime.runtimeType,
        },
      })
      appendedEventIds.push(failEvent.id)
    } finally {
      this.runningControllers.delete(room.id)
      this.roomRuntimeKind.delete(room.id)
    }

    return { roomId: room.id, appendedEventIds }
  }

  /**
   * Run a Worker from a group-room @mention.
   *
   * This is the bridge between AgentHub's current CLI Worker base and the
   * HiClaw room model: the mention lives in the group room, the addressed
   * Worker executes as itself, and the reply is written back to the same room.
   * Resident OpenClaw/QwenPaw Workers can later replace this bridge by listening
   * to the room directly.
   */
  async runGroupMentionRoom(input: RunGroupMentionRoomInput): Promise<RunGroupMentionRoomResult> {
    const room = await roomService.getRoomForOwner(input.roomId, input.ownerId)
    if (room.kind !== 'group' && room.kind !== 'manager_dm') {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'WorkerRuntime 只能从 group room 处理 @mention')
    }

    const workerParticipant = await findWorkerParticipant(room.id, input.workspaceAgentId)
    if (!workerParticipant?.workspaceAgentId) {
      throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, '群聊房间还没有该 Worker participant')
    }

    const controllerKey = `${room.id}:${workerParticipant.workspaceAgentId}`
    if (this.runningControllers.has(controllerKey)) {
      logger.info({ roomId: room.id, agentId: workerParticipant.workspaceAgentId }, 'Group mention worker is already running')
      return { roomId: room.id, appendedEventIds: [], status: 'waiting_for_human' }
    }

    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.id, workerParticipant.workspaceAgentId))
      .limit(1)
    if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Worker Agent 不存在')
    const [workerInstance] = workerParticipant.workerInstanceId
      ? await db.select().from(workerInstances).where(eq(workerInstances.id, workerParticipant.workerInstanceId)).limit(1)
      : []

    const [workspace] = room.workspaceId
      ? await db.select().from(workspaces).where(eq(workspaces.id, room.workspaceId)).limit(1)
      : []
    const timeline = await roomService.listTimelineEvents({ roomId: room.id, limit: 100 })
    const runtime =
      workerInstance?.runtimeBase === 'openclaw' || workerInstance?.runtimeBase === 'qwenpaw' || workerInstance?.runtimeBase === 'copaw'
        ? new ResidentRoomWorkerRuntime({
            runtimeType: workerInstance.runtimeBase === 'openclaw' ? 'openclaw' : 'qwenpaw',
            workerParticipantId: workerParticipant.id,
          })
        : new EphemeralCodeAgentWorkerRuntime(agent)
    this.roomRuntimeKind.set(controllerKey, runtime.kind)

    const abortController = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) {
        abortController.abort()
      } else {
        input.signal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
    }
    this.runningControllers.set(controllerKey, abortController)

    const appendedEventIds: string[] = []
    let finalStatus: RunGroupMentionRoomResult['status'] =
      runtime.kind === 'resident-openclaw' || runtime.kind === 'resident-qwenpaw'
        ? 'waiting_for_human'
        : 'completed'
    await markWorkerInstanceState(workerParticipant.workerInstanceId, 'busy', {
      message: `${agent.name} is answering a group mention.`,
      health: {
        roomId: room.id,
        sourceEventId: input.sourceEventId,
      },
    })

    try {
      const startedEvent = await roomService.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: workerParticipant.id,
        senderType: 'system',
        type: 'task.progress',
        body: `${agent.name} 正在处理这条 @。`,
        metadata: {
          kind: 'worker-runtime.group-mention-started',
          sourceEventId: input.sourceEventId,
          workspaceAgentId: agent.id,
          workerInstanceId: workerParticipant.workerInstanceId ?? null,
          runtimeType: runtime.runtimeType,
          hiddenFromChat: true,
          uiPresentation: 'agent-activity',
        },
      })
      appendedEventIds.push(startedEvent.id)

      const iterator = runtime.executeTask(
        {
          roomId: room.id,
          sessionId: room.sessionId ?? room.id,
          workspaceId: room.workspaceId ?? agent.workspaceId,
          workspaceAgentId: agent.id,
          workerInstanceId: workerParticipant.workerInstanceId ?? null,
          taskId: null,
          taskThreadId: null,
          runId: null,
          prompt: input.prompt,
          history: timeline.map((event) => ({
            senderType: event.senderType,
            type: event.type,
            body: event.body,
          })),
          workspacePath: workspace?.projectPath ?? null,
        },
        abortController.signal,
      )

      let next = await iterator.next()
      while (!next.done) {
        const runtimeEvent = next.value
        if (runtimeEvent.type === 'message') {
          next = await iterator.next()
          continue
        }
        if (runtimeEvent.type === 'progress' || runtimeEvent.type === 'failed') {
          await markWorkerInstanceState(workerParticipant.workerInstanceId, runtimeEvent.type === 'failed' ? 'failed' : 'busy', {
            message: runtimeEvent.message,
            health: {
              roomId: room.id,
              sourceEventId: input.sourceEventId,
              runtimeType: runtime.runtimeType,
              progressPercent: runtimeEvent.type === 'progress' ? runtimeEvent.progressPercent ?? null : null,
            },
          })
          next = await iterator.next()
          continue
        }
        const event = await appendWorkerRuntimeEvent({
          roomId: room.id,
          participantId: workerParticipant.id,
          workspaceId: room.workspaceId ?? agent.workspaceId,
          workspaceAgentId: agent.id,
          workerInstanceId: workerParticipant.workerInstanceId ?? null,
          runtimeType: runtime.runtimeType,
          event: runtimeEvent,
        })
        appendedEventIds.push(event.id)
        next = await iterator.next()
      }

      const result = next.value
      finalStatus = result.status
      const completedEvent = await roomService.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: workerParticipant.id,
        senderType: 'worker',
        type: 'worker.message',
        body:
          result.status === 'completed'
            ? result.message || '处理完成。'
            : result.status === 'waiting_for_human'
              ? '已通过 Matrix @mention 发送给 Resident Worker，等待其在房间里回复。'
              : '我这边还没启动成功，请检查这个 Worker 的 CLI 基底、模型绑定和认证状态。',
        metadata: {
          kind:
            result.status === 'completed'
              ? 'worker-runtime.group-mention-completed'
              : result.status === 'waiting_for_human'
                ? 'worker-runtime.group-mention-dispatched'
                : 'worker-runtime.group-mention-failed',
          status: result.status,
          sourceEventId: input.sourceEventId,
          workspaceAgentId: agent.id,
          workerInstanceId: workerParticipant.workerInstanceId ?? null,
          runtimeType: runtime.runtimeType,
          artifacts: result.artifacts ?? [],
          sessionId: result.sessionId ?? null,
          rawError: result.status === 'completed' || result.status === 'waiting_for_human' ? null : result.message ?? null,
        },
      })
      appendedEventIds.push(completedEvent.id)
      await markWorkerInstanceState(
        workerParticipant.workerInstanceId,
        result.status === 'completed' ? 'idle' : result.status === 'waiting_for_human' ? 'assigned' : 'failed',
        {
          message: result.message ?? null,
          health: {
            roomId: room.id,
            sourceEventId: input.sourceEventId,
            status: result.status,
          },
        },
      )
    } catch (error: any) {
      logger.error({ err: error?.message, roomId: room.id, agentId: agent.id }, 'Group mention worker execution failed')
      const failEvent = await roomService.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: workerParticipant.id,
        senderType: 'worker',
        type: 'worker.message',
        body: '我这边还没启动成功，请检查这个 Worker 的 CLI 基底、模型绑定和认证状态。',
        metadata: {
          kind: 'worker-runtime.group-mention-failed',
          sourceEventId: input.sourceEventId,
          workspaceAgentId: agent.id,
          workerInstanceId: workerParticipant.workerInstanceId ?? null,
          runtimeType: runtime.runtimeType,
          rawError: error?.message || '执行失败',
        },
      })
      appendedEventIds.push(failEvent.id)
      finalStatus = 'failed'
      await markWorkerInstanceState(workerParticipant.workerInstanceId, 'failed', {
        message: error?.message || 'Group mention worker execution failed.',
      })
    } finally {
      this.runningControllers.delete(controllerKey)
      this.roomRuntimeKind.delete(controllerKey)
    }

    return {
      roomId: room.id,
      appendedEventIds,
      status: finalStatus,
    }
  }

  async runTaskRoom(input: RunTaskRoomInput): Promise<RunTaskRoomResult> {
    const room = await roomService.getRoomForOwner(input.roomId, input.ownerId)
    if (room.kind !== 'task') {
      throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, 'WorkerRuntime 只能从 task room 接单')
    }

    const workerParticipant = await findWorkerParticipant(room.id, input.workspaceAgentId)
    if (!workerParticipant?.workspaceAgentId) {
      throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, '任务房间还没有可接单的 Worker')
    }

    const [agent] = await db
      .select()
      .from(workspaceAgents)
      .where(eq(workspaceAgents.id, workerParticipant.workspaceAgentId))
      .limit(1)
    if (!agent) throw AppError.fromCode(AppErrorCodes.AGENT_NOT_FOUND, 'Worker Agent 不存在')

    const [workspace] = room.workspaceId
      ? await db.select().from(workspaces).where(eq(workspaces.id, room.workspaceId)).limit(1)
      : []
    const [thread] = room.taskThreadId
      ? await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId)).limit(1)
      : []
    const [lease] = thread?.workerInstanceId
      ? await db
          .select()
          .from(runtimeLeases)
          .where(
            room.taskId
              ? and(
                  eq(runtimeLeases.workerInstanceId, thread.workerInstanceId),
                  eq(runtimeLeases.taskId, room.taskId),
                )
              : eq(runtimeLeases.workerInstanceId, thread.workerInstanceId),
          )
          .limit(1)
      : room.taskId
        ? await db
            .select()
            .from(runtimeLeases)
            .where(eq(runtimeLeases.taskId, room.taskId))
            .limit(1)
        : []

    const timeline = await roomService.listTimelineEvents({ roomId: room.id, limit: 100 })

    // Try to read spec.md from shared task directory (HiClaw-style task file protocol)
    let specPrompt: string | null = null
    let sharedTaskRelativeRoot: string | null = null
    let sharedTaskSpecPath: string | null = null
    if (room.taskId) {
      sharedTaskRelativeRoot = readString(room.metadata?.sharedTaskRelativeRoot) ?? ['.agenthub', 'shared', 'tasks', room.taskId].join('/')
      sharedTaskSpecPath = readString(room.metadata?.sharedTaskSpecPath) ?? `${sharedTaskRelativeRoot}/spec.md`
      const projectPath = workspace?.projectPath ?? lease?.cwd ?? null
      if (projectPath) {
        const specPath = join(projectPath, sharedTaskRelativeRoot, 'spec.md')
        try {
          specPrompt = await readFile(specPath, 'utf8')
        } catch (e: any) {
          if (e.code !== 'ENOENT') {
            logger.warn({ err: e, taskId: room.taskId, specPath }, 'Failed to read task spec.md')
          }
        }
      }
    }

    const prompt =
      input.prompt?.trim() ||
      specPrompt?.trim() ||
      latestAssignedTaskPrompt(timeline) ||
      room.topic ||
      room.title

    // Resolve worker instance to infer runtime mode
    const [workerInstance] = thread?.workerInstanceId
      ? await db.select().from(workerInstances).where(eq(workerInstances.id, thread.workerInstanceId)).limit(1)
      : []

    // Choose runtime by mode
    let runtime: WorkerRuntime
    if (input.runtime) {
      runtime = input.runtime
    } else if (
      workerInstance?.runtimeBase === 'openclaw' ||
      workerInstance?.runtimeBase === 'copaw' ||
      workerInstance?.runtimeBase === 'qwenpaw'
    ) {
      runtime = new ResidentRoomWorkerRuntime({
        runtimeType: workerInstance.runtimeBase === 'openclaw' ? 'openclaw' : 'qwenpaw',
        workerParticipantId: workerParticipant.id,
      })
    } else {
      runtime = new EphemeralCodeAgentWorkerRuntime(agent)
    }

    // Record runtime kind for stopTaskRoom dispatch
    this.roomRuntimeKind.set(room.id, runtime.kind)

    const appendedEventIds: string[] = []
    await runtimeLeaseController.markRunning(lease?.id, {
      cwd: lease?.cwd ?? null,
      homeDir: lease?.homeDir ?? null,
      configDir: lease?.configDir ?? null,
      cacheDir: lease?.cacheDir ?? null,
      tmpDir: lease?.tmpDir ?? null,
      dataDir: lease?.dataDir ?? null,
      metadata: {
        ...(lease?.metadata ?? {}),
        resumedFromWaitingForHuman: lease?.status === 'waiting_for_human',
      },
    })
    await markWorkerInstanceState(thread?.workerInstanceId, 'busy', {
      message: `${agent.name} is running a task room.`,
      runtimeHome: lease?.homeDir ?? null,
      runtimeConfigPath: lease?.configDir ?? null,
      health: {
        roomId: room.id,
        runId: room.runId ?? null,
        taskId: room.taskId ?? null,
        waitingForHuman: false,
      },
    })

    const startedEvent = await roomService.appendTimelineEvent({
      roomId: room.id,
      senderParticipantId: workerParticipant.id,
      senderType: 'worker',
      type: 'task.progress',
      body: `${agent.name} 已接单。`,
        metadata: {
          kind: 'worker-runtime.started',
          status: 'running',
          taskThreadStatus: 'active',
          progressPercent: 5,
        runId: room.runId ?? null,
        taskId: room.taskId ?? null,
        taskThreadId: room.taskThreadId ?? null,
        workspaceAgentId: agent.id,
          workerInstanceId: thread?.workerInstanceId ?? null,
          runtimeLeaseId: lease?.id ?? null,
          runtimeType: runtime.runtimeType,
          hiddenFromChat: true,
        },
      })
    appendedEventIds.push(startedEvent.id)

    await syncRunControllerAtTaskRoomStart({
      roomId: room.id,
      workspaceId: room.workspaceId ?? agent.workspaceId,
      runId: room.runId,
      taskId: room.taskId,
      taskThreadId: room.taskThreadId,
      groupSessionId: thread?.groupSessionId ?? null,
      childSessionId: room.sessionId ?? thread?.sessionId ?? null,
      title: room.title,
      agentId: agent.id,
      workerInstanceId: thread?.workerInstanceId ?? null,
      runtimeLeaseId: lease?.id ?? null,
      runtimeType: runtime.runtimeType,
      startedEventId: startedEvent.id,
    })
    await syncSharedTaskDirectoryStatus({
      roomId: room.id,
      projectPath: workspace?.projectPath ?? lease?.cwd ?? null,
      sharedTaskRelativeRoot,
      taskId: room.taskId,
      status: 'running',
      workerInstanceId: thread?.workerInstanceId ?? null,
      runtimeLeaseId: lease?.id ?? null,
      messageId: startedEvent.id,
      summary: `${agent.name} 已接单。`,
      executionConfig: {
        runtimeType: runtime.runtimeType,
        source: input.source ?? 'worker-runtime.start',
      },
      timestamps: { startedAt: new Date().toISOString() },
    })
    await refreshWorkerContractMirror({
      workerInstanceId: thread?.workerInstanceId ?? null,
      source: input.source ?? 'worker-runtime.start',
    })
    if (thread?.workerInstanceId) {
      touchWorkerAgentContractHeartbeat(thread.workerInstanceId, {
        lastTaskStartedAt: new Date().toISOString(),
        queueDepth: 0,
      })
    }

    const stopHeartbeat = startWorkerRuntimeHeartbeat({
      roomId: room.id,
      participantId: workerParticipant.id,
      workspaceAgentId: agent.id,
      workerInstanceId: thread?.workerInstanceId ?? null,
      runtimeLeaseId: lease?.id ?? null,
      runId: room.runId ?? null,
      taskId: room.taskId ?? null,
      taskThreadId: room.taskThreadId ?? null,
      runtimeType: runtime.runtimeType,
      intervalMs: input.heartbeatIntervalMs,
    })

    const abortController = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) {
        abortController.abort()
      } else {
        input.signal.addEventListener('abort', () => abortController.abort(), { once: true })
      }
    }
    this.runningControllers.set(room.id, abortController)

    try {
      const iterator = runtime.executeTask(
        {
          roomId: room.id,
          sessionId: room.sessionId ?? thread?.sessionId ?? room.id,
          workspaceId: room.workspaceId ?? agent.workspaceId,
          workspaceAgentId: agent.id,
          workerParticipantId: workerParticipant.id,
          workerInstanceId: thread?.workerInstanceId ?? null,
          taskId: room.taskId,
          taskThreadId: room.taskThreadId,
          runId: room.runId,
          sharedTaskRelativeRoot,
          sharedTaskSpecPath,
          runtimeLeaseId: lease?.id ?? null,
          prompt,
          history: timeline.map((event) => ({
            senderType: event.senderType,
            type: event.type,
            body: event.body,
          })),
          workspacePath: lease?.cwd ?? workspace?.projectPath ?? null,
          sandboxEnv: buildSandboxEnvFromLease(lease),
          resumeSessionId: input.resumeSessionId,
          continueSession: input.continueSession,
        },
        abortController.signal,
      )

      let next = await iterator.next()
      let sawClarification = false
      let lastClarificationId: string | null = null
      let lastClarificationQuestion: string | null = null
      while (!next.done) {
        const event = await appendWorkerRuntimeEvent({
          roomId: room.id,
          participantId: workerParticipant.id,
          workspaceAgentId: agent.id,
          workerInstanceId: thread?.workerInstanceId ?? null,
          runtimeLeaseId: lease?.id ?? null,
          workspaceId: room.workspaceId ?? agent.workspaceId,
          runId: room.runId,
          taskId: room.taskId,
          taskThreadId: room.taskThreadId,
          runtimeType: runtime.runtimeType,
          event: next.value,
        })
        appendedEventIds.push(event.id)
        if (next.value.type === 'clarification') {
          sawClarification = true
          lastClarificationQuestion = next.value.question ?? next.value.message
          const clarificationId = event.metadata?.clarificationId
          lastClarificationId = typeof clarificationId === 'string' ? clarificationId : null
        }
        next = await iterator.next()
      }

      const rawResult = next.value
      const result: WorkerRuntimeResult =
        sawClarification && rawResult.status === 'failed'
          ? {
              ...rawResult,
              status: 'waiting_for_human',
              message: rawResult.message || '等待用户澄清后继续。',
              metadata: {
                ...(rawResult.metadata ?? {}),
                waitingForHuman: true,
                clarificationId: lastClarificationId,
                clarificationQuestion: lastClarificationQuestion,
              },
            }
          : rawResult
      const completedEvent = await roomService.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: workerParticipant.id,
        senderType: 'worker',
        type: result.status === 'completed' ? 'worker.message' : 'task.progress',
        body:
          result.message ||
          (result.status === 'completed'
            ? '任务完成。'
            : result.status === 'waiting_for_human'
              ? '等待用户澄清。'
              : '任务失败。'),
        metadata: {
          kind:
            result.status === 'waiting_for_human'
              ? 'worker-runtime.waiting-for-human'
              : 'worker-runtime.completed',
          status: result.status,
          workspaceAgentId: agent.id,
          workerInstanceId: thread?.workerInstanceId ?? null,
          runtimeLeaseId: lease?.id ?? null,
          runtimeType: result.runtimeType,
          artifacts: result.artifacts ?? [],
          ...(result.metadata ?? {}),
        },
      })
      appendedEventIds.push(completedEvent.id)

      const finalResult: RunTaskRoomResult = {
        ...result,
        roomId: room.id,
        workerParticipantId: workerParticipant.id,
        appendedEventIds,
      }

      if (rawResult.sessionId && lease?.id) {
        await runtimeLeaseController.markRunning(lease.id, {
          metadata: {
            ...(lease.metadata ?? {}),
            sessionId: rawResult.sessionId,
          },
        })
      }

      await syncRunControllerAfterTaskRoomResult({
        roomId: room.id,
        ownerId: input.ownerId,
        result: finalResult,
        source: input.source ?? 'worker-runtime.run',
      })
      await refreshWorkerContractMirror({
        workerInstanceId: thread?.workerInstanceId ?? null,
        source: input.source ?? 'worker-runtime.run',
      })
      if (thread?.workerInstanceId) {
        touchWorkerAgentContractHeartbeat(thread.workerInstanceId, {
          ...(finalResult.status === 'completed' ? { lastTaskCompletedAt: new Date().toISOString() } : {}),
          ...(finalResult.status === 'failed' ? { lastError: finalResult.message ?? 'WorkerRuntime failed.' } : {}),
          queueDepth: 0,
        })
      }

      return finalResult
    } finally {
      stopHeartbeat()
      this.runningControllers.delete(room.id)
      this.roomRuntimeKind.delete(room.id)
    }
  }

  async resumeTaskRoomAfterHumanAnswer(
    input: ResumeTaskRoomAfterHumanAnswerInput,
  ): Promise<ResumeTaskRoomAfterHumanAnswerResult> {
    const room = await roomService.getRoomForOwner(input.roomId, input.ownerId)
    if (room.kind !== 'task') {
      return {
        roomId: room.id,
        consumed: false,
        reason: 'Session room is not a task room.',
        resumed: false,
        appendedEventIds: [],
      }
    }

    const timeline = await roomService.listTimelineEvents({ roomId: room.id, limit: 500 })
    const humanEvent = timeline.find(
      (event) =>
        (input.sourceMessageId ? event.metadata?.messageId === input.sourceMessageId : false) ||
        (input.sourceEventId ? event.id === input.sourceEventId : false),
    )
    const humanSequence = humanEvent?.sequence ?? Number.MAX_SAFE_INTEGER
    const duplicateResume = timeline.find(
      (event) =>
        event.metadata?.kind === 'worker-runtime.resume-requested' &&
        ((input.sourceMessageId ? event.metadata?.sourceMessageId === input.sourceMessageId : false) ||
          (input.sourceEventId ? event.metadata?.sourceEventId === input.sourceEventId : false)),
    )
    if (duplicateResume) {
      return {
        roomId: room.id,
        consumed: true,
        reason: 'Human clarification answer was already recorded for resume.',
        resumed: true,
        appendedEventIds: [duplicateResume.id],
      }
    }

    const clarification = [...timeline]
      .reverse()
      .find(
        (event) =>
          event.sequence < humanSequence &&
          event.type === 'approval.requested' &&
          event.metadata?.kind === 'worker-runtime.clarification-requested',
      )
    if (!clarification) {
      return {
        roomId: room.id,
        consumed: false,
        reason: 'Task room has no pending Worker clarification request.',
        resumed: false,
        appendedEventIds: [],
      }
    }

    const laterWorkerResumeOrCompletion = timeline.find(
      (event) =>
        event.sequence > clarification.sequence &&
        event.sequence < humanSequence &&
        (event.metadata?.kind === 'worker-runtime.resume-requested' ||
          (event.metadata?.kind === 'worker-runtime.completed' &&
            event.metadata?.status === 'completed')),
    )
    if (laterWorkerResumeOrCompletion) {
      return {
        roomId: room.id,
        consumed: false,
        reason: 'A later Worker resume/completion already superseded the clarification.',
        resumed: false,
        appendedEventIds: [],
      }
    }

    const manager = await ensureManagerParticipantForRoom(room.id)
    const answer = input.answer.trim()
    const question =
      typeof clarification.metadata?.question === 'string'
        ? clarification.metadata.question
        : clarification.body
    const clarificationId =
      typeof clarification.metadata?.clarificationId === 'string'
        ? clarification.metadata.clarificationId
        : null
    const targetWorkerId =
      typeof clarification.metadata?.workspaceAgentId === 'string'
        ? clarification.metadata.workspaceAgentId
        : null
    const answeredClarification = await answerPendingTaskClarification({
      clarificationId,
      runId: room.runId,
      taskId: room.taskId,
      agentId: targetWorkerId,
      answer,
    })
    const resumePrompt = buildClarificationResumePrompt({
      timeline,
      clarificationQuestion: question,
      answer,
    })
    const resumeEvent = await roomService.appendTimelineEvent({
      roomId: room.id,
      senderParticipantId: manager.id,
      senderType: 'manager',
      type: 'task.progress',
      body: '已收到你的澄清，我会让当前 Worker 带着这条回答继续。',
      metadata: {
        kind: 'worker-runtime.resume-requested',
        clarificationId: answeredClarification?.id ?? clarificationId,
        sourceMessageId: input.sourceMessageId,
        sourceEventId: input.sourceEventId,
        clarificationEventId: clarification.id,
        question,
        answer,
        clarificationStatus: answeredClarification?.status ?? null,
      },
    })
    const appendedEventIds = [resumeEvent.id]

    const runResume = async () => {
      const workerInstanceId =
        typeof clarification.metadata?.workerInstanceId === 'string'
          ? clarification.metadata.workerInstanceId
          : null
      if (workerInstanceId) {
        await markWorkerInstanceState(workerInstanceId, 'resuming', {
          message: 'Worker resuming after human clarification.',
          health: {
            resumedAt: new Date().toISOString(),
            clarificationId: answeredClarification?.id ?? clarificationId,
          },
        })
      }
      // Look up the latest lease for this room to get the saved sessionId
      let resumeSessionId: string | undefined
      try {
        const [latestLease] = await db
          .select()
          .from(runtimeLeases)
          .where(
            room.taskId
              ? and(eq(runtimeLeases.taskId, room.taskId), eq(runtimeLeases.status, 'waiting_for_human'))
              : eq(runtimeLeases.runId, room.runId),
          )
          .orderBy(desc(runtimeLeases.updatedAt))
          .limit(1)
        const leaseMetadata = latestLease?.metadata as Record<string, unknown> | undefined
        if (typeof leaseMetadata?.sessionId === 'string') {
          resumeSessionId = leaseMetadata.sessionId
        }
      } catch {
        // Best-effort: resume without sessionId if lookup fails
      }
      try {
        const result = await this.runTaskRoom({
          roomId: room.id,
          ownerId: input.ownerId,
          runtime: input.runtime,
          prompt: resumePrompt,
          source: 'worker-runtime.resume',
          signal: input.signal,
          resumeSessionId,
          continueSession: Boolean(resumeSessionId),
        })
        appendedEventIds.push(...result.appendedEventIds)
      } catch (error: any) {
        const failed = await roomService.appendTimelineEvent({
          roomId: room.id,
          senderParticipantId: manager.id,
          senderType: 'manager',
          type: 'task.progress',
          body: `Worker 恢复执行失败：${error?.message || 'unknown error'}`,
          metadata: {
            kind: 'worker-runtime.resume-failed',
            sourceMessageId: input.sourceMessageId,
            sourceEventId: input.sourceEventId,
            clarificationEventId: clarification.id,
            error: error?.message || String(error),
          },
        })
        appendedEventIds.push(failed.id)
      }
    }

    if (input.runAfterResume === false) {
      return {
        roomId: room.id,
        consumed: true,
        reason: 'Human clarification answer recorded a WorkerRuntime resume request.',
        resumed: false,
        appendedEventIds,
      }
    }

    void runResume()

    return {
      roomId: room.id,
      consumed: true,
      reason: 'Human clarification answer resumed the task room WorkerRuntime.',
      resumed: true,
      appendedEventIds,
    }
  }

  async denyTaskRoomClarification(
    input: DenyTaskRoomClarificationInput,
  ): Promise<DenyTaskRoomClarificationResult> {
    const room = await roomService.getRoomForOwner(input.roomId, input.ownerId)
    if (room.kind !== 'task') {
      return {
        roomId: room.id,
        consumed: false,
        reason: 'Session room is not a task room.',
        denied: false,
        appendedEventIds: [],
      }
    }

    const timeline = await roomService.listTimelineEvents({ roomId: room.id, limit: 500 })
    const humanEvent = timeline.find(
      (event) =>
        (input.sourceMessageId ? event.metadata?.messageId === input.sourceMessageId : false) ||
        (input.sourceEventId ? event.id === input.sourceEventId : false),
    )
    const humanSequence = humanEvent?.sequence ?? Number.MAX_SAFE_INTEGER
    const duplicateDenial = timeline.find(
      (event) =>
        event.metadata?.kind === 'worker-runtime.clarification-denied' &&
        ((input.sourceMessageId ? event.metadata?.sourceMessageId === input.sourceMessageId : false) ||
          (input.sourceEventId ? event.metadata?.sourceEventId === input.sourceEventId : false)),
    )
    if (duplicateDenial) {
      return {
        roomId: room.id,
        consumed: true,
        reason: 'Human clarification denial was already recorded.',
        denied: true,
        appendedEventIds: [duplicateDenial.id],
      }
    }

    const clarification = [...timeline]
      .reverse()
      .find(
        (event) =>
          event.sequence < humanSequence &&
          event.type === 'approval.requested' &&
          event.metadata?.kind === 'worker-runtime.clarification-requested',
      )
    if (!clarification) {
      return {
        roomId: room.id,
        consumed: false,
        reason: 'Task room has no pending Worker clarification request.',
        denied: false,
        appendedEventIds: [],
      }
    }

    const laterDecisionOrCompletion = timeline.find(
      (event) =>
        event.sequence > clarification.sequence &&
        event.sequence < humanSequence &&
        (event.metadata?.kind === 'worker-runtime.resume-requested' ||
          event.metadata?.kind === 'worker-runtime.clarification-denied' ||
          (event.metadata?.kind === 'worker-runtime.completed' &&
            event.metadata?.status === 'completed')),
    )
    if (laterDecisionOrCompletion) {
      return {
        roomId: room.id,
        consumed: false,
        reason: 'A later Worker decision/completion already superseded the clarification.',
        denied: false,
        appendedEventIds: [],
      }
    }

    const manager = await ensureManagerParticipantForRoom(room.id)
    const denialReason = input.reason.trim() || '用户拒绝当前澄清请求。'
    const question =
      typeof clarification.metadata?.question === 'string'
        ? clarification.metadata.question
        : clarification.body
    const clarificationId =
      typeof clarification.metadata?.clarificationId === 'string'
        ? clarification.metadata.clarificationId
        : null
    const targetWorkerId =
      typeof clarification.metadata?.workspaceAgentId === 'string'
        ? clarification.metadata.workspaceAgentId
        : null
    const answeredClarification = await answerPendingTaskClarification({
      clarificationId,
      runId: room.runId,
      taskId: room.taskId,
      agentId: targetWorkerId,
      answer: `[DENIED] ${denialReason}`,
    })
    const deniedEvent = await roomService.appendTimelineEvent({
      roomId: room.id,
      senderParticipantId: manager.id,
      senderType: 'manager',
      type: 'task.progress',
      body: '已记录你的拒绝，当前 Worker 不会按该澄清继续；我会交给 Manager 判断后续是返工、取消还是重新分配。',
      metadata: {
        kind: 'worker-runtime.clarification-denied',
        status: 'denied',
        clarificationId: answeredClarification?.id ?? clarificationId,
        sourceMessageId: input.sourceMessageId,
        sourceEventId: input.sourceEventId,
        clarificationEventId: clarification.id,
        question,
        reason: denialReason,
        answer: `[DENIED] ${denialReason}`,
        clarificationStatus: answeredClarification?.status ?? null,
      },
    })

    return {
      roomId: room.id,
      consumed: true,
      reason: 'Human clarification denial was recorded for Manager review.',
      denied: true,
      appendedEventIds: [deniedEvent.id],
    }
  }

  async rerunTaskRoom(input: RerunTaskRoomInput): Promise<RunTaskRoomResult> {
    const result = await this.runTaskRoom({
      roomId: input.roomId,
      ownerId: input.ownerId,
      workspaceAgentId: input.workspaceAgentId,
      prompt: input.prompt,
      runtime: input.runtime,
      source: input.source ?? 'worker-runtime.rerun',
      signal: input.signal,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
    })
    return result
  }
}

async function findWorkerParticipant(roomId: string, workspaceAgentId?: string | null) {
  const rows = await db
    .select()
    .from(roomParticipants)
    .where(eq(roomParticipants.roomId, roomId))
  return (
    rows.find(
      (participant) =>
        participant.participantType === 'worker' &&
        (workspaceAgentId ? participant.workspaceAgentId === workspaceAgentId : true),
    ) ?? null
  )
}

async function appendWorkerRuntimeEvent(input: {
  roomId: string
  participantId: string
  workspaceId: string
  runId?: string | null
  taskId?: string | null
  taskThreadId?: string | null
  workspaceAgentId: string
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  runtimeType: string
  event: WorkerRuntimeEvent
}) {
  if (input.event.type === 'artifact') {
    const registeredArtifact =
      input.runId && input.taskId
        ? await registerTaskArtifact({
            workspaceId: input.workspaceId,
            runId: input.runId,
            taskId: input.taskId,
            roomId: input.roomId,
            taskThreadId: input.taskThreadId ?? null,
            workspaceAgentId: input.workspaceAgentId,
            workerInstanceId: input.workerInstanceId ?? null,
            artifact: input.event.artifact as unknown as Record<string, unknown>,
            status: input.event.status ?? 'registered',
          })
        : null
    const canonicalArtifact = registeredArtifact
      ? toCanonicalArtifactRecord(registeredArtifact)
      : input.event.artifact
    return roomService.appendTimelineEvent({
      roomId: input.roomId,
      senderParticipantId: input.participantId,
      senderType: 'worker',
      type: 'artifact.created',
      body: input.event.message ?? input.event.artifact.title,
      metadata: {
        kind: 'worker-runtime.artifact',
        artifactId: registeredArtifact?.id ?? input.event.artifact.id,
        status: input.event.status ?? registeredArtifact?.status ?? 'registered',
        workspaceAgentId: input.workspaceAgentId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeType: input.runtimeType,
        artifact: canonicalArtifact,
        ...(input.event.metadata ?? {}),
      },
    })
  }
  if (input.event.type === 'clarification') {
    const question = input.event.question ?? input.event.message
    const clarification = await createTaskClarification({
      runId: input.runId,
      taskId: input.taskId,
      agentId: input.workspaceAgentId,
      question,
      options: input.event.options ?? [],
    })
    await runtimeLeaseController.markWaitingForHuman(input.runtimeLeaseId, {
      workerInstanceId: input.workerInstanceId ?? null,
      message: question,
      metadata: {
        waitingForHuman: true,
        clarificationId: clarification?.id ?? null,
        question,
        roomId: input.roomId,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
      },
    })
    return roomService.appendTimelineEvent({
      roomId: input.roomId,
      senderParticipantId: input.participantId,
      senderType: 'worker',
      type: 'approval.requested',
      body: input.event.message,
      metadata: {
        kind: 'worker-runtime.clarification-requested',
        clarificationId: clarification?.id ?? null,
        workspaceAgentId: input.workspaceAgentId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        runtimeType: input.runtimeType,
        question,
        options: input.event.options ?? [],
        ...(input.event.metadata ?? {}),
      },
    })
  }
  if (input.event.type === 'message') {
    return roomService.appendTimelineEvent({
      roomId: input.roomId,
      senderParticipantId: input.participantId,
      senderType: 'worker',
      type: 'worker.message',
      body: input.event.message,
      metadata: {
        kind: 'worker-runtime.message',
        workspaceAgentId: input.workspaceAgentId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeType: input.runtimeType,
        hiddenFromChat: true,
        ...(input.event.metadata ?? {}),
      },
    })
  }
  return roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderParticipantId: input.participantId,
    senderType: 'worker',
    type: 'task.progress',
    body: input.event.message,
      metadata: {
        kind: input.event.type === 'failed' ? 'worker-runtime.failed' : 'worker-runtime.progress',
        workspaceAgentId: input.workspaceAgentId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeType: input.runtimeType,
        progressPercent: input.event.type === 'progress' ? input.event.progressPercent ?? null : null,
        hiddenFromChat: true,
        ...(input.event.metadata ?? {}),
      },
    })
}

const DEFAULT_WORKER_RUNTIME_HEARTBEAT_MS = 60_000

function startWorkerRuntimeHeartbeat(input: {
  roomId: string
  participantId: string
  workspaceAgentId: string
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  runId?: string | null
  taskId?: string | null
  taskThreadId?: string | null
  runtimeType: string
  intervalMs?: number
}) {
  const intervalMs = input.intervalMs ?? DEFAULT_WORKER_RUNTIME_HEARTBEAT_MS
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => {}
  }
  let stopped = false
  let heartbeatCount = 0
  const writeHeartbeat = async () => {
    if (stopped) return
    heartbeatCount += 1
    const now = new Date()
    await markWorkerInstanceState(input.workerInstanceId, 'busy', {
      message: 'WorkerRuntime heartbeat.',
      health: {
        roomId: input.roomId,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
        heartbeatAt: now.toISOString(),
        heartbeatCount,
      },
    })
    if (input.workerInstanceId) {
      touchWorkerAgentContractHeartbeat(input.workerInstanceId, {
        lastHeartbeatAt: now.toISOString(),
        queueDepth: 0,
      })
    }
    await roomService.appendTimelineEvent({
      roomId: input.roomId,
      senderParticipantId: input.participantId,
      senderType: 'worker',
      type: 'task.progress',
      body: 'WorkerRuntime heartbeat.',
      metadata: {
        kind: 'worker-runtime.heartbeat',
        status: 'running',
        heartbeatCount,
        heartbeatAt: now.toISOString(),
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
        taskThreadId: input.taskThreadId ?? null,
        workspaceAgentId: input.workspaceAgentId,
        workerInstanceId: input.workerInstanceId ?? null,
        runtimeLeaseId: input.runtimeLeaseId ?? null,
        runtimeType: input.runtimeType,
        hiddenFromChat: true,
      },
    })
  }
  const timer = setInterval(() => {
    writeHeartbeat().catch(() => {
      // Heartbeat is supervision metadata; task execution remains the source of truth.
    })
  }, intervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

function latestAssignedTaskPrompt(events: Array<{ type: string; body: string; metadata?: Record<string, unknown> | null }>) {
  const assigned = [...events].reverse().find((event) => event.type === 'task.assigned')
  const description = assigned?.metadata?.taskDescription
  if (typeof description === 'string' && description.trim()) return description.trim()
  if (assigned?.body.trim()) return assigned.body.trim()
  return null
}

function latestHumanMessageBody(events: Array<{ senderType: string; body: string }>): string | null {
  const human = [...events].reverse().find((event) => event.senderType === 'human')
  return human?.body.trim() || null
}

function buildClarificationResumePrompt(input: {
  timeline: Array<{ type: string; body: string; metadata?: Record<string, unknown> | null }>
  clarificationQuestion: string
  answer: string
}) {
  const assigned = [...input.timeline].reverse().find((event) => event.type === 'task.assigned')
  const taskDescription =
    typeof assigned?.metadata?.taskDescription === 'string' && assigned.metadata.taskDescription.trim()
      ? assigned.metadata.taskDescription.trim()
      : assigned?.body?.trim() || '继续当前任务。'
  return [
    taskDescription,
    '',
    '用户已经在任务房间回答了 Worker 的澄清问题。',
    `澄清问题：${input.clarificationQuestion}`,
    `用户回答：${input.answer}`,
    '',
    '请结合任务房间 timeline、已有部分产物和这条回答继续执行，并在完成后汇报结果和产物。',
  ].join('\n')
}

async function syncRunControllerAtTaskRoomStart(input: {
  roomId: string
  workspaceId: string
  runId?: string | null
  taskId?: string | null
  taskThreadId?: string | null
  groupSessionId?: string | null
  childSessionId?: string | null
  title: string
  agentId: string
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  runtimeType: string
  startedEventId: string
}) {
  if (!input.runId || !input.taskId || !input.groupSessionId) return
  await runController.markTaskActive(
    {
      runId: input.runId,
      workspaceId: input.workspaceId,
      groupSessionId: input.groupSessionId,
    },
    {
      taskId: input.taskId,
      title: input.title,
      agentId: input.agentId,
      childSessionId: input.childSessionId,
      taskThreadId: input.taskThreadId,
      workerInstanceId: input.workerInstanceId,
      runtimeLeaseId: input.runtimeLeaseId,
      progressPercent: 5,
      progressStatus: 'worker-runtime-started',
      extraPayload: {
        source: 'worker-runtime.started',
        taskRoomId: input.roomId,
        timelineEventId: input.startedEventId,
        runtimeType: input.runtimeType,
        coordinationSource: 'room-timeline',
      },
    },
  )
}

async function syncRunControllerAfterTaskRoomResult(input: {
  roomId: string
  ownerId: string
  result: RunTaskRoomResult
  source: string
}) {
  const room = await roomService.getRoomForOwner(input.roomId, input.ownerId)
  if (!room.runId || !room.workspaceId || !room.taskId) return
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, room.workspaceId)).limit(1)
  const [thread] = room.taskThreadId
    ? await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId)).limit(1)
    : []
  const [task] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, room.taskId)).limit(1)
  const [lease] = thread?.workerInstanceId
    ? await db
        .select()
        .from(runtimeLeases)
        .where(and(eq(runtimeLeases.workerInstanceId, thread.workerInstanceId), eq(runtimeLeases.taskId, room.taskId)))
        .limit(1)
      : await db.select().from(runtimeLeases).where(eq(runtimeLeases.taskId, room.taskId)).limit(1)
  await syncSharedTaskDirectoryStatus({
    roomId: room.id,
    projectPath: workspace?.projectPath ?? lease?.cwd ?? null,
    sharedTaskRelativeRoot: readString(room.metadata?.sharedTaskRelativeRoot) ?? ['.agenthub', 'shared', 'tasks', room.taskId].join('/'),
    taskId: room.taskId,
    status: sharedTaskStatusFromWorkerResult(input.result.status),
    workerInstanceId: thread?.workerInstanceId ?? null,
    runtimeLeaseId: lease?.id ?? null,
    messageId: input.result.appendedEventIds.at(-1) ?? null,
    error: input.result.status === 'failed' ? input.result.message ?? 'WorkerRuntime failed.' : null,
    summary: input.result.message ?? null,
    artifacts: artifactsForRunController(input.result.artifacts),
    executionConfig: {
      runtimeType: input.result.runtimeType,
      source: input.source,
      sessionId: input.result.sessionId ?? null,
    },
    timestamps: terminalSharedTaskTimestamps(input.result.status),
  })
  const run = {
    runId: room.runId,
    workspaceId: room.workspaceId,
    groupSessionId: thread?.groupSessionId ?? room.sessionId ?? room.id,
  }
  const base = {
    taskId: room.taskId,
    title: task?.title ?? room.title,
    agentId: task?.agentId ?? null,
    childSessionId: thread?.sessionId ?? room.sessionId ?? null,
    taskThreadId: thread?.id ?? room.taskThreadId ?? null,
    workerInstanceId: thread?.workerInstanceId ?? null,
    runtimeLeaseId: lease?.id ?? null,
    artifacts: artifactsForRunController(input.result.artifacts),
    extraPayload: {
      source: input.source,
      taskRoomId: room.id,
      timelineEventCount: input.result.appendedEventIds.length,
      message: input.result.message ?? null,
    },
  }

  if (input.result.status === 'completed') {
    await runController.markTaskCompleted(run, base)
    await runtimeLeaseController.release(lease?.id, {
      workerInstanceId: thread?.workerInstanceId ?? null,
      metadata: { resultStatus: input.result.status, source: input.source },
    })
    return
  }
  if (input.result.status === 'cancelled') {
    await runController.markTaskCancelled(run, {
      ...base,
      reason: input.result.message ?? 'worker-runtime-cancelled',
    })
    await runtimeLeaseController.release(lease?.id, {
      workerInstanceId: thread?.workerInstanceId ?? null,
      metadata: { resultStatus: input.result.status, source: input.source },
    })
    return
  }
  if (input.result.status === 'waiting_for_human') {
    const clarificationId =
      typeof input.result.metadata?.clarificationId === 'string'
        ? input.result.metadata.clarificationId
        : null
    const clarificationQuestion =
      typeof input.result.metadata?.clarificationQuestion === 'string'
        ? input.result.metadata.clarificationQuestion
        : input.result.message ?? null
    await runController.markTaskWaitingForHuman(run, {
      ...base,
      question: clarificationQuestion,
      clarificationId,
    })
    await runtimeLeaseController.markWaitingForHuman(lease?.id, {
      workerInstanceId: thread?.workerInstanceId ?? null,
      message: clarificationQuestion,
      metadata: {
        resultStatus: input.result.status,
        clarificationId,
        clarificationQuestion,
        taskRoomId: room.id,
        source: input.source,
      },
    })
    return
  }
  await runController.markTaskFailed(run, {
    ...base,
    error: input.result.message ?? 'WorkerRuntime failed.',
  })
  await runtimeLeaseController.fail(lease?.id, {
    workerInstanceId: thread?.workerInstanceId ?? null,
    error: input.result.message ?? 'WorkerRuntime failed.',
    metadata: { resultStatus: input.result.status, source: input.source },
  })
}

async function syncSharedTaskDirectoryStatus(input: Parameters<typeof updateSharedTaskDirectoryStatus>[0] & {
  roomId: string
}) {
  try {
    await updateSharedTaskDirectoryStatus(input)
  } catch (error: any) {
    logger.warn(
      {
        err: error?.message || String(error),
        roomId: input.roomId,
        taskId: input.taskId,
        sharedTaskRelativeRoot: input.sharedTaskRelativeRoot,
        status: input.status,
      },
      'Failed to update shared task directory status',
    )
  }
}

function sharedTaskStatusFromWorkerResult(
  status: WorkerRuntimeResult['status'],
): Parameters<typeof updateSharedTaskDirectoryStatus>[0]['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'waiting_for_human') return 'blocked'
  return 'failed'
}

function terminalSharedTaskTimestamps(status: WorkerRuntimeResult['status']) {
  const now = new Date().toISOString()
  if (status === 'completed') return { completedAt: now, updatedAt: now }
  if (status === 'cancelled') return { cancelledAt: now, updatedAt: now }
  if (status === 'failed') return { failedAt: now, updatedAt: now }
  return { updatedAt: now }
}

async function refreshWorkerContractMirror(input: {
  workerInstanceId: string | null
  source: string
}) {
  if (!input.workerInstanceId) return
  try {
    await ensureWorkerAgentContractFromController({
      workerInstanceId: input.workerInstanceId,
      controllerUrl: process.env.AGENTHUB_CONTAINER_CONTROLLER_URL || process.env.AGENTHUB_CONTROLLER_URL || null,
      sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
    })
  } catch (error: any) {
    logger.warn(
      {
        err: error?.message || String(error),
        workerInstanceId: input.workerInstanceId,
        source: input.source,
      },
      'Failed to refresh Worker contract mirror',
    )
  }
}

function artifactsForRunController(value: unknown) {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export const workerRuntimeService = new WorkerRuntimeService()
