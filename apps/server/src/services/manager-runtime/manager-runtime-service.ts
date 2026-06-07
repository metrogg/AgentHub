import { db, eq, roomParticipants, rooms, workspaceAgents } from '@agenthub/db'
import { roomService } from '../rooms'
import { ensureManagerParticipantForRoom, resolveRoomManagerAgent } from '../rooms/manager-participant'
import { getActiveManagerProvider, getManagerProvider } from './manager-runtime-registry'
import { controllerApi } from '../controller-plane'
import { memberProposalsFromManagerAction } from './member-proposals'
import type {
  ManagerAction,
  ManagerActionType,
  ManagerObservedEvent,
  ManagerRuntime,
  ManagerRuntimeEvent,
  ManagerRuntimeType,
  ManagerStepResult,
  ManagerWorkerCandidate,
} from './types'

export interface StepManagerRoomInput {
  roomId: string
  ownerId: string
  runtime?: ManagerRuntime
  afterSequence?: number
  limit?: number
  source: string
  allowedActionTypes?: ManagerActionType[]
  appendActions?: boolean
  runState?: import('./types').ManagerRunState
  signal?: AbortSignal
}

export interface StepManagerRoomResult {
  roomId: string
  runtimeType: ManagerRuntimeType
  actions: ManagerAction[]
  rawActions: ManagerAction[]
  rawOutput?: string
  appendedEventIds: string[]
}

const SUPPORTED_ACTION_TYPES = new Set<ManagerActionType>([
  'reply',
  'clarify',
  'propose_members',
  'assign',
  'wait',
  'create_worker',
  'cancel_task',
  'rework',
])

export class ManagerRuntimeService {
  constructor(private readonly runtimeResolver: ManagerRuntime | (() => ManagerRuntime) = createDefaultManagerRuntime) {}

  private get defaultRuntime(): ManagerRuntime {
    return typeof this.runtimeResolver === 'function'
      ? this.runtimeResolver()
      : this.runtimeResolver
  }

  async stepRoom(input: StepManagerRoomInput): Promise<StepManagerRoomResult> {
    const room = await roomService.getRoomForOwner(input.roomId, input.ownerId)
    const timelineRows = await roomService.listTimelineEvents({
      roomId: room.id,
      afterSequence: input.afterSequence,
      limit: input.limit ?? 100,
    })
    const runtime = input.runtime ?? this.defaultRuntime
    const roomRuntime = input.runtime ? runtime : await resolveManagerRuntimeForRoom(room.id)
    const activeRuntime = roomRuntime ?? runtime
    const workers = await listRoomWorkerCandidates(room.id)
    const appendedEventIds: string[] = []
    let sawVisibleRoomMessage = false

    let step: ManagerStepResult
    try {
      step = await runManagerRuntimeToCompletion(
        activeRuntime.step(
          {
            context: {
              roomId: room.id,
              ownerId: input.ownerId,
              workspaceId: room.workspaceId,
              runId: room.runId,
              groupSessionId: room.sessionId,
              goal: typeof room.metadata?.goal === 'string' ? room.metadata.goal : null,
              managerName: 'Manager',
              workers,
            },
            timeline: timelineRows.map((event) => ({
              id: event.id,
              sequence: event.sequence,
              type: event.type,
              senderType: event.senderType,
              body: event.body,
              metadata: event.metadata,
            })) satisfies ManagerObservedEvent[],
            runState: input.runState,
            signal: input.signal,
          },
          input.signal,
        ),
        async (event) => {
          if (event.type === 'room_message' && event.messageType !== 'status') {
            sawVisibleRoomMessage = true
          }
          const appended = await appendManagerRuntimeEvent(room.id, event, activeRuntime.runtimeType, input.source)
          if (appended) appendedEventIds.push(appended.id)
        },
      )
    } catch (error) {
      const appended = await appendManagerRuntimeError(room.id, activeRuntime.runtimeType, input.source, error)
      appendedEventIds.push(appended.id)
      throw error
    }

    const actions = await convertManagerActions(room.id, step.actions, activeRuntime.runtimeType, input.source)
    const allowedActionTypes = input.allowedActionTypes
      ? new Set(input.allowedActionTypes)
      : null
    const shouldAppendActions =
      input.appendActions !== false &&
      (!allowedActionTypes || actions.every((action) => allowedActionTypes.has(action.type)))
    if (shouldAppendActions) {
      for (const action of actions) {
        if (sawVisibleRoomMessage && (action.type === 'reply' || action.type === 'clarify')) {
          continue
        }
        const event = await appendManagerAction(room.id, action, activeRuntime.runtimeType)
        if (event) appendedEventIds.push(event.id)
      }
    }

    return {
      roomId: room.id,
      runtimeType: step.runtimeType,
      actions,
      rawActions: step.actions,
      rawOutput: step.rawOutput,
      appendedEventIds,
    }
  }
}

