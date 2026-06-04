import type { CodeAgentRunMetadata } from '@agenthub/shared'
import { codeAgentRuntimeLabel } from './agentDisplay'
import { compactPath, trimLongText } from './utils'
import type { AgentArtifact, Message, OrchestratorRunListItem } from './api'

export interface RuntimeAgentTabProjection {
  agentId: string
  agentName: string
  childSessionId: string | null
  status: 'pending' | 'assigned' | 'running' | 'waiting' | 'done' | 'failed'
}

export interface RuntimeTaskProjection {
  agentId: string
  agentName: string
  childSessionId?: string | null
  status: RuntimeTaskStatus
}

export interface RuntimeTaskBoardProjection {
  sessionId: string
  status: RuntimeTaskBoardStatus
  tasks: RuntimeTaskProjection[]
}

export type RuntimeTaskStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export type RuntimeTaskBoardStatus =
  | 'planning'
  | 'running'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AgentActivity {
  sessionId: string
  agentId?: string
  agentName?: string
  phase?: 'planning' | 'replying' | 'executing' | string
  startedAt: string
}

export interface RuntimeActivityProjection {
  agentTyping: boolean
  agentActivity: AgentActivity | null
}

export interface RuntimeStreamingMessageProjection {
  id: string
  content: string
  agentId?: string
  agentName?: string
}

export interface LiveRuntimeProjection extends RuntimeActivityProjection {
  streamingMessage: RuntimeStreamingMessageProjection | null
  streamingCodeAgentRun: CodeAgentRunMetadata | null
}

export interface AgUiEventPayload {
  code?: string
  message?: string
  name?: string
  result?: unknown
  runId?: string
  stepName?: string
  threadId?: string
  type?: string
  value?: unknown
}

export type HeaderAgentStatusTone =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'synthesizing'
  | 'warning'

export interface HeaderAgentStatusProjection {
  label: string
  detail?: string
  tone: HeaderAgentStatusTone
  live: boolean
}

export type DirectRunStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DirectRunProgressProjection {
  agentName?: string
  done: number
  percent: number
  run: CodeAgentRunMetadata
  status: CodeAgentRunMetadata['status']
  steps: Array<{
    detail?: string
    id: string
    status: DirectRunStepStatus
    subtitle?: string
    title: string
  }>
  subtitle: string
  total: number
}

export function clearRuntimeActivity(): RuntimeActivityProjection {
  return {
    agentActivity: null,
    agentTyping: false,
  }
}

export function buildRuntimeActivity(
  sessionId: string,
  input: {
    agentId?: string | undefined
    agentName?: string | undefined
    phase?: string | undefined
  },
): RuntimeActivityProjection {
  return {
    agentActivity: {
      sessionId,
      agentId: input.agentId,
      agentName: input.agentName,
      phase: input.phase,
      startedAt: new Date().toISOString(),
    },
    agentTyping: true,
  }
}

export function buildReplyingRuntimeProjection(
  sessionId: string,
  input: {
    agentId?: string | undefined
    agentName?: string | undefined
    phase?: string | undefined
  },
): LiveRuntimeProjection {
  const activity = buildRuntimeActivity(sessionId, input)
  return {
    ...activity,
    streamingCodeAgentRun: null,
    streamingMessage: null,
  }
}

export function clearLiveRuntimeProjection(): LiveRuntimeProjection {
  return {
    ...clearRuntimeActivity(),
    streamingCodeAgentRun: null,
    streamingMessage: null,
  }
}

export function deriveRuntimeActivityFromTaskBoard(
  taskBoard: RuntimeTaskBoardProjection,
): RuntimeActivityProjection {
  const runningTask = taskBoard.tasks.find(
    (task) => task.status === 'running' || task.status === 'blocked',
  )
  if (runningTask) {
    return buildRuntimeActivity(taskBoard.sessionId, {
      agentId: runningTask.agentId || undefined,
      agentName: runningTask.agentName || undefined,
      phase: 'executing',
    })
  }

  if (taskBoard.status === 'planning') {
    return buildRuntimeActivity(taskBoard.sessionId, {
      agentName: 'Orchestrator',
      phase: 'planning',
    })
  }

  if (taskBoard.status === 'synthesizing') {
    return buildRuntimeActivity(taskBoard.sessionId, {
      agentName: 'Orchestrator',
      phase: 'synthesizing',
    })
  }

  return clearRuntimeActivity()
}

