import {
  EventType,
  type AGUIEvent,
  type CustomEvent,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
} from '@ag-ui/core'

export interface AgentHubRunRef {
  runId: string
  threadId: string
  parentRunId?: string
  timestampMs?: number
}

export interface AgentHubRunEventLike {
  runId: string
  groupSessionId: string
  taskId?: string | null
  threadId?: string | null
  workerInstanceId?: string | null
  agentId?: string | null
  type: string
  payload?: Record<string, unknown> | null
  severity?: string | null
  timestampMs?: number
}

export function buildAgUiEventsFromRunEvent(event: AgentHubRunEventLike): AGUIEvent[] {
  const payload = event.payload ?? {}
  const baseRef = {
    runId: event.runId,
    threadId: event.groupSessionId,
    timestampMs: event.timestampMs,
  }

  if (event.type === 'run.started') {
    return [
      buildAgUiRunStartedEvent(baseRef),
      buildAgUiRunStatusEvent({
        ref: baseRef,
        status: stringValue(payload.status) ?? 'planning',
        summary: stringValue(payload.goal),
      }),
    ]
  }
  if (event.type === 'manager.thinking') {
    return [
      buildAgUiManagerStatusEvent({
        ref: baseRef,
        value: {
          ...payload,
          status: 'thinking',
          phase: stringValue(payload.stage) ?? 'thinking',
        },
      }),
    ]
  }
  if (event.type === 'manager.intent_observed') {
    return [
      buildAgUiManagerStatusEvent({
        ref: baseRef,
        value: {
          ...payload,
          status: 'intent_observed',
          phase: 'planning',
        },
      }),
    ]
  }
  if (event.type === 'manager.next_action') {
    return [
      buildAgUiManagerStatusEvent({
        ref: baseRef,
        value: {
          ...payload,
          status: 'next_action',
          phase: stringValue(payload.action) ?? 'planning',
        },
      }),
    ]
  }
  if (event.type === 'run.completed') {
    return [
      buildAgUiRunFinishedEvent(baseRef, {
        ...payload,
        status: 'completed',
      }),
      buildAgUiRunStatusEvent({
        ref: baseRef,
        status: 'completed',
        artifactCount: numberValue(payload.artifactCount),
        summary: stringValue(payload.summary),
      }),
    ]
  }
  if (event.type === 'run.failed') {
    return [
      buildAgUiRunErrorEvent({
        code: 'ORCHESTRATOR_RUN_FAILED',
        message:
          stringValue(payload.error) ?? stringValue(payload.message) ?? 'Orchestrator run failed',
        ref: baseRef,
      }),
      buildAgUiRunStatusEvent({
        ref: baseRef,
        status: 'failed',
        artifactCount: numberValue(payload.artifactCount),
        summary:
          stringValue(payload.error) ??
          stringValue(payload.message) ??
          stringValue(payload.summary),
      }),
    ]
  }
  if (event.type === 'run.cancelled') {
    return [
      buildAgUiRunFinishedEvent(baseRef, {
        ...payload,
        status: 'cancelled',
      }),
      buildAgUiRunStatusEvent({
        ref: baseRef,
        status: 'cancelled',
        artifactCount: numberValue(payload.artifactCount),
        summary: stringValue(payload.summary) ?? stringValue(payload.reason),
      }),
    ]
  }
  if (event.type === 'plan.created') {
    return [
      buildAgUiPlanCreatedEvent({
        plan: payload,
        ref: baseRef,
      }),
    ]
  }
  if (event.type === 'task.planned')
    return [buildAgUiTaskStatusEvent(taskStatusPayload(event, 'pending'))]
  if (event.type === 'thread.prepared')
    return [buildAgUiTaskStatusEvent(taskStatusPayload(event, 'pending'))]
  if (event.type === 'task.started') {
    return [
      buildAgUiTaskStartedEvent({
        agentName: stringValue(payload.agentName),
        ref: baseRef,
        taskId: event.taskId ?? stringValue(payload.taskId) ?? 'task',
        taskTitle:
          stringValue(payload.taskTitle) ?? stringValue(payload.title) ?? event.taskId ?? '任务',
      }),
      buildAgUiTaskStatusEvent(taskStatusPayload(event, 'running')),
    ]
  }
  if (event.type === 'task.completed') {
    return [
      buildAgUiTaskFinishedEvent({
        agentName: stringValue(payload.agentName),
        ref: baseRef,
        taskId: event.taskId ?? stringValue(payload.taskId) ?? 'task',
        taskTitle:
          stringValue(payload.taskTitle) ?? stringValue(payload.title) ?? event.taskId ?? '任务',
      }),
      buildAgUiTaskStatusEvent(taskStatusPayload(event, 'done')),
    ]
  }
  if (event.type === 'task.progress')
    return [buildAgUiTaskStatusEvent(taskStatusPayload(event, 'running'))]
  if (event.type === 'task.failed')
    return [buildAgUiTaskStatusEvent(taskStatusPayload(event, 'failed'))]
  if (event.type === 'task.cancelled')
    return [buildAgUiTaskStatusEvent(taskStatusPayload(event, 'cancelled'))]
  if (event.type === 'task.queued')
    return [buildAgUiTaskStatusEvent(taskStatusPayload(event, 'pending'))]
  if (event.type === 'task.assigned')
    return [buildAgUiTaskStatusEvent(taskStatusPayload(event, 'assigned'))]
  if (event.type === 'worker.message.sent')
    return [buildAgUiTaskStatusEvent(taskStatusPayload(event, 'assigned'))]
  if (event.type === 'task.clarification_needed') {
    return [
      {
        name: 'agenthub.task.clarification_needed',
        runId: event.runId,
        threadId: event.groupSessionId,
        timestamp: eventTimestamp(event.timestampMs),
        type: EventType.CUSTOM,
        value: {
          ...payload,
          agentId: event.agentId ?? stringValue(payload.agentId),
          taskId: event.taskId ?? stringValue(payload.taskId) ?? 'task',
        },
      },
    ]
  }
  if (event.type === 'artifact.created') {
    return [
      buildAgUiArtifactEvent({
        artifact: payload,
        ref: baseRef,
        taskId: event.taskId ?? stringValue(payload.taskId) ?? 'task',
      }),
    ]
  }
  if (event.type === 'blackboard.written') {
    return [
      buildAgUiBlackboardEvent({
        agentName: stringValue(payload.agentName),
        key: stringValue(payload.key),
        ref: baseRef,
        summary: stringValue(payload.summary),
        taskId: event.taskId ?? stringValue(payload.taskId) ?? 'task',
        taskTitle:
          stringValue(payload.taskTitle) ?? stringValue(payload.title) ?? event.taskId ?? '任务',
        version: numberValue(payload.version),
      }),
    ]
  }
  if (event.type === 'run.synthesizing') {
    return [
      buildAgUiRunStatusEvent({
        artifactCount: numberValue(payload.artifactCount),
        ref: baseRef,
        status: 'synthesizing',
        summary: stringValue(payload.summary) ?? '汇总团队产出',
      }),
    ]
  }
  if (event.type === 'manager.reviewed') {
    return [
      buildAgUiManagerStatusEvent({
        ref: baseRef,
        value: {
          ...payload,
          status: 'reviewed',
          phase: 'reviewing',
          taskId: event.taskId ?? stringValue(payload.taskId),
        },
      }),
    ]
  }
  if (event.type === 'member_proposal.continued') {
    return [
      buildAgUiMemberProposalContinueEvent({
        ref: baseRef,
        value: {
          ...payload,
          status: stringValue(payload.status) ?? 'completed',
        },
      }),
    ]
  }

  return []
}

