import { asc, db, eq, messages, roomParticipants, rooms, timelineEvents } from '@agenthub/db'

type RoomRow = typeof rooms.$inferSelect
type ParticipantRow = typeof roomParticipants.$inferSelect
type TimelineEventRow = typeof timelineEvents.$inferSelect
type MessageRow = typeof messages.$inferSelect

const PROJECTABLE_EVENT_TYPES = new Set([
  'human.message',
  'manager.message',
  'worker.message',
  'task.assigned',
  'task.progress',
  'artifact.created',
  'approval.requested',
  'system',
])

export async function listSessionMessagesRoomFirst(input: {
  sessionId: string
  legacyMessages: MessageRow[]
}): Promise<MessageRow[]> {
  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.sessionId, input.sessionId))
    .limit(1)
  if (!room) return input.legacyMessages

  const [participants, timeline] = await Promise.all([
    db.select().from(roomParticipants).where(eq(roomParticipants.roomId, room.id)),
    db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.roomId, room.id))
      .orderBy(asc(timelineEvents.sequence)),
  ])
  if (!timeline.length) return input.legacyMessages

  return mergeTimelineProjectionWithLegacy({
    room,
    participants,
    timeline,
    legacyMessages: input.legacyMessages,
    sessionId: input.sessionId,
  })
}

export function mergeTimelineProjectionWithLegacy(input: {
  room: RoomRow
  participants: ParticipantRow[]
  timeline: TimelineEventRow[]
  legacyMessages: MessageRow[]
  sessionId: string
}): MessageRow[] {
  const participantsById = new Map(input.participants.map((participant) => [participant.id, participant]))
  const controls = timelineProjectionControls(input.timeline)
  const projectedMessages = input.timeline
    .filter((event) => event.sequence > controls.clearedBeforeOrAtSequence)
    .filter((event) => !isMessageControlEvent(event))
    .filter((event) => !timelineEventIsRedacted(event, controls))
    .map((event) =>
      timelineEventToMessage({
        event,
        room: input.room,
        participant: event.senderParticipantId ? participantsById.get(event.senderParticipantId) : undefined,
        sessionId: input.sessionId,
      }),
    )
    .filter((message): message is MessageRow => Boolean(message))
    .map((message) => applyTimelineEdit(message, controls))

  const coveredLegacyIds = new Set<string>()
  for (const message of projectedMessages) coveredLegacyIds.add(message.id)
  for (const event of input.timeline) {
    const metadata = asRecord(event.metadata)
    const messageId = asString(metadata.messageId)
    const projectionMessageId = asString(metadata.projectionMessageId)
    if (messageId) coveredLegacyIds.add(messageId)
    if (projectionMessageId) coveredLegacyIds.add(projectionMessageId)
  }

  const legacyMessages = input.legacyMessages.filter((message) => {
    if (controls.redactedMessageIds.has(message.id)) return false
    if (message.createdAt.getTime() <= controls.clearedAtTime) return false
    if (coveredLegacyIds.has(message.id)) return false
    const metadata = asRecord(message.metadata)
    if (metadata.roomTimeline || metadata.roomTimelineProjection) return false
    return !input.timeline.some((event) =>
      timelineEventCoversLegacyMessage({
        room: input.room,
        event,
        legacyMessage: message,
      }),
    )
  })

  return [...projectedMessages, ...legacyMessages].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime()
    if (byTime !== 0) return byTime
    return a.id.localeCompare(b.id)
  })
}

type TimelineProjectionControls = {
  clearedBeforeOrAtSequence: number
  clearedAtTime: number
  redactedMessageIds: Set<string>
  redactedEventIds: Set<string>
  redactedDescriptors: Array<Record<string, unknown>>
  editsByMessageId: Map<string, Record<string, unknown>>
  pinsByMessageId: Map<string, boolean>
}