export function runtimeActivityFromSnapshot(input: {
  agUiEvents: AgUiEventPayload[]
  serverRuntimeActivity?: OrchestratorRunListItem['runtimeActivitySnapshot']
  taskBoard: RuntimeTaskBoardProjection
}): RuntimeActivityProjection {
  const { taskBoard, agUiEvents, serverRuntimeActivity } = input
  if (serverRuntimeActivity) {
    return {
      agentActivity: serverRuntimeActivity.agentActivity
        ? {
            sessionId: serverRuntimeActivity.agentActivity.sessionId,
            agentId: serverRuntimeActivity.agentActivity.agentId ?? undefined,
            agentName: serverRuntimeActivity.agentActivity.agentName ?? undefined,
            phase: serverRuntimeActivity.agentActivity.phase ?? undefined,
            startedAt:
              serverRuntimeActivity.agentActivity.startedAt ?? new Date().toISOString(),
          }
        : null,
      agentTyping: serverRuntimeActivity.agentTyping,
    }
  }
  if (!agUiEvents.length) return deriveRuntimeActivityFromTaskBoard(taskBoard)

  const reduced = agUiEvents.reduce(
    (current, event) => reduceRuntimeActivityProjection(current, event, taskBoard.sessionId),
    clearRuntimeActivity(),
  )

  if (reduced.agentTyping || reduced.agentActivity) return reduced
  return deriveRuntimeActivityFromTaskBoard(taskBoard)
}

export function applyLiveMessageStreamProjection(
  current: LiveRuntimeProjection,
  pending: {
    agentId?: string
    agentName?: string
    delta: string
    messageId: string
  },
): LiveRuntimeProjection {
  const streamingMessage =
    current.streamingMessage?.id === pending.messageId
      ? {
          id: pending.messageId,
          content: current.streamingMessage.content + pending.delta,
          agentId: pending.agentId ?? current.streamingMessage.agentId,
          agentName: pending.agentName ?? current.streamingMessage.agentName,
        }
      : {
          id: pending.messageId,
          content: pending.delta,
          agentId: pending.agentId,
          agentName: pending.agentName,
        }

  return {
    ...clearRuntimeActivity(),
    streamingCodeAgentRun: current.streamingCodeAgentRun,
    streamingMessage,
  }
}

export function applyLiveMessageMetadataProjection(
  current: LiveRuntimeProjection,
  input: {
    agentId?: string
    agentName?: string
    codeAgentRun: Partial<CodeAgentRunMetadata>
    messageId: string
  },
): LiveRuntimeProjection {
  const nextCodeAgentRun =
    current.streamingCodeAgentRun && input.codeAgentRun
      ? ({ ...current.streamingCodeAgentRun, ...input.codeAgentRun } as CodeAgentRunMetadata)
      : (input.codeAgentRun as CodeAgentRunMetadata)

  return {
    ...clearRuntimeActivity(),
    streamingCodeAgentRun: nextCodeAgentRun,
    streamingMessage:
      current.streamingMessage?.id === input.messageId
        ? {
            ...current.streamingMessage,
            agentId: input.agentId ?? current.streamingMessage.agentId,
            agentName: input.agentName ?? current.streamingMessage.agentName,
          }
        : {
            id: input.messageId,
            content: current.streamingMessage?.content ?? '',
            agentId: input.agentId,
            agentName: input.agentName,
          },
  }
}