function createDefaultManagerRuntime(): ManagerRuntime {
  return getActiveManagerProvider().createRuntime()
}

async function resolveManagerRuntimeForRoom(roomId: string): Promise<ManagerRuntime | null> {
  const managerAgent = await resolveRoomManagerAgent(roomId)
  const runtimeType = readManagerRuntimeType(managerAgent?.roleProfile)
  if (!runtimeType) return null
  const provider = getManagerProvider(runtimeType)
  return provider?.createRuntime() ?? null
}

function readManagerRuntimeType(roleProfile: unknown): ManagerRuntimeType | null {
  if (!roleProfile || typeof roleProfile !== 'object') return null
  const value = (roleProfile as Record<string, unknown>).managerRuntimeType
  if (value === 'openclaw' || value === 'qwenpaw') return value
  return null
}

async function runManagerRuntimeToCompletion(
  iterator: AsyncGenerator<ManagerRuntimeEvent, ManagerStepResult>,
  onEvent: (event: ManagerRuntimeEvent) => Promise<void>,
): Promise<ManagerStepResult> {
  let next = await iterator.next()
  while (!next.done) {
    await onEvent(next.value)
    next = await iterator.next()
  }
  return next.value
}

async function appendManagerRuntimeEvent(
  roomId: string,
  event: ManagerRuntimeEvent,
  runtimeType: ManagerRuntimeType,
  source: string,
) {
  const managerParticipant = await ensureManagerParticipantForRoom(roomId)
  const metadataBase = {
    kind: `manager-runtime.${event.type}`,
    runtimeType,
    source,
    hiddenFromChat: true,
    skipAutoDispatch: true,
  }
  if (event.type === 'thinking') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'system',
      body: event.content,
      metadata: {
        ...metadataBase,
        uiPresentation: 'room-status',
      },
    })
  }
  if (event.type === 'tool_call') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'system',
      body: `Manager 调用工具：${event.call.name}`,
      metadata: {
        ...metadataBase,
        uiPresentation: 'room-status',
        call: event.call,
      },
    })
  }
  if (event.type === 'tool_result') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'system',
      body: event.result.output,
      metadata: {
        ...metadataBase,
        uiPresentation: 'room-status',
        result: event.result,
      },
    })
  }
  if (event.type === 'room_message') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: event.messageType === 'status' ? 'system' : 'manager.message',
      body: event.content,
      metadata: {
        ...metadataBase,
        hiddenFromChat: event.messageType === 'status',
        uiPresentation: event.messageType === 'status' ? 'room-status' : 'message',
        messageType: event.messageType,
      },
    })
  }
  if (event.type === 'task_assigned') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'system',
      body: event.taskTitle,
      metadata: {
        ...metadataBase,
        uiPresentation: 'room-status',
        targetWorkerId: event.targetWorkerId,
        taskTitle: event.taskTitle,
        taskDescription: event.taskDescription,
      },
    })
  }
  if (event.type === 'member_proposed') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'system',
      body: 'Manager 提出了补员建议。',
      metadata: {
        ...metadataBase,
        uiPresentation: 'room-status',
        proposals: event.proposals,
      },
    })
  }
  return roomService.appendTimelineEvent({
    roomId,
    senderParticipantId: managerParticipant?.id ?? null,
    senderType: 'manager',
    type: 'system',
    body: `Manager Runtime completed with ${event.actions.length} action(s).`,
    metadata: {
      ...metadataBase,
      uiPresentation: 'room-status',
      actions: event.actions,
      hiddenFromChat: true,
    },
  })
}

async function appendManagerRuntimeError(
  roomId: string,
  runtimeType: ManagerRuntimeType,
  source: string,
  error: unknown,
) {
  const managerParticipant = await ensureManagerParticipantForRoom(roomId)
  return roomService.appendTimelineEvent({
    roomId,
    senderParticipantId: managerParticipant?.id ?? null,
    senderType: 'manager',
    type: 'system',
    body: `Manager Runtime 执行失败：${error instanceof Error ? error.message : String(error)}`,
    metadata: {
      kind: 'manager-runtime.error',
      runtimeType,
      source,
      hiddenFromChat: true,
      skipAutoDispatch: true,
      uiPresentation: 'room-status',
    },
  })
}

