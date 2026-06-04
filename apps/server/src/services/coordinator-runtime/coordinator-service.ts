import { db, eq, roomParticipants, rooms, workspaceAgents } from '@agenthub/db'
import { managerRuntimeService, type ManagerRuntimeService } from '../manager-runtime/manager-runtime-service'
import type { ManagerRuntimeType } from '../manager-runtime/types'
import { roomService } from '../rooms'
import { getDefaultCoordinatorRuntime } from './runtime-registry'
import type {
  CoordinatorAction,
  CoordinatorActionType,
  CoordinatorObservedEvent,
  CoordinatorRuntime,
  CoordinatorStepResult,
  CoordinatorWorkerCandidate,
} from './types'

export interface StepRoomInput {
  roomId: string
  ownerId: string
  runtime?: CoordinatorRuntime
  afterSequence?: number
  limit?: number
  allowedActionTypes?: CoordinatorActionType[]
  appendActions?: boolean
  signal?: AbortSignal
}

export interface StepRoomResult extends Omit<CoordinatorStepResult, 'runtimeType'> {
  roomId: string
  runtimeType: CoordinatorStepResult['runtimeType'] | ManagerRuntimeType
  appendedEventIds: string[]
}

export interface CoordinatorServiceOptions {
  managerService?: ManagerRuntimeService
  useManagerRuntimeByDefault?: boolean
}

export class CoordinatorService {
  private readonly defaultRuntime: CoordinatorRuntime
  private readonly managerService: ManagerRuntimeService
  private readonly useManagerRuntimeByDefault: boolean

  constructor(defaultRuntime?: CoordinatorRuntime, options: CoordinatorServiceOptions = {}) {
    this.defaultRuntime = defaultRuntime ?? getDefaultCoordinatorRuntime()
    this.managerService = options.managerService ?? managerRuntimeService
    this.useManagerRuntimeByDefault = options.useManagerRuntimeByDefault ?? !defaultRuntime
  }

  async stepRoom(input: StepRoomInput): Promise<StepRoomResult> {
    if (!input.runtime && this.useManagerRuntimeByDefault) {
      const result = await this.managerService.stepRoom({
        roomId: input.roomId,
        ownerId: input.ownerId,
        afterSequence: input.afterSequence,
        limit: input.limit,
        allowedActionTypes: input.allowedActionTypes,
        appendActions: input.appendActions,
        signal: input.signal,
        source: 'coordinator-service',
      })
      return {
        roomId: result.roomId,
        runtimeType: result.runtimeType,
        actions: result.actions,
        rawOutput: result.rawOutput,
        appendedEventIds: result.appendedEventIds,
      }
    }

    const room = await roomService.getRoomForOwner(input.roomId, input.ownerId)
    const timelineRows = await roomService.listTimelineEvents({
      roomId: room.id,
      afterSequence: input.afterSequence,
      limit: input.limit ?? 100,
    })
    const runtime = input.runtime ?? this.defaultRuntime
    const workers = await listRoomWorkerCandidates(room.id)
    const step = await runtime.step(
      {
        context: {
          roomId: room.id,
          workspaceId: room.workspaceId,
          runId: room.runId,
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
        })) satisfies CoordinatorObservedEvent[],
      },
      input.signal,
    )
    const allowedActionTypes = input.allowedActionTypes
      ? new Set(input.allowedActionTypes)
      : null
    const shouldAppendActions =
      input.appendActions !== false &&
      (!allowedActionTypes || step.actions.every((action) => allowedActionTypes.has(action.type)))
    const appendedEventIds: string[] = []
    if (shouldAppendActions) {
      for (const action of step.actions) {
        const event = await appendCoordinatorAction(room.id, action, step.runtimeType)
        if (event) appendedEventIds.push(event.id)
      }
    }
    return {
      ...step,
      roomId: room.id,
      appendedEventIds,
    }
  }
}

async function appendCoordinatorAction(
  roomId: string,
  action: CoordinatorAction,
  runtimeType: string,
) {
  const managerParticipant = await findParticipant(roomId, { participantType: 'manager' })
  if (action.type === 'wait') {
    return roomService.appendTimelineEvent({
      roomId,
      senderParticipantId: managerParticipant?.id ?? null,
      senderType: 'manager',
      type: 'system',
      body: action.message ?? 'Manager is waiting.',
      metadata: {
        kind: 'coordinator.action',
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
        kind: 'coordinator.action',
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
        kind: 'coordinator.action',
        actionType: action.type,
        memberProposals: action.memberProposals ?? [],
        reason: action.reason ?? null,
        runtimeType,
        ...(action.metadata ?? {}),
      },
    })
  }
  return roomService.appendTimelineEvent({
    roomId,
    senderParticipantId: managerParticipant?.id ?? null,
    senderType: 'manager',
    type: 'manager.message',
    body: action.message ?? '',
    metadata: {
      kind: 'coordinator.action',
      actionType: action.type,
      reason: action.reason ?? null,
      runtimeType,
      ...(action.metadata ?? {}),
    },
  })
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

async function listRoomWorkerCandidates(roomId: string): Promise<CoordinatorWorkerCandidate[]> {
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
    runtimeType: row.runtimeType,
    codeAgentType: row.codeAgentType,
    capabilityTags: row.capabilityTags ?? [],
    status: row.participantStatus,
  }))
}

export const coordinatorService = new CoordinatorService()
