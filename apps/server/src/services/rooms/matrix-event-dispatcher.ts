import {
  and,
  asc,
  db,
  desc,
  eq,
  matrixIdentities,
  orchestratorRuns,
  roomParticipants,
  rooms,
  runtimeLeases,
  sessions,
  taskThreads,
  timelineEvents,
  workerInstances,
  workspaceAgents,
  workspaceTasks,
} from '@agenthub/db'
import { getActiveManagerProvider, getManagerProvider, type ManagerRuntimeType } from '../manager-runtime'
import { resolveRoomManagerAgent } from './manager-participant'
import { logger } from '../../lib/logger'
import { registerTaskArtifact, toCanonicalArtifactRecord } from '../orchestrator/artifact-store'
import { runController } from '../orchestrator/run-controller'
import { runtimeLeaseController } from '../orchestrator/runtime-lease-controller'
import { markWorkerInstanceState } from '../orchestrator/worker-runtime-resources'
import { emitRunEvent } from '../orchestrator/run-events'
import { workerRuntimeService } from '../worker-runtime/worker-runtime-service'
import { blackboard, Blackboard } from '../blackboard'
import { createMatrixClientFromEnv } from './matrix-client'
import { roomService } from './room-service'

const MANAGER_SLOW_STATUS_MS = Number(process.env.AGENTHUB_MANAGER_SLOW_STATUS_MS || '60000')
const MANAGER_TIMEOUT_STATUS_MS = Number(process.env.AGENTHUB_MANAGER_TIMEOUT_STATUS_MS || '300000')

export interface MatrixRoomEventDispatcherInput {
  eventIds: string[]
}

export interface MatrixRoomEventDispatcherResult {
  dispatchedEventIds: string[]
  ignoredEventIds: string[]
}

export interface MatrixRoomEventDispatcherHandlers {
  stepManagerRoom(input: {
    roomId: string
    ownerId: string
    afterSequence: number
    source: string
  }): Promise<unknown>
  cancelTaskRoom?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    reason: string
  }): Promise<unknown>
  recordApprovalControl?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    command: 'approve' | 'deny'
    body: string
  }): Promise<unknown>
  resumeTaskRoomAfterApproval?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    answer: string
    runAfterResume?: boolean
  }): Promise<{ consumed: boolean; appendedEventIds: string[] } | unknown>
  resumeTaskRoomAfterHumanAnswer?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    answer: string
    runAfterResume?: boolean
  }): Promise<{ consumed: boolean; appendedEventIds: string[] } | unknown>
  denyTaskRoomClarification?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
    reason: string
  }): Promise<{ consumed: boolean; appendedEventIds: string[] } | unknown>
  registerFileArtifact?(input: {
    roomId: string
    ownerId: string
    sourceEventId: string
  }): Promise<unknown>
}

export class MatrixRoomEventDispatcher {
  private readonly handlers: MatrixRoomEventDispatcherHandlers

  constructor(handlers: Partial<MatrixRoomEventDispatcherHandlers> = {}) {
    this.handlers = {
      stepManagerRoom: async (input) => {
        // HiClaw model: Manager is always an external OpenClaw/QwenPaw process.
        // When resident Manager is active, it observes rooms via Matrix /sync autonomously.
        // When it is NOT active, we try to start it. We do NOT fall back to local LLM.
        const configuredManagerRuntime = await resolveManagerRuntimeTypeForRoom(input.roomId)
        const provider = configuredManagerRuntime
          ? getManagerProvider(configuredManagerRuntime)
          : getActiveManagerProvider()
        if (provider && (provider.runtimeType === 'openclaw' || provider.runtimeType === 'qwenpaw')) {
          const status = await provider.status()
          if (status.running && !status.error) {
            const roomBinding = await describeResidentManagerRoomBinding(input.roomId)
            if (!roomBinding.ready) {
              return {
                consumed: false,
                skipped: true,
                reason: roomBinding.reason,
                error: roomBinding.error,
                roomBinding,
              }
            }
            return { consumed: true, skipped: true, reason: 'resident-manager-active', roomBinding }
          }
          if (!status.endpoint && provider.ensureStarted) {
            try {
              const started = await provider.ensureStarted()
              if (started.running && !started.error) {
                return { consumed: false, skipped: true, reason: 'resident-manager-started' }
              }
              return {
                consumed: false,
                skipped: true,
                reason: 'resident-manager-start-failed',
                error: started.error || 'Manager runtime failed to start.',
              }
            } catch (error) {
              return {
                consumed: false,
                skipped: true,
                reason: 'resident-manager-start-failed',
                error: error instanceof Error ? error.message : String(error),
              }
            }
          }
          return {
            consumed: false,
            skipped: true,
            reason: status.error ? 'resident-manager-not-ready' : 'resident-manager-not-running',
            error:
              status.error ||
              'Manager runtime is not running. Install OpenClaw (bash infra/setup-openclaw.sh) or set AGENTHUB_OPENCLAW_MANAGER_ENDPOINT.',
          }
        }
        return { consumed: false, skipped: true, reason: 'no-resident-manager-provider' }
      },
      cancelTaskRoom: (input) => cancelTaskRoomFromMatrix(input),
      recordApprovalControl: (input) => recordApprovalControlFromMatrix(input),
      resumeTaskRoomAfterHumanAnswer: (input) =>
        workerRuntimeService.resumeTaskRoomAfterHumanAnswer({
          roomId: input.roomId,
          ownerId: input.ownerId,
          sourceEventId: input.sourceEventId,
          answer: input.answer,
          runAfterResume: input.runAfterResume,
        }),
      denyTaskRoomClarification: (input) =>
        workerRuntimeService.denyTaskRoomClarification({
          roomId: input.roomId,
          ownerId: input.ownerId,
          sourceEventId: input.sourceEventId,
          reason: input.reason,
        }),
      registerFileArtifact: (input) => registerMatrixFileArtifact(input),
      ...handlers,
    }
    this.handlers.resumeTaskRoomAfterApproval ??= this.handlers.resumeTaskRoomAfterHumanAnswer
  }