export function buildAgUiRunStartedEvent(ref: AgentHubRunRef): RunStartedEvent {
  return {
    parentRunId: ref.parentRunId,
    runId: ref.runId,
    threadId: ref.threadId,
    timestamp: eventTimestamp(ref.timestampMs),
    type: EventType.RUN_STARTED,
  }
}

export function buildAgUiRunFinishedEvent(
  ref: AgentHubRunRef,
  result?: Record<string, unknown>,
): RunFinishedEvent {
  return {
    outcome: { type: 'success' },
    result,
    runId: ref.runId,
    threadId: ref.threadId,
    timestamp: eventTimestamp(ref.timestampMs),
    type: EventType.RUN_FINISHED,
  }
}

export function buildAgUiRunErrorEvent(params: {
  code?: string
  message: string
  ref?: AgentHubRunRef
}): RunErrorEvent {
  return {
    code: params.code,
    message: params.message,
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.RUN_ERROR,
  }
}

export function buildAgUiPlanCreatedEvent(params: {
  plan: Record<string, unknown>
  ref?: AgentHubRunRef
}): CustomEvent {
  return {
    name: 'agenthub.plan.created',
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.CUSTOM,
    value: params.plan,
  }
}

export function buildAgUiTaskStartedEvent(params: {
  agentName?: string | null
  ref?: AgentHubRunRef
  taskId: string
  taskTitle: string
}): StepStartedEvent {
  return {
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    stepName: taskStepName(params),
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.STEP_STARTED,
  }
}

