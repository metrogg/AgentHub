import { MessageType, SenderType } from '@agenthub/shared'
import type { CodeAgentRunMetadata } from '@agenthub/shared'
import type { Message, Room, RoomParticipant, TimelineEvent } from './api'

export interface RoomTimelineProjection {
  room: Room
  participantsById: Map<string, RoomParticipant>
  messages: Message[]
  events: RoomTimelineAgUiEvent[]
  messageControl?: RoomTimelineMessageControl
}

export interface RoomTimelineMessageControl {
  kind: 'message.clear' | 'message.edit' | 'message.redact' | 'message.pin'
  targetMessageIds: string[]
  targetEventIds: string[]
  targetMessages: Array<Record<string, unknown>>
  content?: string
  editedAt?: string
  pinned?: boolean
  clearedAt?: string
}

export interface RoomTimelineAgUiEvent {
  type: 'CUSTOM'
  name: string
  value: Record<string, unknown>
  runId?: string
  threadId?: string
  message?: string
}

const INTERNAL_RUNTIME_CHAT_KINDS = new Set([
  'worker-runtime.progress',
  'worker-runtime.heartbeat',
  'worker-runtime.busy',
  'worker-runtime.claimed',
  'worker-runtime.resident-assignment',
  'worker-runtime.group-mention-started',
  'worker-runtime.group-mention-dispatched',
])

export function projectRoomTimeline(input: {
  room: Room
  participants: RoomParticipant[]
  timeline: TimelineEvent[]
  sessionId: string
}): RoomTimelineProjection {
  const participantsById = new Map(input.participants.map((participant) => [participant.id, participant]))
  const controls = timelineProjectionControls(input.timeline)
  const messages = collapseTimelineStreamMessages(
    dedupeProjectedTimelineMessages(input.timeline
      .filter((event) => event.sequence > controls.clearedBeforeOrAtSequence)
      .filter((event) => !isMessageControlEvent(event))
      .filter((event) => !timelineEventIsRedacted(event, controls))
      .map((event) => timelineEventToMessage(event, input.room, input.sessionId, participantsById))
      .filter((message): message is Message => Boolean(message))
      .map((message) => applyTimelineControlsToMessage(message, controls))),
  )
  const events = input.timeline.flatMap((event) => timelineEventToAgUiEvents(event, input.room, input.sessionId))
  return {
    room: input.room,
    participantsById,
    messages,
    events,
    messageControl: input.timeline.length === 1 ? timelineEventToMessageControl(input.timeline[0]!) : undefined,
  }
}

export function mergeRoomTimelineStreamMessages(messages: Message[], incoming: Message[]): Message[] {
  let output = [...messages]
  for (const message of incoming) {
    const existingIndex = output.findIndex((item) => item.id === message.id)
    if (existingIndex >= 0) {
      output = output.map((item, index) => (index === existingIndex ? message : item))
      continue
    }

    const previous = output[output.length - 1]
    const streamKey = roomTimelineStreamKey(message)
    if (previous && streamKey && roomTimelineStreamKey(previous) === streamKey) {
      output = [
        ...output.slice(0, -1),
        mergeTimelineStreamMessage(previous, message),
      ]
      continue
    }

    output = [...output, message]
  }
  return output
}

export function applyRoomTimelineMessageControl(
  messages: Message[],
  control: RoomTimelineMessageControl,
): Message[] {
  if (control.kind === 'message.clear') return []
  if (control.kind === 'message.redact') {
    return messages.filter((message) => !messageMatchesControl(message, control))
  }
  return messages.map((message) => {
    if (!messageMatchesControl(message, control)) return message
    const metadata = asRecord(message.metadata) ?? {}
    if (control.kind === 'message.edit') {
      if (!control.content) return message
      return {
        ...message,
        content: control.content,
        metadata: {
          ...metadata,
          displayContent: control.content,
          editedAt: control.editedAt ?? new Date().toISOString(),
          roomTimelineEdit: {
            source: 'room-timeline-control',
            targetMessageId: message.id,
          },
        },
      }
    }
    if (control.kind === 'message.pin') {
      return {
        ...message,
        isPinned: control.pinned ?? false,
        metadata: {
          ...metadata,
          roomTimelinePin: {
            source: 'room-timeline-control',
            targetMessageId: message.id,
            pinned: control.pinned ?? false,
          },
        },
      }
    }
    return message
  })
}

