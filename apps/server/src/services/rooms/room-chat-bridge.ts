import { and, asc, db, eq, roomParticipants, sessions, workspaceAgents } from '@agenthub/db'
import type { MessageRow } from '../agent-runner'
import type { ManagerRuntime } from '../manager-runtime'
import { workerController } from '../orchestrator/worker-controller'
import { ensureManagerParticipantForRoom } from './manager-participant'
import type { WorkerRuntime } from '../worker-runtime'
import { roomService } from './room-service'

export interface AppendHumanMessageRoomFirstInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  content: string
  type: string
  metadata?: Record<string, unknown> | null
  replyToMessageId?: string | null
  /** Skip auto-dispatch. Used by tests that need to control dispatch timing. */
  skipDispatch?: boolean
}

export interface AppendMessageControlEventInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  kind: 'message.clear' | 'message.edit' | 'message.redact' | 'message.pin'
  body?: string
  metadata?: Record<string, unknown>
}

export async function appendHumanMessageRoomFirst(input: AppendHumanMessageRoomFirstInput) {
  const room = await roomService.ensureRoomForSession(input.session.id, input.session.ownerId)
  await ensureSessionRoomParticipants({
    roomId: room.id,
    session: input.session,
    userId: input.userId,
    userName: input.userName,
  })
  const human = await ensureHumanParticipant(room.id, input.userId, input.userName)

  let matrixMentions: string[] | undefined
  const mentionAgentIds = await resolveMentionedAgentIds(input.session, input.content, input.metadata?.mentions)
  if (mentionAgentIds.length > 0) {
    const participants = await db
      .select()
      .from(roomParticipants)
      .where(eq(roomParticipants.roomId, room.id))
    const participantIdByAgentId = new Map(
      participants
        .filter((p) => p.participantType === 'worker' && p.workspaceAgentId)
        .map((p) => [p.workspaceAgentId!, p.id]),
    )
    const managerParticipant = participants.find((p) => p.participantType === 'manager') ?? null
    const orchestratorAgentIds = await listSessionOrchestratorAgentIds(input.session)
    matrixMentions = mentionAgentIds
      .map((id) => {
        const agentId = typeof id === 'string' ? id : ''
        return participantIdByAgentId.get(agentId) ?? (orchestratorAgentIds.has(agentId) ? managerParticipant?.id : null)
      })
      .filter((id): id is string => Boolean(id))
  }

  const eventInput = {
    roomId: room.id,
    senderParticipantId: human.id,
    senderType: 'human',
    type: 'human.message',
    body: input.content,
    metadata: {
      ...(input.metadata ?? {}),
      kind: 'chat.message',
      sessionId: input.session.id,
      messageType: input.type,
      replyToMessageId: input.replyToMessageId ?? null,
      source: 'room-first',
      ...(input.skipDispatch ? { skipAutoDispatch: true } : {}),
      ...(matrixMentions?.length ? { matrix: { mentionedParticipantIds: matrixMentions } } : {}),
    },
  } as const
  const event =
    matrixMentions?.length === 1
      ? await roomService.appendMentionTimelineEvent({
          ...eventInput,
          mentionParticipantId: matrixMentions[0]!,
        })
      : await roomService.appendTimelineEvent(eventInput)
  const message: MessageRow = {
    id: `room:${event.id}`,
    sessionId: input.session.id,
    senderId: input.userId,
    senderType: 'user',
    type: input.type,
    content: input.content,
    metadata: {
      ...(input.metadata ?? {}),
      roomTimelineProjection: {
        source: 'room-first',
        roomId: room.id,
        roomKind: room.kind,
        providerRoomId: room.providerRoomId,
        eventId: event.id,
        providerEventId: event.providerEventId,
        sequence: event.sequence,
        eventType: event.type,
      },
    },
    isPinned: false,
    replyToMessageId: input.replyToMessageId ?? null,
    createdAt: event.createdAt,
  }

  // HiClaw model: dispatch is now handled automatically by roomService.appendTimelineEvent().
  // No explicit dispatch call needed here.

  return { room, event, message }
}

