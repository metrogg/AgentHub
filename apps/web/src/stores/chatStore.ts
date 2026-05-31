import { create } from 'zustand'
import {
  api,
  type AgentConfigInput,
  type ChatAttachment,
  type Message,
  type OrchestratorRunListItem,
  type Session,
  type Workspace,
  type WorkspaceAgent,
  type WorkspaceFull,
} from '../lib/api'
import { wsClient, type WSEvent } from '../lib/ws'
import type { CodeAgentRunMetadata } from '@agenthub/shared'
import { WsEvent, MessageType, SessionType, SenderType } from '@agenthub/shared'

let pendingStream: {
  messageId: string
  delta: string
  agentId?: string
  agentName?: string
} | null = null
let pendingStreamTimer: number | null = null
const cancelledSessions = new Set<string>()
const messageCache = new Map<string, Message[]>()
const workspaceDetailsCache = new Map<string, { workspace: Workspace; agents: WorkspaceAgent[] }>()

function updateCachedMessages(sessionId: string, updater: (messages: Message[]) => Message[]) {
  const cached = messageCache.get(sessionId)
  if (!cached) return
  messageCache.set(sessionId, sortMessages(updater(cached)))
}

function messageTime(message: Message): number {
  const time = Date.parse(message.createdAt)
  return Number.isFinite(time) ? time : 0
}

function messageSortPriority(message: Message): number {
  if (message.senderType === SenderType.User) return 0
  if (message.senderType === SenderType.System) return 1
  return 2
}

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const byTime = messageTime(a) - messageTime(b)
    if (byTime !== 0) return byTime
    const byPriority = messageSortPriority(a) - messageSortPriority(b)
    return byPriority !== 0 ? byPriority : a.id.localeCompare(b.id)
  })
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const exists = messages.some((item) => item.id === message.id)
  return sortMessages(
    exists
      ? messages.map((item) => (item.id === message.id ? message : item))
      : [...messages, message],
  )
}

function sessionWorkspaceAgents(session: Session | null | undefined, agents: WorkspaceAgent[]) {
  if (session?.type !== SessionType.Group) return agents
  const agentIds = readSessionAgentIds(session)
  if (!agentIds.length) return agents
  const allowed = new Set(agentIds)
  return agents.filter((agent) => allowed.has(agent.id))
}

