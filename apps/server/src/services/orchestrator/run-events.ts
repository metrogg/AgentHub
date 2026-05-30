import { db, orchestratorRunEvents, asc, eq } from '@agenthub/db'
import { WsEvent } from '@agenthub/shared'
import { broadcastSessionEvent } from '../agent-runner'
import { logger } from '../../lib/logger'
import { updateProgressLedgerFromEvent } from './run-ledger'
import { buildAgUiEventsFromRunEvent } from '../protocols'

export type OrchestratorRunEventType =
  | 'run.started'
  | 'plan.created'
  | 'plan.validated'
  | 'approval.requested'
  | 'approval.granted'
  | 'phase.started'
  | 'task.queued'
  | 'task.started'
  | 'task.stream'
  | 'blackboard.written'
  | 'artifact.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.retrying'
  | 'task.reassigned'
  | 'run.replanned'
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
  agentId?: string | null
  type: OrchestratorRunEventType
  payload?: Record<string, unknown>
  severity?: OrchestratorRunEventSeverity
}

export type OrchestratorRunEvent = typeof orchestratorRunEvents.$inferSelect

export async function emitRunEvent(input: EmitRunEventInput): Promise<OrchestratorRunEvent> {
  const [event] = await db
    .insert(orchestratorRunEvents)
    .values({
      runId: input.runId,
      workspaceId: input.workspaceId,
      groupSessionId: input.groupSessionId,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      type: input.type,
      payload: input.payload ?? {},
      severity: input.severity ?? 'info',
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

export async function listRunEvents(runId: string): Promise<OrchestratorRunEvent[]> {
  return db
    .select()
    .from(orchestratorRunEvents)
    .where(eq(orchestratorRunEvents.runId, runId))
    .orderBy(asc(orchestratorRunEvents.createdAt))
}