export function buildAgUiTaskFinishedEvent(params: {
  agentName?: string | null
  ref?: AgentHubRunRef
  taskId: string
  taskTitle: string
}): StepFinishedEvent {
  return {
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    stepName: taskStepName(params),
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.STEP_FINISHED,
  }
}

export function buildAgUiTaskStatusEvent(params: {
  agentId?: string | null
  agentName?: string | null
  artifactCount?: number
  childSessionId?: string | null
  dependencies?: string[]
  description?: string
  executionConfig?: Record<string, unknown>
  phaseId?: string
  progressPercent?: number | null
  progressStatus?: string | null
  runId?: string
  runtimeLeaseId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  status: string
  taskThreadStatus?: string | null
  taskThreadId?: string | null
  taskId: string
  taskTitle: string
  taskType?: string
  threadId?: string
  timestampMs?: number
  workerInstanceId?: string | null
}): CustomEvent {
  const { timestampMs, ...value } = params
  return {
    name: 'agenthub.task.status',
    runId: params.runId,
    threadId: params.threadId,
    timestamp: eventTimestamp(timestampMs),
    type: EventType.CUSTOM,
    value,
  }
}

export function buildAgUiBlackboardEvent(params: {
  agentName?: string | null
  key?: string | null
  ref?: AgentHubRunRef
  summary?: string | null
  taskId: string
  taskTitle: string
  version?: number | null
}): CustomEvent {
  return {
    name: 'agenthub.blackboard.written',
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.CUSTOM,
    value: params,
  }
}

export function buildAgUiRunStatusEvent(params: {
  artifactCount?: number
  ref?: AgentHubRunRef
  status: string
  summary?: string | null
}): CustomEvent {
  return {
    name: 'agenthub.run.status',
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.CUSTOM,
    value: params,
  }
}

export function buildAgUiManagerStatusEvent(params: {
  ref?: Partial<AgentHubRunRef> & { threadId?: string }
  value: Record<string, unknown>
}): CustomEvent {
  return {
    name: 'agenthub.manager.status',
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.CUSTOM,
    value: params.value,
  }
}

export function buildAgUiArtifactEvent(params: {
  artifact: Record<string, unknown>
  ref?: AgentHubRunRef
  taskId: string
}): CustomEvent {
  const artifact = params.artifact
  return {
    name: 'agenthub.artifact.created',
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.CUSTOM,
    value: {
      ...artifact,
      artifact,
      childSessionId: stringValue(artifact.childSessionId) ?? stringValue(artifact.sessionId),
      taskId: params.taskId,
      taskThreadId: stringValue(artifact.taskThreadId) ?? stringValue(artifact.threadId),
      workerInstanceId: stringValue(artifact.workerInstanceId),
    },
  }
}