function readSessionAgentIds(session: Session | null | undefined) {
  const value = session?.metadata?.agentIds
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function phaseTitleFromId(phaseId: string) {
  const map: Record<string, string> = {
    analysis: '分析',
    design: '设计',
    implementation: '实现',
    verification: '验证',
    synthesis: '汇总',
    followup: '跟进',
    execution: '执行',
  }
  return map[phaseId] || '动态任务'
}

function phasePurposeFromId(phaseId: string) {
  const map: Record<string, string> = {
    analysis: '理解目标、上下文和依赖',
    design: '确定方案、边界和产物契约',
    implementation: '执行具体实现与产出',
    verification: '验证结果、审查风险与质量门禁',
    synthesis: '汇总所有产出并形成收口结果',
    followup: '根据已有产物生成后续任务',
    execution: '执行中动态补充的任务',
  }
  return map[phaseId] || '动态注入的任务阶段'
}

function updateAgentTabsFromTaskBoard(
  currentTabs: AgentTab[],
  taskBoard: ChatState['taskBoard'],
  event: { type: string; taskId?: string | null; payload?: Record<string, unknown> },
): AgentTab[] {
  if (!taskBoard) return currentTabs
  const taskId = event.taskId
  if (!taskId) return currentTabs

  const task = taskBoard.tasks.find((t) => t.id === taskId)
  if (!task) return currentTabs

  const tabIndex = currentTabs.findIndex((t) => t.taskId === task.id)
  if (tabIndex === -1) {
    const newTab: AgentTab = {
      taskId: task.id,
      agentId: task.agentId || task.id,
      agentName: task.agentName,
      taskTitle: task.title,
      status:
        task.status === 'running'
          ? 'running'
          : task.status === 'done'
            ? 'done'
            : task.status === 'failed'
              ? 'failed'
              : 'pending',
      childSessionId: (event.payload?.sessionId as string) ?? task.childSessionId ?? null,
    }
    return [...currentTabs, newTab]
  }

  return currentTabs.map((tab, i) => {
    if (i !== tabIndex) return tab
    const sessionId =
      (event.payload?.sessionId as string) ?? tab.childSessionId ?? task.childSessionId
    const status: AgentTab['status'] =
      task.status === 'running'
        ? 'running'
        : task.status === 'done'
          ? 'done'
          : task.status === 'failed'
            ? 'failed'
            : 'pending'
    return {
      ...tab,
      status,
      childSessionId: sessionId,
      taskTitle: task.title,
      agentName: task.agentName,
    }
  })
}

function isTaskBoardSession(
  sessionId: string,
  taskBoard: ChatState['taskBoard'],
  agentTabs: AgentTab[],
) {
  return Boolean(
    taskBoard &&
    (taskBoard.sessionId === sessionId ||
      agentTabs.some((tab) => tab.childSessionId === sessionId)),
  )
}

function selectedTaskForSession(
  sessionId: string,
  taskBoard: ChatState['taskBoard'],
  agentTabs: AgentTab[],
) {
  if (taskBoard?.sessionId === sessionId) return null
  return agentTabs.find((tab) => tab.childSessionId === sessionId)?.taskId ?? null
}

interface AgentTab {
  taskId: string
  agentId: string
  agentName: string
  taskTitle: string
  status: 'pending' | 'running' | 'done' | 'failed'
  childSessionId: string | null
  progress?: number
  progressStatus?: string
}

interface AgentActivity {
  sessionId: string
  agentId?: string
  agentName?: string
  phase?: 'planning' | 'replying' | 'executing' | string
  startedAt: string
}

interface TaskBoardArtifact {
  artifactId?: string
  id?: string
  title?: string
  filePath?: string
  artifactKind?: string
  kind?: string
  type?: string
  source?: string
  url?: string
  size?: number
  taskTitle?: string
  childSessionId?: string | null
}

interface TaskBoardValidationResult {
  command: string
  status: string
  durationMs: number
  outputSummary: string
}

interface TaskBoardTask {
  id: string
  phaseId: string
  title: string
  description: string
  agentId: string
  agentName: string
  taskType?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled'
  progress?: number
  progressStatus?: string
  dependencies: string[]
  childSessionId?: string | null
  artifactCount?: number
  artifacts?: TaskBoardArtifact[]
  outputSummary?: string
  outputRef?: { key?: string; version?: number } | null
  validationStatus?: 'passed' | 'failed' | 'skipped' | 'not_run'
  validationResults?: TaskBoardValidationResult[]
  contractStatus?: 'passed' | 'failed'
  contractViolations?: Array<{ message?: string }>
  resultError?: string
}

function normalizeTaskStatusFromRun(value: unknown): TaskBoardTask['status'] | null {
  if (value === 'pending' || value === 'running' || value === 'done' || value === 'failed' || value === 'blocked' || value === 'cancelled') {
    return value
  }
  return null
}

function taskBoardFromRun(run: OrchestratorRunListItem): ChatState['taskBoard'] | null {
  const plan = asRecord(run.plan)
  if (!plan) return null
  const taskLedger = asRecord(plan.taskLedger)
  const progressLedger = asRecord(plan.progressLedger)
  const planTasks = Array.isArray(plan.tasks) ? plan.tasks : []
  const ledgerTasks = Array.isArray(taskLedger?.tasks) ? taskLedger!.tasks : []
  const tasksSource = ledgerTasks.length > 0 ? ledgerTasks : planTasks
  const planTasksById = new Map(
    planTasks
      .map((task) => asRecord(task))
      .filter((task): task is Record<string, unknown> => Boolean(task?.id))
      .map((task) => [String(task.id), task] as const),
  )
  const ledgerTasksById = new Map(
    ledgerTasks
      .map((task) => asRecord(task))
      .filter((task): task is Record<string, unknown> => Boolean(task?.id))
      .map((task) => [String(task.id), task] as const),
  )
  const phasesSource = Array.isArray(taskLedger?.phases) && taskLedger?.phases.length
    ? taskLedger.phases
    : Array.isArray(plan.phases)
      ? plan.phases
      : []
  const agentNames = new Map(
    Array.isArray(plan.agents)
      ? plan.agents
          .map((agent) => asRecord(agent))
          .filter((agent): agent is Record<string, unknown> => Boolean(agent?.id))
          .map((agent) => [String(agent.id), asString(agent.name) ?? asString(agent.key) ?? 'Agent'] as const)
      : [],
  )
  const taskRowsById = new Map(
    (run.tasks ?? [])
      .map((task) => asRecord(task))
      .filter((task): task is Record<string, unknown> => Boolean(task?.id))
      .map((task) => [String(task.id), task] as const),
  )

  const tasks = tasksSource
    .map((task) => asRecord(task))
    .filter((task): task is Record<string, unknown> => Boolean(task?.id))
    .map((task) => {
      const id = String(task.id)
      const ledgerTask = ledgerTasksById.get(id) ?? task
      const planTask = planTasksById.get(id) ?? task
      const runTask = taskRowsById.get(id)
      const status =
        normalizeTaskStatusFromRun(asString(runTask?.status)) ||
        normalizeTaskStatusFromRun(asString(ledgerTask.status)) ||
        'pending'
      const childSessionId =
        asString(runTask?.childSessionId) ??
        asString(task.childSessionId) ??
        asString(planTask.childSessionId) ??
        null
      return {
        id,
        phaseId:
          asString(runTask?.phaseId) ??
          asString(ledgerTask.phaseId) ??
          asString(planTask.phaseId) ??
          'execution',
        title: asString(runTask?.title) ?? asString(ledgerTask.title) ?? asString(planTask.title) ?? id,
        description:
          asString(runTask?.description) ??
          asString(ledgerTask.description) ??
          asString(planTask.description) ??
          '',
        agentId:
          asString(runTask?.agentId) ??
          asString(ledgerTask.agentId) ??
          asString(planTask.agentId) ??
          id,
        agentName:
          agentNames.get(
            asString(runTask?.agentId) ?? asString(ledgerTask.agentId) ?? asString(planTask.agentId) ?? id,
          ) ?? asString(planTask.agentName) ?? asString(ledgerTask.agentName) ?? asString(task.agentName) ?? 'Agent',
        status,
        progress: asNumber(runTask?.progressPercent) ?? undefined,
        progressStatus: asString(runTask?.progressStatus) ?? undefined,
        dependencies:
          asStringArray(runTask?.dependencies) ??
          asStringArray(ledgerTask.dependencies) ??
          asStringArray(planTask.dependencies) ??
          [],
        childSessionId,
        artifactCount:
          Array.isArray(runTask?.artifacts) ? runTask!.artifacts.length : undefined,
        artifacts: readTaskBoardArtifacts(runTask?.artifacts ?? ledgerTask.artifacts ?? planTask.artifacts),
        outputSummary:
          asString(ledgerTask.outputSummary) ??
          asString(planTask.outputSummary) ??
          undefined,
        validationStatus:
          asString(ledgerTask.validationStatus) ??
          asString(planTask.validationStatus) ??
          undefined,
        contractStatus:
          asString(ledgerTask.contractStatus) ??
          asString(planTask.contractStatus) ??
          undefined,
      } as TaskBoardTask
    })

  const phases = phasesSource.map((phase: unknown) => {
    const item = asRecord(phase) ?? {}
    return {
      id: asString(item.id) ?? 'execution',
      title: asString(item.title) ?? '执行',
      purpose: asString(item.purpose) ?? '',
      taskIds: asStringArray(item.taskIds) ?? [],
      status: 'pending' as const,
    }
  })

  return {
    runId: run.id,
    title: asString(plan.title) ?? '',
    goal: asString(plan.goal) ?? '',
    collaborationMode: asString(plan.collaborationMode) ?? 'mapreduce',
    phases,
    tasks,
    status:
      normalizeAgUiBoardStatus(asString(progressLedger?.status)) ??
      (run.status as NonNullable<ChatState['taskBoard']>['status']) ??
      'running',
    sessionId: run.groupSessionId,
  }
}

function agentTabsFromTaskBoard(taskBoard: NonNullable<ChatState['taskBoard']>): AgentTab[] {
  return taskBoard.tasks.map((task) => ({
    taskId: task.id,
    agentId: task.agentId || task.id,
    agentName: task.agentName,
    taskTitle: task.title,
    status:
      task.status === 'running'
        ? 'running'
        : task.status === 'done'
          ? 'done'
          : task.status === 'failed'
            ? 'failed'
            : 'pending',
    childSessionId: task.childSessionId ?? null,
    progress: task.progress,
    progressStatus: task.progressStatus,
  }))
}

async function loadTaskBoardSnapshotForGroupSession(sessionId: string) {
  const { items } = await api.listOrchestratorRuns()
  const run = items.find((item) => item.groupSessionId === sessionId)
  if (!run) return null
  const taskBoard = taskBoardFromRun(run)
  if (!taskBoard || taskBoard.tasks.length === 0) return null
  return {
    taskBoard,
    agentTabs: agentTabsFromTaskBoard(taskBoard),
  }
}

async function loadTaskBoardSnapshotForSession(session: Session) {
  if (session.type === SessionType.Group) return loadTaskBoardSnapshotForGroupSession(session.id)
  const metadata = session.metadata ?? {}
  const runId =
    typeof metadata.orchestratorRunId === 'string' && metadata.orchestratorRunId.trim()
      ? metadata.orchestratorRunId
      : null
  if (metadata.kind !== 'orchestrator-task' || !runId) return null
  const run = await api.getOrchestratorRun(runId)
  const taskBoard = taskBoardFromRun(run)
  if (!taskBoard || taskBoard.tasks.length === 0) return null
  return {
    taskBoard,
    agentTabs: agentTabsFromTaskBoard(taskBoard),
  }
}

interface AgUiEventPayload {
  type?: string
  name?: string
  value?: unknown
  runId?: string
  threadId?: string
  stepName?: string
  message?: string
  code?: string
  result?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function readTaskBoardArtifacts(value: unknown): TaskBoardArtifact[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      artifactId: asString(item.artifactId),
      id: asString(item.id),
      title: asString(item.title),
      filePath: asString(item.filePath) ?? asString(item.path),
      artifactKind: asString(item.artifactKind),
      kind: asString(item.kind),
      type: asString(item.type),
      source: asString(item.source),
      url: asString(item.url),
      size: asNumber(item.size),
      taskTitle: asString(item.taskTitle),
      childSessionId: asString(item.childSessionId) ?? null,
    }))
}