  async dispatchImportedEvents(input: MatrixRoomEventDispatcherInput): Promise<MatrixRoomEventDispatcherResult> {
    const dispatchedEventIds: string[] = []
    const ignoredEventIds: string[] = []
    for (const eventId of input.eventIds) {
      const dispatched = await this.dispatchImportedEvent(eventId)
      if (dispatched) dispatchedEventIds.push(eventId)
      else ignoredEventIds.push(eventId)
    }
    return { dispatchedEventIds, ignoredEventIds }
  }

  /**
   * Dispatch a single timeline event regardless of source.
   * This is the HiClaw-style entry point: after the platform writes a timeline
   * event (human message, worker protocol, @mention), it calls this method
   * to let the dispatcher route it to the appropriate handler.
   *
   * Unlike dispatchImportedEvent, this does NOT require metadata.kind === 'matrix.sync.imported'.
   */
  async dispatchTimelineEvent(eventId: string): Promise<boolean> {
    return this.dispatchAnyEvent(eventId)
  }

  private async dispatchImportedEvent(eventId: string) {
    const [event] = await db.select().from(timelineEvents).where(eq(timelineEvents.id, eventId)).limit(1)
    if (!event) return false
    const [room] = await db.select().from(rooms).where(eq(rooms.id, event.roomId)).limit(1)
    if (!room) return false
    const mentionedParticipantIds = matrixMentionedParticipantIds(event.metadata)

    // Imported-only filter: skip events that aren't from Matrix /sync and have no mentions
    if (event.metadata?.kind !== 'matrix.sync.imported' && mentionedParticipantIds.length === 0) {
      return false
    }

    return this.dispatchEventByType(event, room, mentionedParticipantIds)
  }

  /**
   * Core dispatch logic shared by both imported and platform-written events.
   */
  private async dispatchAnyEvent(eventId: string): Promise<boolean> {
    const [event] = await db.select().from(timelineEvents).where(eq(timelineEvents.id, eventId)).limit(1)
    if (!event) return false
    const [room] = await db.select().from(rooms).where(eq(rooms.id, event.roomId)).limit(1)
    if (!room) return false
    const mentionedParticipantIds = matrixMentionedParticipantIds(event.metadata)
    return this.dispatchEventByType(event, room, mentionedParticipantIds)
  }

