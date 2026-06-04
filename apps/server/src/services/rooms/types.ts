export type RoomProvider = 'local-matrix-compatible' | 'matrix'
export type RoomKind = 'group' | 'manager_dm' | 'task' | 'direct' | 'human_intervention'
export type RoomStatus = 'active' | 'archived' | 'failed'
export type ParticipantType = 'human' | 'manager' | 'worker' | 'system'
export type ParticipantRole = 'owner' | 'manager' | 'member' | 'observer' | 'system'
export type ParticipantStatus = 'joined' | 'invited' | 'left'
export type TimelineEventType =
  | 'human.message'
  | 'manager.message'
  | 'worker.message'
  | 'task.assigned'
  | 'task.progress'
  | 'artifact.created'
  | 'approval.requested'
  | 'file.shared'
  | 'system'

export interface CreateRoomInput {
  kind: RoomKind
  ownerId: string
  title: string
  topic?: string | null
  workspaceId?: string | null
  sessionId?: string | null
  runId?: string | null
  taskId?: string | null
  taskThreadId?: string | null
  metadata?: Record<string, unknown>
}

export interface EnsureRoomForSessionInput {
  ownerId: string
  sessionId: string
  title: string
  sessionType: 'direct' | 'group'
  workspaceId?: string | null
  workspaceAgentId?: string | null
  metadata?: Record<string, unknown> | null
}

export interface EnsureRoomForTaskThreadInput {
  ownerId: string
  workspaceId: string
  groupSessionId: string
  sessionId: string
  runId: string
  taskId: string
  taskThreadId: string
  title: string
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  metadata?: Record<string, unknown>
}

export interface AddParticipantInput {
  roomId: string
  participantType: ParticipantType
  displayName: string
  role?: ParticipantRole
  userId?: string | null
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  providerUserId?: string | null
  metadata?: Record<string, unknown>
}

export interface AppendTimelineEventInput {
  roomId: string
  senderParticipantId?: string | null
  senderType: ParticipantType
  type: TimelineEventType
  body?: string
  metadata?: Record<string, unknown>
  providerEventId?: string
}

export interface AppendMentionTimelineEventInput extends AppendTimelineEventInput {
  mentionParticipantId: string
}

export interface ImportTimelineEventInput extends AppendTimelineEventInput {
  providerEventId: string
}

export interface ListTimelineEventsInput {
  roomId: string
  afterSequence?: number
  limit?: number
}

export interface RoomAdapter {
  createRoom(input: CreateRoomInput): Promise<any>
  ensureRoomForSession(input: EnsureRoomForSessionInput): Promise<any>
  ensureRoomForTaskThread(input: EnsureRoomForTaskThreadInput): Promise<any>
  addParticipant(input: AddParticipantInput): Promise<any>
  appendTimelineEvent(input: AppendTimelineEventInput): Promise<any>
  appendMentionTimelineEvent?(input: AppendMentionTimelineEventInput): Promise<any>
  importTimelineEvent?(input: ImportTimelineEventInput): Promise<any>
  listTimelineEvents(input: ListTimelineEventsInput): Promise<any[]>
  listRoomsForOwner(ownerId: string, workspaceId?: string | null): Promise<any[]>
  getRoom(roomId: string): Promise<any | null>
  listParticipants(roomId: string): Promise<any[]>
}