function mergeTaskArtifacts(
  existing: TaskBoardArtifact[] | undefined,
  incoming: TaskBoardArtifact[],
): TaskBoardArtifact[] {
  const merged: TaskBoardArtifact[] = []
  const seen = new Set<string>()
  for (const artifact of [...(existing ?? []), ...incoming]) {
    const key =
      artifact.artifactId ?? artifact.id ?? artifact.filePath ?? artifact.url ?? artifact.title
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(artifact)
  }
  return merged
}

function artifactFromRunPayload(payload: Record<string, unknown>): TaskBoardArtifact | null {
  const artifact = asRecord(payload.artifact) ?? {}
  const item = {
    artifactId: asString(payload.artifactId) ?? asString(artifact.id),
    id: asString(artifact.id) ?? asString(payload.artifactId),
    title: asString(payload.title) ?? asString(artifact.title),
    filePath: asString(payload.filePath) ?? asString(artifact.filePath) ?? asString(artifact.path),
    artifactKind: asString(payload.artifactKind),
    kind: asString(artifact.kind),
    type: asString(artifact.type),
    source: asString(payload.source),
    url: asString(payload.url) ?? asString(artifact.url),
    size: asNumber(payload.size) ?? asNumber(artifact.size),
    taskTitle: asString(payload.taskTitle),
    childSessionId: asString(payload.childSessionId) ?? null,
  }
  return item.artifactId || item.id || item.filePath || item.url || item.title ? item : null
}

function normalizeAgUiTaskStatus(value: string | undefined): TaskBoardTask['status'] | null {
  if (
    value === 'pending' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'blocked' ||
    value === 'cancelled'
  ) {
    return value
  }
  return null
}

function normalizeAgUiBoardStatus(
  value: string | undefined,
): NonNullable<ChatState['taskBoard']>['status'] | null {
  if (
    value === 'planning' ||
    value === 'running' ||
    value === 'synthesizing' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  return null
}

function normalizeTaskBoardValidationStatus(
  value: string | undefined,
): TaskBoardTask['validationStatus'] | undefined {
  if (value === 'passed' || value === 'failed' || value === 'skipped' || value === 'not_run') {
    return value
  }
  return undefined
}

function normalizeTaskBoardContractStatus(
  value: string | undefined,
): TaskBoardTask['contractStatus'] | undefined {
  if (value === 'passed' || value === 'failed') {
    return value
  }
  return undefined
}

function taskBoardMatchesAgUiEvent(
  taskBoard: ChatState['taskBoard'],
  event: AgUiEventPayload,
  currentSessionId: string,
) {
  if (!taskBoard) return false
  const runId = asString(event.runId)
  const threadId = asString(event.threadId)
  if (runId && runId !== taskBoard.runId) return false
  if (threadId && threadId !== taskBoard.sessionId && threadId !== currentSessionId) return false
  return true
}

function applyTaskStatusToPhases(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  taskId: string,
  tasks: TaskBoardTask[],
  status: TaskBoardTask['status'],
) {
  return taskBoard.phases.map((phase) => {
    if (!phase.taskIds.includes(taskId)) return phase
    if (status === 'running') return { ...phase, status: 'active' as const }
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      const phaseDone = phase.taskIds.every((id) => {
        const task = tasks.find((item) => item.id === id)
        return (
          task &&
          (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')
        )
      })
      return phaseDone ? { ...phase, status: 'completed' as const } : phase
    }
    return phase
  })
}

function applyAgUiTaskStatus(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  value: Record<string, unknown>,
) {
  const taskId = asString(value.taskId)
  const status = normalizeAgUiTaskStatus(asString(value.status))
  if (!taskId || !status) return taskBoard

  const existingTask = taskBoard.tasks.find((task) => task.id === taskId)
  const phaseId =
    asString(value.phaseId) ?? existingTask?.phaseId ?? taskBoard.phases[0]?.id ?? 'execution'
  const progressPercent = asNumber(value.progressPercent)
  const progressStatus = asString(value.progressStatus)
  const artifactCount = asNumber(value.artifactCount)
  const dependencies = asStringArray(value.dependencies)
  const nextTask: TaskBoardTask = {
    id: taskId,
    phaseId,
    title: asString(value.taskTitle) ?? existingTask?.title ?? taskId,
    description: asString(value.description) ?? existingTask?.description ?? '',
    agentId: asString(value.agentId) ?? existingTask?.agentId ?? taskId,
    agentName:
      asString(value.agentName) ?? existingTask?.agentName ?? asString(value.agentId) ?? taskId,
    taskType: asString(value.taskType) ?? existingTask?.taskType,
    status,
    progress: progressPercent ?? existingTask?.progress,
    progressStatus: progressStatus ?? existingTask?.progressStatus,
    dependencies: dependencies ?? existingTask?.dependencies ?? [],
    childSessionId: asString(value.childSessionId) ?? existingTask?.childSessionId ?? null,
    artifactCount: artifactCount ?? existingTask?.artifactCount,
    artifacts: existingTask?.artifacts,
    outputSummary: existingTask?.outputSummary,
    outputRef: existingTask?.outputRef,
    validationStatus: existingTask?.validationStatus,
    validationResults: existingTask?.validationResults,
    contractStatus: existingTask?.contractStatus,
    contractViolations: existingTask?.contractViolations,
    resultError: existingTask?.resultError,
  }

  const tasks = existingTask
    ? taskBoard.tasks.map((task) => (task.id === taskId ? nextTask : task))
    : [...taskBoard.tasks, nextTask]
  const phaseExists = taskBoard.phases.some((phase) => phase.id === phaseId)
  const phases = applyTaskStatusToPhases(
    {
      ...taskBoard,
      phases: phaseExists
        ? taskBoard.phases.map((phase) =>
            phase.id === phaseId && !phase.taskIds.includes(taskId)
              ? { ...phase, taskIds: [...phase.taskIds, taskId] }
              : phase,
          )
        : [
            ...taskBoard.phases,
            {
              id: phaseId,
              title: phaseTitleFromId(phaseId),
              purpose: phasePurposeFromId(phaseId),
              taskIds: [taskId],
              status: 'active' as const,
            },
          ],
    },
    taskId,
    tasks,
    status,
  )

  return {
    ...taskBoard,
    status: status === 'running' ? ('running' as const) : taskBoard.status,
    phases,
    tasks,
  }
}

function applyAgUiArtifact(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  value: Record<string, unknown>,
) {
  const taskId = asString(value.taskId)
  if (!taskId) return taskBoard
  const artifact = artifactFromRunPayload(value)
  if (!artifact) return taskBoard
  return {
    ...taskBoard,
    tasks: taskBoard.tasks.map((task) => {
      if (task.id !== taskId) return task
      const artifacts = mergeTaskArtifacts(task.artifacts, [artifact])
      return {
        ...task,
        childSessionId: artifact.childSessionId ?? task.childSessionId ?? null,
        artifacts,
        artifactCount: artifacts.length,
      }
    }),
  }
}

function applyAgUiBlackboard(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  value: Record<string, unknown>,
) {
  const taskId = asString(value.taskId)
  if (!taskId) return taskBoard
  const key = asString(value.key)
  return {
    ...taskBoard,
    tasks: taskBoard.tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            outputSummary: asString(value.summary) ?? task.outputSummary,
            outputRef: key
              ? {
                  key,
                  version: asNumber(value.version),
                }
              : task.outputRef,
            agentName: asString(value.agentName) ?? task.agentName,
            title: asString(value.taskTitle) ?? task.title,
          }
        : task,
    ),
  }
}

function applyAgUiRunStatus(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  value: Record<string, unknown>,
) {
  const status = normalizeAgUiBoardStatus(asString(value.status))
  if (!status) return taskBoard
  return {
    ...taskBoard,
    status,
  }
}