  private async dispatchEventByType(
    event: typeof timelineEvents.$inferSelect,
    room: typeof rooms.$inferSelect,
    mentionedParticipantIds: string[],
  ): Promise<boolean> {
    if (event.metadata?.kind === 'matrix.sync.imported' && event.type === 'file.shared') {
      await this.handlers.registerFileArtifact?.({
        roomId: room.id,
        ownerId: room.ownerId,
        sourceEventId: event.id,
      })
      return true
    }

    // Check for Worker protocol messages (TASK_COMPLETED, BLOCKED, QUESTION, NO_REPLY)
    if (event.senderType === 'worker') {
      const { handleWorkerProtocolMessage } = await import('../worker-runtime/worker-result-listener')
      const handled = await handleWorkerProtocolMessage({
        roomId: room.id,
        roomKind: room.kind,
        body: event.body,
        senderParticipantId: event.senderParticipantId,
        senderType: event.senderType,
        eventId: event.id,
      })
      if (handled) return true
    }

    const command = parseMatrixControlCommand(event.body)
    if (command?.type === 'stop' && room.kind === 'task') {
      await this.handlers.cancelTaskRoom?.({
        roomId: room.id,
        ownerId: room.ownerId,
        sourceEventId: event.id,
        reason: command.reason || 'matrix_room_stop',
      })
      return true
    }
    if (command?.type === 'approve' || command?.type === 'deny') {
      if (command.type === 'approve' && room.kind === 'task') {
        const resumeResult = await this.handlers.resumeTaskRoomAfterApproval?.({
          roomId: room.id,
          ownerId: room.ownerId,
          sourceEventId: event.id,
          answer: command.reason || '批准继续。',
        })
        if (isConsumedResult(resumeResult)) return true
      }
      if (command.type === 'deny' && room.kind === 'task') {
        const denyResult = await this.handlers.denyTaskRoomClarification?.({
          roomId: room.id,
          ownerId: room.ownerId,
          sourceEventId: event.id,
          reason: command.reason || '用户拒绝当前澄清请求。',
        })
        if (isConsumedResult(denyResult)) return true
      }
      await this.handlers.recordApprovalControl?.({
        roomId: room.id,
        ownerId: room.ownerId,
        sourceEventId: event.id,
        command: command.type,
        body: event.body,
      })
      if (room.kind === 'group' || room.kind === 'manager_dm') {
        await this.handlers.stepManagerRoom({
          roomId: room.id,
          ownerId: room.ownerId,
          afterSequence: Math.max(0, event.sequence - 1),
          source: `matrix-human-${command.type}`,
        })
      }
      return true
    }

    if (event.senderType === 'human' && room.kind === 'task') {
      // Handle human interrupt for active run before resuming Worker
      if (room.workspaceId && room.runId) {
        const [thread] = room.taskThreadId
          ? await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId)).limit(1)
          : []
        const groupSessionId = thread?.groupSessionId ?? room.sessionId ?? room.id
        if (groupSessionId) {
          await this.maybeHandleHumanInterrupt({
            groupSessionId,
            workspaceId: room.workspaceId,
            ownerId: room.ownerId,
            content: event.body,
            eventId: event.id,
            source: {
              kind: 'task_thread',
              taskThreadId: room.taskThreadId ?? thread?.id ?? null,
              taskId: room.taskId ?? thread?.taskId ?? null,
              childSessionId: room.sessionId ?? null,
              workerInstanceId: thread?.workerInstanceId ?? null,
              workspaceAgentId: thread?.workspaceAgentId ?? null,
            },
          }).catch(() => {})
        }
      }
      const resumeResult = await this.handlers.resumeTaskRoomAfterHumanAnswer?.({
        roomId: room.id,
        ownerId: room.ownerId,
        sourceEventId: event.id,
        answer: event.body,
      })
      if (isConsumedResult(resumeResult)) return true
    }

    for (const participantId of mentionedParticipantIds) {
      const [participant] = await db
        .select()
        .from(roomParticipants)
        .where(eq(roomParticipants.id, participantId))
        .limit(1)
      if (!participant) continue
      if (participant.participantType === 'worker' && room.kind === 'task' && participant.workspaceAgentId) {
        const canClaim = await canWorkerClaimTask(participant.workerInstanceId)
        if (!canClaim) {
          await roomService.appendTimelineEvent({
            roomId: room.id,
            senderParticipantId: participant.id,
            senderType: 'worker',
            type: 'task.progress',
            body: '当前正忙，无法接单。',
            metadata: {
              kind: 'worker-runtime.busy',
              workspaceAgentId: participant.workspaceAgentId,
              workerInstanceId: participant.workerInstanceId,
            },
          })
          return true
        }

        // Worker claims the task: write "已接单" and update state
        await roomService.appendTimelineEvent({
          roomId: room.id,
          senderParticipantId: participant.id,
          senderType: 'worker',
          type: 'task.progress',
          body: '已接单，准备执行任务。',
          metadata: {
            kind: 'worker-runtime.claimed',
            workspaceAgentId: participant.workspaceAgentId,
            workerInstanceId: participant.workerInstanceId,
            sourceEventId: event.id,
          },
        })
        if (participant.workerInstanceId) {
          await markWorkerInstanceState(participant.workerInstanceId, 'assigned', {
            message: 'Worker claimed task from Matrix mention.',
            health: {
              claimedRoomId: room.id,
              claimedAt: new Date().toISOString(),
              sourceEventId: event.id,
            },
          })
        }

        // HiClaw model: Worker picks up @mention via its own /sync loop
        // (resident) or Matrix listener (ephemeral). No platform dispatch.
        return true
      }

      // Group room @Worker → forward to active task room if any (HiClaw model)
      if (participant.participantType === 'worker' && room.kind === 'group' && participant.workspaceAgentId) {
        const [activeThread] = participant.workerInstanceId
          ? await db
              .select()
              .from(taskThreads)
              .where(
                and(
                  eq(taskThreads.workerInstanceId, participant.workerInstanceId),
                  eq(taskThreads.status, 'active'),
                ),
              )
              .orderBy(desc(taskThreads.updatedAt))
              .limit(1)
          : []
        if (activeThread) {
          const [taskRoom] = await db
            .select()
            .from(rooms)
            .where(eq(rooms.taskThreadId, activeThread.id))
            .limit(1)
          if (taskRoom) {
            await roomService.appendTimelineEvent({
              roomId: taskRoom.id,
              senderType: 'human',
              type: 'human.message',
              body: event.body,
              metadata: {
                kind: 'chat.message.forwarded',
                sourceRoomId: room.id,
                sourceEventId: event.id,
                sourceParticipantId: event.senderParticipantId,
                note: `Forwarded from group room mention of ${participant.displayName}`,
              },
            })
          }
          return true
        }
        const runResult = await workerRuntimeService.runGroupMentionRoom({
          roomId: room.id,
          ownerId: room.ownerId,
          workspaceAgentId: participant.workspaceAgentId,
          sourceEventId: event.id,
          prompt: event.body,
        })
        if (runResult.appendedEventIds.length > 0 && participant.workerInstanceId && runResult.status === 'completed') {
          await markWorkerInstanceState(participant.workerInstanceId, 'idle', {
            message: 'Worker answered group room mention.',
            health: {
              roomId: room.id,
              sourceEventId: event.id,
              appendedEventIds: runResult.appendedEventIds,
            },
          })
        }
        return true
      }

      if (
        event.senderType === 'human' &&
        participant.participantType === 'manager' &&
        (room.kind === 'group' || room.kind === 'manager_dm')
      ) {
        const pendingEventId = await this.appendManagerPendingStatus(room, event, 'matrix-manager-mention')
        const managerResult = await this.handlers.stepManagerRoom({
          roomId: room.id,
          ownerId: room.ownerId,
          afterSequence: Math.max(0, event.sequence - 1),
          source: 'matrix-manager-mention',
        })
        this.scheduleManagerSlowStatus(room.id, event.id, pendingEventId, managerResult)
        await this.appendManagerDispatchDiagnostic(room, event, managerResult)
        return true
      }
    }

    // Human message in group room without a more specific @mention → Manager observes.
    if (event.senderType === 'human' && (room.kind === 'group' || room.kind === 'manager_dm')) {
      // Handle human interrupt for active run before stepping Manager
      if (room.workspaceId && room.sessionId) {
        await this.maybeHandleHumanInterrupt({
          groupSessionId: room.sessionId,
          workspaceId: room.workspaceId,
          ownerId: room.ownerId,
          content: event.body,
          eventId: event.id,
        }).catch(() => {})
      }
      const pendingEventId = await this.appendManagerPendingStatus(
        room,
        event,
        event.metadata?.kind === 'matrix.sync.imported' ? 'matrix-sync' : 'platform-timeline',
      )
      const managerResult = await this.handlers.stepManagerRoom({
        roomId: room.id,
        ownerId: room.ownerId,
        afterSequence: Math.max(0, event.sequence - 1),
        source: event.metadata?.kind === 'matrix.sync.imported' ? 'matrix-sync' : 'platform-timeline',
      })
      this.scheduleManagerSlowStatus(room.id, event.id, pendingEventId, managerResult)
      await this.appendManagerDispatchDiagnostic(room, event, managerResult)
      return true
    }

    // Direct room: Worker picks up human messages via its own /sync loop.
    // No platform dispatch needed — the Worker's OpenClaw process sees the message
    // and responds autonomously.

    return false
  }

  private async appendManagerPendingStatus(
    room: typeof rooms.$inferSelect,
    sourceEvent: typeof timelineEvents.$inferSelect,
    source: string,
  ) {
    if (sourceEvent.metadata?.kind === 'matrix.sync.imported' && sourceEvent.senderType !== 'human') return null
    const existing = await findManagerStatusEvent(room.id, sourceEvent.id, 'manager.status.pending')
    if (existing) return existing.id
    const managerParticipant = await findRoomManagerParticipant(room.id)
    const event = await roomService.appendTimelineEvent({
      roomId: room.id,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'manager.message',
      body: 'Manager 已收到，正在处理...',
      metadata: {
        kind: 'manager.status.pending',
        source,
        sourceEventId: sourceEvent.id,
        sourceEventSequence: sourceEvent.sequence,
        uiPresentation: 'room-status',
        hiddenFromChat: true,
        skipAutoDispatch: true,
      },
    })
    return event.id
  }

  private scheduleManagerSlowStatus(
    roomId: string,
    sourceEventId: string,
    pendingEventId: string | null,
    managerResult: unknown,
  ) {
    if (!pendingEventId || MANAGER_SLOW_STATUS_MS <= 0) return
    const consumed = Boolean(managerResult && typeof managerResult === 'object' && (managerResult as any).consumed === true)
    const reason = managerResult && typeof managerResult === 'object' ? String((managerResult as any).reason ?? '') : ''
    if (!consumed || reason !== 'resident-manager-active') return
    const slowTimer = setTimeout(() => {
      void appendManagerSlowOrTimeoutStatus({
        roomId,
        sourceEventId,
        statusKind: 'manager.status.slow',
        body: 'Manager 仍在处理，OpenClaw 队列或模型响应较慢。',
      })
    }, MANAGER_SLOW_STATUS_MS)
    ;(slowTimer as any).unref?.()
    if (MANAGER_TIMEOUT_STATUS_MS > MANAGER_SLOW_STATUS_MS) {
      const timeoutTimer = setTimeout(() => {
        void appendManagerSlowOrTimeoutStatus({
          roomId,
          sourceEventId,
          statusKind: 'manager.status.timeout',
          body: 'Manager 处理超时。请检查设置页的 OpenClaw Manager / Matrix / 模型状态。',
          includeDiagnostics: true,
        })
      }, MANAGER_TIMEOUT_STATUS_MS)
      ;(timeoutTimer as any).unref?.()
    }
  }

  private async appendManagerDispatchDiagnostic(
    room: typeof rooms.$inferSelect,
    sourceEvent: typeof timelineEvents.$inferSelect,
    result: unknown,
  ) {
    if (!result || typeof result !== 'object') return
    const payload = result as Record<string, unknown>
    const consumed = payload.consumed === true
    const error = typeof payload.error === 'string' ? payload.error : ''
    if (consumed && !error) return
    const reason = typeof payload.reason === 'string' ? payload.reason : 'manager-dispatch-not-consumed'
    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderParticipantId: null,
      senderType: 'system',
      type: 'system',
      body: managerDispatchDiagnosticBody(reason, error),
      metadata: {
        kind: 'manager.dispatch.diagnostic',
        reason,
        sourceEventId: sourceEvent.id,
        sourceEventSequence: sourceEvent.sequence,
        result: payload,
        hiddenFromChat: true,
        skipAutoDispatch: true,
        uiPresentation: 'room-status',
      },
    })
  }

  private async maybeHandleHumanInterrupt(params: {
    groupSessionId: string
    workspaceId: string
    ownerId: string
    content: string
    eventId: string
    source?: {
      kind: 'group' | 'task_thread'
      taskThreadId?: string | null
      taskId?: string | null
      childSessionId?: string | null
      workerInstanceId?: string | null
      workspaceAgentId?: string | null
    }
  }): Promise<boolean> {
    const activeRun = await this.findLatestInterruptibleRun(params.groupSessionId)
    if (!activeRun) return false

    const [orchestrator] = await db
      .select()
      .from(workspaceAgents)
      .where(and(eq(workspaceAgents.workspaceId, params.workspaceId), eq(workspaceAgents.roleType, 'orchestrator')))
      .orderBy(asc(workspaceAgents.orderIdx))
      .limit(1)
    if (!orchestrator) return false

    const source = params.source ?? { kind: 'group' as const }
    const namespace = Blackboard.namespace(params.workspaceId, activeRun.id)
    const interruptKey = `human_interrupts/room:${params.eventId}`
    const createdAt = new Date().toISOString()
    await blackboard.write({
      namespace,
      key: interruptKey,
      value: {
        kind: 'human_interrupt',
        source: source.kind,
        messageId: `room:${params.eventId}`,
        groupSessionId: params.groupSessionId,
        taskThreadId: source.taskThreadId ?? null,
        taskId: source.taskId ?? null,
        childSessionId: source.childSessionId ?? null,
        workerInstanceId: source.workerInstanceId ?? null,
        workspaceAgentId: source.workspaceAgentId ?? null,
        content: params.content,
        actorType: 'user',
        actorId: params.ownerId,
        acknowledgedBy: { agentId: orchestrator.id, agentName: orchestrator.name },
        createdAt,
      },
      agentId: orchestrator.id,
      taskId: source.taskId ?? undefined,
      tags: [
        'human-interrupt',
        'hitl',
        ...(source.kind === 'task_thread' ? ['task-thread'] : []),
      ],
    })

    await emitRunEvent({
      runId: activeRun.id,
      workspaceId: params.workspaceId,
      groupSessionId: params.groupSessionId,
      agentId: orchestrator.id,
      type: 'blackboard.written',
      payload: {
        key: interruptKey,
        version: 1,
        summary:
          source.kind === 'task_thread'
            ? 'Human provided an in-flight correction inside a TaskThread room.'
            : 'Human provided an in-flight correction for the current run.',
        source: 'human_interrupt',
        interruptSource: source.kind,
        taskThreadId: source.taskThreadId ?? null,
        childSessionId: source.childSessionId ?? null,
        taskId: source.taskId ?? null,
        taskTitle: 'Human interrupt',
        agentName: orchestrator.name,
        contentPreview: params.content.slice(0, 200),
      },
    })

    await runController.recordDecision(
      {
        runId: activeRun.id,
        workspaceId: params.workspaceId,
        groupSessionId: params.groupSessionId,
        actor: { id: orchestrator.id, name: orchestrator.name },
      },
      {
        action: 'human_interrupt_received',
        reason: 'A human participant added or corrected requirements while the run is active.',
        message:
          source.kind === 'task_thread'
            ? `Merged a TaskThread human instruction into the active run: ${params.content.slice(0, 160)}`
            : `Merged a new human instruction into the active run: ${params.content.slice(0, 160)}`,
      },
    )

    await runController.reconcile({
      runId: activeRun.id,
      workspaceId: params.workspaceId,
      groupSessionId: params.groupSessionId,
      actor: { id: orchestrator.id, name: orchestrator.name },
    })

    return true
  }

  private async findLatestInterruptibleRun(groupSessionId: string) {
    const runs = await db
      .select()
      .from(orchestratorRuns)
      .where(eq(orchestratorRuns.groupSessionId, groupSessionId))
      .orderBy(desc(orchestratorRuns.updatedAt), desc(orchestratorRuns.createdAt))
      .limit(20)
    const INTERRUPTIBLE_RUN_STATUSES = new Set(['planning', 'running', 'synthesizing'])
    return runs.find((run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status)) ?? null
  }
}

