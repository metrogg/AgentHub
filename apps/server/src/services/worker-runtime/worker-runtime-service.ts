import {
  and,
  db,
  eq,
  roomParticipants,
  rooms,
  runtimeLeases,
  taskThreads,
  workspaceTasks,
  workspaceAgents,
  workspaces,
} from '@agenthub/db'
import { AppError, AppErrorCodes } from '../../lib/error'
import { registerTaskArtifact, toCanonicalArtifactRecord } from '../orchestrator/artifact-store'
import { runController } from '../orchestrator/run-controller'
import {
  failRuntimeLease,
  markRuntimeLeaseRunning,
  markRuntimeLeaseWaitingForHuman,
  markWorkerInstanceState,
  releaseRuntimeLease,
} from '../orchestrator/worker-runtime-resources'
import { roomService } from '../rooms'
import { LocalWorkerRuntimeAdapter } from './local-worker-runtime'
import { answerPendingTaskClarification, createTaskClarification } from './task-clarification-store'
import type { WorkerRuntime, WorkerRuntimeEvent, WorkerRuntimeResult } from './types'

export interface RunTaskRoomInput {
  roomId: string
  ownerId: string
  workspaceAgentId?: string | null
  prompt?: string | null
  runtime?: WorkerRuntime
  source?: string
  signal?: AbortSignal
  heartbeatIntervalMs?: number
}

export interface RunTaskRoomResult extends WorkerRuntimeResult {
  roomId: string
  workerParticipantId: string
  appendedEventIds: string[]
}

export interface ResumeTaskRoomAfterHumanAnswerInput {
  roomId: string
  ownerId: string
  sourceMessageId: string
  answer: string
  runtime?: WorkerRuntime
  executeInline?: boolean
  signal?: AbortSignal
}

export interface ResumeTaskRoomAfterHumanAnswerResult {
  roomId: string
  consumed: boolean
  reason: string
  resumed: boolean
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

export class WorkerRuntimeService {
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
    const prompt =
      input.prompt?.trim() ||
      latestAssignedTaskPrompt(timeline) ||
      room.topic ||
      room.title
    const runtime = input.runtime ?? new LocalWorkerRuntimeAdapter(agent)
    const appendedEventIds: string[] = []
    await markRuntimeLeaseRunning(lease?.id, {
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

    try {
      const iterator = runtime.executeTask(
        {
          roomId: room.id,
          sessionId: room.sessionId ?? thread?.sessionId ?? room.id,
          workspaceId: room.workspaceId ?? agent.workspaceId,
          workspaceAgentId: agent.id,
          workerInstanceId: thread?.workerInstanceId ?? null,
          taskId: room.taskId,
          taskThreadId: room.taskThreadId,
          runId: room.runId,
          prompt,
          history: timeline.map((event) => ({
            senderType: event.senderType,
            type: event.type,
            body: event.body,
          })),
          workspacePath: lease?.cwd ?? workspace?.projectPath ?? null,
        },
        input.signal,
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

      await syncRunControllerAfterTaskRoomResult({
        roomId: room.id,
        ownerId: input.ownerId,
        result: finalResult,
        source: input.source ?? 'worker-runtime.run',
      })

      return finalResult
    } finally {
      stopHeartbeat()
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
    const humanEvent = timeline.find((event) => event.metadata?.messageId === input.sourceMessageId)
    const humanSequence = humanEvent?.sequence ?? Number.MAX_SAFE_INTEGER
    const duplicateResume = timeline.find(
      (event) =>
        event.metadata?.kind === 'worker-runtime.resume-requested' &&
        event.metadata?.sourceMessageId === input.sourceMessageId,
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

    const manager = await ensureManagerParticipant(room.id)
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
        clarificationEventId: clarification.id,
        question,
        answer,
        clarificationStatus: answeredClarification?.status ?? null,
        executeInline: input.executeInline ?? false,
      },
    })
    const appendedEventIds = [resumeEvent.id]

    const runResume = async () => {
      try {
        const result = await this.runTaskRoom({
          roomId: room.id,
          ownerId: input.ownerId,
          runtime: input.runtime,
          prompt: resumePrompt,
          source: 'worker-runtime.resume',
          signal: input.signal,
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
            clarificationEventId: clarification.id,
            error: error?.message || String(error),
          },
        })
        appendedEventIds.push(failed.id)
      }
    }

    if (input.executeInline) {
      await runResume()
    } else {
      void runResume()
    }

    return {
      roomId: room.id,
      consumed: true,
      reason: 'Human clarification answer resumed the task room WorkerRuntime.',
      resumed: true,
      appendedEventIds,
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
    await markRuntimeLeaseWaitingForHuman(input.runtimeLeaseId, {
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

async function ensureManagerParticipant(roomId: string) {
  const participants = await db
    .select()
    .from(roomParticipants)
    .where(eq(roomParticipants.roomId, roomId))
  const existing = participants.find((participant) => participant.participantType === 'manager')
  if (existing) return existing
  return roomService.addParticipant({
    roomId,
    participantType: 'manager',
    displayName: 'Manager',
    role: 'manager',
  })
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
    await releaseRuntimeLease(lease?.id, {
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
    await releaseRuntimeLease(lease?.id, {
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
    await markRuntimeLeaseWaitingForHuman(lease?.id, {
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
  await failRuntimeLease(lease?.id, {
    workerInstanceId: thread?.workerInstanceId ?? null,
    error: input.result.message ?? 'WorkerRuntime failed.',
    metadata: { resultStatus: input.result.status, source: input.source },
  })
}

function artifactsForRunController(value: unknown) {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
}

export const workerRuntimeService = new WorkerRuntimeService()