function buildTaskBoardFromPlanPayload(
  payload: Record<string, unknown>,
  runId: string,
  sessionId: string,
  status: NonNullable<ChatState['taskBoard']>['status'] = 'planning',
): NonNullable<ChatState['taskBoard']> | null {
  const plan = asRecord(payload.plan) ?? asRecord(payload)
  if (!plan) return null
  const phases = Array.isArray(plan.phases) ? plan.phases : []
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : []
  const agents = Array.isArray(plan.agents) ? plan.agents : []
  const agentNames = new Map(
    agents
      .map((agent: unknown) => asRecord(agent))
      .filter((agent): agent is Record<string, unknown> => Boolean(agent?.id))
      .map((agent) => [String(agent.id), asString(agent.name) ?? asString(agent.key) ?? 'Agent'] as const),
  )

  const taskBoardTasks = tasks
    .map((task: unknown) => asRecord(task))
    .filter((task): task is Record<string, unknown> => Boolean(task?.id))
    .map((task) => {
      const id = String(task.id)
      const agentId = asString(task.agentId) ?? id
      return {
        id,
        phaseId: asString(task.phaseId) ?? 'execution',
        title: asString(task.title) ?? id,
        description: asString(task.description) ?? '',
        agentId,
        agentName: agentNames.get(agentId) ?? asString(task.agentName) ?? 'Agent',
        taskType: asString(task.taskType),
        status: 'pending' as const,
        dependencies: asStringArray(task.dependencies) ?? [],
        childSessionId: asString(task.childSessionId) ?? null,
        artifactCount: asNumber(task.artifactCount) ?? undefined,
        artifacts: readTaskBoardArtifacts(task.artifacts),
        outputSummary: asString(task.outputSummary) ?? undefined,
        outputRef: null,
        validationStatus: normalizeTaskBoardValidationStatus(asString(task.validationStatus)),
        contractStatus: normalizeTaskBoardContractStatus(asString(task.contractStatus)),
        contractViolations: undefined,
        resultError: undefined,
      } satisfies TaskBoardTask
    })

  const phaseRows = phases.map((phase: unknown) => {
    const item = asRecord(phase) ?? {}
    return {
      id: asString(item.id) ?? 'execution',
      title: asString(item.title) ?? '执行',
      purpose: asString(item.purpose) ?? '',
      taskIds: asStringArray(item.taskIds) ?? [],
      status: 'pending' as const,
    }
  })

  return {
    runId,
    title: asString(plan.title) ?? '',
    goal: asString(plan.goal) ?? '',
    collaborationMode: asString(plan.collaborationMode) ?? 'mapreduce',
    phases: phaseRows,
    tasks: taskBoardTasks,
    status,
    sessionId,
  }
}

function applyAgUiPlanCreated(
  taskBoard: NonNullable<ChatState['taskBoard']> | null,
  event: AgUiEventPayload,
  currentSessionId: string,
) {
  const runId = asString(event.runId)
  const threadId = asString(event.threadId) ?? currentSessionId
  const payload = asRecord(event.value)
  const board = buildTaskBoardFromPlanPayload(payload ?? {}, runId ?? taskBoard?.runId ?? '', threadId)
  if (!board) return taskBoard
  const preservedSelected = taskBoard?.runId === board.runId ? taskBoard : null
  return preservedSelected
    ? {
        ...board,
        tasks: board.tasks.map((task) => {
          const existing = preservedSelected.tasks.find((item) => item.id === task.id)
          if (!existing) return task
          return {
            ...task,
            status: existing.status,
            progress: existing.progress,
            progressStatus: existing.progressStatus,
            artifactCount: existing.artifactCount ?? task.artifactCount,
            artifacts: existing.artifacts?.length ? existing.artifacts : task.artifacts,
            outputSummary: existing.outputSummary ?? task.outputSummary,
            outputRef: existing.outputRef ?? task.outputRef,
            validationStatus: existing.validationStatus ?? task.validationStatus,
            contractStatus: existing.contractStatus ?? task.contractStatus,
            contractViolations: existing.contractViolations ?? task.contractViolations,
            resultError: existing.resultError ?? task.resultError,
            childSessionId: existing.childSessionId ?? task.childSessionId,
          }
        }),
      }
    : board
}

function applyAgUiEventToState(
  state: ChatState,
  event: AgUiEventPayload,
  sessionId: string,
): ChatState {
  let nextTaskBoard = state.taskBoard
  let agentTyping = state.agentTyping
  let agentActivity = state.agentActivity
  let selectedAgentTab = state.selectedAgentTab

  const currentSessionMatches =
    asString(event.threadId) === sessionId ||
    (nextTaskBoard ? taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId) : true)

  if (!currentSessionMatches) return state

  if (event.type === 'RUN_STARTED') {
    agentTyping = true
    agentActivity = {
      sessionId,
      phase: 'planning',
      startedAt: new Date().toISOString(),
    }
    if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
      nextTaskBoard = { ...nextTaskBoard, status: 'running' }
    }
  }

  if (event.type === 'STEP_STARTED') {
    agentTyping = true
    agentActivity = {
      sessionId,
      phase: 'executing',
      agentName: asString(event.stepName),
      startedAt: new Date().toISOString(),
    }
  }

  if (event.type === 'STEP_FINISHED') {
    agentTyping = false
    agentActivity = null
  }

  if (event.type === 'RUN_FINISHED') {
    const result = asRecord(event.result)
    const boardStatus =
      normalizeAgUiBoardStatus(asString(result?.status)) ??
      (asString(result?.status) === 'cancelled' ? 'cancelled' : 'completed')
    agentTyping = false
    agentActivity = null
    if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
      nextTaskBoard = { ...nextTaskBoard, status: boardStatus }
    }
  }

  if (event.type === 'RUN_ERROR') {
    agentTyping = false
    agentActivity = null
    if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
      nextTaskBoard = { ...nextTaskBoard, status: 'failed' }
    }
  }

  if (event.type === 'CUSTOM') {
    const value = asRecord(event.value)
    if (value && event.name === 'agenthub.plan.created') {
      const previousRunId = nextTaskBoard?.runId
      nextTaskBoard = applyAgUiPlanCreated(nextTaskBoard, event, sessionId)
      if (nextTaskBoard?.runId && previousRunId !== nextTaskBoard.runId) {
        selectedAgentTab = null
      }
      agentTyping = true
      agentActivity = {
        sessionId,
        phase: 'planning',
        startedAt: new Date().toISOString(),
      }
    }
    if (value && event.name === 'agenthub.task.status') {
      const taskStatus = normalizeAgUiTaskStatus(asString(value.status))
      const boardStatus = normalizeAgUiBoardStatus(asString(value.status))
      const taskId = asString(value.taskId)
      if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
        nextTaskBoard = taskStatus
          ? applyAgUiTaskStatus(nextTaskBoard, value)
          : boardStatus
            ? { ...nextTaskBoard, status: boardStatus }
            : nextTaskBoard
      }
      if (taskStatus === 'running') {
        agentTyping = true
        agentActivity = {
          sessionId,
          agentId: asString(value.agentId),
          agentName: asString(value.agentName),
          phase: 'executing',
          startedAt: new Date().toISOString(),
        }
      } else if (taskId && taskStatus) {
        agentTyping = false
        agentActivity = null
      }
    }
    if (value && event.name === 'agenthub.artifact.created') {
      if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
        nextTaskBoard = applyAgUiArtifact(nextTaskBoard, value)
      }
    }
    if (value && event.name === 'agenthub.blackboard.written') {
      if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
        nextTaskBoard = applyAgUiBlackboard(nextTaskBoard, value)
      }
    }
    if (value && event.name === 'agenthub.run.status') {
      if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
        nextTaskBoard = applyAgUiRunStatus(nextTaskBoard, value)
      }
      if (asString(value.status) === 'synthesizing') {
        agentTyping = true
        agentActivity = {
          sessionId,
          phase: 'synthesizing',
          startedAt: new Date().toISOString(),
        }
      }
    }
  }

  const nextAgentTabs =
    nextTaskBoard && nextTaskBoard !== state.taskBoard
      ? updateAgentTabsFromTaskBoard(state.agentTabs, nextTaskBoard, {
          type: event.type ?? 'ag-ui:event',
          taskId: asString(asRecord(event.value)?.taskId) ?? null,
          payload: asRecord(event.value) ?? {},
        })
      : state.agentTabs

  if (
    nextTaskBoard !== state.taskBoard ||
    nextAgentTabs !== state.agentTabs ||
    agentTyping !== state.agentTyping ||
    agentActivity !== state.agentActivity ||
    selectedAgentTab !== state.selectedAgentTab
  ) {
    return {
      ...state,
      taskBoard: nextTaskBoard,
      agentTabs: nextAgentTabs,
      agentTyping,
      agentActivity,
      selectedAgentTab,
    }
  }

  return state
}

