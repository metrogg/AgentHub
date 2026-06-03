import { db, orchestratorRunEvents, and, asc, desc, eq, sql, databasePath } from '@agenthub/db'
import { Database } from 'bun:sqlite'
import { WsEvent } from '@agenthub/shared'
import { broadcastSessionEvent } from '../agent-runner'
import { logger } from '../../lib/logger'
import { updateProgressLedgerFromEvent } from './run-ledger'
import { buildAgUiEventsFromRunEvent } from '../protocols'

export type OrchestratorRunEventType =
  | 'manager.thinking'
  | 'manager.intent_observed'
  | 'manager.next_action'
  | 'run.started'
  | 'plan.created'
  | 'plan.validated'
  | 'approval.requested'
  | 'approval.granted'
  | 'phase.started'
  | 'phase.completed'
  | 'task.queued'
  | 'task.started'
  | 'task.progress'
  | 'task.stream'
  | 'task.planned'
  | 'thread.prepared'
  | 'task.assigned'
  | 'worker.message.sent'
  | 'blackboard.written'
  | 'artifact.created'
  | 'manager.reviewed'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.rework_requested'
  | 'task.retrying'
  | 'task.reassigned'
  | 'task.clarification_needed'
  | 'run.replanned'
  | 'member_proposal.continued'
  | 'conflict.detected'
  | 'conflict.resolved'
  | 'run.synthesizing'
  | 'run.completed'
  | 'run.cancelled'
  | 'run.failed'

export type OrchestratorRunEventSeverity = 'debug' | 'info' | 'warning' | 'error'

export interface EmitRunEventInput {
  runId: string
  workspaceId: string
  groupSessionId: string
  taskId?: string | null
  threadId?: string | null
  workerInstanceId?: string | null
  agentId?: string | null
  type: OrchestratorRunEventType
  payload?: Record<string, unknown>
  severity?: OrchestratorRunEventSeverity
}

export type OrchestratorRunEvent = typeof orchestratorRunEvents.$inferSelect

let runEventReplaySchemaEnsured = false

function ensureRunEventReplaySchema() {
  if (runEventReplaySchemaEnsured) return
  const sqlite = new Database(databasePath, { create: true })
  try {
    const columns = sqlite
      .query('PRAGMA table_info(orchestrator_run_events)')
      .all() as Array<{ name: string }>
    const hasSequence = columns.some((column) => column.name === 'sequence')
    const hasThreadId = columns.some((column) => column.name === 'thread_id')
    const hasWorkerInstanceId = columns.some((column) => column.name === 'worker_instance_id')
    if (!hasThreadId) {
      sqlite.exec('ALTER TABLE orchestrator_run_events ADD COLUMN thread_id TEXT')
    }
    if (!hasWorkerInstanceId) {
      sqlite.exec('ALTER TABLE orchestrator_run_events ADD COLUMN worker_instance_id TEXT')
    }
    if (!hasSequence) {
      sqlite.exec(
        'ALTER TABLE orchestrator_run_events ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0',
      )
    }
    sqlite.exec(
      'CREATE INDEX IF NOT EXISTS orchestrator_run_events_run_id_idx ON orchestrator_run_events(run_id)',
    )
    sqlite.exec(
      'CREATE INDEX IF NOT EXISTS orchestrator_run_events_thread_id_idx ON orchestrator_run_events(thread_id)',
    )
    runEventReplaySchemaEnsured = true
  } finally {
    sqlite.close()
  }
}

export async function emitRunEvent(input: EmitRunEventInput): Promise<OrchestratorRunEvent> {
  ensureRunEventReplaySchema()
  const duplicate = await findDuplicateRunEvent(input)
  if (duplicate) return duplicate
  const sequence = await nextRunEventSequence(input.runId)

  const [event] = await db
    .insert(orchestratorRunEvents)
    .values({
      runId: input.runId,
      workspaceId: input.workspaceId,
      groupSessionId: input.groupSessionId,
      taskId: input.taskId ?? null,
      threadId: input.threadId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      agentId: input.agentId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      severity: input.severity ?? 'info',
      sequence,
    })
    .returning()

  if (!event) {
    throw new Error('Failed to create orchestrator run event')
  }

  try {
    await updateProgressLedgerFromEvent(input)
  } catch (err: any) {
    logger.warn(
      { err: err?.message, runId: input.runId, eventType: input.type },
      'Failed to update progress ledger',
    )
  }

  const agUiEvents = buildAgUiEventsFromRunEvent(input)
  for (const agUiEvent of agUiEvents) {
    broadcastSessionEvent(input.groupSessionId, {
      type: WsEvent.AgUiEvent,
      payload: agUiEvent,
    })
  }

  return event
}

async function findDuplicateRunEvent(input: EmitRunEventInput): Promise<OrchestratorRunEvent | null> {
  if (input.type !== 'phase.completed') return null
  const phaseId = typeof input.payload?.phaseId === 'string' ? input.payload.phaseId : null
  if (!phaseId) return null

  const recentEvents = await db
    .select()
    .from(orchestratorRunEvents)
    .where(and(eq(orchestratorRunEvents.runId, input.runId), eq(orchestratorRunEvents.type, input.type)))
    .orderBy(desc(orchestratorRunEvents.createdAt))
    .limit(50)

  return (
    recentEvents.find((event) => {
      const payload = event.payload
      return payload && typeof payload === 'object' && !Array.isArray(payload) && payload.phaseId === phaseId
    }) ?? null
  )
}

export async function listRunEvents(
  runId: string,
  options: { afterSequence?: number } = {},
): Promise<OrchestratorRunEvent[]> {
  ensureRunEventReplaySchema()
  if (typeof options.afterSequence === 'number' && options.afterSequence > 0) {
    return db
      .select()
      .from(orchestratorRunEvents)
      .where(
        and(
          eq(orchestratorRunEvents.runId, runId),
          sql`${orchestratorRunEvents.sequence} > ${options.afterSequence}`,
        ),
      )
      .orderBy(asc(orchestratorRunEvents.sequence), asc(orchestratorRunEvents.createdAt))
  }
  return db
    .select()
    .from(orchestratorRunEvents)
    .where(eq(orchestratorRunEvents.runId, runId))
    .orderBy(asc(orchestratorRunEvents.sequence), asc(orchestratorRunEvents.createdAt))
}

async function nextRunEventSequence(runId: string): Promise<number> {
  const [latest] = await db
    .select({ sequence: orchestratorRunEvents.sequence })
    .from(orchestratorRunEvents)
    .where(eq(orchestratorRunEvents.runId, runId))
    .orderBy(desc(orchestratorRunEvents.sequence), desc(orchestratorRunEvents.createdAt))
    .limit(1)
  return (latest?.sequence ?? 0) + 1
}