function timelineProjectionControls(timeline: TimelineEvent[]) {
  const controls = {
    clearedBeforeOrAtSequence: 0,
    redactedMessageIds: new Set<string>(),
    redactedEventIds: new Set<string>(),
    redactedDescriptors: [] as Array<Record<string, unknown>>,
    editsByMessageId: new Map<string, RoomTimelineMessageControl>(),
    pinsByMessageId: new Map<string, boolean>(),
    memberProposalUpdatesByMessageId: new Map<string, { content?: string; patch: Record<string, unknown> }>(),
    agentDraftUpdatesByMessageId: new Map<string, { content?: string; patch: Record<string, unknown> }>(),
  }

  for (const event of timeline) {
    const metadata = asRecord(event.metadata)
    if (event.type === 'system' && asString(metadata?.kind) === 'member-proposal.update') {
      const content = asString(metadata?.content) ?? asString(event.body)
      const update = {
        content,
        patch: asRecord(metadata?.patch) ?? {},
      }
      const targetMessageId = asString(metadata?.targetMessageId)
      const targetEventId = asString(metadata?.targetEventId)
      if (targetMessageId) controls.memberProposalUpdatesByMessageId.set(targetMessageId, update)
      if (targetEventId) controls.memberProposalUpdatesByMessageId.set(`room:${targetEventId}`, update)
      continue
    }
    if (event.type === 'system' && asString(metadata?.kind) === 'agent-draft.update') {
      const content = asString(metadata?.content) ?? asString(event.body)
      const update = {
        content,
        patch: asRecord(metadata?.patch) ?? {},
      }
      const targetMessageId = asString(metadata?.targetMessageId)
      const targetEventId = asString(metadata?.targetEventId)
      if (targetMessageId) controls.agentDraftUpdatesByMessageId.set(targetMessageId, update)
      if (targetEventId) controls.agentDraftUpdatesByMessageId.set(`room:${targetEventId}`, update)
      continue
    }

    const control = timelineEventToMessageControl(event)
    if (!control) continue
    if (control.kind === 'message.clear') {
      controls.clearedBeforeOrAtSequence = Math.max(controls.clearedBeforeOrAtSequence, event.sequence)
      continue
    }
    if (control.kind === 'message.redact') {
      for (const id of control.targetMessageIds) controls.redactedMessageIds.add(id)
      for (const id of control.targetEventIds) controls.redactedEventIds.add(id)
      controls.redactedDescriptors.push(...control.targetMessages)
      continue
    }
    if (control.kind === 'message.edit') {
      for (const id of controlTargetIds(control)) controls.editsByMessageId.set(id, control)
      continue
    }
    if (control.kind === 'message.pin') {
      for (const id of controlTargetIds(control)) controls.pinsByMessageId.set(id, control.pinned ?? false)
    }
  }

  return controls
}

function timelineEventToMessageControl(event: TimelineEvent): RoomTimelineMessageControl | undefined {
  if (event.type !== 'system') return undefined
  const metadata = asRecord(event.metadata)
  const kind = asString(metadata?.kind)
  if (
    kind !== 'message.clear' &&
    kind !== 'message.edit' &&
    kind !== 'message.redact' &&
    kind !== 'message.pin'
  ) {
    return undefined
  }
  const targetMessageId = asString(metadata?.targetMessageId)
  const targetEventId = asString(metadata?.targetEventId)
  return {
    kind,
    targetMessageIds: [
      ...(targetMessageId ? [targetMessageId] : []),
      ...asStringArray(metadata?.targetMessageIds),
    ],
    targetEventIds: [
      ...(targetEventId ? [targetEventId] : []),
      ...asStringArray(metadata?.targetEventIds),
    ],
    targetMessages: asRecordArray(metadata?.targetMessages),
    content: asString(metadata?.content),
    editedAt: asString(metadata?.editedAt),
    pinned: typeof metadata?.pinned === 'boolean' ? metadata.pinned : undefined,
    clearedAt: asString(metadata?.clearedAt),
  }
}

function isMessageControlEvent(event: TimelineEvent) {
  const metadata = asRecord(event.metadata)
  if (event.type === 'system' && asString(metadata?.kind) === 'member-proposal.update') return true
  if (event.type === 'system' && asString(metadata?.kind) === 'agent-draft.update') return true
  return Boolean(timelineEventToMessageControl(event))
}

function timelineEventIsRedacted(event: TimelineEvent, controls: ReturnType<typeof timelineProjectionControls>) {
  if (controls.redactedEventIds.has(event.id)) return true
  if (controls.redactedMessageIds.has(`room:${event.id}`)) return true
  const metadata = asRecord(event.metadata)
  const messageId = asString(metadata?.messageId)
  const projectionMessageId = asString(metadata?.projectionMessageId)
  if (messageId && controls.redactedMessageIds.has(messageId)) return true
  if (projectionMessageId && controls.redactedMessageIds.has(projectionMessageId)) return true
  return controls.redactedDescriptors.some((descriptor) => timelineEventMatchesDescriptor(event, descriptor))
}

