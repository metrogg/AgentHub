import type { AgentArtifact } from '@agenthub/db'
import { OrchestratorRunStatus } from '@agenthub/shared'

export interface DirectRuntimeRunRow {
  eventId: string
  eventType: string
  eventBody: string
  eventMetadata: unknown
  createdAt: Date
  roomId: string
  roomTitle: string
  sessionId: string
  sessionTitle: string | null
  workspaceId: string
  workspaceName: string
  participantName: string | null
  participantWorkspaceAgentId: string | null
  participantWorkerInstanceId: string | null
  workspaceAgentName: string | null
}

export interface DirectRuntimeRunProjection {
  runRow: {
    id: string
    workspaceId: string
    groupSessionId: string
    planMessageId: null
    status: OrchestratorRunStatus
    plan: Record<string, unknown>
    summaryMessageId: null
    conflictReport: []
    createdAt: Date
    updatedAt: Date
    workspaceName: string
    sessionTitle: string | null
    source: 'direct-runtime'
    roomId: string
    eventId: string
  }
  task: DirectRuntimeTaskProjection
}

export interface DirectRuntimeTaskProjection {
  id: string
  workspaceId: string
  agentId: string
  title: string
  description: string
  status: 'done' | 'cancelled' | 'failed' | 'running'
  sessionId: string
  taskThreadId: null
  taskThreadSessionId: string
  taskThreadStatus: null
  workerInstanceId: string | null
  taskThreadSessionMetadata: Record<string, unknown>
  orderIdx: number
  runId: string
  phaseId: 'direct'
  dependencies: []
  artifacts: AgentArtifact[]
  progressPercent: null
  progressStatus: null
  startedAt: Date
  completedAt: Date
  errorLog: null
}

export function isDirectRuntimeTerminalEvent(eventType: string, metadata: unknown) {
  if (eventType !== 'worker.message' && eventType !== 'task.progress') return false
  const record = recordValue(metadata)
  const kind = stringValue(record?.kind)
  if (
    kind === 'worker-runtime.completed' ||
    kind === 'worker-runtime.failed' ||
    kind === 'worker-runtime.cancelled'
  ) {
    return true
  }
  const codeAgentRun = recordValue(record?.codeAgentRun) ?? record
  const status = stringValue(codeAgentRun?.status)
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed-out'
}

export function buildDirectRuntimeRunProjection(row: DirectRuntimeRunRow): DirectRuntimeRunProjection {
  const metadata = recordValue(row.eventMetadata) ?? {}
  const codeAgentRun = recordValue(metadata.codeAgentRun) ?? metadata
  const status = directRunStatusFromMetadata(metadata)
  const agentId =
    stringValue(metadata.workspaceAgentId) ??
    row.participantWorkspaceAgentId ??
    row.participantWorkerInstanceId ??
    'direct-agent'
  const agentName =
    stringValue(metadata.agentName) ??
    row.workspaceAgentName ??
    row.participantName ??
    'Agent'
  const taskId = `direct-task:${row.eventId}`
  const runId = `direct-runtime:${row.eventId}`
  const artifacts = directRunArtifacts(codeAgentRun, metadata)
  const taskStatus = directTaskStatusFromRunStatus(status)
  const summary =
    stringValue(codeAgentRun.finalMessage) ??
    stringValue(row.eventBody) ??
    row.sessionTitle ??
    row.roomTitle
  const taskTitle = `${agentName} direct run`
  const taskDescription = summary || 'Agent direct runtime record'

  const task: DirectRuntimeTaskProjection = {
    id: taskId,
    workspaceId: row.workspaceId,
    agentId,
    title: taskTitle,
    description: taskDescription,
    status: taskStatus,
    sessionId: row.sessionId,
    taskThreadId: null,
    taskThreadSessionId: row.sessionId,
    taskThreadStatus: null,
    workerInstanceId: row.participantWorkerInstanceId,
    taskThreadSessionMetadata: {},
    orderIdx: 0,
    runId,
    phaseId: 'direct',
    dependencies: [],
    artifacts,
    progressPercent: null,
    progressStatus: null,
    startedAt: row.createdAt,
    completedAt: row.createdAt,
    errorLog: null,
  }

  const plan = {
    title: `私聊运行：${row.sessionTitle ?? row.roomTitle}`,
    goal: summary,
    collaborationMode: 'direct',
    phases: [
      {
        id: 'direct',
        title: '私聊执行',
        purpose: 'Agent 私聊中的单次运行。',
        taskIds: [taskId],
      },
    ],
    tasks: [
      {
        id: taskId,
        phaseId: 'direct',
        title: `${agentName} 私聊执行`,
        description: taskDescription,
        agentId,
        agentName,
        status: taskStatus,
        childSessionId: row.sessionId,
        artifacts,
        outputSummary: summary || undefined,
      },
    ],
    taskLedger: {
      phases: [
        {
          id: 'direct',
          title: '私聊执行',
          purpose: 'Agent 私聊中的单次运行。',
        },
      ],
      tasks: [
        {
          id: taskId,
          phaseId: 'direct',
          title: `${agentName} 私聊执行`,
          agentId,
          agentName,
        },
      ],
    },
    progressLedger: {
      status,
      completedTaskIds: status === OrchestratorRunStatus.Completed ? [taskId] : [],
      runningTaskIds: status === OrchestratorRunStatus.Running ? [taskId] : [],
      failedTaskIds: status === OrchestratorRunStatus.Failed ? [taskId] : [],
      cancelledTaskIds: status === OrchestratorRunStatus.Cancelled ? [taskId] : [],
      blockedTaskIds: [],
    },
  }

  return {
    runRow: {
      id: runId,
      workspaceId: row.workspaceId,
      groupSessionId: row.sessionId,
      planMessageId: null,
      status,
      plan,
      summaryMessageId: null,
      conflictReport: [],
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
      workspaceName: row.workspaceName,
      sessionTitle: row.sessionTitle ?? row.roomTitle,
      source: 'direct-runtime',
      roomId: row.roomId,
      eventId: row.eventId,
    },
    task,
  }
}