function agUiEventsFromLegacyTaskBoardEvent(
  event: WSEvent,
  sessionId: string,
): AgUiEventPayload[] {
  if (event.type === WsEvent.TaskBoardPlanReady) {
    const { runId, plan, sessionId: groupSessionId } = event.payload as {
      runId: string
      plan: Record<string, unknown>
      sessionId: string
    }
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.plan.created',
        runId,
        threadId: groupSessionId ?? sessionId,
        value: { plan, runId, threadId: groupSessionId ?? sessionId },
      },
    ]
  }
  if (event.type === WsEvent.TaskBoardTaskProgress) {
    const { taskId, percent, status, runId, sessionId: groupSessionId, agentId, agentName } =
      event.payload as {
        taskId: string
        percent: number
        status: string
        runId?: string
        sessionId?: string
        agentId?: string
        agentName?: string
      }
    return [
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId,
        threadId: groupSessionId ?? sessionId,
        value: {
          taskId,
          status: 'running',
          progressPercent: percent,
          progressStatus: status,
          agentId,
          agentName,
        },
      },
    ]
  }
  if (event.type === WsEvent.TaskBoardRunCompleted) {
    const { runId, status } = event.payload as { runId: string; status: string }
    return [
      {
        type: 'RUN_FINISHED',
        runId,
        threadId: sessionId,
        result: { status },
      } as unknown as AgUiEventPayload,
    ]
  }
  return []
}

interface ChatState {
  sessions: Session[]
  currentSession: Session | null
  currentWorkspace: Workspace | null
  currentWorkspaceAgents: WorkspaceAgent[]
  currentSessionId: string | null
  messages: Message[]
  streamingMessage: { id: string; content: string; agentId?: string; agentName?: string } | null
  streamingCodeAgentRun: CodeAgentRunMetadata | null
  pendingAttachments: ChatAttachment[]
  loadingSessions: boolean
  loadingMessages: boolean
  agentTyping: boolean
  agentActivity: AgentActivity | null
  replyingToMessageId: string | null
  replyingToMessage: Message | null
  sessionsBootstrapped: boolean
  taskBoard: {
    runId: string
    title: string
    goal: string
    collaborationMode: string
    phases: Array<{
      id: string
      title: string
      purpose: string
      taskIds: string[]
      status: 'pending' | 'active' | 'completed'
    }>
    tasks: TaskBoardTask[]
    status: 'planning' | 'running' | 'synthesizing' | 'completed' | 'failed' | 'cancelled'
    sessionId: string
  } | null
  previewUrl: string | null
  previewFileType: 'html' | 'markdown' | 'image' | null
  previewFileName: string | null
  selectedAgentTab: string | null
  agentTabs: AgentTab[]

  fetchSessions: () => Promise<void>
  createSession: (
    title?: string,
    options?: {
      workspaceId?: string | null
      workspaceAgentId?: string | null
      type?: 'direct' | 'group'
      metadata?: Record<string, unknown> | null
    },
  ) => Promise<Session>
  selectSession: (sessionId: string) => Promise<void>
  setSessionWorkspace: (sessionId: string, workspaceId: string | null) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  clearMessages: (sessionId: string) => Promise<void>
  sendMessage: (
    content: string,
    options?: {
      displayContent?: string
      replyToMessageId?: string | null
    },
  ) => Promise<{ groupSessionId?: string } | undefined>
  sendMessageToSession: (
    sessionId: string,
    content: string,
    options?: {
      displayContent?: string
      replyToMessageId?: string | null
    },
  ) => Promise<{ groupSessionId?: string } | undefined>
  editMessage: (messageId: string, content: string) => Promise<void>
  withdrawMessage: (messageId: string) => Promise<{ reverted: number; failed: number } | null>
  regenerateMessage: (messageId: string) => Promise<void>
  pinMessage: (messageId: string) => Promise<void>
  unpinMessage: (messageId: string) => Promise<void>
  addPendingAttachments: (attachments: ChatAttachment[]) => void
  removePendingAttachment: (id: string) => void
  clearPendingAttachments: () => void
  cancelRun: () => Promise<void>
  setReplyingTo: (messageId: string | null) => void
  setPreviewUrl: (
    url: string | null,
    fileType?: 'html' | 'markdown' | 'image' | null,
    fileName?: string | null,
  ) => void
  selectAgentTab: (agentId: string | null) => void
  handleWSEvent: (e: WSEvent) => void
  initWebSocket: () => () => void
}