function timelineEventMatchesDescriptor(event: TimelineEvent, descriptor: Record<string, unknown>) {
  const metadata = asRecord(event.metadata)
  const sourceMessageId = asString(descriptor.sourceMessageId)
  const actionType = asString(descriptor.actionType)
  if (sourceMessageId && asString(metadata?.sourceMessageId) !== sourceMessageId) return false
  if (actionType && asString(metadata?.actionType) !== actionType) return false
  return Boolean(sourceMessageId || actionType)
}

function applyTimelineControlsToMessage(message: Message, controls: ReturnType<typeof timelineProjectionControls>) {
  const edit = controls.editsByMessageId.get(message.id)
  const pinned = controls.pinsByMessageId.get(message.id)
  const memberProposalUpdate = controls.memberProposalUpdatesByMessageId.get(message.id)
  const agentDraftUpdate = controls.agentDraftUpdatesByMessageId.get(message.id)
  if (!edit && pinned === undefined && !memberProposalUpdate && !agentDraftUpdate) return message
  const controlled = applyRoomTimelineMessageControl(
    [message],
    edit ??
      ({
        kind: 'message.pin',
        targetMessageIds: [message.id],
        targetEventIds: [],
        targetMessages: [],
        pinned,
      } satisfies RoomTimelineMessageControl),
  )[0] ?? message
  let next = controlled
  if (memberProposalUpdate) {
    const metadata = asRecord(next.metadata) ?? {}
    next = {
      ...next,
      content: memberProposalUpdate.content ?? next.content,
      metadata: {
        ...metadata,
        ...memberProposalUpdate.patch,
        displayContent: memberProposalUpdate.content ?? next.content,
        roomTimelineMemberProposalUpdate: {
          source: 'room-timeline-control',
          targetMessageId: next.id,
        },
      },
    }
  }
  if (!agentDraftUpdate) return next
  const nextMetadata = asRecord(next.metadata) ?? {}
  next = {
    ...next,
    content: agentDraftUpdate.content ?? next.content,
    metadata: {
      ...nextMetadata,
      ...agentDraftUpdate.patch,
      displayContent: agentDraftUpdate.content ?? next.content,
      roomTimelineAgentDraftUpdate: {
        source: 'room-timeline-control',
        targetMessageId: next.id,
      },
    },
  }
  return next
}

function messageMatchesControl(message: Message, control: RoomTimelineMessageControl) {
  if (control.targetMessageIds.includes(message.id)) return true
  const eventId = readRoomTimelineEventId(message)
  if (eventId && control.targetEventIds.includes(eventId)) return true
  if (eventId && control.targetMessageIds.includes(`room:${eventId}`)) return true
  return control.targetMessages.some((descriptor) => messageMatchesDescriptor(message, descriptor))
}

function messageMatchesDescriptor(message: Message, descriptor: Record<string, unknown>) {
  const metadata = asRecord(message.metadata)
  const sourceMessageId = asString(descriptor.sourceMessageId)
  const actionType = asString(descriptor.actionType)
  if (sourceMessageId && asString(metadata?.sourceMessageId) !== sourceMessageId) return false
  if (actionType && asString(metadata?.actionType) !== actionType) return false
  return Boolean(sourceMessageId || actionType)
}

function readRoomTimelineEventId(message: Message) {
  if (message.id.startsWith('room:')) return message.id.slice('room:'.length)
  const metadata = asRecord(message.metadata)
  return (
    asString(asRecord(metadata?.roomTimeline)?.eventId) ??
    asString(asRecord(metadata?.roomTimelineProjection)?.eventId)
  )
}

function controlTargetIds(control: RoomTimelineMessageControl) {
  return [
    ...control.targetMessageIds,
    ...control.targetEventIds.map((id) => `room:${id}`),
  ]
}

function collapseTimelineStreamMessages(messages: Message[]) {
  const output: Message[] = []
  for (const message of messages) {
    const previous = output[output.length - 1]
    const streamKey = roomTimelineStreamKey(message)
    if (previous && streamKey && roomTimelineStreamKey(previous) === streamKey) {
      output[output.length - 1] = mergeTimelineStreamMessage(previous, message)
      continue
    }
    output.push(message)
  }
  return output
}

function roomTimelineStreamKey(message: Message) {
  const metadata = asRecord(message.metadata) ?? {}
  const roomTimeline = asRecord(metadata.roomTimeline)
  const eventType = asString(roomTimeline?.eventType)
  if (eventType !== 'manager.message' && eventType !== 'worker.message') return null
  if (asString(metadata.actionType)) return null

  const messageType = asString(metadata.messageType)
  if (
    messageType &&
    messageType !== MessageType.Text &&
    messageType !== MessageType.Markdown &&
    messageType !== 'reply' &&
    messageType !== 'clarify'
  ) {
    return null
  }

  const traceId = asString(metadata.traceId)
  const senderParticipantId =
    asString(metadata.senderParticipantId) ??
    asString(metadata.senderWorkerInstanceId) ??
    asString(metadata.senderWorkspaceAgentId) ??
    message.senderId
  if (!traceId || !senderParticipantId) return null
  return `${traceId}:${senderParticipantId}`
}