function parseMatrixControlCommand(body: string | null | undefined) {
  const trimmed = body?.trim() ?? ''
  const match = trimmed.match(/^\/([a-zA-Z-]+)(?:\s+([\s\S]*))?$/)
  if (!match?.[1]) return null
  const command = match[1].toLowerCase()
  const rest = match[2]?.trim() ?? ''
  if (command === 'stop' || command === 'cancel') return { type: 'stop' as const, reason: rest }
  if (command === 'approve' || command === 'ok' || command === 'yes') return { type: 'approve' as const, reason: rest }
  if (command === 'deny' || command === 'reject' || command === 'no') return { type: 'deny' as const, reason: rest }
  return null
}

async function resolveManagerRuntimeTypeForRoom(roomId: string): Promise<ManagerRuntimeType | null> {
  const managerAgent = await resolveRoomManagerAgent(roomId)
  const roleProfile = managerAgent?.roleProfile
  if (!roleProfile || typeof roleProfile !== 'object') return null
  const value = (roleProfile as Record<string, unknown>).managerRuntimeType
  return value === 'openclaw' || value === 'qwenpaw' ? value : null
}

function managerDispatchDiagnosticBody(reason: string, error: string) {
  if (reason === 'resident-manager-started') {
    return 'Manager 正在启动，已接管到房间后会自动回复。'
  }
  if (reason === 'resident-manager-start-failed') {
    return error || 'Manager 启动失败，请在设置页检查 OpenClaw / QwenPaw 状态。'
  }
  if (reason === 'resident-manager-not-running') {
    return 'Manager 当前未在线。请在设置页启动 OpenClaw / QwenPaw Manager 后再由 Manager 接管群聊。'
  }
  if (reason === 'resident-manager-not-ready') {
    return 'Manager Runtime 尚未就绪。请检查设置页的 Manager Runtime / Matrix 状态。'
  }
  if (reason === 'resident-manager-room-not-bound') {
    return error || 'Manager Runtime 正在运行，但当前房间没有绑定到同一个 Matrix Manager 身份。请重启 OpenClaw Manager 或重新打开群聊。'
  }
  if (reason === 'resident-manager-room-not-joined') {
    return error || 'Manager Runtime 正在运行，但还没有加入当前 Matrix 房间。请重启 OpenClaw Manager 或在设置页重新准备 Matrix。'
  }
  if (reason === 'no-resident-manager-provider') {
    return '尚未配置可接管群聊的 Manager Runtime。'
  }
  return error || 'Manager runtime 没有接住这条消息，请检查设置页的 Manager Runtime / Matrix 状态。'
}