export function directRunStatusFromMetadata(metadata: Record<string, unknown>) {
  const kind = stringValue(metadata.kind)
  const codeAgentRun = recordValue(metadata.codeAgentRun) ?? metadata
  const status = stringValue(codeAgentRun.status) ?? stringValue(metadata.status)
  if (kind === 'worker-runtime.cancelled' || status === 'cancelled') return OrchestratorRunStatus.Cancelled
  if (kind === 'worker-runtime.failed' || status === 'failed' || status === 'timed-out') return OrchestratorRunStatus.Failed
  if (kind === 'worker-runtime.completed' || status === 'completed') return OrchestratorRunStatus.Completed
  return OrchestratorRunStatus.Running
}

export function directRunArtifacts(...sources: Array<Record<string, unknown>>): AgentArtifact[] {
  const items: AgentArtifact[] = []
  for (const source of sources) {
    if (Array.isArray(source.artifacts)) {
      for (const item of source.artifacts) {
        const artifact = normalizeDirectRunArtifact(recordValue(item))
        if (artifact) items.push(artifact)
      }
    }
    if (Array.isArray(source.files)) {
      for (const file of source.files) {
        const record = recordValue(file)
        const path = stringValue(record?.path) ?? stringValue(record?.filePath)
        if (!path) continue
        items.push({
          id: `code-agent-file:${path}`,
          kind: 'file',
          title: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
          path,
          filePath: path,
          status: normalizeDirectRunFileStatus(stringValue(record?.status)) ?? 'modified',
          source: 'codeAgentRun.files',
        })
      }
    }
  }
  const seen = new Set<string>()
  return items.filter((item) => {
    const key =
      stringValue(item.id) ??
      stringValue(item.path) ??
      stringValue(item.filePath) ??
      JSON.stringify(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function normalizeDirectRunArtifact(record: Record<string, unknown> | null): AgentArtifact | null {
  if (!record) return null
  const path =
    stringValue(record.path) ??
    stringValue(record.filePath) ??
    stringValue(record.handoffPath) ??
    stringValue(record.relativePath)
  const kind = normalizeDirectRunArtifactKind(stringValue(record.kind) ?? stringValue(record.type) ?? 'file')
  const title =
    stringValue(record.title) ??
    (path ? path.split(/[\\/]/).filter(Boolean).at(-1) : null) ??
    stringValue(record.id) ??
    'artifact'
  return {
    ...record,
    id: stringValue(record.id) ?? stringValue(record.artifactId) ?? `${kind}:${path ?? title}`,
    kind,
    title,
    description: stringValue(record.description) ?? stringValue(record.summary) ?? undefined,
    source: stringValue(record.source) ?? 'codeAgentRun.artifacts',
    path: path ?? stringValue(record.url) ?? undefined,
    filePath: stringValue(record.filePath) ?? path ?? undefined,
    status: normalizeDirectRunFileStatus(stringValue(record.status)),
    url: stringValue(record.url) ?? undefined,
    mimeType: stringValue(record.mimeType) ?? undefined,
    size: numberValue(record.size) ?? undefined,
  }
}

export function normalizeDirectRunArtifactKind(value: string): AgentArtifact['kind'] {
  if (value === 'diff') return 'diff'
  if (value === 'preview') return 'preview'
  if (value === 'deploy') return 'deploy'
  if (value === 'log') return 'log'
  if (value === 'workflow') return 'workflow'
  return 'file'
}

export function normalizeDirectRunFileStatus(value: string | null): AgentArtifact['status'] | undefined {
  if (value === 'created' || value === 'modified' || value === 'deleted' || value === 'renamed' || value === 'untracked') {
    return value
  }
  return undefined
}

function directTaskStatusFromRunStatus(status: OrchestratorRunStatus): DirectRuntimeTaskProjection['status'] {
  if (status === OrchestratorRunStatus.Completed) return 'done'
  if (status === OrchestratorRunStatus.Cancelled) return 'cancelled'
  if (status === OrchestratorRunStatus.Failed) return 'failed'
  return 'running'
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
