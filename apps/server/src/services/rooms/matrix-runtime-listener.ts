import { and, db, eq, matrixIdentities, roomParticipants, rooms, timelineEvents } from '@agenthub/db'
import { createMatrixClientFromEnv, type MatrixClient, type MatrixSyncRoomEvent } from './matrix-client'
import { roomService } from './room-service'
import type { ParticipantType, TimelineEventType } from './types'

export interface MatrixRuntimeListenerSyncInput {
  identityId: string
  since?: string | null
  timeoutMs?: number
  dispatch?: boolean
}

export interface MatrixRuntimeListenerLoopInput {
  identityId: string
  pollIntervalMs?: number
  timeoutMs?: number
  dispatch?: boolean
  signal?: AbortSignal
}

export interface MatrixRuntimeListenerLoopHandle {
  identityId: string
  stop(): void
  stopped: Promise<void>
}

export interface MatrixRuntimeListenerSyncResult {
  identityId: string
  nextBatch: string | null
  importedEventIds: string[]
  dispatchedEventIds: string[]
  ignoredEventCount: number
}

export class MatrixRuntimeListener {
  private readonly loops = new Map<string, MatrixRuntimeListenerLoopHandle>()

  constructor(private readonly configuredClient?: MatrixClient) {}

  async syncOnce(input: MatrixRuntimeListenerSyncInput): Promise<MatrixRuntimeListenerSyncResult> {
    const client = this.configuredClient ?? createMatrixClientFromEnv()
    const [identity] = await db.select().from(matrixIdentities).where(eq(matrixIdentities.id, input.identityId)).limit(1)
    if (!identity?.accessToken) {
      throw new Error(`Matrix identity is missing an access token: ${input.identityId}`)
    }
    const since = input.since ?? matrixSyncState(identity.metadata).nextBatch ?? null
    const synced = await client.sync({
      accessToken: identity.accessToken,
      since,
      timeoutMs: input.timeoutMs ?? 0,
    })
    const importedEventIds: string[] = []
    let ignoredEventCount = 0
    const joinedRooms = synced.rooms?.join ?? {}
    for (const [providerRoomId, joinedRoom] of Object.entries(joinedRooms)) {
      const localRoom = await findLocalRoom(providerRoomId)
      if (!localRoom) {
        ignoredEventCount += joinedRoom.timeline?.events?.length ?? 0
        continue
      }
      for (const event of joinedRoom.timeline?.events ?? []) {
        const imported = await importMatrixEvent(localRoom.id, event)
        if (imported) importedEventIds.push(imported.id)
        else ignoredEventCount += 1
      }
    }
    await db
      .update(matrixIdentities)
      .set({
        metadata: {
          ...(identity.metadata ?? {}),
          matrixSync: {
            ...matrixSyncState(identity.metadata),
            nextBatch: synced.next_batch ?? null,
            lastSyncedAt: new Date().toISOString(),
            lastOkAt: new Date().toISOString(),
            consecutiveErrors: 0,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(matrixIdentities.id, identity.id))
    const dispatchedEventIds =
      input.dispatch === false || importedEventIds.length === 0
        ? []
        : await dispatchImportedEvents(importedEventIds)
    return {
      identityId: identity.id,
      nextBatch: synced.next_batch ?? null,
      importedEventIds,
      dispatchedEventIds,
      ignoredEventCount,
    }
  }

  start(input: MatrixRuntimeListenerLoopInput): MatrixRuntimeListenerLoopHandle {
    const existing = this.loops.get(input.identityId)
    if (existing) return existing
    const controller = new AbortController()
    const stop = () => controller.abort()
    const stopped = this.runLoop({
      ...input,
      signal: combinedSignal(input.signal, controller.signal),
    }).finally(() => {
      this.loops.delete(input.identityId)
    })
    const handle = {
      identityId: input.identityId,
      stop,
      stopped,
    }
    this.loops.set(input.identityId, handle)
    return handle
  }

  stop(identityId: string) {
    this.loops.get(identityId)?.stop()
  }

  isRunning(identityId: string) {
    return this.loops.has(identityId)
  }

  getRunningIdentityIds() {
    return Array.from(this.loops.keys())
  }

  private async runLoop(input: MatrixRuntimeListenerLoopInput) {
    const pollIntervalMs = Math.max(50, input.pollIntervalMs ?? 1000)
    let consecutiveErrors = 0
    while (!input.signal?.aborted) {
      try {
        await this.syncOnce({
          identityId: input.identityId,
          timeoutMs: input.timeoutMs ?? pollIntervalMs,
          dispatch: input.dispatch,
        })
        consecutiveErrors = 0
        await sleep(pollIntervalMs, input.signal)
      } catch (error) {
        consecutiveErrors += 1
        await recordSyncLoopError(input.identityId, error, consecutiveErrors)
        const backoffMs = Math.min(pollIntervalMs * Math.max(1, consecutiveErrors), 30_000)
        await sleep(backoffMs, input.signal)
      }
    }
  }
}

async function recordSyncLoopError(identityId: string, error: unknown, consecutiveErrors: number) {
  const [identity] = await db.select().from(matrixIdentities).where(eq(matrixIdentities.id, identityId)).limit(1)
  if (!identity) return
  await db
    .update(matrixIdentities)
    .set({
      metadata: {
        ...(identity.metadata ?? {}),
        matrixSync: {
          ...matrixSyncState(identity.metadata),
          lastErrorAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
          consecutiveErrors,
        },
      },
      updatedAt: new Date(),
    })
    .where(eq(matrixIdentities.id, identityId))
}

async function importMatrixEvent(roomId: string, event: MatrixSyncRoomEvent) {
  if (event.type !== 'm.room.message' || !event.event_id) return null
  const [existing] = await db
    .select({ id: timelineEvents.id })
    .from(timelineEvents)
    .where(and(eq(timelineEvents.roomId, roomId), eq(timelineEvents.providerEventId, event.event_id)))
    .limit(1)
  if (existing) return null
  const content = event.content ?? {}
  const body = typeof content.body === 'string' ? content.body : ''
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : 'm.text'
  const sender = event.sender ?? null
  const senderParticipant = sender ? await ensureParticipantForMatrixSender(roomId, sender) : null
  const mentions = parseMatrixMentions(content, body)
  const mentionedParticipantIds = await findMentionedParticipantIds(roomId, mentions)
  const eventType = timelineEventTypeFor(msgtype, senderParticipant?.participantType)
  return roomService.importTimelineEvent({
    roomId,
    providerEventId: event.event_id,
    senderParticipantId: senderParticipant?.id ?? null,
    senderType: senderParticipant?.participantType ?? participantTypeFromMatrixUserId(sender),
    type: eventType,
    body,
    metadata: {
      kind: 'matrix.sync.imported',
      matrix: {
        eventId: event.event_id,
        senderUserId: sender,
        msgtype,
        originServerTs: event.origin_server_ts ?? null,
        mentions,
        mentionedParticipantIds,
        file: fileRefFromContent(content),
      },
    },
  })
}

async function dispatchImportedEvents(eventIds: string[]) {
  const { matrixRoomEventDispatcher } = await import('./matrix-event-dispatcher')
  const result = await matrixRoomEventDispatcher.dispatchImportedEvents({ eventIds })
  return result.dispatchedEventIds
}

async function findLocalRoom(providerRoomId: string) {
  const [room] = await db
    .select()
    .from(rooms)
    .where(and(eq(rooms.provider, 'matrix'), eq(rooms.providerRoomId, providerRoomId)))
    .limit(1)
  return room ?? null
}

async function ensureParticipantForMatrixSender(roomId: string, matrixUserId: string) {
  const [existing] = await db
    .select()
    .from(roomParticipants)
    .where(and(eq(roomParticipants.roomId, roomId), eq(roomParticipants.providerUserId, matrixUserId)))
    .limit(1)
  if (existing) return existing
  const participantType = participantTypeFromMatrixUserId(matrixUserId)
  const [participant] = await db
    .insert(roomParticipants)
    .values({
      roomId,
      providerUserId: matrixUserId,
      participantType,
      displayName: displayNameFromMatrixUserId(matrixUserId),
      role: participantType === 'human' ? 'observer' : participantType === 'manager' ? 'manager' : 'member',
      status: 'joined',
      metadata: {
        matrixMembership: {
          provider: 'matrix',
          providerUserId: matrixUserId,
          discoveredBySync: true,
        },
      },
    })
    .returning()
  return participant ?? null
}

async function findMentionedParticipantIds(roomId: string, userIds: string[]) {
  if (!userIds.length) return []
  const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, roomId))
  const byUserId = new Map(participants.map((participant) => [participant.providerUserId, participant.id]))
  return userIds.map((userId) => byUserId.get(userId)).filter((id): id is string => Boolean(id))
}

function timelineEventTypeFor(msgtype: string, participantType?: ParticipantType | null): TimelineEventType {
  if (msgtype === 'm.file' || msgtype === 'm.image' || msgtype === 'm.video' || msgtype === 'm.audio') return 'file.shared'
  if (participantType === 'manager') return 'manager.message'
  if (participantType === 'worker') return 'worker.message'
  if (participantType === 'system') return 'system'
  return 'human.message'
}

function participantTypeFromMatrixUserId(userId?: string | null): ParticipantType {
  if (!userId) return 'human'
  const localpart = userId.replace(/^@/, '').replace(/:.+$/, '')
  if (localpart.startsWith('manager-')) return 'manager'
  if (localpart.startsWith('worker-')) return 'worker'
  if (localpart.startsWith('system-')) return 'system'
  return 'human'
}

function displayNameFromMatrixUserId(userId: string) {
  return userId.replace(/^@/, '').replace(/:.+$/, '')
}

function parseMatrixMentions(content: Record<string, unknown>, body: string) {
  const explicit = content['m.mentions']
  const userIds = new Set<string>()
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    const ids = (explicit as Record<string, unknown>).user_ids
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'string' && id.startsWith('@')) userIds.add(id)
      }
    }
  }
  const formattedBody = typeof content.formatted_body === 'string' ? content.formatted_body : ''
  for (const source of [body, formattedBody]) {
    const matches = source.matchAll(/@[-a-zA-Z0-9._=]+:[-a-zA-Z0-9.:]+/g)
    for (const match of matches) userIds.add(match[0])
  }
  const matrixToMatches = formattedBody.matchAll(/matrix\.to\/#\/(@[^"'<\s]+)/g)
  for (const match of matrixToMatches) {
    if (match[1]) userIds.add(decodeURIComponent(match[1]))
  }
  return Array.from(userIds)
}

function fileRefFromContent(content: Record<string, unknown>) {
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : null
  if (!msgtype || !['m.file', 'm.image', 'm.video', 'm.audio'].includes(msgtype)) return null
  return {
    msgtype,
    name: typeof content.body === 'string' ? content.body : null,
    url: typeof content.url === 'string' ? content.url : null,
    info: content.info && typeof content.info === 'object' ? content.info : null,
  }
}

function matrixSyncState(metadata: Record<string, unknown> | null | undefined) {
  const state = metadata?.matrixSync
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {}
  return state as { nextBatch?: string | null; lastSyncedAt?: string | null }
}

export const matrixRuntimeListener = new MatrixRuntimeListener()

function combinedSignal(a?: AbortSignal, b?: AbortSignal) {
  if (!a) return b
  if (!b) return a
  const controller = new AbortController()
  const abort = () => controller.abort()
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  if (a.aborted || b.aborted) controller.abort()
  return controller.signal
}

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}