async function describeResidentManagerRoomBinding(roomId: string) {
  const [managerIdentity] = await db
    .select()
    .from(matrixIdentities)
    .where(and(eq(matrixIdentities.ownerType, 'manager'), eq(matrixIdentities.ownerId, 'manager')))
    .limit(1)
  if (!managerIdentity?.userId) {
    return {
      ready: false,
      reason: 'resident-manager-room-not-bound',
      error: 'OpenClaw Manager identity is missing. Start Manager from Settings to create its Matrix account.',
    }
  }
  const [participant] = await db
    .select()
    .from(roomParticipants)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantType, 'manager')))
    .limit(1)
  if (!participant) {
    return {
      ready: false,
      reason: 'resident-manager-room-not-bound',
      error: `Current room has no Manager participant bound to ${managerIdentity.userId}.`,
      managerUserId: managerIdentity.userId,
    }
  }
  if (participant.providerUserId !== managerIdentity.userId) {
    return {
      ready: false,
      reason: 'resident-manager-room-not-bound',
      error: `Current room Manager is ${participant.providerUserId || 'unbound'}, but resident OpenClaw Manager is ${managerIdentity.userId}. Reconcile the room or restart Manager.`,
      managerUserId: managerIdentity.userId,
      participantUserId: participant.providerUserId,
      participantId: participant.id,
    }
  }
  if (participant.status !== 'joined') {
    return {
      ready: false,
      reason: 'resident-manager-room-not-joined',
      error: `Resident OpenClaw Manager (${managerIdentity.userId}) is not joined to this room yet.`,
      managerUserId: managerIdentity.userId,
      participantStatus: participant.status,
      participantId: participant.id,
    }
  }
  return {
    ready: true,
    reason: 'resident-manager-room-bound',
    managerUserId: managerIdentity.userId,
    participantId: participant.id,
  }
}