function mergeTimelineStreamMessage(base: Message, next: Message): Message {
  const baseMetadata = asRecord(base.metadata) ?? {}
  const nextMetadata = asRecord(next.metadata) ?? {}
  const baseRoomTimeline = asRecord(baseMetadata.roomTimeline)
  const nextRoomTimeline = asRecord(nextMetadata.roomTimeline)
  const baseStream = asRecord(baseMetadata.roomTimelineStream)
  const nextStream = asRecord(nextMetadata.roomTimelineStream)
  const eventIds = uniqueStrings([
    ...asStringArray(baseStream?.eventIds),
    ...asStringArray(nextStream?.eventIds),
    asString(baseRoomTimeline?.eventId),
    asString(nextRoomTimeline?.eventId),
  ])
  const providerEventIds = uniqueStrings([
    ...asStringArray(baseStream?.providerEventIds),
    ...asStringArray(nextStream?.providerEventIds),
    asString(baseRoomTimeline?.providerEventId),
    asString(nextRoomTimeline?.providerEventId),
  ])
  const content = mergeTimelineStreamContent(base.content, next.content)
  const traceId = asString(nextMetadata.traceId) ?? asString(baseMetadata.traceId)
  const senderParticipantId =
    asString(nextMetadata.senderParticipantId) ?? asString(baseMetadata.senderParticipantId)

  return {
    ...base,
    type: next.type,
    content,
    metadata: {
      ...baseMetadata,
      ...nextMetadata,
      displayContent: content,
      roomTimeline: nextMetadata.roomTimeline ?? baseMetadata.roomTimeline,
      roomTimelineStream: {
        traceId,
        senderParticipantId,
        eventIds,
        providerEventIds,
        latestEventId: asString(nextRoomTimeline?.eventId) ?? eventIds[eventIds.length - 1] ?? null,
        latestProviderEventId: asString(nextRoomTimeline?.providerEventId) ?? providerEventIds[providerEventIds.length - 1] ?? null,
      },
    },
  }
}

function mergeTimelineStreamContent(base: string, next: string) {
  if (!base) return next
  if (!next) return base
  if (next.startsWith(base)) return next
  if (base.startsWith(next)) return base
  return `${base}${next}`
}

function timelineEventToMessage(
  event: TimelineEvent,
  room: Room,
  sessionId: string,
  participantsById: Map<string, RoomParticipant>,
): Message | null {
  const eventMetadata = asRecord(event.metadata)
  if (eventMetadata?.hiddenFromChat === true) return null
  if (isLiveCodeAgentRunMetadataEvent(event)) return null
  const kind = asString(eventMetadata?.kind)
  if (kind?.startsWith('manager.status.')) return null
  if (kind === 'manager.dispatch.diagnostic') return null

  if (
    event.type !== 'human.message' &&
    event.type !== 'manager.message' &&
    event.type !== 'worker.message' &&
    event.type !== 'task.assigned' &&
    event.type !== 'task.progress' &&
    event.type !== 'artifact.created' &&
    event.type !== 'approval.requested' &&
    event.type !== 'system'
  ) {
    return null
  }

  if (shouldHideRuntimeStatusMessage(event, room)) return null

  const participant = event.senderParticipantId
    ? participantsById.get(event.senderParticipantId)
    : undefined
  const senderType = senderTypeFromTimeline(event)
  const senderName = displayNameForEvent(event, participant)
  const content = visibleBodyForEvent(event)
  if (!content.trim()) return null
  const codeAgentRun = codeAgentRunFromWorkerRuntimeEvent(event)

  return {
    id: `room:${event.id}`,
    sessionId,
    senderId:
      participant?.workspaceAgentId ??
      participant?.userId ??
      participant?.workerInstanceId ??
      event.senderParticipantId ??
      event.senderType,
    senderType,
    type: normalizeTimelineMessageType(event.metadata?.messageType),
    content,
    metadata: {
      ...(event.metadata ?? {}),
      ...(shouldAttachCodeAgentRunToMessage(event, codeAgentRun) ? { codeAgentRun } : {}),
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
      senderParticipantId: participant?.id ?? event.senderParticipantId ?? null,
      senderParticipantType: participant?.participantType ?? event.senderType,
      senderWorkspaceAgentId: participant?.workspaceAgentId ?? null,
      senderWorkerInstanceId: participant?.workerInstanceId ?? null,
      senderUserId: participant?.userId ?? null,
      agentName: senderType === SenderType.Agent ? senderName : undefined,
      displayContent: content,
    },
    createdAt: event.createdAt,
  }
}