export function buildAgUiMemberProposalContinueEvent(params: {
  ref?: Partial<AgentHubRunRef> & { threadId?: string }
  value: Record<string, unknown>
}): CustomEvent {
  return {
    name: 'agenthub.member_proposal.continue',
    parentRunId: params.ref?.parentRunId,
    runId: params.ref?.runId,
    threadId: params.ref?.threadId,
    timestamp: eventTimestamp(params.ref?.timestampMs),
    type: EventType.CUSTOM,
    value: params.value,
  }
}

function taskStepName(params: { agentName?: string | null; taskId: string; taskTitle: string }) {
  return [params.agentName, params.taskTitle || params.taskId].filter(Boolean).join(' · ')
}

function taskStatusPayload(event: AgentHubRunEventLike, status: string) {
  const payload = event.payload ?? {}
  return {
    agentId: event.agentId ?? stringValue(payload.agentId),
    agentName: stringValue(payload.agentName),
    artifactCount: numberValue(payload.artifactCount),
    childSessionId: stringValue(payload.childSessionId) ?? stringValue(payload.sessionId),
    dependencies: Array.isArray(payload.dependencies)
      ? payload.dependencies.filter((item): item is string => typeof item === 'string')
      : undefined,
    description: stringValue(payload.description),
    executionConfig: recordValue(payload.executionConfig),
    phaseId: stringValue(payload.phaseId),
    progressPercent: numberValue(payload.progressPercent) ?? numberValue(payload.percent),
    progressStatus: stringValue(payload.progressStatus) ?? stringValue(payload.status),
    runId: event.runId,
    runtimeLeaseId: stringValue(payload.runtimeLeaseId),
    sharedTaskRelativeRoot: stringValue(payload.sharedTaskRelativeRoot),
    sharedTaskSpecPath: stringValue(payload.sharedTaskSpecPath),
    status,
    taskThreadStatus:
      explicitTaskThreadStatus(payload) ?? inferTaskThreadStatusFromEventType(event.type),
    taskThreadId: event.threadId ?? stringValue(payload.taskThreadId) ?? stringValue(payload.threadId),
    taskId: event.taskId ?? stringValue(payload.taskId) ?? 'task',
    taskTitle:
      stringValue(payload.taskTitle) ?? stringValue(payload.title) ?? event.taskId ?? '任务',
    taskType: stringValue(payload.taskType),
    threadId: event.groupSessionId,
    timestampMs: event.timestampMs,
    workerInstanceId: event.workerInstanceId ?? stringValue(payload.workerInstanceId),
  }
}

function explicitTaskThreadStatus(payload: Record<string, unknown>): string | undefined {
  const value = stringValue(payload.taskThreadStatus) ?? stringValue(payload.threadStatus)
  return isTaskThreadStatus(value) ? value : undefined
}

function inferTaskThreadStatusFromEventType(type: string): string | undefined {
  if (type === 'thread.prepared' || type === 'task.planned' || type === 'task.queued') {
    return 'prepared'
  }
  if (type === 'task.assigned' || type === 'worker.message.sent') return 'assigned'
  if (type === 'task.started' || type === 'task.progress') return 'active'
  if (type === 'task.completed') return 'completed'
  if (type === 'task.failed') return 'failed'
  if (type === 'task.cancelled') return 'cancelled'
  return undefined
}

function isTaskThreadStatus(
  value: string | undefined,
): value is 'prepared' | 'assigned' | 'active' | 'completed' | 'failed' | 'cancelled' {
  return (
    value === 'prepared' ||
    value === 'assigned' ||
    value === 'active' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  )
}

function eventTimestamp(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