async function appendManagerSlowOrTimeoutStatus(input: {
  roomId: string
  sourceEventId: string
  statusKind: 'manager.status.slow' | 'manager.status.timeout'
  body: string
  includeDiagnostics?: boolean
}) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
  if (!room) return null
  const sourceEvent = await findTimelineEvent(input.sourceEventId)
  if (!sourceEvent || sourceEvent.roomId !== input.roomId) return null
  if (await hasManagerReplyAfterSource(input.roomId, sourceEvent.sequence)) return null
  const existing = await findManagerStatusEvent(input.roomId, input.sourceEventId, input.statusKind)
  if (existing) return existing
  const managerParticipant = await findRoomManagerParticipant(input.roomId)
  const diagnostics = input.includeDiagnostics ? await managerStatusDiagnostics(input.roomId) : null
  return roomService.appendTimelineEvent({
    roomId: input.roomId,
    senderParticipantId: managerParticipant?.id ?? null,
    senderType: 'manager',
    type: 'manager.message',
    body: input.body,
    metadata: {
      kind: input.statusKind,
      sourceEventId: input.sourceEventId,
      sourceEventSequence: sourceEvent.sequence,
      uiPresentation: 'room-status',
      hiddenFromChat: true,
      diagnostics,
      skipAutoDispatch: true,
    },
  })
}

async function findManagerStatusEvent(roomId: string, sourceEventId: string, kind: string) {
  const recent = await db
    .select()
    .from(timelineEvents)
    .where(and(eq(timelineEvents.roomId, roomId), eq(timelineEvents.senderType, 'manager'), eq(timelineEvents.type, 'manager.message')))
    .orderBy(desc(timelineEvents.sequence))
    .limit(30)
  return recent.find((event) => event.metadata?.kind === kind && event.metadata?.sourceEventId === sourceEventId) ?? null
}

async function findTimelineEvent(eventId: string) {
  const [event] = await db.select().from(timelineEvents).where(eq(timelineEvents.id, eventId)).limit(1)
  return event ?? null
}

async function findRoomManagerParticipant(roomId: string) {
  const [participant] = await db
    .select()
    .from(roomParticipants)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.participantType, 'manager')))
    .limit(1)
  return participant ?? null
}

async function hasManagerReplyAfterSource(roomId: string, sourceSequence: number) {
  const recent = await db
    .select()
    .from(timelineEvents)
    .where(and(eq(timelineEvents.roomId, roomId), eq(timelineEvents.senderType, 'manager'), eq(timelineEvents.type, 'manager.message')))
    .orderBy(desc(timelineEvents.sequence))
    .limit(30)
  return recent.some((event) => {
    if (event.sequence <= sourceSequence) return false
    const kind = typeof event.metadata?.kind === 'string' ? event.metadata.kind : ''
    if (kind.startsWith('manager.status.')) return false
    if (kind === 'manager.dispatch.diagnostic') return false
    return Boolean(event.body?.trim())
  })
}