async function convertManagerActions(
  roomId: string,
  actions: ManagerAction[],
  runtimeType: ManagerRuntimeType,
  source: string,
): Promise<ManagerAction[]> {
  const converted: ManagerAction[] = []
  for (const action of actions) {
    if (!SUPPORTED_ACTION_TYPES.has(action.type as ManagerActionType)) {
      await appendUnsupportedAction(roomId, action, runtimeType, source)
      continue
    }
    converted.push({
      type: action.type as ManagerActionType,
      message: action.message,
      reason: action.reason,
      targetWorkerId: action.targetWorkerId,
      taskKey: action.taskKey,
      dependsOn: action.dependsOn,
      taskTitle: action.taskTitle,
      taskDescription: action.taskDescription,
      memberProposals: action.memberProposals,
      metadata: {
        ...(action.metadata ?? {}),
        managerRuntimeType: runtimeType,
        source,
      },
    })
  }
  return converted
}

async function appendUnsupportedAction(
  roomId: string,
  action: ManagerAction,
  runtimeType: ManagerRuntimeType,
  source: string,
) {
  const managerParticipant = await ensureManagerParticipantForRoom(roomId)
  return roomService.appendTimelineEvent({
    roomId,
    senderParticipantId: managerParticipant?.id ?? null,
    senderType: 'manager',
    type: 'system',
    body: `Manager 输出了当前尚未接入的动作：${action.type}`,
    metadata: {
      kind: 'manager-runtime.unsupported-action',
      runtimeType,
      source,
      action,
      hiddenFromChat: true,
      skipAutoDispatch: true,
      uiPresentation: 'room-status',
    },
  })
}

async function appendManagerAction(
  roomId: string,
  action: ManagerAction,
  runtimeType: string,
) {
  const managerParticipant = await ensureManagerParticipantForRoom(roomId)
  if (action.type === 'wait') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'system',
      body: action.message ?? 'Manager is waiting.',
      metadata: {
        kind: 'manager.action',
        actionType: action.type,
        reason: action.reason ?? null,
        runtimeType,
        ...(action.metadata ?? {}),
      },
    })
  }
  if (action.type === 'assign') {
    const targetParticipant = action.targetWorkerId
      ? await findParticipant(roomId, { workspaceAgentId: action.targetWorkerId })
      : null
    const payload = {
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'task.assigned',
      body: action.message ?? action.taskDescription ?? action.taskTitle ?? 'Manager assigned a task.',
      metadata: {
        kind: 'manager.action',
        actionType: action.type,
        targetWorkerId: action.targetWorkerId ?? null,
        taskTitle: action.taskTitle ?? null,
        taskDescription: action.taskDescription ?? null,
        reason: action.reason ?? null,
        runtimeType,
        matrixMention: targetParticipant
          ? {
              participantId: targetParticipant.id,
              providerUserId: targetParticipant.providerUserId ?? null,
            }
          : null,
        ...(action.metadata ?? {}),
      },
    } as const
    if (targetParticipant) {
      return roomService.appendMentionTimelineEvent({
        ...payload,
        mentionParticipantId: targetParticipant.id,
      })
    }
    return roomService.appendTimelineEvent(payload)
  }
  if (action.type === 'propose_members') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'approval.requested',
      body: action.message ?? 'Manager 建议补充成员，请确认。',
      metadata: {
        kind: 'manager.action',
        actionType: action.type,
        memberProposals: action.memberProposals ?? [],
        memberProposalStatus: 'pending',
        reason: action.reason ?? null,
        runtimeType,
        ...(action.metadata ?? {}),
      },
    })
  }
  if (action.type === 'create_worker') {
    return applyCreateWorkerAction(roomId, action, runtimeType, managerParticipant?.id ?? null)
  }
  return roomService.appendTimelineEvent({
    roomId,
    senderParticipantId: managerParticipant?.id ?? null,
    senderType: 'manager',
    type: 'manager.message',
    body: action.message ?? '',
    metadata: {
      kind: 'manager.action',
      actionType: action.type,
      reason: action.reason ?? null,
      runtimeType,
      ...(action.metadata ?? {}),
    },
  })
}