export function reduceRuntimeActivityProjection(
  current: RuntimeActivityProjection,
  event: AgUiEventPayload,
  sessionId: string,
): RuntimeActivityProjection {
  if (event.type === 'RUN_STARTED') {
    return buildRuntimeActivity(sessionId, { phase: 'planning' })
  }

  if (event.type === 'STEP_STARTED') {
    return buildRuntimeActivity(sessionId, {
      agentName: asString(event.stepName) ?? undefined,
      phase: 'executing',
    })
  }

  if (
    event.type === 'STEP_FINISHED' ||
    event.type === 'RUN_FINISHED' ||
    event.type === 'RUN_ERROR'
  ) {
    return clearRuntimeActivity()
  }

  if (event.type !== 'CUSTOM') {
    return current
  }

  const value = asRecord(event.value)
  if (!value) return current

  if (event.name === 'agenthub.plan.created') {
    return buildRuntimeActivity(sessionId, { phase: 'planning' })
  }

  if (event.name === 'agenthub.task.status') {
    const taskStatus = normalizeAgUiTaskStatus(asString(value.status))
    const taskId = asString(value.taskId)
    if (taskStatus === 'running') {
      return buildRuntimeActivity(sessionId, {
        agentId: asString(value.agentId) ?? undefined,
        agentName: asString(value.agentName) ?? undefined,
        phase: 'executing',
      })
    }
    if (taskId && taskStatus) {
      return clearRuntimeActivity()
    }
    return current
  }

  if (event.name === 'agenthub.run.status') {
    const status = asString(value.status)
    if (status === 'synthesizing') {
      return buildRuntimeActivity(sessionId, { phase: 'synthesizing' })
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      return clearRuntimeActivity()
    }
    return current
  }

  if (event.name === 'agenthub.manager.status') {
    const status = asString(value.status)
    if (status === 'reviewed') {
      return clearRuntimeActivity()
    }
    return buildRuntimeActivity(sessionId, {
      agentId: asString(value.agentId) ?? asString(value.actorAgentId) ?? undefined,
      agentName:
        asString(value.agentName) ?? asString(value.actorName) ?? 'Orchestrator',
      phase: asString(value.phase) ?? asString(value.action) ?? status ?? 'thinking',
    })
  }

  if (event.name === 'agenthub.member_proposal.continue') {
    const status = asString(value.status)
    if (status === 'running') {
      return buildRuntimeActivity(sessionId, {
        agentName: 'Orchestrator',
        phase: 'planning',
      })
    }
    if (status === 'completed' || status === 'failed') {
      return clearRuntimeActivity()
    }
  }

  return current
}

export function runtimeActivityLabel(phase?: string | null) {
  if (phase === 'planning') return '正在规划任务'
  if (phase === 'thinking') return '正在理解目标'
  if (phase === 'executing') return '正在执行任务'
  if (phase === 'synthesizing') return '正在汇总结果'
  if (phase === 'replying') return '正在回复'
  return '正在处理'
}

export function describeRuntimeActivity(activity: AgentActivity | null | undefined) {
  if (!activity) return null
  return {
    agentName: activity.agentName ?? 'Agent',
    phase: activity.phase,
    label: runtimeActivityLabel(activity.phase),
  }
}

export function activityLabel(activity: AgentActivity | null) {
  if (activity?.phase === 'thinking') return '理解中'
  if (activity?.phase === 'planning') return '规划中'
  if (activity?.phase === 'synthesizing') return '汇总中'
  return '未开始'
}

export function taskProgressStats(taskBoard: RuntimeTaskBoardProjection | null) {
  const tasks = taskBoard?.tasks ?? []
  const done = tasks.filter((task) => task.status === 'done').length
  const finished =
    done +
    tasks.filter((task) =>
      ['failed', 'blocked', 'cancelled'].includes(task.status),
    ).length
  return {
    done,
    total: tasks.length,
    percent: tasks.length ? Math.round((finished / tasks.length) * 100) : 0,
  }
}

export function buildHeaderAgentStatusProjection(input: {
  agentActivity: AgentActivity | null
  agentTabs: RuntimeAgentTabProjection[]
  agentTyping: boolean
  sessionId: string | null | undefined
  streamingCodeAgentRun: CodeAgentRunMetadata | null
  streamingMessage: RuntimeStreamingMessageProjection | null
  taskBoard: RuntimeTaskBoardProjection | null
}): HeaderAgentStatusProjection {
  const {
    sessionId,
    taskBoard,
    agentTabs,
    agentTyping,
    agentActivity,
    streamingMessage,
    streamingCodeAgentRun,
  } = input

  if (streamingCodeAgentRun?.status === 'running') {
    return {
      label: '工作中',
      detail: codeAgentRuntimeLabel(streamingCodeAgentRun.runtime),
      tone: 'working',
      live: true,
    }
  }

  if (streamingMessage) {
    return {
      label: '工作中',
      detail: streamingMessage.agentName ?? '正在输出',
      tone: 'working',
      live: true,
    }
  }

  if (agentTyping) {
    const phase = agentActivity?.phase ?? 'replying'
    if (phase === 'thinking' || phase === 'planning') {
      return {
        label: phase === 'planning' ? '规划中' : '思考中',
        detail: agentActivity?.agentName ?? 'Orchestrator',
        tone: 'thinking',
        live: true,
      }
    }
    if (phase === 'synthesizing') {
      return {
        label: '汇总中',
        detail: agentActivity?.agentName ?? 'Synthesizer',
        tone: 'synthesizing',
        live: true,
      }
    }
    return {
      label: '工作中',
      detail: agentActivity?.agentName ?? '正在处理',
      tone: 'working',
      live: true,
    }
  }

  const currentTask =
    sessionId && taskBoard
      ? taskBoard.tasks.find((task) => task.childSessionId === sessionId) ??
        taskBoard.tasks.find((task) => task.status === 'running' || task.status === 'blocked') ??
        null
      : null
  const currentTab =
    sessionId && agentTabs.length
      ? agentTabs.find((tab) => tab.childSessionId === sessionId) ??
        agentTabs.find((tab) => tab.status === 'running' || tab.status === 'waiting') ??
        null
      : null

  if (
    currentTask?.status === 'running' ||
    currentTask?.status === 'blocked' ||
    currentTab?.status === 'running' ||
    currentTab?.status === 'waiting'
  ) {
    return {
      label: currentTask?.status === 'blocked' ? '等待补充' : '工作中',
      detail: currentTask?.agentName ?? currentTab?.agentName ?? 'Agent',
      tone: currentTask?.status === 'blocked' ? 'warning' : 'working',
      live: true,
    }
  }

  if (taskBoard && sessionId === taskBoard.sessionId) {
    if (taskBoard.status === 'planning') {
      return { label: '规划中', detail: 'Orchestrator', tone: 'thinking', live: true }
    }
    if (taskBoard.status === 'synthesizing') {
      return { label: '汇总中', detail: 'Synthesizer', tone: 'synthesizing', live: true }
    }
    if (taskBoard.status === 'running') {
      return { label: '工作中', detail: '多 Agent 协作', tone: 'working', live: true }
    }
    if (taskBoard.status === 'failed' || taskBoard.status === 'cancelled') {
      return {
        label: taskBoard.status === 'failed' ? '需关注' : '已停止',
        detail: runStatusDetailLabel(taskBoard.status),
        tone: 'warning',
        live: false,
      }
    }
  }

  return { label: '空闲中', detail: '等待新任务', tone: 'idle', live: false }
}

