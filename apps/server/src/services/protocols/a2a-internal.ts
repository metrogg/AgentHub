import type { Message, MessageSendParams, Task } from '@a2a-js/sdk'
import { TaskStatus } from '@agenthub/shared'
import type { AgentArtifact } from '@agenthub/db'
import type { ExecutionAgent, ExecutionPlan, ExecutionTask } from '../orchestrator/types'
import { buildA2AArtifact, buildA2AMessage, toA2ATaskState } from './a2a-adapter'

export const A2A_INTERNAL_EXTENSION_URI = 'https://agenthub.dev/extensions/a2a/internal/v1'
export const A2A_AGENTHUB_METADATA_KEY = 'agenthub.dev/a2a/internal'

export interface AgentHubA2AEnvelope {
  protocolVersion: '0.3.0'
  method: 'message/send'
  params: MessageSendParams
  contextId: string
  taskId: string
  runId: string
  workspaceId: string
  groupSessionId: string
  childSessionId: string
  fromAgentId: string
  fromAgentName: string
  toAgentId: string
  toAgentName: string
  referenceTaskIds: string[]
}

export function buildA2ADispatchEnvelope(params: {
  task: ExecutionTask
  plan: ExecutionPlan
  agent: ExecutionAgent
  prompt: string
  workspaceId: string
  groupSessionId: string
  childSessionId: string
  userMessageId: string
}): AgentHubA2AEnvelope {
  const orchestrator =
    params.plan.agents.find((agent) => agent.roleType === 'orchestrator') ??
    params.plan.agents.find((agent) => agent.name.toLowerCase().includes('orchestrator'))
  const fromAgentId = orchestrator?.id ?? 'orchestrator'
  const fromAgentName = orchestrator?.name ?? 'Orchestrator'
  const referenceTaskIds = params.task.dependencies ?? []
  const contextId = params.groupSessionId
  const message = buildA2AMessage({
    id: params.userMessageId,
    role: 'user',
    content: params.prompt,
    contextId,
    taskId: params.task.id,
    metadata: {
      [A2A_AGENTHUB_METADATA_KEY]: {
        runId: params.plan.runId,
        workspaceId: params.workspaceId,
        groupSessionId: params.groupSessionId,
        childSessionId: params.childSessionId,
        fromAgentId,
        fromAgentName,
        toAgentId: params.agent.id,
        toAgentName: params.agent.name,
        taskTitle: params.task.title,
        taskType: params.task.taskType,
      },
    },
  })
  if (referenceTaskIds.length > 0) {
    message.referenceTaskIds = referenceTaskIds
  }
  message.extensions = [A2A_INTERNAL_EXTENSION_URI]

  return {
    protocolVersion: '0.3.0',
    method: 'message/send',
    params: {
      configuration: {
        acceptedOutputModes: ['text/plain', 'application/json', 'text/markdown'],
        blocking: true,
        historyLength: 20,
      },
      message,
      metadata: {
        [A2A_AGENTHUB_METADATA_KEY]: {
          transport: 'agenthub-local',
          runId: params.plan.runId,
          workspaceId: params.workspaceId,
          taskId: params.task.id,
          childSessionId: params.childSessionId,
        },
      },
    },
    contextId,
    taskId: params.task.id,
    runId: params.plan.runId,
    workspaceId: params.workspaceId,
    groupSessionId: params.groupSessionId,
    childSessionId: params.childSessionId,
    fromAgentId,
    fromAgentName,
    toAgentId: params.agent.id,
    toAgentName: params.agent.name,
    referenceTaskIds,
  }
}

export function buildA2AAgentMessage(params: {
  envelope: AgentHubA2AEnvelope
  content: string
  messageId: string
  artifacts?: Array<Record<string, unknown> | AgentArtifact>
}): Message {
  const message = buildA2AMessage({
    id: params.messageId,
    role: 'agent',
    content: params.content,
    contextId: params.envelope.contextId,
    taskId: params.envelope.taskId,
    metadata: {
      [A2A_AGENTHUB_METADATA_KEY]: {
        runId: params.envelope.runId,
        workspaceId: params.envelope.workspaceId,
        childSessionId: params.envelope.childSessionId,
        fromAgentId: params.envelope.toAgentId,
        fromAgentName: params.envelope.toAgentName,
        toAgentId: params.envelope.fromAgentId,
        toAgentName: params.envelope.fromAgentName,
        artifactCount: params.artifacts?.length ?? 0,
      },
    },
  })
  message.extensions = [A2A_INTERNAL_EXTENSION_URI]
  return message
}

export function buildA2AExecutionTask(params: {
  envelope: AgentHubA2AEnvelope
  status: TaskStatus
  output?: string
  error?: string
  artifacts?: Array<Record<string, unknown> | AgentArtifact>
  messageId?: string
}): Task {
  const messageContent = params.error
    ? `执行失败：${params.error}`
    : params.output?.trim()
      ? params.output
      : statusText(params.status)
  return {
    artifacts: (params.artifacts ?? []).map((artifact, index) =>
      buildA2AArtifact(asRecord(artifact), index),
    ),
    contextId: params.envelope.contextId,
    history: [
      params.envelope.params.message,
      buildA2AAgentMessage({
        envelope: params.envelope,
        content: messageContent,
        messageId: params.messageId ?? `${params.envelope.taskId}:status`,
        artifacts: params.artifacts,
      }),
    ],
    id: params.envelope.taskId,
    kind: 'task',
    metadata: {
      [A2A_AGENTHUB_METADATA_KEY]: {
        runId: params.envelope.runId,
        workspaceId: params.envelope.workspaceId,
        groupSessionId: params.envelope.groupSessionId,
        childSessionId: params.envelope.childSessionId,
        fromAgentId: params.envelope.fromAgentId,
        toAgentId: params.envelope.toAgentId,
        referenceTaskIds: params.envelope.referenceTaskIds,
      },
    },
    status: {
      message: buildA2AAgentMessage({
        envelope: params.envelope,
        content: messageContent,
        messageId: params.messageId ?? `${params.envelope.taskId}:status`,
        artifacts: params.artifacts,
      }),
      state: toA2ATaskState(params.status),
      timestamp: new Date().toISOString(),
    },
  }
}

function statusText(status: TaskStatus) {
  if (status === TaskStatus.Done) return '任务已完成'
  if (status === TaskStatus.Running) return '任务执行中'
  if (status === TaskStatus.Cancelled) return '任务已取消'
  if (status === TaskStatus.Blocked) return '任务等待输入'
  if (status === TaskStatus.Failed) return '任务执行失败'
  return '任务已提交'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