export function codeAgentRunFromWorkerRuntimeEvent(
  event: TimelineEvent,
): CodeAgentRunMetadata | null {
  const metadata = asRecord(event.metadata)
  const nested = codeAgentRunMetadataFromRecord(asRecord(metadata?.codeAgentRun))
  if (nested) return nested
  const direct = codeAgentRunMetadataFromRecord(metadata)
  if (direct) return direct

  const kind = asString(metadata?.kind)
  if (!kind?.startsWith('worker-runtime.')) return null
  const runtime = readCodeAgentRuntime(metadata)
  if (!runtime) return null
  const status = codeAgentStatusFromWorkerRuntimeEvent(event, metadata)
  if (!status) return null
  const isFinal = status !== 'running'
  const stepTitle =
    kind === 'worker-runtime.started'
      ? 'Start Agent runtime'
      : kind === 'worker-runtime.failed'
        ? 'Runtime failed'
        : kind === 'worker-runtime.completed'
          ? 'Runtime completed'
          : event.type === 'worker.message'
            ? 'Agent output'
            : 'Runtime progress'

  return {
    type: 'code-agent-run',
    status,
    runtime,
    command: asString(metadata?.command) ?? runtime,
    cwd: asString(metadata?.cwd) ?? undefined,
    durationMs: asNumber(metadata?.durationMs) ?? 0,
    exitCode: asNumber(metadata?.exitCode) ?? (status === 'failed' || status === 'timed-out' ? 1 : 0),
    commands: [],
    files: [],
    toolCalls: [],
    artifacts: Array.isArray(metadata?.artifacts)
      ? (metadata.artifacts as CodeAgentRunMetadata['artifacts'])
      : [],
    finalMessage: isFinal ? (event.body || asString(metadata?.finalMessage) || undefined) : undefined,
    logs: event.body
      ? [
          {
            id: `timeline-${event.id}`,
            stream: 'event',
            text: event.body,
          },
        ]
      : [],
    steps: [
      {
        id: `timeline-${event.id}`,
        kind: event.type === 'worker.message' ? 'log' : 'status',
        status,
        title: stepTitle,
        detail: event.body || undefined,
      },
    ],
  }
}

function isLiveCodeAgentRunMetadataEvent(event: TimelineEvent) {
  const metadata = asRecord(event.metadata)
  return (
    event.type === 'task.progress' &&
    asString(metadata?.kind) === 'worker-runtime.progress' &&
    asString(metadata?.type) === 'code-agent-run'
  )
}

function shouldHideRuntimeStatusMessage(event: TimelineEvent, room: Room) {
  const kind = asString(asRecord(event.metadata)?.kind)
  if (!kind) return false
  if (INTERNAL_RUNTIME_CHAT_KINDS.has(kind)) return true
  return room.kind === 'direct' && kind === 'worker-runtime.started'
}

function shouldAttachCodeAgentRunToMessage(
  event: TimelineEvent,
  run: CodeAgentRunMetadata | null,
) {
  if (!run) return false
  const kind = asString(asRecord(event.metadata)?.kind)
  return (
    run.status !== 'running' &&
    (kind === 'worker-runtime.completed' ||
      kind === 'worker-runtime.failed' ||
      event.type === 'worker.message')
  )
}

function codeAgentRunMetadataFromRecord(
  value: Record<string, unknown> | null | undefined,
): CodeAgentRunMetadata | null {
  if (!value || value.type !== 'code-agent-run') return null
  const runtime = readCodeAgentRuntime(value)
  const status = readCodeAgentStatus(value.status)
  if (!runtime || !status) return null
  return {
    type: 'code-agent-run',
    status,
    runtime,
    command: asString(value.command) ?? runtime,
    cwd: asString(value.cwd) ?? undefined,
    durationMs: asNumber(value.durationMs) ?? 0,
    exitCode: asNumber(value.exitCode) ?? (status === 'failed' || status === 'timed-out' ? 1 : 0),
    commands: Array.isArray(value.commands) ? (value.commands as CodeAgentRunMetadata['commands']) : [],
    files: Array.isArray(value.files) ? (value.files as CodeAgentRunMetadata['files']) : [],
    toolCalls: Array.isArray(value.toolCalls) ? (value.toolCalls as CodeAgentRunMetadata['toolCalls']) : [],
    artifacts: Array.isArray(value.artifacts) ? (value.artifacts as CodeAgentRunMetadata['artifacts']) : [],
    finalMessage: asString(value.finalMessage) ?? undefined,
    partialSuccess: typeof value.partialSuccess === 'boolean' ? value.partialSuccess : undefined,
    warning: asString(value.warning) ?? undefined,
    reviewRequired: typeof value.reviewRequired === 'boolean' ? value.reviewRequired : undefined,
    logs: Array.isArray(value.logs) ? (value.logs as CodeAgentRunMetadata['logs']) : [],
    steps: Array.isArray(value.steps) ? (value.steps as CodeAgentRunMetadata['steps']) : [],
    diagnostics: asString(value.diagnostics) ?? undefined,
  }
}