export async function appendMessageControlEvent(input: AppendMessageControlEventInput) {
  const room = await roomService.ensureRoomForSession(input.session.id, input.session.ownerId)
  await ensureSessionRoomParticipants({
    roomId: room.id,
    session: input.session,
    userId: input.userId,
    userName: input.userName,
  })
  const human = await ensureHumanParticipant(room.id, input.userId, input.userName)
  const event = await roomService.appendTimelineEvent({
    roomId: room.id,
    senderParticipantId: human.id,
    senderType: 'human',
    type: 'system',
    body: input.body ?? '',
    metadata: {
      ...(input.metadata ?? {}),
      kind: input.kind,
      sessionId: input.session.id,
      actorUserId: input.userId,
      source: 'room-timeline-control',
    },
  })
  return { room, event }
}

export interface RecordHumanMessageInput {
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
  message: MessageRow
  runtime?: ManagerRuntime
  workerRuntime?: WorkerRuntime
}

export async function recordHumanMessageInRoomTimeline(input: RecordHumanMessageInput) {
  const room = await roomService.ensureRoomForSession(input.session.id, input.session.ownerId)
  await ensureSessionRoomParticipants({
    roomId: room.id,
    session: input.session,
    userId: input.userId,
    userName: input.userName,
  })
  const existingEvents = await roomService.listTimelineEvents({ roomId: room.id, limit: 500 })
  const projectedEventId = projectedEventIdFromMessage(input.message)
  const hasEvent = existingEvents.some((event) => {
    if (event.metadata?.messageId === input.message.id) return true
    if (event.metadata?.projectionMessageId === input.message.id) return true
    return Boolean(projectedEventId && event.id === projectedEventId)
  })
  if (hasEvent) return room
  const human = await ensureHumanParticipant(room.id, input.userId, input.userName)
  await roomService.appendTimelineEvent({
    roomId: room.id,
    senderParticipantId: human.id,
    senderType: 'human',
    type: 'human.message',
    body: input.message.content,
    metadata: {
      kind: 'chat.message',
      messageId: input.message.id,
      sessionId: input.session.id,
      messageType: input.message.type,
      replyToMessageId: input.message.replyToMessageId ?? null,
      ...(input.message.metadata ?? {}),
    },
  })
  return room
}

function projectedEventIdFromMessage(message: MessageRow) {
  if (!message.id.startsWith('room:')) return null
  const eventId = message.id.slice('room:'.length).trim()
  return eventId || null
}

async function ensureSessionRoomParticipants(input: {
  roomId: string
  session: typeof sessions.$inferSelect
  userId: string
  userName?: string | null
}) {
  await ensureHumanParticipant(input.roomId, input.userId, input.userName)

  if (input.session.type === 'direct') {
    if (input.session.workspaceAgentId) {
      const [agent] = await db
        .select()
        .from(workspaceAgents)
        .where(eq(workspaceAgents.id, input.session.workspaceAgentId))
        .limit(1)
      if (agent) {
        if (agent.roleType === 'orchestrator') {
          // Orchestrator direct rooms go through the Manager runtime path;
          // they need a manager participant so OpenClaw can bind the room.
          await ensureManagerParticipantForRoom(input.roomId)
        } else {
          await ensureWorkerParticipantForAgent(input.roomId, input.session.workspaceId, agent)
        }
      } else {
        await roomService.addWorkerParticipant(input.roomId, input.session.workspaceAgentId)
      }
    }
    return
  }

  await ensureManagerParticipantForRoom(input.roomId)
  if (!input.session.workspaceId) return
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, input.session.workspaceId))
    .orderBy(asc(workspaceAgents.orderIdx), asc(workspaceAgents.createdAt))
  for (const agent of agents) {
    if (agent.roleType === 'orchestrator') continue
    await ensureWorkerParticipantForAgent(input.roomId, input.session.workspaceId, agent)
  }
}