async function managerStatusDiagnostics(roomId: string) {
  const provider = getActiveManagerProvider()
  const status = provider ? await provider.status().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })) : null
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1)
  const binding = await describeResidentManagerRoomBinding(roomId).catch((error) => ({
    ready: false,
    reason: 'resident-manager-binding-check-failed',
    error: error instanceof Error ? error.message : String(error),
  }))
  return {
    roomId,
    providerRoomId: room?.providerRoomId ?? null,
    managerRuntime: status,
    roomBinding: binding,
    sessionKey: room?.providerRoomId ? `agenthub:manager:room:${room.providerRoomId}` : null,
  }
}

function isConsumedResult(result: unknown): result is { consumed: boolean } {
  return Boolean(result && typeof result === 'object' && 'consumed' in result && (result as any).consumed === true)
}

async function cancelTaskRoomFromMatrix(input: {
  roomId: string
  ownerId: string
  sourceEventId: string
  reason: string
}) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
  if (!room || room.ownerId !== input.ownerId || room.kind !== 'task') return null
  if (!room.runId || !room.workspaceId || !room.taskId) {
    return roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'system',
      type: 'system',
      body: '收到 /stop，但这个任务房间缺少 run/task 绑定，无法取消执行。',
      metadata: {
        kind: 'matrix.control.stop.failed',
        sourceEventId: input.sourceEventId,
        reason: 'room_missing_run_task_binding',
      },
    })
  }
  const [thread] = room.taskThreadId
    ? await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId)).limit(1)
    : await db
        .select()
        .from(taskThreads)
        .where(and(eq(taskThreads.runId, room.runId), eq(taskThreads.taskId, room.taskId)))
        .limit(1)
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

  const stopped = await workerRuntimeService.stopTaskRoom(room.id)
  if (stopped) {
    await roomService.appendTimelineEvent({
      roomId: room.id,
      senderType: 'system',
      type: 'task.progress',
      body: '已终止正在运行的 Worker 进程。',
      metadata: {
        kind: 'matrix.control.stop.process-terminated',
        sourceEventId: input.sourceEventId,
      },
    })
  }

  await runController.markTaskCancelled(run, {
    taskId: room.taskId,
    title: task?.title ?? room.title,
    agentId: task?.agentId ?? thread?.workspaceAgentId ?? null,
    reason: input.reason || 'matrix_room_stop',
    progressStatus: 'cancelled-by-matrix-stop',
    childSessionId: thread?.sessionId ?? room.sessionId ?? null,
    taskThreadId: thread?.id ?? room.taskThreadId ?? null,
    workerInstanceId: thread?.workerInstanceId ?? null,
    runtimeLeaseId: lease?.id ?? null,
    extraPayload: {
      source: 'matrix-room-control',
      sourceEventId: input.sourceEventId,
    },
  })
  await runtimeLeaseController.release(lease?.id, {
    workerInstanceId: thread?.workerInstanceId ?? null,
    metadata: {
      resultStatus: 'cancelled',
      source: 'matrix-room-control',
      sourceEventId: input.sourceEventId,
    },
  })
  return roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'system',
    type: 'task.progress',
    body: '已收到 /stop，当前任务已取消。',
    metadata: {
      kind: 'matrix.control.stop.applied',
      status: 'cancelled',
      sourceEventId: input.sourceEventId,
      runId: room.runId,
      taskId: room.taskId,
      taskThreadId: thread?.id ?? room.taskThreadId ?? null,
      runtimeLeaseId: lease?.id ?? null,
    },
  })
}

async function recordApprovalControlFromMatrix(input: {
  roomId: string
  ownerId: string
  sourceEventId: string
  command: 'approve' | 'deny'
  body: string
}) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
  if (!room || room.ownerId !== input.ownerId) return null
  return roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'system',
    type: 'system',
    body: input.command === 'approve' ? '已记录人工确认。' : '已记录人工拒绝。',
    metadata: {
      kind: 'matrix.control.approval',
      command: input.command,
      sourceEventId: input.sourceEventId,
      body: input.body,
      roomKind: room.kind,
    },
  })
}

async function registerMatrixFileArtifact(input: {
  roomId: string
  ownerId: string
  sourceEventId: string
}) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1)
  if (!room || room.ownerId !== input.ownerId) return null
  if (!room.workspaceId || !room.runId || !room.taskId) return null
  const [event] = await db.select().from(timelineEvents).where(eq(timelineEvents.id, input.sourceEventId)).limit(1)
  const file = matrixFileRef(event?.metadata)
  if (!file) return null
  const [thread] = room.taskThreadId
    ? await db.select().from(taskThreads).where(eq(taskThreads.id, room.taskThreadId)).limit(1)
    : []
  const materialized = await materializeMatrixFileArtifact({
    roomId: room.id,
    sourceEventId: input.sourceEventId,
    file,
    senderParticipantId: event?.senderParticipantId ?? null,
  })
  const artifact = await registerTaskArtifact({
    workspaceId: room.workspaceId,
    runId: room.runId,
    taskId: room.taskId,
    roomId: room.id,
    taskThreadId: thread?.id ?? room.taskThreadId ?? null,
    workspaceAgentId: thread?.workspaceAgentId ?? null,
    workerInstanceId: thread?.workerInstanceId ?? null,
    artifact: {
      kind: 'file',
      title: file.name ?? 'Matrix shared file',
      path: file.name ?? `matrix-file-${input.sourceEventId}.json`,
      mimeType: materialized.mimeType ?? file.info?.mimetype,
      size: materialized.size ?? file.info?.size,
      bytes: materialized.bytes,
      content: materialized.content,
      matrixFile: file,
      sourceEventId: input.sourceEventId,
      matrixDownload: materialized.metadata,
    },
    status: materialized.status,
  })
  if (!artifact) return null
  return roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'system',
    type: 'artifact.created',
    body: materialized.status === 'registered'
      ? `已从 Matrix 下载并登记共享文件：${artifact.title}`
      : `已登记 Matrix 文件引用，但下载原始文件失败：${artifact.title}`,
    metadata: {
      kind: 'matrix.file.artifact-registered',
      sourceEventId: input.sourceEventId,
      artifactId: artifact.id,
      artifact: toCanonicalArtifactRecord(artifact),
      matrixDownload: materialized.metadata,
    },
  })
}