function readCodeAgentRuntime(value: Record<string, unknown> | null | undefined) {
  const runtime =
    asString(value?.runtime) ?? asString(value?.runtimeType) ?? asString(value?.codeAgentType)
  if (
    runtime === 'codex' ||
    runtime === 'claude-code' ||
    runtime === 'opencode' ||
    runtime === 'gemini'
  ) {
    return runtime
  }
  return null
}

function codeAgentStatusFromWorkerRuntimeEvent(
  event: TimelineEvent,
  metadata: Record<string, unknown> | null,
): CodeAgentRunMetadata['status'] | null {
  const explicit = readCodeAgentStatus(metadata?.status)
  if (explicit) return explicit
  const kind = asString(metadata?.kind)
  if (kind === 'worker-runtime.completed') return 'completed'
  if (kind === 'worker-runtime.failed') return 'failed'
  if (kind === 'worker-runtime.cancelled') return 'cancelled'
  if (
    kind === 'worker-runtime.started' ||
    kind === 'worker-runtime.progress' ||
    kind === 'worker-runtime.message' ||
    event.type === 'worker.message'
  ) {
    return 'running'
  }
  return null
}

function readCodeAgentStatus(value: unknown): CodeAgentRunMetadata['status'] | null {
  if (
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'timed-out'
  ) {
    return value
  }
  return null
}

function senderTypeFromTimeline(event: TimelineEvent): SenderType {
  if (event.senderType === 'human') return SenderType.User
  if (event.senderType === 'system' || event.type === 'system') return SenderType.System
  return SenderType.Agent
}

function displayNameForEvent(event: TimelineEvent, participant?: RoomParticipant) {
  if (participant?.displayName?.trim()) return participant.displayName.trim()
  if (event.senderType === 'manager') return 'Manager'
  if (event.senderType === 'worker') return 'Worker'
  if (event.senderType === 'human') return '我'
  return '系统'
}

function visibleBodyForEvent(event: TimelineEvent) {
  if (event.type === 'system' && event.metadata?.systemEvent === 'agent_draft_created') return '已生成 Agent 草案。确认后会加入当前 Agent Group。'
  const metadata = asRecord(event.metadata) ?? {}
  if (metadata.hiddenFromChat === true) return ''
  const kind = asString(metadata.kind)
  if (kind && INTERNAL_RUNTIME_CHAT_KINDS.has(kind)) return ''
  if (event.body.trim()) return event.body
  if (event.metadata?.kind === 'manager.dispatch.diagnostic') return ''
  if (event.type === 'approval.requested' && event.metadata?.actionType === 'propose_members') {
    return '我建议补充一些更合适的成员，请确认。'
  }
  if (event.type === 'approval.requested' && event.metadata?.kind === 'controller.apply.approval.requested') {
    return '需要确认 Controller 变更。'
  }
  if (event.type === 'artifact.created') {
    const artifact = asRecord(event.metadata?.artifact)
    return asString(artifact?.title) ?? asString(event.metadata?.title) ?? '产物已创建'
  }
  if (event.type === 'task.progress') return asString(event.metadata?.progressStatus) ?? '任务进度更新'
  if (event.type === 'task.assigned') return asString(event.metadata?.taskTitle) ?? '任务已分配'
  if (event.type === 'approval.requested') return '需要用户确认'
  return ''
}

function normalizeTimelineMessageType(value: unknown): MessageType {
  const text = asString(value)
  if (
    text === MessageType.Text ||
    text === MessageType.Markdown ||
    text === MessageType.Code ||
    text === MessageType.Diff ||
    text === MessageType.Image ||
    text === MessageType.File ||
    text === MessageType.TaskCard ||
    text === MessageType.TaskBoard
  ) {
    return text
  }
  return MessageType.Text
}

