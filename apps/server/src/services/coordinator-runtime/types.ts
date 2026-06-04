import type { TimelineEventType } from '../rooms'
import type { CodeAgentType } from '@agenthub/shared'

export type CoordinatorRuntimeType = 'local-llm' | 'openclaw' | 'qwenpaw'

export type CoordinatorActionType =
  | 'reply'
  | 'clarify'
  | 'propose_members'
  | 'assign'
  | 'wait'

export interface CoordinatorObservedEvent {
  id: string
  sequence: number
  type: TimelineEventType
  senderType: 'human' | 'manager' | 'worker' | 'system'
  body: string
  metadata?: Record<string, unknown> | null
}

export interface CoordinatorWorkerCandidate {
  workspaceAgentId: string
  name: string
  role: string
  runtimeType: 'llm' | 'code-agent'
  codeAgentType?: CodeAgentType | null
  capabilityTags: string[]
  status?: string | null
}

export interface CoordinatorRuntimeContext {
  roomId: string
  workspaceId?: string | null
  runId?: string | null
  goal?: string | null
  managerName?: string | null
  workers?: CoordinatorWorkerCandidate[]
}

export interface CoordinatorAction {
  type: CoordinatorActionType
  message?: string
  reason?: string
  targetWorkerId?: string
  taskKey?: string
  dependsOn?: string[]
  taskTitle?: string
  taskDescription?: string
  memberProposals?: Array<{
    name: string
    role: string
    reason: string
    expectedContribution?: string
  }>
  metadata?: Record<string, unknown>
}

export interface CoordinatorStepInput {
  context: CoordinatorRuntimeContext
  timeline: CoordinatorObservedEvent[]
}

export interface CoordinatorStepResult {
  runtimeType: CoordinatorRuntimeType
  actions: CoordinatorAction[]
  rawOutput?: string
}

export interface CoordinatorRuntime {
  readonly runtimeType: CoordinatorRuntimeType
  step(input: CoordinatorStepInput, signal?: AbortSignal): Promise<CoordinatorStepResult>
}
