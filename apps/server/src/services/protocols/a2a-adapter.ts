import type {
  AgentCard,
  AgentSkill,
  Artifact as A2AArtifact,
  Message as A2AMessage,
  Part as A2APart,
  Task as A2ATask,
  TaskState,
} from '@a2a-js/sdk'
import { APP_VERSION, TaskStatus as AgentHubTaskStatus } from '@agenthub/shared'

export interface AgentHubWorkspaceLike {
  id: string
  name: string
  goal?: string | null
}

export interface AgentHubAgentLike {
  id: string
  name: string
  role: string
  roleType?: string | null
  description?: string | null
  runtimeType: string
  capabilityTags?: string[] | null
  toolPermissions?: string[] | null
  sandboxPolicy?: string | null
}

export interface AgentHubTaskLike {
  id: string
  title: string
  description?: string | null
  status: string
  agentId?: string | null
  artifacts?: unknown[] | null
  progressPercent?: number | null
  progressStatus?: string | null
  createdAt?: Date | string | number | null
  updatedAt?: Date | string | number | null
}

export interface BuildAgentCardOptions {
  baseUrl: string
  workspace: AgentHubWorkspaceLike
  agent?: AgentHubAgentLike
  agents?: AgentHubAgentLike[]
}

export function buildWorkspaceAgentCard(options: BuildAgentCardOptions): AgentCard {
  const { baseUrl, workspace, agent } = options
  const agents = options.agents ?? (agent ? [agent] : [])
  const endpoint = agent
    ? `${baseUrl}/api/protocols/a2a/workspaces/${workspace.id}/agents/${agent.id}`
    : `${baseUrl}/api/protocols/a2a/workspaces/${workspace.id}`
  const name = agent ? agent.name : `${workspace.name} Team`
  const description = agent
    ? agent.description || agent.role || `${agent.name} in AgentHub workspace ${workspace.name}`
    : workspace.goal || `AgentHub multi-agent workspace ${workspace.name}`

  return {
    capabilities: {
      pushNotifications: false,
      stateTransitionHistory: true,
      streaming: true,
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json', 'text/markdown'],
    description,
    name,
    preferredTransport: 'JSONRPC',
    protocolVersion: '0.3.0',
    provider: {
      organization: 'AgentHub',
      url: baseUrl,
    },
    skills: agent ? [agentToSkill(agent)] : agents.map(agentToSkill),
    url: endpoint,
    version: APP_VERSION,
  }
}

export function agentToSkill(agent: AgentHubAgentLike): AgentSkill {
  const tags = uniqueStrings([
    agent.roleType,
    agent.runtimeType,
    agent.sandboxPolicy,
    ...(agent.capabilityTags ?? []),
    ...(agent.toolPermissions ?? []),
  ])

  return {
    description: agent.description || agent.role || `${agent.name} workspace agent`,
    id: agent.id,
    inputModes: ['text/plain', 'application/json'],
    name: agent.name,
    outputModes: ['text/plain', 'application/json', 'text/markdown'],
    tags,
  }
}

export function buildA2ATaskFromWorkspaceTask(params: {
  task: AgentHubTaskLike
  contextId: string
  message?: string
}): A2ATask {
  const artifacts = (params.task.artifacts ?? []).map((artifact, index) =>
    buildA2AArtifact(asRecord(artifact), index),
  )
  return {
    artifacts,
    contextId: params.contextId,
    id: params.task.id,
    kind: 'task',
    metadata: {
      agentHubTaskTitle: params.task.title,
      agentHubAgentId: params.task.agentId,
      progressPercent: params.task.progressPercent ?? 0,
      progressStatus: params.task.progressStatus ?? undefined,
    },
    status: {
      message: params.message
        ? buildA2AMessage({
            content: params.message,
            contextId: params.contextId,
            id: `${params.task.id}:status`,
            role: 'agent',
            taskId: params.task.id,
          })
        : undefined,
      state: toA2ATaskState(params.task.status),
      timestamp: toIsoString(params.task.updatedAt ?? params.task.createdAt ?? Date.now()),
    },
  }
}

export function buildA2AMessage(params: {
  id: string
  role: 'agent' | 'user'
  content: string
  contextId?: string
  taskId?: string
  metadata?: Record<string, unknown>
}): A2AMessage {
  return {
    contextId: params.contextId,
    kind: 'message',
    messageId: params.id,
    metadata: params.metadata,
    parts: [{ kind: 'text', text: params.content }],
    role: params.role,
    taskId: params.taskId,
  }
}

export function buildA2AArtifact(artifact: Record<string, unknown>, index = 0): A2AArtifact {
  const title = stringValue(artifact.title) ?? stringValue(artifact.name) ?? stringValue(artifact.path)
  const path = stringValue(artifact.filePath) ?? stringValue(artifact.path)
  const url = stringValue(artifact.url)
  const mimeType = stringValue(artifact.mimeType)
  const diff = stringValue(artifact.diff)
  const parts: A2APart[] = []

  if (url) {
    parts.push({
      file: {
        mimeType,
        name: title ?? path,
        uri: url,
      },
      kind: 'file',
    })
  } else if (diff) {
    parts.push({
      kind: 'text',
      metadata: { language: 'diff', path },
      text: diff,
    })
  } else {
    parts.push({
      data: {
        ...artifact,
        path,
      },
      kind: 'data',
      metadata: { mimeType },
    })
  }

  return {
    artifactId: stringValue(artifact.id) ?? `artifact-${index + 1}`,
    description: stringValue(artifact.description),
    metadata: {
      agentHubKind: stringValue(artifact.kind) ?? stringValue(artifact.type),
      path,
      source: stringValue(artifact.source),
    },
    name: title ?? `Artifact ${index + 1}`,
    parts,
  }
}

export function toA2ATaskState(status: string): TaskState {
  if (status === AgentHubTaskStatus.Pending) return 'submitted'
  if (status === AgentHubTaskStatus.Running) return 'working'
  if (status === AgentHubTaskStatus.Done) return 'completed'
  if (status === AgentHubTaskStatus.Cancelled) return 'canceled'
  if (status === AgentHubTaskStatus.Blocked) return 'input-required'
  if (status === AgentHubTaskStatus.Failed) return 'failed'
  if (status === 'skipped') return 'rejected'
  return 'unknown'
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))))
}