function timelineProjectionControls(timeline: TimelineEventRow[]): TimelineProjectionControls {
  const controls: TimelineProjectionControls = {
    clearedBeforeOrAtSequence: 0,
    clearedAtTime: 0,
    redactedMessageIds: new Set(),
    redactedEventIds: new Set(),
    redactedDescriptors: [],
    editsByMessageId: new Map(),
    pinsByMessageId: new Map(),
  }

  for (const event of timeline) {
    if (event.type !== 'system') continue
    const metadata = asRecord(event.metadata)
    const kind = asString(metadata.kind)
    if (kind === 'message.clear') {
      controls.clearedBeforeOrAtSequence = Math.max(controls.clearedBeforeOrAtSequence, event.sequence)
      controls.clearedAtTime = Math.max(controls.clearedAtTime, event.createdAt.getTime())
      continue
    }
    if (kind === 'message.redact') {
      for (const id of asStringArray(metadata.targetMessageIds)) controls.redactedMessageIds.add(id)
      for (const id of asStringArray(metadata.targetEventIds)) controls.redactedEventIds.add(id)
      const descriptors = Array.isArray(metadata.targetMessages) ? metadata.targetMessages : []
      for (const descriptor of descriptors) {
        if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)) {
          controls.redactedDescriptors.push(descriptor as Record<string, unknown>)
        }
      }
      continue
    }
    if (kind === 'message.edit') {
      const targetMessageId = asString(metadata.targetMessageId)
      if (targetMessageId) controls.editsByMessageId.set(targetMessageId, metadata)
      const targetEventId = asString(metadata.targetEventId)
      if (targetEventId) controls.editsByMessageId.set(`room:${targetEventId}`, metadata)
      continue
    }
    if (kind === 'message.pin') {
      const pinned = metadata.pinned === true
      const targetMessageId = asString(metadata.targetMessageId)
      if (targetMessageId) controls.pinsByMessageId.set(targetMessageId, pinned)
      const targetEventId = asString(metadata.targetEventId)
      if (targetEventId) controls.pinsByMessageId.set(`room:${targetEventId}`, pinned)
    }
  }

  return controls
}

function isMessageControlEvent(event: TimelineEventRow) {
  if (event.type !== 'system') return false
  const kind = asString(asRecord(event.metadata).kind)
  return Boolean(kind?.startsWith('message.'))
}

function timelineEventIsRedacted(event: TimelineEventRow, controls: TimelineProjectionControls) {
  if (controls.redactedEventIds.has(event.id)) return true
  if (controls.redactedMessageIds.has(`room:${event.id}`)) return true
  const metadata = asRecord(event.metadata)
  const messageId = asString(metadata.messageId)
  const projectionMessageId = asString(metadata.projectionMessageId)
  if (messageId && controls.redactedMessageIds.has(messageId)) return true
  if (projectionMessageId && controls.redactedMessageIds.has(projectionMessageId)) return true
  return controls.redactedDescriptors.some((descriptor) => timelineEventMatchesDescriptor(event, descriptor))
}

function timelineEventMatchesDescriptor(event: TimelineEventRow, descriptor: Record<string, unknown>) {
  const metadata = asRecord(event.metadata)
  const sourceMessageId = asString(descriptor.sourceMessageId)
  const actionType = asString(descriptor.actionType)
  if (sourceMessageId && asString(metadata.sourceMessageId) !== sourceMessageId) return false
  if (actionType && asString(metadata.actionType) !== actionType) return false
  return Boolean(sourceMessageId || actionType)
}

function applyTimelineEdit(message: MessageRow, controls: TimelineProjectionControls): MessageRow {
  const edit = controls.editsByMessageId.get(message.id)
  const pinned = controls.pinsByMessageId.get(message.id)
  if (!edit && pinned === undefined) return message
  const content = edit ? asString(edit.content) : null
  const metadata = asRecord(message.metadata)
  return {
    ...message,
    content: content ?? message.content,
    isPinned: pinned ?? message.isPinned,
    metadata: {
      ...metadata,
      ...(content
        ? {
            displayContent: content,
            editedAt: asString(edit?.editedAt) ?? new Date().toISOString(),
            roomTimelineEdit: {
              source: 'room-timeline-control',
              targetMessageId: message.id,
            },
          }
        : {}),
      ...(pinned !== undefined
        ? {
            roomTimelinePin: {
              source: 'room-timeline-control',
              targetMessageId: message.id,
              pinned,
            },
          }
        : {}),
    },
  }
}

