import { inArray } from 'drizzle-orm'
import { and, db, rooms, sql, timelineEvents } from '@agenthub/db'

const PREVIEW_EVENT_TYPES: Array<typeof timelineEvents.$inferSelect.type> = [
  'human.message',
  'manager.message',
  'worker.message',
  'task.assigned',
  'task.progress',
  'artifact.created',
  'approval.requested',
  'system',
]

const INTERNAL_RUNTIME_PREVIEW_KINDS = new Set([
  'worker-runtime.message',
  'worker-runtime.started',
  'worker-runtime.progress',
  'worker-runtime.heartbeat',
  'worker-runtime.busy',
  'worker-runtime.claimed',
  'worker-runtime.resident-assignment',
  'worker-runtime.group-mention-started',
  'worker-runtime.group-mention-dispatched',
  'worker-runtime.waiting-for-human',
  'worker-runtime.waiting-on-human-dependency',
  'worker-runtime.failed',
])

export async function listRoomLastMessagePreviews(sessionIds: string[]) {
  if (!sessionIds.length) return {}
  const rankedTimeline = db
    .select({
      sessionId: rooms.sessionId,
      content: timelineEvents.body,
      senderType: timelineEvents.senderType,
      metadata: timelineEvents.metadata,
      rank: sql<number>`row_number() over (partition by ${rooms.sessionId} order by ${timelineEvents.sequence} desc, ${timelineEvents.id} desc)`.as(
        'rank',
      ),
    })
    .from(timelineEvents)
    .innerJoin(rooms, sql`${rooms.id} = ${timelineEvents.roomId}`)
    .where(
      and(
        inArray(rooms.sessionId, sessionIds),
        inArray(timelineEvents.type, PREVIEW_EVENT_TYPES),
        sql`trim(${timelineEvents.body}) <> ''`,
      ),
    )
    .as('ranked_timeline')

  const latestRows = await db
    .select({
      sessionId: rankedTimeline.sessionId,
      content: rankedTimeline.content,
      senderType: rankedTimeline.senderType,
      metadata: rankedTimeline.metadata,
    })
    .from(rankedTimeline)
    .where(sql`${rankedTimeline.rank} = 1`)

  const previews: Record<string, { content: string; senderType: string }> = {}
  for (const row of latestRows) {
    if (!row.sessionId) continue
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {}
    if (metadata.hiddenFromChat === true) continue
    const kind = typeof metadata.kind === 'string' ? metadata.kind : ''
    if (kind.startsWith('manager.status.') || kind === 'manager.dispatch.diagnostic') continue
    if (INTERNAL_RUNTIME_PREVIEW_KINDS.has(kind)) continue
    previews[row.sessionId] = {
      content: row.content.slice(0, 120),
      senderType: timelineSenderTypeToMessageSenderType(row.senderType),
    }
  }
  return previews
}

function timelineSenderTypeToMessageSenderType(senderType: string) {
  if (senderType === 'human') return 'user'
  if (senderType === 'system') return 'system'
  return 'agent'
}