export function buildA2AAgentMessage(params: {
  envelope: {
    contextId: string
    taskId: string
    runId: string
    workspaceId: string
    childSessionId: string
    taskThreadId?: string | null
    sharedTaskRelativeRoot?: string | null
    sharedTaskSpecPath?: string | null
    toAgentId: string
    toAgentName: string
    fromAgentId: string
    fromAgentName: string
  }
  content: string
  messageId: string
  artifacts?: Array<Record<string, unknown> | unknown>
}): A2AMessage {
  const message = buildA2AMessage({
    id: params.messageId,
    role: 'agent',
    content: params.content,
    contextId: params.envelope.contextId,
    taskId: params.envelope.taskId,
    metadata: {
      'agenthub.dev/a2a/internal': {
        runId: params.envelope.runId,
        workspaceId: params.envelope.workspaceId,
        childSessionId: params.envelope.childSessionId,
        taskThreadId: params.envelope.taskThreadId ?? null,
        sharedTaskRelativeRoot: params.envelope.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: params.envelope.sharedTaskSpecPath ?? null,
        fromAgentId: params.envelope.toAgentId,
        fromAgentName: params.envelope.toAgentName,
        toAgentId: params.envelope.fromAgentId,
        toAgentName: params.envelope.fromAgentName,
        artifactCount: params.artifacts?.length ?? 0,
      },
    },
  })
  message.extensions = ['https://agenthub.dev/extensions/a2a/internal/v1']
  return message
}

function toIsoString(value: Date | string | number | null | undefined): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return new Date(value).toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  return new Date().toISOString()
}