function timelineEventToAgUiEvents(
  event: TimelineEvent,
  room: Room,
  sessionId: string,
): RoomTimelineAgUiEvent[] {
  if (event.type === 'task.assigned') {
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
        threadId: room.sessionId ?? sessionId,
        message: event.body,
        value: {
          ...baseTaskValue(event, room, sessionId),
          status: workspaceAgentIdForEvent(event) ? 'assigned' : 'pending',
          taskThreadStatus: workspaceAgentIdForEvent(event) ? 'assigned' : 'prepared',
          progressStatus: event.body,
        },
      },
    ]
  }

  if (event.type === 'task.progress') {
    const status = normalizeWorkerProgressStatus(event)
    const taskThreadStatus = normalizeWorkerTaskThreadStatus(event, status)
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
        threadId: room.sessionId ?? sessionId,
        message: event.body,
        value: {
          ...baseTaskValue(event, room, sessionId),
          status,
          taskThreadStatus,
          waitingForHuman: taskThreadStatus === 'waiting_for_human',
          clarificationId: asString(event.metadata?.clarificationId),
          clarificationQuestion: asString(event.metadata?.clarificationQuestion) ?? asString(event.metadata?.question),
          progressPercent: asNumber(event.metadata?.progressPercent),
          progressStatus: event.body || asString(event.metadata?.progressStatus),
        },
      },
    ]
  }

  if (
    event.type === 'approval.requested' &&
    event.metadata?.kind === 'worker-runtime.clarification-requested'
  ) {
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
        threadId: room.sessionId ?? sessionId,
        message: event.body,
        value: {
          ...baseTaskValue(event, room, sessionId),
          status: 'blocked',
          taskThreadStatus: 'waiting_for_human',
          waitingForHuman: true,
          clarificationId: asString(event.metadata?.clarificationId),
          clarificationQuestion: asString(event.metadata?.question) ?? event.body,
          progressStatus: event.body || asString(event.metadata?.question) || '等待用户澄清',
        },
      },
    ]
  }

  if (event.type === 'artifact.created') {
    const value = {
      ...baseTaskValue(event, room, sessionId),
      ...artifactValueFromEvent(event),
    }
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.artifact.created',
        runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
        threadId: room.sessionId ?? sessionId,
        message: event.body,
        value,
      },
    ]
  }

  if (event.type === 'manager.message') {
    const runStatusEvent = managerTimelineEventToRunStatus(event, room, sessionId)
    return runStatusEvent ? [runStatusEvent] : []
  }

  return []
}

function managerTimelineEventToRunStatus(
  event: TimelineEvent,
  room: Room,
  sessionId: string,
): RoomTimelineAgUiEvent | null {
  if (event.metadata?.kind === 'manager-review-started') {
    return {
      type: 'CUSTOM',
      name: 'agenthub.run.status',
      runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
      threadId: room.sessionId ?? sessionId,
      message: event.body,
      value: {
        status: 'synthesizing',
        runId: asString(event.metadata?.runId) ?? room.runId,
        taskCount: asNumber(event.metadata?.taskCount),
        artifactCount: asNumber(event.metadata?.artifactCount),
        summary: event.body,
        source: 'room-timeline',
      },
    }
  }

  if (event.metadata?.kind === 'manager-final-review') {
    const finalStatus = asString(event.metadata?.finalStatus)
    return {
      type: 'CUSTOM',
      name: 'agenthub.run.status',
      runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
      threadId: room.sessionId ?? sessionId,
      message: event.body,
      value: {
        status: finalStatus === 'failed' ? 'failed' : 'completed',
        runId: asString(event.metadata?.runId) ?? room.runId,
        finalStatus,
        doneCount: asNumber(event.metadata?.doneCount),
        failedCount: asNumber(event.metadata?.failedCount),
        cancelledCount: asNumber(event.metadata?.cancelledCount),
        blockedCount: asNumber(event.metadata?.blockedCount),
        artifactCount: asNumber(event.metadata?.artifactCount),
        summary: event.body,
        source: 'room-timeline',
      },
    }
  }

  const kind = asString(event.metadata?.kind)
  if (kind === 'manager.status.pending' || kind === 'manager.status.slow' || kind === 'manager.status.timeout') {
    return {
      type: 'CUSTOM',
      name: 'agenthub.manager.status',
      runId: asString(event.metadata?.runId) ?? room.runId ?? undefined,
      threadId: room.sessionId ?? sessionId,
      message: event.body,
      value: {
        status:
          kind === 'manager.status.timeout'
            ? 'timeout'
            : kind === 'manager.status.slow'
              ? 'slow'
              : 'processing',
        phase: kind === 'manager.status.timeout' ? 'warning' : 'thinking',
        agentName: asString(event.metadata?.agentName) ?? 'Manager',
        source: 'room-timeline',
        sourceEventId: asString(event.metadata?.sourceEventId),
        diagnostics: event.metadata?.diagnostics,
      },
    }
  }

  return null
}