function clearPendingStream() {
  pendingStream = null
  if (pendingStreamTimer !== null) {
    window.clearTimeout(pendingStreamTimer)
    pendingStreamTimer = null
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  currentSession: null,
  currentWorkspace: null,
  currentWorkspaceAgents: [],
  currentSessionId: null,
  messages: [],
  streamingMessage: null,
  streamingCodeAgentRun: null,
  pendingAttachments: [],
  loadingSessions: false,
  loadingMessages: false,
  agentTyping: false,
  agentActivity: null,
  replyingToMessageId: null,
  replyingToMessage: null,
  sessionsBootstrapped: false,
  taskBoard: null,
  previewUrl: null,
  previewFileType: null,
  previewFileName: null,
  selectedAgentTab: null,
  agentTabs: [],

  async fetchSessions() {
    set({ loadingSessions: true })
    try {
      const { items } = await api.listSessions()
      set({ sessions: items, loadingSessions: false, sessionsBootstrapped: true })
    } catch {
      set({ loadingSessions: false })
    }
  },

  async createSession(title = '新会话', options = {}) {
    const session = await api.createSession({
      title,
      type: options.type ?? SessionType.Direct,
      workspaceId: options.workspaceId ?? null,
      workspaceAgentId: options.workspaceAgentId ?? null,
      metadata: options.metadata ?? null,
    })
    set((s) => ({ sessions: [session, ...s.sessions] }))
    return session
  },

  async selectSession(sessionId) {
    clearPendingStream()
    cancelledSessions.delete(sessionId)
    const state = get()
    const keepTaskBoard = isTaskBoardSession(sessionId, state.taskBoard, state.agentTabs)
    const optimisticSession =
      state.sessions.find((session) => session.id === sessionId) ??
      (state.currentSession?.id === sessionId ? state.currentSession : null)
    const cachedWorkspace = optimisticSession?.workspaceId
      ? workspaceDetailsCache.get(optimisticSession.workspaceId)
      : null
    const canReuseWorkspace =
      optimisticSession?.workspaceId &&
      state.currentSession?.workspaceId === optimisticSession.workspaceId
    const cachedMessages = messageCache.get(sessionId)
    const shouldRestoreTaskBoard =
      optimisticSession?.type === SessionType.Group ||
      (optimisticSession?.metadata?.kind === 'orchestrator-task' &&
        typeof optimisticSession.metadata?.orchestratorRunId === 'string')
    const taskBoardSnapshot =
      !keepTaskBoard && optimisticSession && shouldRestoreTaskBoard
        ? loadTaskBoardSnapshotForSession(optimisticSession).catch(() => null)
        : Promise.resolve(null)

    set({
      currentSessionId: sessionId,
      currentSession: optimisticSession ?? state.currentSession,
      currentWorkspace: optimisticSession?.workspaceId
        ? (cachedWorkspace?.workspace ?? (canReuseWorkspace ? state.currentWorkspace : null))
        : null,
      currentWorkspaceAgents: optimisticSession?.workspaceId
        ? sessionWorkspaceAgents(
            optimisticSession,
            cachedWorkspace?.agents ?? (canReuseWorkspace ? state.currentWorkspaceAgents : []),
          )
        : [],
      loadingMessages: true,
      messages: cachedMessages ? sortMessages(cachedMessages) : [],
      streamingMessage: null,
      streamingCodeAgentRun: null,
      pendingAttachments: [],
      agentTyping: false,
      agentActivity: null,
      replyingToMessageId: null,
      replyingToMessage: null,
      taskBoard: keepTaskBoard ? state.taskBoard : null,
      agentTabs: keepTaskBoard ? state.agentTabs : [],
      selectedAgentTab: keepTaskBoard
        ? selectedTaskForSession(sessionId, state.taskBoard, state.agentTabs)
        : null,
    })
    wsClient.joinSessions(
      Array.from(new Set([sessionId, keepTaskBoard ? state.taskBoard?.sessionId : null].filter(Boolean) as string[])),
    )
    try {
      const [session, { items }] = await Promise.all([
        api.getSession(sessionId),
        api.listMessages(sessionId),
      ])
      messageCache.set(sessionId, sortMessages(items))
      if (session.workspaceId) {
        const [full, snapshot] = await Promise.all([
          api.getWorkspace(session.workspaceId),
          taskBoardSnapshot,
        ])
        const resolvedSnapshot =
          snapshot ?? (!keepTaskBoard ? await loadTaskBoardSnapshotForSession(session).catch(() => null) : null)
        workspaceDetailsCache.set(session.workspaceId, {
          workspace: full.workspace,
          agents: full.agents,
        })
        if (get().currentSessionId !== sessionId) return
        const currentAgents = sessionWorkspaceAgents(session, full.agents)
        if (resolvedSnapshot) {
          wsClient.joinSessions(
            Array.from(new Set([sessionId, resolvedSnapshot.taskBoard.sessionId].filter(Boolean) as string[])),
          )
        }
        set({
          currentSession: session,
          currentWorkspace: full.workspace,
          currentWorkspaceAgents: currentAgents,
          messages: sortMessages(items),
          loadingMessages: false,
          ...(resolvedSnapshot
            ? {
                taskBoard: resolvedSnapshot.taskBoard,
                agentTabs: resolvedSnapshot.agentTabs,
                selectedAgentTab: selectedTaskForSession(
                  sessionId,
                  resolvedSnapshot.taskBoard,
                  resolvedSnapshot.agentTabs,
                ),
              }
            : {}),
        })
      } else {
        const snapshot =
          (await taskBoardSnapshot) ??
          (!keepTaskBoard ? await loadTaskBoardSnapshotForSession(session).catch(() => null) : null)
        if (get().currentSessionId !== sessionId) return
        if (snapshot) {
          wsClient.joinSessions(
            Array.from(new Set([sessionId, snapshot.taskBoard.sessionId].filter(Boolean) as string[])),
          )
        }
        set({
          currentSession: session,
          currentWorkspace: null,
          currentWorkspaceAgents: [],
          messages: sortMessages(items),
          loadingMessages: false,
          ...(snapshot
            ? {
                taskBoard: snapshot.taskBoard,
                agentTabs: snapshot.agentTabs,
                selectedAgentTab: selectedTaskForSession(
                  sessionId,
                  snapshot.taskBoard,
                  snapshot.agentTabs,
                ),
              }
            : {}),
        })
      }
    } catch (error) {
      if (get().currentSessionId !== sessionId) return
      set({ loadingMessages: false })
      throw error
    }
  },

  async setSessionWorkspace(sessionId, workspaceId) {
    const state = get()
    const currentSession =
      state.currentSession?.id === sessionId
        ? state.currentSession
        : (state.sessions.find((item) => item.id === sessionId) ?? null)

    let workspaceAgentId: string | null = null
    let full: WorkspaceFull | null = null
    if (workspaceId) {
      full = await api.getWorkspace(workspaceId)
      if (currentSession?.type === SessionType.Direct && currentSession.workspaceAgentId) {
        const currentAgent =
          state.currentWorkspaceAgents.find(
            (item) => item.id === currentSession.workspaceAgentId,
          ) ?? null
        workspaceAgentId =
          full.agents.find((item) => item.id === currentSession.workspaceAgentId)?.id ??
          full.agents.find((item) => sameAgentIdentity(item, currentAgent))?.id ??
          null

        if (!workspaceAgentId && currentAgent) {
          const created = await api.addWorkspaceAgent(
            workspaceId,
            workspaceAgentToConfigInput(currentAgent),
          )
          full = { ...full, agents: [...full.agents, created] }
          workspaceAgentId = created.id
        } else if (!workspaceAgentId && full.agents.length === 1) {
          workspaceAgentId = full.agents[0]!.id
        }
      } else if (full.agents.length === 1) {
        workspaceAgentId = full.agents[0]!.id
      }
    }

    const session = await api.updateSession(sessionId, { workspaceId, workspaceAgentId })
    if (workspaceId && full) {
      workspaceDetailsCache.set(workspaceId, {
        workspace: full.workspace,
        agents: full.agents,
      })
    }
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === session.id ? session : item)),
      currentSession: s.currentSessionId === session.id ? session : s.currentSession,
      currentWorkspace:
        s.currentSessionId === session.id ? (full?.workspace ?? null) : s.currentWorkspace,
      currentWorkspaceAgents:
        s.currentSessionId === session.id ? (full?.agents ?? []) : s.currentWorkspaceAgents,
    }))
  },

  async deleteSession(sessionId) {
    await api.deleteSession(sessionId)
    clearPendingStream()
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== sessionId),
      currentSessionId: s.currentSessionId === sessionId ? null : s.currentSessionId,
      currentSession: s.currentSessionId === sessionId ? null : s.currentSession,
      currentWorkspace: s.currentSessionId === sessionId ? null : s.currentWorkspace,
      currentWorkspaceAgents: s.currentSessionId === sessionId ? [] : s.currentWorkspaceAgents,
      messages: s.currentSessionId === sessionId ? [] : s.messages,
      streamingMessage: s.currentSessionId === sessionId ? null : s.streamingMessage,
      streamingCodeAgentRun: s.currentSessionId === sessionId ? null : s.streamingCodeAgentRun,
      agentTyping: s.currentSessionId === sessionId ? false : s.agentTyping,
      agentActivity: s.currentSessionId === sessionId ? null : s.agentActivity,
    }))
  },

  async clearMessages(sessionId) {
    await api.clearMessages(sessionId)
    if (get().currentSessionId === sessionId) {
      set({
        messages: [],
        streamingMessage: null,
        streamingCodeAgentRun: null,
        agentTyping: false,
        agentActivity: null,
      })
    }
  },

  async sendMessage(content, options) {
    const sessionId = get().currentSessionId
    if (!sessionId) return undefined
    return get().sendMessageToSession(sessionId, content, options)
  },

  async sendMessageToSession(sessionId, content, options) {
    cancelledSessions.delete(sessionId)
    const targetSession =
      get().currentSession?.id === sessionId
        ? get().currentSession
        : (get().sessions.find((item) => item.id === sessionId) ?? null)
    const isGroupSession = targetSession?.type === SessionType.Group && Boolean(targetSession.workspaceId)
    const orchestrator = isGroupSession
      ? get().currentWorkspaceAgents.find((agent) => agent.roleType === 'orchestrator')
      : null
    set({
      agentTyping: true,
      agentActivity: isGroupSession
        ? {
            sessionId,
            agentId: orchestrator?.id,
            agentName: orchestrator?.name ?? 'Orchestrator',
            phase: 'planning',
            startedAt: new Date().toISOString(),
          }
        : null,
    })
    const attachments = get().pendingAttachments
    const contentForAgent = attachments.length
      ? appendAttachmentNote(content, attachments)
      : content
    const displayContent =
      options?.displayContent ?? (attachments.length ? content : contentForAgent)
    const optimisticId = `local-${crypto.randomUUID()}`
    const optimisticMessage: Message = {
      id: optimisticId,
      sessionId,
      senderId: 'default-user',
      senderType: SenderType.User,
      type: MessageType.Text,
      content: displayContent,
      metadata: null,
      replyToMessageId: options?.replyToMessageId ?? get().replyingToMessageId,
      createdAt: new Date().toISOString(),
    }
    set((s) => ({
      messages: upsertMessage(s.messages, optimisticMessage),
      pendingAttachments: [],
      replyingToMessageId: null,
      replyingToMessage: null,
    }))
    try {
      const replyToMessageId = optimisticMessage.replyToMessageId ?? undefined
      const msg = await api.sendMessageWithModel(sessionId, {
        content: contentForAgent,
        attachments,
        displayContent: options?.displayContent ?? (attachments.length ? content : undefined),
        replyToMessageId,
      })
      updateCachedMessages(sessionId, (messages) => upsertMessage(messages, msg))
      set((s) => ({
        messages: upsertMessage(
          s.messages.filter((message) => message.id !== optimisticId),
          msg,
        ),
      }))
      await get().fetchSessions()
      set((state) => {
        if (
          state.agentActivity?.sessionId === sessionId &&
          state.agentActivity.phase === 'planning'
        ) {
          return { agentTyping: true }
        }
        return { agentTyping: false, agentActivity: null }
      })
    } catch (error) {
      set((s) => ({
        messages: s.messages.filter((message) => message.id !== optimisticId),
        agentTyping: false,
        agentActivity: null,
        streamingMessage: null,
        streamingCodeAgentRun: null,
      }))
      throw error
    }
    return undefined
  },

  async editMessage(messageId, content) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const updated = await api.updateMessage(sessionId, messageId, { content })
    updateCachedMessages(sessionId, (messages) =>
      messages.map((message) => (message.id === messageId ? updated : message)),
    )
    set((s) => ({
      messages: s.messages.map((message) => (message.id === messageId ? updated : message)),
    }))
  },

  async withdrawMessage(messageId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return null
    cancelledSessions.add(sessionId)
    clearPendingStream()
    set({
      agentTyping: false,
      agentActivity: null,
      streamingMessage: null,
      streamingCodeAgentRun: null,
    })
    await api.cancelMessage(sessionId).catch(() => undefined)
    const result = await api.withdrawMessage(sessionId, messageId, { rollback: true })
    const removed = new Set(result.removedMessageIds)
    updateCachedMessages(sessionId, (messages) =>
      messages.filter((message) => !removed.has(message.id)),
    )
    set((s) => ({ messages: s.messages.filter((message) => !removed.has(message.id)) }))
    return result.rollback
  },

  async regenerateMessage(messageId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    cancelledSessions.delete(sessionId)
    clearPendingStream()
    set({
      agentTyping: true,
      agentActivity: null,
      streamingMessage: null,
      streamingCodeAgentRun: null,
    })
    const result = await api.regenerateMessage(sessionId, messageId)
    updateCachedMessages(sessionId, (messages) =>
      messages.filter((message) => message.id !== result.removedMessageId),
    )
    set((s) => ({
      messages: s.messages.filter((message) => message.id !== result.removedMessageId),
    }))
  },

  async pinMessage(messageId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const updated = await api.pinMessage(sessionId, messageId)
    set((s) => ({
      messages: s.messages.map((message) => (message.id === messageId ? updated : message)),
    }))
  },

  async unpinMessage(messageId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const updated = await api.unpinMessage(sessionId, messageId)
    set((s) => ({
      messages: s.messages.map((message) => (message.id === messageId ? updated : message)),
    }))
  },

  addPendingAttachments(attachments) {
    if (!attachments.length) return
    set((s) => ({ pendingAttachments: [...s.pendingAttachments, ...attachments].slice(0, 6) }))
  },

  removePendingAttachment(id) {
    set((s) => ({
      pendingAttachments: s.pendingAttachments.filter((attachment) => attachment.id !== id),
    }))
  },

  clearPendingAttachments() {
    set({ pendingAttachments: [] })
  },

  async cancelRun() {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    cancelledSessions.add(sessionId)
    clearPendingStream()
    set({
      agentTyping: false,
      agentActivity: null,
      streamingMessage: null,
      streamingCodeAgentRun: null,
    })
    await api.cancelMessage(sessionId).catch(() => undefined)
  },

  setReplyingTo(messageId) {
    if (!messageId) {
      set({ replyingToMessageId: null, replyingToMessage: null })
      return
    }
    const msg = get().messages.find((m) => m.id === messageId) ?? null
    set({ replyingToMessageId: messageId, replyingToMessage: msg })
  },

  setPreviewUrl(url, fileType = null, fileName = null) {
    set({ previewUrl: url, previewFileType: fileType, previewFileName: fileName })
  },

  selectAgentTab(taskId: string | null) {
    const { agentTabs, currentSessionId, taskBoard } = get()
    if (taskId === null) {
      set({ selectedAgentTab: null })
      const groupSessionId = taskBoard?.sessionId ?? currentSessionId
      if (groupSessionId) {
        get().selectSession(groupSessionId)
      }
      return
    }
    const tab = agentTabs.find((t) => t.taskId === taskId)
    if (!tab || !tab.childSessionId) return
    set({ selectedAgentTab: taskId })
    get().selectSession(tab.childSessionId)
  },

  handleWSEvent(e) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const eventSessionId =
      typeof e.payload?.sessionId === 'string' && e.payload.sessionId
        ? e.payload.sessionId
        : typeof e.payload?.threadId === 'string' && e.payload.threadId
          ? e.payload.threadId
          : sessionId
    const isCurrentSessionEvent = eventSessionId === sessionId
    if (!isCurrentSessionEvent) {
      const isTaskBoardEvent = e.type?.startsWith('task_board:') || e.type === WsEvent.AgUiEvent
      if (e.type === WsEvent.MessageCompleted) {
        const { message } = e.payload as { message?: Message }
        if (message) {
          updateCachedMessages(eventSessionId, (messages) => upsertMessage(messages, message))
          void get().fetchSessions()
        }
        return
      }
      if (!isTaskBoardEvent) return
    }

    switch (e.type) {
      case WsEvent.AgentTyping:
        if (cancelledSessions.has(sessionId)) break
        set({
          agentTyping: true,
          agentActivity: {
            sessionId: eventSessionId,
            agentId: typeof e.payload?.agentId === 'string' ? e.payload.agentId : undefined,
            agentName: typeof e.payload?.agentName === 'string' ? e.payload.agentName : undefined,
            phase: typeof e.payload?.phase === 'string' ? e.payload.phase : 'replying',
            startedAt: new Date().toISOString(),
          },
        })
        break
      case WsEvent.MessageStream: {
        if (cancelledSessions.has(sessionId)) break
        const { messageId, delta, agentId, agentName } = e.payload as {
          messageId: string
          delta: string
          agentId?: string
          agentName?: string
        }
        const commitPendingStream = (pending: {
          messageId: string
          delta: string
          agentId?: string
          agentName?: string
        }) => {
          set((s) => {
            const current = s.streamingMessage
            if (current?.id === pending.messageId) {
              return {
                streamingMessage: {
                  id: pending.messageId,
                  content: current.content + pending.delta,
                  agentId: pending.agentId ?? current.agentId,
                  agentName: pending.agentName ?? current.agentName,
                },
              }
            }
            return {
              streamingMessage: {
                id: pending.messageId,
                content: pending.delta,
                agentId: pending.agentId,
                agentName: pending.agentName,
              },
              agentTyping: false,
              agentActivity: null,
            }
          })
        }

        if (pendingStream && pendingStream.messageId !== messageId) {
          const previous = pendingStream
          clearPendingStream()
          commitPendingStream(previous)
        }

        if (pendingStream && pendingStream.messageId === messageId) {
          pendingStream = {
            messageId,
            delta: pendingStream.delta + delta,
            agentId: agentId ?? pendingStream.agentId,
            agentName: agentName ?? pendingStream.agentName,
          }
        } else {
          pendingStream = { messageId, delta, agentId, agentName }
        }

        if (pendingStreamTimer === null) {
          pendingStreamTimer = window.setTimeout(() => {
            const pending = pendingStream
            pendingStream = null
            pendingStreamTimer = null
            if (!pending) return

            commitPendingStream(pending)
          }, 32)
        }
        break
      }
      case WsEvent.MessageMetadata: {
        if (cancelledSessions.has(sessionId)) break
        const { messageId, codeAgentRun, agentId, agentName } = e.payload as {
          messageId: string
          codeAgentRun: Partial<CodeAgentRunMetadata>
          agentId?: string
          agentName?: string
        }
        set((s) => {
          const current = s.streamingMessage
          const nextCodeAgentRun =
            s.streamingCodeAgentRun && codeAgentRun
              ? ({ ...s.streamingCodeAgentRun, ...codeAgentRun } as CodeAgentRunMetadata)
              : (codeAgentRun as CodeAgentRunMetadata)
          return {
            streamingMessage:
              current?.id === messageId
                ? {
                    ...current,
                    agentId: agentId ?? current.agentId,
                    agentName: agentName ?? current.agentName,
                  }
                : {
                    id: messageId,
                    content: current?.content ?? '',
                    agentId,
                    agentName,
                  },
            streamingCodeAgentRun: nextCodeAgentRun,
            agentTyping: false,
            agentActivity: null,
          }
        })
        break
      }
      case WsEvent.MessageCompleted: {
        const { message } = e.payload as { message: Message }
        cancelledSessions.delete(sessionId)
        clearPendingStream()
        updateCachedMessages(sessionId, (messages) => upsertMessage(messages, message))
        set((s) => {
          return {
            messages: upsertMessage(s.messages, message),
            streamingMessage: null,
            streamingCodeAgentRun: null,
            agentTyping: false,
            agentActivity: null,
          }
        })
        break
      }
      case WsEvent.MessageCancelled:
        cancelledSessions.add(sessionId)
        clearPendingStream()
        set({
          streamingMessage: null,
          streamingCodeAgentRun: null,
          agentTyping: false,
          agentActivity: null,
        })
        break
      case WsEvent.AgUiEvent: {
        const event = (e.payload ?? {}) as AgUiEventPayload
        set((s) => applyAgUiEventToState(s, event, sessionId))
        break
      }
      case WsEvent.TaskBoardPlanReady: {
        const events = agUiEventsFromLegacyTaskBoardEvent(e, sessionId)
        if (events.length > 0) {
          set((state) =>
            events.reduce((next, event) => applyAgUiEventToState(next, event, sessionId), state),
          )
        }
        void get().fetchSessions()
        break
      }
      case WsEvent.TaskBoardTaskProgress: {
        const events = agUiEventsFromLegacyTaskBoardEvent(e, sessionId)
        if (events.length > 0) {
          set((state) =>
            events.reduce((next, event) => applyAgUiEventToState(next, event, sessionId), state),
          )
        }
        break
      }
      case WsEvent.TaskBoardRunCompleted: {
        const events = agUiEventsFromLegacyTaskBoardEvent(e, sessionId)
        if (events.length > 0) {
          set((state) =>
            events.reduce((next, event) => applyAgUiEventToState(next, event, sessionId), state),
          )
        }
        void get().fetchSessions()
        break
      }
    }
  },

  initWebSocket() {
    wsClient.connect()
    return wsClient.on((e) => get().handleWSEvent(e))
  },
}))