async function ensureWorkerParticipantForAgent(
  roomId: string,
  workspaceId: string | null,
  agent: typeof workspaceAgents.$inferSelect,
) {
  let workerInstanceId: string | null = null
  if (workspaceId) {
    workerInstanceId = await workerController.ensureWorkerForAgent(workspaceId, {
      id: agent.id,
      runtimeType: agent.runtimeType,
      codeAgentType: agent.codeAgentType,
      roleProfile: agent.roleProfile,
      modelId: agent.modelId,
      skillIds: agent.skillIds,
      sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
    }).catch(() => null)
  }
  return roomService.addWorkerParticipant(roomId, agent.id, workerInstanceId)
}

async function ensureHumanParticipant(roomId: string, userId: string, userName?: string | null) {
  return roomService.addParticipant({
    roomId,
    participantType: 'human',
    userId,
    displayName: userName || 'You',
    role: 'owner',
  })
}

async function listSessionOrchestratorAgentIds(session: typeof sessions.$inferSelect) {
  if (session.type !== 'group' || !session.workspaceId) return new Set<string>()
  const rows = await db
    .select({ id: workspaceAgents.id })
    .from(workspaceAgents)
    .where(and(eq(workspaceAgents.workspaceId, session.workspaceId), eq(workspaceAgents.roleType, 'orchestrator')))
  return new Set(rows.map((row) => row.id))
}

async function resolveMentionedAgentIds(
  session: typeof sessions.$inferSelect,
  text: string,
  rawMentions: unknown,
) {
  const ids: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(rawMentions)) {
    for (const id of rawMentions) {
      if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  if (session.type !== 'group' || !session.workspaceId || !text.includes('@')) return ids
  const agents = await db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, session.workspaceId))
  const entries = mentionAliasEntries(agents)
  if (!entries.length) return ids
  const pattern = new RegExp(
    `@(${entries.map((entry) => escapeRegExp(entry.alias)).join('|')})(?=$|\\s|[，,。.!！?？:：；;）)\\]】])`,
    'gi',
  )
  const aliasToAgentId = new Map(entries.map((entry) => [entry.alias.toLowerCase(), entry.agentId]))
  for (const match of text.matchAll(pattern)) {
    const rawAlias = (match[1] ?? '').trim().toLowerCase()
    const agentId = aliasToAgentId.get(rawAlias)
    if (!agentId || seen.has(agentId)) continue
    seen.add(agentId)
    ids.push(agentId)
  }
  return ids
}

function mentionAliasEntries(agents: Array<typeof workspaceAgents.$inferSelect>) {
  const entries: Array<{ alias: string; agentId: string }> = []
  for (const agent of agents) {
    entries.push(
      { alias: agent.name, agentId: agent.id },
      { alias: agent.role, agentId: agent.id },
    )
    if (agent.roleType === 'orchestrator') {
      entries.push(
        { alias: 'orchestrator', agentId: agent.id },
        { alias: 'manager', agentId: agent.id },
        { alias: 'coordinator', agentId: agent.id },
        { alias: '总指挥', agentId: agent.id },
        { alias: '协调器', agentId: agent.id },
        { alias: '调度', agentId: agent.id },
        { alias: '管理员', agentId: agent.id },
      )
    }
  }
  const deduped = new Map<string, string>()
  for (const entry of entries) {
    const alias = entry.alias.trim()
    if (!alias) continue
    const key = alias.toLowerCase()
    if (!deduped.has(key)) deduped.set(key, entry.agentId)
  }
  return Array.from(deduped.entries())
    .map(([alias, agentId]) => ({ alias, agentId }))
    .sort((a, b) => b.alias.length - a.alias.length)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
