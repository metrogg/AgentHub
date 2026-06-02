import { db, orchestratorRunEvents, and, asc, desc, eq } from '@agenthub/db'
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
  | 'phase.completed'
  | 'task.queued'
  | 'task.started'
  | 'task.progress'
  | 'task.stream'
  | 'blackboard.written'
  | 'artifact.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
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
  agentId?: string | null
  type: OrchestratorRunEventType
  payload?: Record<string, unknown>
  severity?: OrchestratorRunEventSeverity
}

export type OrchestratorRunEvent = typeof orchestratorRunEvents.$inferSelect

export async function emitRunEvent(input: EmitRunEventInput): Promise<OrchestratorRunEvent> {
  const duplicate = await findDuplicateRunEvent(input)
  if (duplicate) return duplicate

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

export async function listRunEvents(runId: string): Promise<OrchestratorRunEvent[]> {
  return db
    .select()
    .from(orchestratorRunEvents)
    .where(eq(orchestratorRunEvents.runId, runId))
    .orderBy(asc(orchestratorRunEvents.createdAt))
}