function sameAgentIdentity(agent: WorkspaceAgent, current: WorkspaceAgent | null) {
  if (!current) return false
  return (
    [
      normalizeMatchText(agent.name),
      normalizeMatchText(agent.role),
      normalizeMatchText(agent.runtimeType ?? ''),
      normalizeMatchText(agent.runtimeType === 'code-agent' ? (agent.codeAgentType ?? '') : ''),
    ].join('|') ===
    [
      normalizeMatchText(current.name),
      normalizeMatchText(current.role),
      normalizeMatchText(current.runtimeType ?? ''),
      normalizeMatchText(current.runtimeType === 'code-agent' ? (current.codeAgentType ?? '') : ''),
    ].join('|')
  )
}

function workspaceAgentToConfigInput(agent: WorkspaceAgent): AgentConfigInput {
  return {
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType ?? 'custom',
    description: agent.description ?? '',
    avatar: agent.avatar ?? null,
    systemPrompt: agent.systemPrompt ?? '',
    roleProfile: agent.roleProfile ?? null,
    color: agent.color ?? '#111827',
    modelId: agent.modelId ?? null,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: [...agent.capabilityTags],
    toolPermissions: [...agent.toolPermissions],
    sandboxPolicy: agent.sandboxPolicy,
    contextPolicy: agent.contextPolicy,
    autoInvoke: agent.autoInvoke,
    approvalRequired: agent.approvalRequired,
  }
}

function normalizeMatchText(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase()
}

function appendAttachmentNote(content: string, attachments: ChatAttachment[]) {
  const note = attachments
    .map((attachment) => `- ${attachment.name} (${attachment.mimeType})`)
    .join('\n')
  return `${content.trim()}\n\n[已附加图片]\n${note}`.trim()
}
