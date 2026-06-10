import { and, db, eq, rooms, sql, timelineEvents } from '@agenthub/db'
import type { AppendTimelineEventInput } from './types'

const sequenceRetryLimit = 20

export async function insertTimelineEventWithAllocatedSequence(
  input: AppendTimelineEventInput & { providerEventId: string },
  options: { failureMessage?: string } = {},
) {
  let lastSequenceError: unknown = null

  for (let attempt = 0; attempt < sequenceRetryLimit; attempt += 1) {
    const existing = await findTimelineEventByProviderId(input.roomId, input.providerEventId)
    if (existing) return existing

    const sequenceRows = await db
      .select({ nextSequence: sql<number>`coalesce(max(${timelineEvents.sequence}), 0) + 1` })
      .from(timelineEvents)
      .where(eq(timelineEvents.roomId, input.roomId))
    const nextSequence = sequenceRows[0]?.nextSequence ?? 1

    try {
      const [event] = await db
        .insert(timelineEvents)
        .values({
          roomId: input.roomId,
          providerEventId: input.providerEventId,
          senderParticipantId: input.senderParticipantId ?? null,
          senderType: input.senderType,
          type: input.type,
          body: input.body ?? '',
          metadata: input.metadata ?? {},
          sequence: nextSequence,
        })
        .onConflictDoNothing({
          target: [timelineEvents.roomId, timelineEvents.providerEventId],
        })
        .returning()

      if (event) {
        await db.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, input.roomId))
        return event
      }

      const existingAfterConflict = await findTimelineEventByProviderId(input.roomId, input.providerEventId)
      if (existingAfterConflict) return existingAfterConflict
      throw new Error(options.failureMessage ?? 'Timeline event create failed')
    } catch (error) {
      if (!isTimelineSequenceConflict(error)) throw error
      lastSequenceError = error
      await waitForSequenceRetry(attempt)
    }
  }

  const detail = lastSequenceError instanceof Error ? `: ${lastSequenceError.message}` : ''
  throw new Error(`Timeline event sequence allocation failed after ${sequenceRetryLimit} attempts${detail}`)
}

async function findTimelineEventByProviderId(roomId: string, providerEventId: string) {
  const [existing] = await db
    .select()
    .from(timelineEvents)
    .where(and(eq(timelineEvents.roomId, roomId), eq(timelineEvents.providerEventId, providerEventId)))
    .limit(1)
  return existing ?? null
}

function isTimelineSequenceConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('timeline_events_room_sequence_unique') ||
    (message.includes('UNIQUE constraint failed') &&
      message.includes('timeline_events') &&
      message.includes('sequence'))
  )
}

function waitForSequenceRetry(attempt: number) {
  const delayMs = Math.min(25, attempt * 5)
  if (delayMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}