function timelineEventToMessage(input: {
  event: TimelineEventRow
  room: RoomRow
  participant?: ParticipantRow
  sessionId: string
}): MessageRow | null {
  const { event, participant, room } = input
  if (!PROJECTABLE_EVENT_TYPES.has(event.type)) return null

  const content = visibleBodyForEvent(event)
  if (!content.trim()) return null

  const senderType = senderTypeFromTimeline(event)
  const senderName = displayNameForEvent(event, participant)
  const metadata = asRecord(event.metadata)
  return {
    id: `room:${event.id}`,
    sessionId: input.sessionId,
    senderId:
      participant?.workspaceAgentId ??
      participant?.userId ??
      participant?.workerInstanceId ??
      event.senderParticipantId ??
      event.senderType,
    senderType,
    type: asString(metadata.messageType) ?? 'text',
    content,
    metadata: {
      ...metadata,
      roomTimeline: {
        roomId: room.id,
        roomKind: room.kind,
        providerRoomId: room.providerRoomId,
        eventId: event.id,
        providerEventId: event.providerEventId,
        sequence: event.sequence,
        eventType: event.type,
      },
      senderName,
      agentName: senderType === 'agent' ? senderName : undefined,
      displayContent: content,
    },
    isPinned: false,
    replyToMessageId: asString(metadata.replyToMessageId) ?? null,
    createdAt: event.createdAt,
  }
}

function timelineEventCoversLegacyMessage(input: {
  room: RoomRow
  event: TimelineEventRow
  legacyMessage: MessageRow
}) {
  const eventMetadata = asRecord(input.event.metadata)
  const legacyMetadata = asRecord(input.legacyMessage.metadata)
  if (asString(eventMetadata.messageId) === input.legacyMessage.id) return true
  if (asString(eventMetadata.projectionMessageId) === input.legacyMessage.id) return true

  const legacyRoomId = asString(legacyMetadata.roomId)
  if (legacyRoomId && legacyRoomId !== input.room.id) return false
  const eventSourceMessageId = asString(eventMetadata.sourceMessageId)
  const legacySourceMessageId = asString(legacyMetadata.sourceMessageId)
  if (!eventSourceMessageId || !legacySourceMessageId || eventSourceMessageId !== legacySourceMessageId) {
    return false
  }
  const eventActionType = asString(eventMetadata.actionType)
  const legacyActionType = asString(legacyMetadata.actionType)
  return Boolean(eventActionType && legacyActionType && eventActionType === legacyActionType)
}

function senderTypeFromTimeline(event: TimelineEventRow): MessageRow['senderType'] {
  if (event.senderType === 'human') return 'user'
  if (event.senderType === 'system' || event.type === 'system') return 'system'
  return 'agent'
}

function displayNameForEvent(event: TimelineEventRow, participant?: ParticipantRow) {
  if (participant?.displayName?.trim()) return participant.displayName.trim()
  if (event.senderType === 'manager') return 'Manager'
  if (event.senderType === 'worker') return 'Worker'
  if (event.senderType === 'human') return '我'
  return '系统'
}

function visibleBodyForEvent(event: TimelineEventRow) {
  if (event.body.trim()) return event.body
  const metadata = asRecord(event.metadata)
  if (event.type === 'artifact.created') {
    const artifact = asRecord(metadata.artifact)
    return asString(artifact.title) ?? asString(metadata.title) ?? '产物已创建'
  }
  if (event.type === 'task.progress') return asString(metadata.progressStatus) ?? '任务进度更新'
  if (event.type === 'task.assigned') return asString(metadata.taskTitle) ?? '任务已分配'
  if (event.type === 'approval.requested') return '需要用户确认'
  return ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}