async function materializeMatrixFileArtifact(input: {
  roomId: string
  sourceEventId: string
  file: MatrixFileRef
  senderParticipantId?: string | null
}): Promise<{
  status: 'registered' | 'partial'
  bytes?: Uint8Array
  content?: string
  mimeType?: string | null
  size?: number | null
  metadata: Record<string, unknown>
}> {
  if (!input.file.url?.startsWith('mxc://')) {
    return descriptorMatrixFileArtifact(input.file, input.sourceEventId, {
      reason: 'not_mxc_uri',
    })
  }

  try {
    const client = createMatrixClientFromEnv()
    const accessToken = await resolveMatrixMediaAccessToken(input.roomId, input.senderParticipantId)
    const downloaded = await client.downloadMedia(
      {
        mxcUrl: input.file.url,
        fileName: input.file.name,
      },
      { accessToken },
    )
    return {
      status: 'registered',
      bytes: downloaded.bytes,
      mimeType: downloaded.contentType ?? input.file.info?.mimetype ?? null,
      size: downloaded.bytes.byteLength,
      metadata: {
        source: 'matrix-media-download',
        downloaded: true,
        endpoint: downloaded.endpoint,
        contentType: downloaded.contentType,
        contentDisposition: downloaded.contentDisposition,
        fileName: downloaded.fileName ?? input.file.name ?? null,
        usedParticipantToken: Boolean(accessToken),
      },
    }
  } catch (error) {
    return descriptorMatrixFileArtifact(input.file, input.sourceEventId, {
      reason: 'download_failed',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function descriptorMatrixFileArtifact(
  file: MatrixFileRef,
  sourceEventId: string,
  extra: Record<string, unknown>,
) {
  return {
    status: 'partial' as const,
    content: JSON.stringify({
      source: 'matrix-file-ref',
      matrix: file,
      sourceEventId,
      ...extra,
    }, null, 2),
    mimeType: 'application/json',
    size: undefined,
    metadata: {
      source: 'matrix-file-ref',
      downloaded: false,
      ...extra,
    },
  }
}

async function resolveMatrixMediaAccessToken(roomId: string, preferredParticipantId?: string | null) {
  const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))
  const preferred = preferredParticipantId
    ? participants.find((participant) => participant.id === preferredParticipantId)
    : null
  for (const participant of [preferred, ...participants]) {
    const userId = participant?.providerUserId
    if (!userId) continue
    const [identity] = await db
      .select()
      .from(matrixIdentities)
      .where(eq(matrixIdentities.userId, userId))
      .limit(1)
    if (identity?.accessToken) return identity.accessToken
  }
  return null
}

type MatrixFileRef = NonNullable<ReturnType<typeof matrixFileRef>>

function matrixFileRef(metadata: Record<string, unknown> | null | undefined) {
  const matrix = metadata?.matrix
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return null
  const file = (matrix as Record<string, unknown>).file
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null
  const record = file as Record<string, unknown>
  const info = record.info && typeof record.info === 'object' && !Array.isArray(record.info)
    ? record.info as Record<string, unknown>
    : null
  return {
    msgtype: typeof record.msgtype === 'string' ? record.msgtype : null,
    name: typeof record.name === 'string' ? record.name : null,
    url: typeof record.url === 'string' ? record.url : null,
    info: info
      ? {
          mimetype: typeof info.mimetype === 'string' ? info.mimetype : undefined,
          size: typeof info.size === 'number' ? info.size : undefined,
        }
      : null,
  }
}

async function canWorkerClaimTask(workerInstanceId: string | null | undefined): Promise<boolean> {
  if (!workerInstanceId) return false
  const [worker] = await db
    .select()
    .from(workerInstances)
    .where(eq(workerInstances.id, workerInstanceId))
    .limit(1)
  if (!worker) return false
  const claimableStates = ['listening', 'idle', 'ready']
  return claimableStates.includes(worker.observedState)
}

async function isResidentWorker(workerInstanceId: string): Promise<boolean> {
  const [worker] = await db
    .select({ runtimeBase: workerInstances.runtimeBase })
    .from(workerInstances)
    .where(eq(workerInstances.id, workerInstanceId))
    .limit(1)
  return worker?.runtimeBase === 'openclaw' || worker?.runtimeBase === 'copaw' || worker?.runtimeBase === 'qwenpaw'
}

function matrixMentionedParticipantIds(metadata: Record<string, unknown> | null | undefined) {
  const matrix = metadata?.matrix
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) return []
  const ids = (matrix as Record<string, unknown>).mentionedParticipantIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
}

export const matrixRoomEventDispatcher = new MatrixRoomEventDispatcher()