async function applyCreateWorkerAction(
  roomId: string,
  action: ManagerAction,
  runtimeType: string,
  managerParticipantId: string | null,
) {
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1)
  if (!room?.workspaceId) {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipantId,
      senderType: 'manager',
      type: 'system',
      body: 'Manager 无法创建 Worker：当前房间没有绑定 workspace。',
      metadata: {
        kind: 'manager.action.create_worker.failed',
        actionType: action.type,
        reason: 'missing-workspace',
        runtimeType,
        action,
      },
    })
  }

  const proposal = memberProposalsFromManagerAction(action)[0]
  if (!proposal) {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipantId,
      senderType: 'manager',
      type: 'system',
      body: 'Manager 无法创建 Worker：create_worker action 缺少有效的 member spec。',
      metadata: {
        kind: 'manager.action.create_worker.failed',
        actionType: action.type,
        reason: 'invalid-member-spec',
        runtimeType,
        action,
      },
    })
  }

  try {
    const result = await controllerApi.createWorker({
      workspaceId: room.workspaceId,
      ownerId: room.ownerId,
      groupSessionId: room.sessionId,
      joinGroupRoom: room.kind === 'group' || room.kind === 'manager_dm',
      createDirectSession: true,
      announce: true,
      name: proposal.name,
      runtimeType: proposal.runtimeType ?? 'code-agent',
      runtimeBase: proposal.workerRuntimeBase ?? proposal.codeAgentType ?? undefined,
      codeAgentType: proposal.codeAgentType ?? undefined,
      modelId: proposal.modelId ?? null,
      skillIds: proposal.skillIds ?? [],
      role: proposal.role,
      roleType: proposal.roleType,
      sandboxPolicy: proposal.sandboxPolicy,
    })
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipantId,
      senderType: 'manager',
      type: 'system',
      body: `${proposal.name} 的创建与入群流程已完成。`,
      metadata: {
        kind: 'manager.action.create_worker.applied',
        actionType: action.type,
        runtimeType,
        workspaceAgentId: result.agentId,
        workerInstanceId: result.workerInstanceId,
        runtimeBase: result.runtimeBase,
        stages: result.stages,
        groupRoomId: result.groupRoom?.id ?? null,
        directRoomId: result.directRoom?.id ?? null,
        directSessionId: result.directSession?.id ?? null,
        announcements: result.announcements,
        proposal,
        hiddenFromChat: true,
      },
    })
  } catch (error) {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipantId,
      senderType: 'manager',
      type: 'system',
      body: `Manager 创建 Worker 失败：${error instanceof Error ? error.message : String(error)}`,
      metadata: {
        kind: 'manager.action.create_worker.failed',
        actionType: action.type,
        reason: 'controller-error',
        runtimeType,
        proposal,
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

async function findParticipant(
  roomId: string,
  filter: { participantType?: 'manager'; workspaceAgentId?: string },
) {
  const rows = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))
  return rows.find((row) => {
    if (filter.participantType && row.participantType !== filter.participantType) return false
    if (filter.workspaceAgentId && row.workspaceAgentId !== filter.workspaceAgentId) return false
    return true
  }) ?? null
}

async function listRoomWorkerCandidates(roomId: string): Promise<ManagerWorkerCandidate[]> {
  const rows = await db
    .select({
      workspaceAgentId: workspaceAgents.id,
      name: workspaceAgents.name,
      role: workspaceAgents.role,
      runtimeType: workspaceAgents.runtimeType,
      codeAgentType: workspaceAgents.codeAgentType,
      capabilityTags: workspaceAgents.capabilityTags,
      participantStatus: roomParticipants.status,
    })
    .from(roomParticipants)
    .innerJoin(workspaceAgents, eq(roomParticipants.workspaceAgentId, workspaceAgents.id))
    .innerJoin(rooms, eq(roomParticipants.roomId, rooms.id))
    .where(eq(roomParticipants.roomId, roomId))
  return rows.map((row) => ({
    workspaceAgentId: row.workspaceAgentId,
    name: row.name,
    role: row.role,
    runtimeType: row.runtimeType as 'code-agent',
    codeAgentType: row.codeAgentType,
    capabilityTags: row.capabilityTags ?? [],
    status: row.participantStatus,
  }))
}

export const managerRuntimeService = new ManagerRuntimeService()