function dedupeProjectedTimelineMessages(messages: Message[]) {
  const seen = new Set<string>()
  const output: Message[] = []
  for (const message of messages) {
    const metadata = asRecord(message.metadata) ?? {}
    const roomTimeline = asRecord(metadata.roomTimeline)
    const kind = asString(metadata.kind)
    const senderKey = [
      asString(metadata.senderParticipantId) ?? message.senderId,
      message.senderType,
      kind?.startsWith('manager.status.') ? kind : '',
    ].join('|')
    const providerEventId = asString(roomTimeline?.providerEventId)
    const eventId = asString(roomTimeline?.eventId)
    const key = providerEventId
      ? `provider:${providerEventId}`
      : eventId
        ? `event:${eventId}`
        : `body:${senderKey}:${message.content.replace(/\s+/g, ' ').trim()}:${Math.floor(Date.parse(message.createdAt) / 10_000)}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(message)
  }
  return output
}

function baseTaskValue(event: TimelineEvent, room: Room, sessionId: string): Record<string, unknown> {
  return {
    taskId: asString(event.metadata?.taskId) ?? room.taskId,
    taskThreadId: asString(event.metadata?.taskThreadId) ?? room.taskThreadId,
    childSessionId: room.sessionId ?? sessionId,
    sessionId: room.sessionId ?? sessionId,
    roomId: room.id,
    taskTitle: asString(event.metadata?.taskTitle) ?? room.title,
    taskDescription: asString(event.metadata?.taskDescription),
    agentId: workspaceAgentIdForEvent(event),
    agentName: asString(event.metadata?.agentName) ?? asString(event.metadata?.workerName),
    workerInstanceId: asString(event.metadata?.workerInstanceId),
    runtimeLeaseId: asString(event.metadata?.runtimeLeaseId),
    runtimeType: asString(event.metadata?.runtimeType),
    sharedTaskRelativeRoot: asString(event.metadata?.sharedTaskRelativeRoot),
    sharedTaskSpecPath: asString(event.metadata?.sharedTaskSpecPath),
  }
}

function normalizeWorkerProgressStatus(event: TimelineEvent) {
  const raw = asString(event.metadata?.status)
  if (raw === 'completed') return 'done'
  if (raw === 'waiting_for_human' || raw === 'awaiting_human_clarification') return 'blocked'
  if (raw === 'failed' || raw === 'cancelled') return raw
  if (event.metadata?.kind === 'worker-runtime.failed') return 'failed'
  if (event.metadata?.kind === 'worker-runtime.skipped-by-dependency') return 'failed'
  if (event.metadata?.kind === 'worker-runtime.waiting-for-human') return 'blocked'
  if (event.metadata?.kind === 'worker-runtime.waiting-on-human-dependency') return 'blocked'
  const progressStatus = asString(event.metadata?.progressStatus)
  if (progressStatus === 'skipped-by-dependency') return 'failed'
  if (progressStatus === 'waiting_on_dependency_human_clarification') return 'blocked'
  return 'running'
}

function normalizeWorkerTaskThreadStatus(
  event: TimelineEvent,
  status: ReturnType<typeof normalizeWorkerProgressStatus>,
) {
  const raw = asString(event.metadata?.taskThreadStatus) ?? asString(event.metadata?.threadStatus)
  if (
    raw === 'prepared' ||
    raw === 'assigned' ||
    raw === 'active' ||
    raw === 'waiting_for_human' ||
    raw === 'completed' ||
    raw === 'failed' ||
    raw === 'cancelled'
  ) {
    return raw
  }
  if (
    event.metadata?.kind === 'worker-runtime.waiting-for-human' ||
    event.metadata?.kind === 'worker-runtime.waiting-on-human-dependency' ||
    event.metadata?.waitingForHuman === true ||
    status === 'blocked'
  ) {
    return 'waiting_for_human'
  }
  if (event.metadata?.kind === 'worker-runtime.skipped-by-dependency') return 'failed'
  if (status === 'failed' || status === 'cancelled') return status
  if (status === 'done') return 'completed'
  return 'active'
}

function workspaceAgentIdForEvent(event: TimelineEvent) {
  return (
    asString(event.metadata?.workspaceAgentId) ??
    asString(event.metadata?.targetWorkerId) ??
    asString(event.metadata?.agentId)
  )
}

function artifactValueFromEvent(event: TimelineEvent): Record<string, unknown> {
  const artifact = asRecord(event.metadata?.artifact) ?? {}
  return {
    artifact,
    artifactId: asString(event.metadata?.artifactId) ?? asString(artifact.id),
    title: asString(artifact.title) ?? asString(event.metadata?.title) ?? event.body,
    filePath:
      asString(artifact.filePath) ??
      asString(artifact.path) ??
      asString(artifact.storagePath) ??
      asString(artifact.objectKey),
    sourcePath: asString(artifact.sourcePath),
    handoffPath: asString(artifact.handoffPath),
    handoffRelativePath: asString(artifact.handoffRelativePath),
    objectKey: asString(artifact.objectKey),
    bucket: asString(artifact.bucket),
    storageProvider: asString(artifact.storageProvider),
    storagePath: asString(artifact.storagePath),
    artifactKind: asString(artifact.artifactKind) ?? asString(artifact.kind),
    source: asString(artifact.source) ?? 'artifact-store',
    url: asString(artifact.url),
    size: asNumber(artifact.size),
    status: asString(artifact.status),
    visibility: asString(artifact.visibility),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === 'object' && !Array.isArray(item)),
      )
    : []
}