export function buildDirectRunProgress(input: {
  activity: AgentActivity | null
  agentName?: string | null
  messages: Message[]
  streamingRun: CodeAgentRunMetadata | null
}): DirectRunProgressProjection | null {
  const run = input.streamingRun ?? latestCodeAgentRunFromMessages(input.messages)
  if (!run) return null

  const steps = buildDirectRunSteps(run)
  if (!steps.length) return null

  const total = steps.length
  const done = steps.filter((step) =>
    step.status === 'done' || step.status === 'failed' || step.status === 'cancelled',
  ).length
  const rawPercent = Math.round((done / total) * 100)
  const percent =
    run.status === 'running'
      ? Math.min(95, Math.max(8, rawPercent))
      : run.status === 'completed'
        ? 100
        : Math.max(rawPercent, 100)
  const summary = [
    codeAgentRuntimeLabel(run.runtime),
    codeAgentStatusLabel(run.status, Boolean(run.partialSuccess)),
    input.agentName || input.activity?.agentName,
  ].filter(Boolean).join(' · ')

  return {
    agentName: input.agentName ?? input.activity?.agentName,
    done,
    percent,
    run,
    status: run.status,
    steps,
    subtitle: summary,
    total,
  }
}

export function latestCodeAgentRunFromMessages(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index]?.metadata?.codeAgentRun
    if (isCodeAgentRunMetadataLike(value)) return value
  }
  return null
}

export function isCodeAgentRunMetadataLike(value: unknown): value is CodeAgentRunMetadata {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { type?: unknown }).type === 'code-agent-run' &&
      typeof (value as { status?: unknown }).status === 'string' &&
      typeof (value as { runtime?: unknown }).runtime === 'string',
  )
}

