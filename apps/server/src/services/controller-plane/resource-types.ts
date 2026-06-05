export type ControllerResourceKind =
  | 'Manager'
  | 'Worker'
  | 'Team'
  | 'Human'
  | 'Room'
  | 'Run'
  | 'Task'
  | 'TaskThread'
  | 'RuntimeLease'
  | 'Artifact'

export type ControllerConditionStatus = 'true' | 'false' | 'unknown'

export interface ControllerResourceRef<K extends ControllerResourceKind = ControllerResourceKind> {
  kind: K
  id: string
  workspaceId?: string | null
  namespace?: string | null
}

export interface ControllerCondition {
  type: string
  status: ControllerConditionStatus
  reason?: string | null
  message?: string | null
  observedGeneration?: number
  lastTransitionAt: string
}

export interface ControllerResourceMetadata {
  id: string
  workspaceId?: string | null
  generation: number
  createdAt?: string | null
  updatedAt?: string | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
}

export interface ControllerResource<
  K extends ControllerResourceKind = ControllerResourceKind,
  Spec extends Record<string, unknown> = Record<string, unknown>,
  Status extends Record<string, unknown> = Record<string, unknown>,
> {
  apiVersion: 'agenthub.dev/v1alpha1'
  kind: K
  metadata: ControllerResourceMetadata
  spec: Spec
  status: Status & {
    observedGeneration: number
    desiredState?: string | null
    observedState?: string | null
    conditions: ControllerCondition[]
  }
}

export interface ReconcileRequest<K extends ControllerResourceKind = ControllerResourceKind> {
  ref: ControllerResourceRef<K>
  reason: string
  requestedAt: string
  payload?: Record<string, unknown>
}

export interface ReconcileResult {
  ref: ControllerResourceRef
  phase: string
  changed: boolean
  requeueAfterMs?: number
  error?: string
  conditions?: ControllerCondition[]
  snapshot?: Record<string, unknown>
}

export function resourceRef<K extends ControllerResourceKind>(
  kind: K,
  id: string,
  workspaceId?: string | null,
): ControllerResourceRef<K> {
  return { kind, id, workspaceId: workspaceId ?? null }
}

export function condition(
  type: string,
  status: ControllerConditionStatus,
  input: {
    reason?: string | null
    message?: string | null
    observedGeneration?: number
    at?: Date
  } = {},
): ControllerCondition {
  return {
    type,
    status,
    reason: input.reason ?? null,
    message: input.message ?? null,
    observedGeneration: input.observedGeneration,
    lastTransitionAt: (input.at ?? new Date()).toISOString(),
  }
}

export function resourceKey(ref: ControllerResourceRef): string {
  return `${ref.workspaceId ?? '_'}:${ref.kind}:${ref.id}`
}
