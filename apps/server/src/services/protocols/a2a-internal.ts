import type { MessageSendParams, Task } from '@a2a-js/sdk'
import { TaskStatus } from '@agenthub/shared'
import type { AgentArtifact } from '@agenthub/db'
import type { ExecutionAgent, ExecutionPlan, ExecutionTask } from '../orchestrator/types'
import type { AgentHubA2AEnvelope } from '../execution/agent-execution-envelope'
import { buildA2AAgentMessage, buildA2AArtifact, buildA2AMessage, toA2ATaskState } from './a2a-adapter'

export const A2A_INTERNAL_EXTENSION_URI = 'https://agenthub.dev/extensions/a2a/internal/v1'
export const A2A_AGENTHUB_METADATA_KEY = 'agenthub.dev/a2a/internal'

export function buildA2ADispatchEnvelope(params: {
  task: ExecutionTask
  plan: ExecutionPlan
  agent: ExecutionAgent
  prompt: string
  workspaceId: string
  groupSessionId: string
  childSessionId: string
  taskThreadId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  userMessageId: string
}): AgentHubA2AEnvelope {
  const orchestrator = params.plan.agents.find((agent) => agent.roleType === 'orchestrator')
  const fromAgentId = orchestrator?.id ?? 'orchestrator'
  const fromAgentName = orchestrator?.name ?? 'Orchestrator'
  const referenceTaskIds = params.task.dependencies ?? []
  const contextId = params.groupSessionId
  const content = buildA2ADispatchMessageContent({
    prompt: params.prompt,
    sharedTaskRelativeRoot: params.sharedTaskRelativeRoot,
    sharedTaskSpecPath: params.sharedTaskSpecPath,
  })
  const message = buildA2AMessage({
    id: params.userMessageId,
    role: 'user',
    content,
    contextId,
    taskId: params.task.id,
    metadata: {
      [A2A_AGENTHUB_METADATA_KEY]: {
        runId: params.plan.runId,
        workspaceId: params.workspaceId,
        groupSessionId: params.groupSessionId,
        childSessionId: params.childSessionId,
        taskThreadId: params.taskThreadId ?? null,
        sharedTaskRelativeRoot: params.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: params.sharedTaskSpecPath ?? null,
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
          taskThreadId: params.taskThreadId ?? null,
          sharedTaskRelativeRoot: params.sharedTaskRelativeRoot ?? null,
          sharedTaskSpecPath: params.sharedTaskSpecPath ?? null,
        },
      },
    },
    contextId,
    taskId: params.task.id,
    runId: params.plan.runId,
    workspaceId: params.workspaceId,
    groupSessionId: params.groupSessionId,
    childSessionId: params.childSessionId,
    taskThreadId: params.taskThreadId ?? null,
    sharedTaskRelativeRoot: params.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath: params.sharedTaskSpecPath ?? null,
    fromAgentId,
    fromAgentName,
    toAgentId: params.agent.id,
    toAgentName: params.agent.name,
    referenceTaskIds,
  }
}

export function buildA2ADispatchMessageContent(params: {
  prompt: string
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
}) {
  return [params.prompt.trim(), buildSharedTaskDirectoryProtocolBlock(params)]
    .filter(Boolean)
    .join('\n\n')
}

export function buildSharedTaskDirectoryProtocolBlock(params: {
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
}) {
  const root = params.sharedTaskRelativeRoot?.trim()
  const specPath = params.sharedTaskSpecPath?.trim()
  if (!root && !specPath) return ''

  const planPath = root ? `${root}/plan.md` : null
  const resultPath = root ? `${root}/result.md` : null
  const artifactsPath = root ? `${root}/artifacts/` : null
  const lines = [
    '# AgentHub 共享任务目录协议',
    '',
    '这是本任务的执行契约，也是 Manager 与 Worker 交接任务和产物的事实来源。',
  ]
  if (specPath) lines.push(`- 开始执行前必须先阅读：\`${specPath}\`。`)
  if (root) lines.push(`- 当前共享任务目录：\`${root}\`。`)
  if (planPath) lines.push(`- 如需写执行计划，写入：\`${planPath}\`。`)
  if (resultPath) lines.push(`- 最终结果摘要写入：\`${resultPath}\`。`)
  if (artifactsPath) {
    lines.push(`- 文件、报告、网页、日志、截图等交付产物放入：\`${artifactsPath}\`。`)
  }
  lines.push('- 不要覆盖共享任务目录中的 `base/` 输入材料。')
  lines.push('- 最终回复请说明已写入的 result/artifacts 路径，方便 Manager 验收和接力。')
  return lines.join('\n')
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
        taskThreadId: params.envelope.taskThreadId ?? null,
        sharedTaskRelativeRoot: params.envelope.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: params.envelope.sharedTaskSpecPath ?? null,
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