export function buildDirectRunSteps(run: CodeAgentRunMetadata): DirectRunProgressProjection['steps'] {
  const steps = run.steps ?? []
  if (steps.length) {
    const rows = steps
      .filter((step) => step.kind !== 'log')
      .map((step) => ({
        detail: step.detail ? trimLongText(step.detail, 120) : undefined,
        id: step.id,
        status: directRunStatusFromCodeAgent(step.status),
        subtitle: [
          step.subtitle,
          step.toolName,
          step.command,
          step.path ? compactPath(step.path) : null,
          step.fileStatus ? fileStatusLabel(step.fileStatus) : null,
        ].filter(Boolean).join(' · ') || undefined,
        title: step.title,
      }))
    const logSteps = steps.filter((step) => step.kind === 'log')
    if (logSteps.length) {
      const lastLog = logSteps[logSteps.length - 1]
      rows.push({
        detail: lastLog.detail ? trimLongText(lastLog.detail, 120) : undefined,
        id: 'direct-log-summary',
        status: logSteps.some((step) => step.status === 'failed') ? 'failed' : 'done',
        subtitle: `${logSteps.length} 条运行日志`,
        title: '整理过程输出',
      })
    }
    return rows
  }

  const inferred: DirectRunProgressProjection['steps'] = [
    {
      detail: run.cwd ? compactPath(run.cwd) ?? run.cwd : undefined,
      id: 'direct-start',
      status: run.status === 'running' ? 'running' : directRunStatusFromCodeAgent(run.status),
      subtitle: [codeAgentRuntimeLabel(run.runtime), run.command].filter(Boolean).join(' · '),
      title: '启动 Coding Tools',
    },
  ]

  for (const command of (run.commands ?? []).slice(0, 3)) {
    inferred.push({
      detail: command.output ? trimLongText(command.output, 120) : undefined,
      id: `direct-command-${command.id}`,
      status: 'done',
      subtitle: command.cwd ? compactPath(command.cwd) ?? command.cwd : undefined,
      title: command.command,
    })
  }

  for (const call of (run.toolCalls ?? []).slice(0, 3)) {
    inferred.push({
      detail: call.detail ? trimLongText(call.detail, 120) : undefined,
      id: `direct-tool-${call.id}`,
      status: 'done',
      subtitle: [call.name, call.target].filter(Boolean).join(' · ') || undefined,
      title: call.label,
    })
  }

  for (const file of (run.files ?? []).slice(0, 4)) {
    inferred.push({
      id: `direct-file-${file.path}`,
      status: directRunStatusFromCodeAgent(run.status === 'running' ? 'running' : 'completed'),
      subtitle: fileStatusLabel(file.status),
      title: compactPath(file.path) ?? file.path,
    })
  }

  const artifacts = readFlowArtifacts(run.artifacts)
  if (artifacts.length) {
    inferred.push({
      id: 'direct-artifacts',
      status: directRunStatusFromCodeAgent(run.status === 'running' ? 'running' : 'completed'),
      subtitle: `${artifacts.length} 个产物`,
      title: '汇总产物',
    })
  }

  if (run.status !== 'running') {
    inferred.push({
      detail: run.finalMessage ? trimLongText(run.finalMessage, 120) : undefined,
      id: 'direct-finish',
      status: directRunStatusFromCodeAgent(run.status),
      title: codeAgentStatusLabel(run.status, Boolean(run.partialSuccess)),
    })
  }

  return inferred
}

export function directRunStatusFromCodeAgent(status: CodeAgentRunMetadata['status']): DirectRunStepStatus {
  if (status === 'running') return 'running'
  if (status === 'failed' || status === 'timed-out') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'done'
}

export function codeAgentStatusLabel(status: CodeAgentRunMetadata['status'], partialSuccess = false) {
  if (status === 'running') return '正在执行'
  if (status === 'completed') return '执行完成'
  if (status === 'cancelled') return '已停止'
  if (status === 'timed-out') return '已超时'
  if (partialSuccess) return '已产出，需复核'
  return '执行失败'
}

export function fileStatusLabel(status: CodeAgentRunMetadata['files'][number]['status']) {
  if (status === 'created') return '创建'
  if (status === 'modified') return '修改'
  if (status === 'deleted') return '删除'
  if (status === 'renamed') return '重命名'
  return '未跟踪'
}

export function readFlowArtifacts(value: unknown): AgentArtifact[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.filter((item): item is AgentArtifact => {
    if (!item || typeof item !== 'object') return false
    const artifact = item as { id?: unknown; type?: unknown }
    if (
      typeof artifact.id !== 'string' ||
      typeof artifact.type !== 'string' ||
      seen.has(artifact.id)
    ) {
      return false
    }
    seen.add(artifact.id)
    return ['diff', 'preview', 'file', 'deploy', 'workflow'].includes(artifact.type)
  })
}

function runStatusDetailLabel(status: RuntimeTaskBoardStatus) {
  if (status === 'planning') return '规划失败'
  if (status === 'synthesizing') return '汇总中断'
  if (status === 'running') return '运行中断'
  if (status === 'failed') return '运行失败'
  if (status === 'cancelled') return '已停止'
  if (status === 'completed') return '已完成'
  return status
}

function normalizeAgUiTaskStatus(value: string | undefined): RuntimeTaskStatus | null {
  if (value === 'pending' || value === 'assigned' || value === 'running' || value === 'done' || value === 'failed' || value === 'blocked' || value === 'cancelled') return value
  if (value === 'completed') return 'done'
  if (value === 'active') return 'running'
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
