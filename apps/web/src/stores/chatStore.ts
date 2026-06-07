import { create } from 'zustand'
import {
  api,
  type AgentConfigInput,
  type ChatAttachment,
  type Message,
  type OrchestratorRunListItem,
  type OrchestratorRunTaskBoardSnapshot,
  type QuotedMessagePreview,
  type Room,
  type RoomParticipant,
  type RoomSessionSnapshot,
  type Session,
  type TimelineEvent,
  type Workspace,
  type WorkspaceAgent,
  type WorkspaceFull,
} from '../lib/api'
import {
  applyRoomTimelineMessageControl,
  projectRoomTimeline,
  type RoomTimelineProjection,
} from '../lib/roomTimeline'
import { wsClient, type WSEvent } from '../lib/ws'
import type { CodeAgentRunMetadata } from '@agenthub/shared'
import { WsEvent, MessageType, SessionType, SenderType } from '@agenthub/shared'
import { codeAgentRuntimeLabel } from '../lib/agentDisplay'

let pendingStream: {
  messageId: string
  delta: string
  agentId?: string
  agentName?: string
} | null = null
let pendingStreamTimer: number | null = null
let pendingSessionRefreshTimer: number | null = null
const cancelledSessions = new Set<string>()
const messageCache = new Map<string, Message[]>()
type WorkspaceDetailsCacheEntry = Pick<WorkspaceFull, 'workspace' | 'agents' | 'workerInstances'>

const workspaceDetailsCache = new Map<string, WorkspaceDetailsCacheEntry>()

function updateCachedMessages(sessionId: string, updater: (messages: Message[]) => Message[]) {
  const cached = messageCache.get(sessionId)
  if (!cached) return
  messageCache.set(sessionId, sortMessages(updater(cached)))
}

function upsertSessionList(sessions: Session[], session: Session) {
  const next = sessions.some((item) => item.id === session.id)
    ? sessions.map((item) => (item.id === session.id ? session : item))
    : [session, ...sessions]
  return next.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

function scheduleSessionRefresh(refresh: () => Promise<void>) {
  if (pendingSessionRefreshTimer !== null) return
  pendingSessionRefreshTimer = window.setTimeout(() => {
    pendingSessionRefreshTimer = null
    void refresh()
  }, 80)
}

function agUiEventShouldRefreshSessions(event: AgUiEventPayload) {
  if (event.type !== 'CUSTOM') return false
  const name = asString(event.name)
  const value = asRecord(event.value)
  if (name === 'agenthub.plan.created') return true
  if (name === 'agenthub.run.status') return true
  if (name === 'agenthub.manager.status') return true
  if (name === 'agenthub.member_proposal.continue') return true
  if (name === 'agenthub.task.status' && asString(value?.childSessionId)) return true
  return false
}

function roomTimelineShouldRefreshResources(
  projection: RoomTimelineProjection,
  projectedSessionId: string,
  currentSessionId: string | null,
) {
  if (projectedSessionId !== currentSessionId) return false
  if (projection.events.some((event) => agUiEventShouldRefreshSessions(event))) return true
  return projection.messages.some((message) => {
    const metadata = message.metadata ?? {}
    const roomTimeline = asRecord(metadata.roomTimeline) ?? asRecord(metadata.roomTimelineProjection)
    const eventType = asString(roomTimeline?.eventType)
    const kind = asString(metadata.kind)
    return (
      eventType === 'task.assigned' ||
      eventType === 'task.progress' ||
      eventType === 'approval.requested' ||
      eventType === 'worker.message' ||
      eventType === 'artifact.created' ||
      eventType === 'file.shared' ||
      kind === 'coordinator.action' ||
      kind === 'approval.control' ||
      kind === 'runtime-lease.updated' ||
      kind === 'worker.instance.updated' ||
      kind === 'worker.claimed' ||
      kind === 'worker.progress' ||
      kind === 'artifact.created' ||
      kind === 'manager.status.pending' ||
      kind === 'manager.status.slow' ||
      kind === 'manager.status.timeout' ||
      kind === 'manager.dispatch.diagnostic'
    )
  })
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

function mergeMessages(messages: Message[], incoming: Message[]): Message[] {
  return incoming.reduce((items, message) => upsertMessage(items, message), messages)
}

function createQuotedMessagePreview(
  message: Message,
  kind: QuotedMessagePreview['kind'] = 'reply',
): QuotedMessagePreview {
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
  const displayContent =
    typeof metadata.displayContent === 'string' && metadata.displayContent.trim()
      ? metadata.displayContent
      : message.content
  const content = displayContent
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/\s+/g, ' ')
    .trim()
  const agentName = typeof metadata.agentName === 'string' ? metadata.agentName.trim() : ''
  const senderName = typeof metadata.senderName === 'string' ? metadata.senderName.trim() : ''
  return {
    messageId: message.id,
    senderName:
      message.senderType === SenderType.User
        ? '我'
        : message.senderType === SenderType.System
          ? '系统'
          : agentName || senderName || 'Agent',
    senderType: message.senderType,
    kind,
    content: content ? content.slice(0, 240) : message.type === MessageType.Diff ? '[代码 Diff]' : '[消息]',
  }
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

function mergeAgentTabsFromTaskBoard(
  currentTabs: AgentTab[],
  taskBoard: NonNullable<ChatState['taskBoard']>,
): AgentTab[] {
  const nextTabsByTaskId = new Map(agentTabsFromTaskBoard(taskBoard).map((tab) => [tab.taskId, tab]))
  for (const existing of currentTabs) {
    const next = nextTabsByTaskId.get(existing.taskId)
    if (!next) continue
    nextTabsByTaskId.set(existing.taskId, {
      ...next,
      childSessionId: next.childSessionId ?? existing.childSessionId,
      taskThreadStatus: next.taskThreadStatus ?? existing.taskThreadStatus ?? null,
      workerInstanceId: next.workerInstanceId ?? existing.workerInstanceId,
      runtimeLeaseId: next.runtimeLeaseId ?? existing.runtimeLeaseId,
      progress: next.progress ?? existing.progress,
      progressStatus: next.progressStatus ?? existing.progressStatus,
    })
  }
  return Array.from(nextTabsByTaskId.values())
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

function taskBoardSessionIds(taskBoard: ChatState['taskBoard'], currentSessionId?: string | null) {
  const ids = new Set<string>()
  if (currentSessionId) ids.add(currentSessionId)
  if (taskBoard?.sessionId) ids.add(taskBoard.sessionId)
  for (const task of taskBoard?.tasks ?? []) {
    if (task.childSessionId) ids.add(task.childSessionId)
  }
  return Array.from(ids)
}

function buildOptimisticOrchestratorTaskSession(
  state: ChatState,
  sessionId: string,
): Session | null {
  const taskBoard = state.taskBoard
  if (!taskBoard?.sessionId) return null
  const task = taskBoard.tasks.find((item) => item.childSessionId === sessionId)
  if (!task) return null
  const groupSession =
    state.sessions.find((session) => session.id === taskBoard.sessionId) ??
    (state.currentSession?.id === taskBoard.sessionId ? state.currentSession : null)
  if (!groupSession?.workspaceId) return null
  const assignedWorkspaceAgentId =
    task.taskThreadStatus === 'assigned' ||
    task.taskThreadStatus === 'active' ||
    task.taskThreadStatus === 'waiting_for_human' ||
    task.taskThreadStatus === 'completed' ||
    task.taskThreadStatus === 'failed' ||
    task.taskThreadStatus === 'cancelled' ||
    task.status === 'assigned' ||
    task.status === 'running' ||
    task.status === 'blocked' ||
    task.status === 'done' ||
    task.status === 'failed' ||
    task.status === 'cancelled'
      ? task.agentId
      : null
  return {
    id: sessionId,
    ownerId: groupSession.ownerId,
    title: `${assignedWorkspaceAgentId ? task.agentName : '准备中'} · ${task.title}`,
    type: SessionType.Direct,
    workspaceId: groupSession.workspaceId,
    workspaceAgentId: assignedWorkspaceAgentId,
    metadata: {
      kind: 'orchestrator-task',
      groupSessionId: taskBoard.sessionId,
      orchestratorRunId: taskBoard.runId,
      orchestratorTaskId: task.id,
      taskThreadId: task.taskThreadId ?? undefined,
      workspaceAgentId: assignedWorkspaceAgentId ?? undefined,
      workerInstanceId: task.workerInstanceId ?? undefined,
      taskThreadStatus: deriveTaskThreadStatus(task),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessage: null,
  }
}

interface AgentTab {
  taskId: string
  agentId: string
  agentName: string
  taskTitle: string
  status: 'pending' | 'assigned' | 'running' | 'waiting' | 'done' | 'failed'
  childSessionId: string | null
  taskThreadStatus?: 'prepared' | 'assigned' | 'active' | 'waiting_for_human' | 'completed' | 'failed' | 'cancelled' | null
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
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

interface RuntimeActivityProjection {
  agentTyping: boolean
  agentActivity: AgentActivity | null
}

interface LiveRuntimeProjection extends RuntimeActivityProjection {
  streamingMessage: ChatState['streamingMessage']
  streamingCodeAgentRun: CodeAgentRunMetadata | null
}

export interface ControlPanelProjection {
  tabs: AgentTab[]
  runStatus: NonNullable<ChatState['taskBoard']>['status']
  activeAgentCount: number
  currentActivity: {
    agentName?: string
    phase?: string
    label: string
  } | null
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

export interface TaskBoardTaskPanelProjection extends TaskBoardTask {
  artifactCountResolved: number
  hasResultLine: boolean
  progressTone: 'blue' | 'red' | 'yellow' | 'green'
  statusTone: 'running' | 'waiting' | 'failed' | 'default'
}

export interface TaskBoardPhasePanelProjection {
  id: string
  title: string
  purpose: string
  taskIds: string[]
  status: 'pending' | 'active' | 'completed'
  completedTaskCount: number
  totalTaskCount: number
  tasks: TaskBoardTaskPanelProjection[]
}

export interface TaskBoardPanelProjection {
  runId: string
  title: string
  goal: string
  collaborationMode: string
  status: NonNullable<ChatState['taskBoard']>['status']
  sessionId: string
  taskCount: number
  phaseCount: number
  hasFailedTasks: boolean
  emptyStateLabel: string
  phases: TaskBoardPhasePanelProjection[]
}

interface TaskBoardArtifact {
  artifactId?: string
  id?: string
  title?: string
  filePath?: string
  path?: string
  sourcePath?: string
  handoffPath?: string
  handoffRelativePath?: string
  roomId?: string | null
  storageProvider?: string
  bucket?: string
  objectKey?: string
  storagePath?: string
  artifactKind?: string
  kind?: string
  type?: string
  source?: string
  url?: string
  size?: number
  status?: string
  visibility?: string
  taskTitle?: string
  taskId?: string | null
  taskThreadId?: string | null
  childSessionId?: string | null
  workerInstanceId?: string | null
}

interface TaskBoardValidationResult {
  command: string
  status: string
  durationMs: number
  outputSummary: string
}

interface TaskExecutionConfig {
  runtimeType?: string
  codeAgentType?: string
  adapterName?: string
  command?: string
  modelId?: string | null
  modelProvider?: string | null
  modelLabel?: string
  baseUrlHost?: string | null
  readinessStatus?: string
  installed?: boolean
  configured?: boolean
  executionEnabled?: boolean
  canExecute?: boolean
  sandboxPolicy?: string
  sandboxProvider?: string
  isolation?: string
  executionPath?: string | null
  workdirRelativePath?: string | null
  skillCount?: number
  toolPermissions?: string[]
  approvalRequired?: boolean
}

interface TaskBoardTask {
  id: string
  phaseId: string
  title: string
  description: string
  agentId: string
  agentName: string
  taskType?: string
  status: 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled'
  progress?: number
  progressStatus?: string
  dependencies: string[]
  childSessionId?: string | null
  taskThreadId?: string | null
  taskThreadStatus?: 'prepared' | 'assigned' | 'active' | 'waiting_for_human' | 'completed' | 'failed' | 'cancelled' | null
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  sharedTaskRelativeRoot?: string | null
  sharedTaskSpecPath?: string | null
  artifactCount?: number
  artifacts?: TaskBoardArtifact[]
  outputSummary?: string
  outputRef?: { key?: string; version?: number } | null
  validationStatus?: 'passed' | 'failed' | 'skipped' | 'not_run'
  validationResults?: TaskBoardValidationResult[]
  contractStatus?: 'passed' | 'failed'
  contractViolations?: Array<{ message?: string }>
  resultError?: string
  executionConfig?: TaskExecutionConfig
}

function normalizeTaskStatusFromRun(value: unknown): TaskBoardTask['status'] | null {
  if (value === 'pending' || value === 'assigned' || value === 'running' || value === 'done' || value === 'failed' || value === 'blocked' || value === 'cancelled') {
    return value
  }
  return null
}

function normalizeTaskStatusFromTaskThread(value: unknown): TaskBoardTask['status'] | null {
  if (value === 'prepared') return 'pending'
  if (value === 'assigned') return 'assigned'
  if (value === 'active') return 'running'
  if (value === 'waiting_for_human') return 'blocked'
  if (value === 'completed') return 'done'
  if (value === 'failed' || value === 'cancelled') return value
  return null
}

function normalizeTaskThreadStatus(
  value: unknown,
): TaskBoardTask['taskThreadStatus'] {
  if (
    value === 'prepared' ||
    value === 'assigned' ||
    value === 'active' ||
    value === 'waiting_for_human' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  return null
}

function deriveTaskThreadStatus(task: Pick<TaskBoardTask, 'taskThreadStatus' | 'status'>) {
  if (task.taskThreadStatus) return task.taskThreadStatus
  if (task.status === 'assigned') return 'assigned'
  if (task.status === 'blocked') return 'waiting_for_human'
  if (task.status === 'running') return 'active'
  if (task.status === 'done') return 'completed'
  if (task.status === 'failed' || task.status === 'cancelled') return task.status
  return 'prepared'
}

function taskBoardFromServerSnapshot(
  snapshot: OrchestratorRunTaskBoardSnapshot | undefined,
): ChatState['taskBoard'] | null {
  if (!snapshot) return null

  const tasks = Array.isArray(snapshot.tasks)
    ? snapshot.tasks
        .map((task) => asRecord(task))
        .filter((task): task is Record<string, unknown> => Boolean(task?.id))
        .map((task) => ({
          id: String(task.id),
          phaseId: asString(task.phaseId) ?? 'execution',
          title: asString(task.title) ?? String(task.id),
          description: asString(task.description) ?? '',
          agentId: asString(task.agentId) ?? String(task.id),
          agentName: asString(task.agentName) ?? 'Agent',
          taskType: asString(task.taskType),
          status: normalizeTaskStatusFromRun(asString(task.status)) ?? 'pending',
          progress: asNumber(task.progress) ?? undefined,
          progressStatus: asString(task.progressStatus) ?? undefined,
          dependencies: asStringArray(task.dependencies) ?? [],
          childSessionId: asString(task.childSessionId) ?? null,
          taskThreadId: asString(task.taskThreadId) ?? null,
          taskThreadStatus: normalizeTaskThreadStatus(task.taskThreadStatus),
          workerInstanceId: asString(task.workerInstanceId) ?? null,
          runtimeLeaseId: asString(task.runtimeLeaseId) ?? null,
          sharedTaskRelativeRoot: asString(task.sharedTaskRelativeRoot) ?? null,
          sharedTaskSpecPath: asString(task.sharedTaskSpecPath) ?? null,
          artifactCount: asNumber(task.artifactCount) ?? undefined,
          artifacts: readTaskBoardArtifacts(task.artifacts),
          outputSummary: asString(task.outputSummary) ?? undefined,
          outputRef: null,
          validationStatus: normalizeTaskBoardValidationStatus(asString(task.validationStatus)),
          validationResults: undefined,
          contractStatus: normalizeTaskBoardContractStatus(asString(task.contractStatus)),
          contractViolations: undefined,
          resultError: asString(task.resultError) ?? undefined,
          executionConfig: readExecutionConfig(task.executionConfig),
        }))
    : []

  const phases = Array.isArray(snapshot.phases)
    ? snapshot.phases
        .map((phase) => asRecord(phase))
        .filter((phase): phase is Record<string, unknown> => Boolean(phase?.id))
        .map((phase) => ({
          id: asString(phase.id) ?? 'execution',
          title: asString(phase.title) ?? '执行',
          purpose: asString(phase.purpose) ?? '',
          taskIds: asStringArray(phase.taskIds) ?? [],
          status: (
            phase.status === 'active' || phase.status === 'completed' || phase.status === 'pending'
              ? phase.status
              : 'pending'
          ) as 'pending' | 'active' | 'completed',
        }))
    : []

  return {
    runId: snapshot.runId,
    title: snapshot.title,
    goal: snapshot.goal,
    collaborationMode: snapshot.collaborationMode,
    phases: applyTaskStatusToPhases(phases, tasks),
    tasks,
    status: normalizeAgUiBoardStatus(snapshot.status) ?? 'running',
    sessionId: snapshot.sessionId,
  }
}

function taskBoardFromRun(run: OrchestratorRunListItem): ChatState['taskBoard'] | null {
  const snapshotBoard = taskBoardFromServerSnapshot(run.taskBoardSnapshot)
  if (snapshotBoard) return snapshotBoard

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
  const resourceSnapshot = asRecord(run.resourceSnapshot)
  const resourceThreadsByTaskId = new Map(
    (Array.isArray(resourceSnapshot?.taskThreads) ? resourceSnapshot.taskThreads : [])
      .map((thread) => asRecord(thread))
      .filter((thread): thread is Record<string, unknown> => Boolean(thread?.taskId))
      .map((thread) => [String(thread.taskId), thread] as const),
  )
  const resourceArtifactsByTaskId = new Map<string, Record<string, unknown>[]>()
  for (const artifact of Array.isArray(resourceSnapshot?.artifacts) ? resourceSnapshot.artifacts : []) {
    const item = asRecord(artifact)
    const taskId = asString(item?.taskId)
    if (!item || !taskId) continue
    const artifacts = resourceArtifactsByTaskId.get(taskId) ?? []
    artifacts.push(item)
    resourceArtifactsByTaskId.set(taskId, artifacts)
  }
  const latestResourceLeaseByTaskId = new Map<string, Record<string, unknown>>()
  for (const lease of Array.isArray(resourceSnapshot?.runtimeLeases) ? resourceSnapshot.runtimeLeases : []) {
    const item = asRecord(lease)
    const taskId = asString(item?.taskId)
    if (!item || !taskId) continue
    latestResourceLeaseByTaskId.set(taskId, item)
  }

  const tasks = tasksSource
    .map((task) => asRecord(task))
    .filter((task): task is Record<string, unknown> => Boolean(task?.id))
    .map((task) => {
      const id = String(task.id)
      const ledgerTask = ledgerTasksById.get(id) ?? task
      const planTask = planTasksById.get(id) ?? task
      const runTask = taskRowsById.get(id)
      const resourceThread = resourceThreadsByTaskId.get(id)
      const resourceLease = latestResourceLeaseByTaskId.get(id)
      const resourceArtifacts = resourceArtifactsByTaskId.get(id)
      const status =
        normalizeTaskStatusFromTaskThread(asString(resourceThread?.status)) ||
        normalizeTaskStatusFromTaskThread(asString(runTask?.taskThreadStatus)) ||
        normalizeTaskStatusFromRun(asString(runTask?.status)) ||
        normalizeTaskStatusFromRun(asString(ledgerTask.status)) ||
        'pending'
      const childSessionId =
        asString(resourceThread?.sessionId) ??
        asString(runTask?.taskThreadSessionId) ??
        asString(runTask?.childSessionId) ??
        asString(task.childSessionId) ??
        asString(planTask.childSessionId) ??
        null
      const taskThreadStatus =
        normalizeTaskThreadStatus(resourceThread?.status) ??
        normalizeTaskThreadStatus(runTask?.taskThreadStatus) ??
        normalizeTaskThreadStatus(task.taskThreadStatus) ??
        normalizeTaskThreadStatus(planTask.taskThreadStatus) ??
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
        taskThreadId:
          asString(resourceThread?.id) ??
          asString(runTask?.taskThreadId) ??
          asString(task.taskThreadId) ??
          asString(planTask.taskThreadId) ??
          null,
        taskThreadStatus,
        workerInstanceId:
          asString(resourceThread?.workerInstanceId) ??
          asString(resourceLease?.workerInstanceId) ??
          asString(runTask?.workerInstanceId) ??
          asString(task.workerInstanceId) ??
          asString(planTask.workerInstanceId) ??
          null,
        runtimeLeaseId:
          asString(resourceLease?.runtimeLeaseId) ??
          asString(resourceLease?.id) ??
          asString(runTask?.runtimeLeaseId) ??
          asString(asRecord(runTask?.runtimeLease)?.runtimeLeaseId) ??
          asString(asRecord(runTask?.runtimeLease)?.id) ??
          asString(task.runtimeLeaseId) ??
          asString(planTask.runtimeLeaseId) ??
          null,
        sharedTaskRelativeRoot:
          asString(resourceThread?.sharedTaskRelativeRoot) ??
          asString(runTask?.sharedTaskRelativeRoot) ??
          asString(task.sharedTaskRelativeRoot) ??
          asString(planTask.sharedTaskRelativeRoot) ??
          null,
        sharedTaskSpecPath:
          asString(resourceThread?.sharedTaskSpecPath) ??
          asString(runTask?.sharedTaskSpecPath) ??
          asString(task.sharedTaskSpecPath) ??
          asString(planTask.sharedTaskSpecPath) ??
          null,
        artifactCount:
          resourceArtifacts?.length ??
          (Array.isArray(runTask?.artifacts) ? runTask!.artifacts.length : undefined),
        artifacts: readTaskBoardArtifacts(resourceArtifacts ?? runTask?.artifacts ?? ledgerTask.artifacts ?? planTask.artifacts),
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
        executionConfig: readExecutionConfig(
          runTask?.executionConfig ?? ledgerTask.executionConfig ?? planTask.executionConfig,
        ),
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
  const normalizedPhases = applyTaskStatusToPhases(phases, tasks)

  return {
    runId: run.id,
    title: asString(plan.title) ?? '',
    goal: asString(plan.goal) ?? '',
    collaborationMode: asString(plan.collaborationMode) ?? 'mapreduce',
    phases: normalizedPhases,
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
    status: agentTabStatusFromTaskStatus(task.status),
    childSessionId: task.childSessionId ?? null,
    taskThreadStatus: task.taskThreadStatus ?? null,
    workerInstanceId: task.workerInstanceId ?? null,
    runtimeLeaseId: task.runtimeLeaseId ?? null,
    progress: task.progress,
    progressStatus: task.progressStatus,
  }))
}

function buildRunResourceTaskEntries(
  run: OrchestratorRunListItem,
  taskBoard: NonNullable<ChatState['taskBoard']>,
): RunResourceTaskEntry[] {
  const resourceSnapshot = asRecord(run.resourceSnapshot)
  const threadRows = Array.isArray(resourceSnapshot?.taskThreads) ? resourceSnapshot.taskThreads : []
  if (!threadRows.length) return []

  const taskRowsById = new Map(
    (Array.isArray(resourceSnapshot?.tasks) ? resourceSnapshot.tasks : [])
      .map((task) => asRecord(task))
      .filter((task): task is Record<string, unknown> => Boolean(task?.id))
      .map((task) => [String(task.id), task] as const),
  )
  const boardTasksById = new Map(taskBoard.tasks.map((task) => [task.id, task] as const))

  return threadRows
    .map((thread) => asRecord(thread))
    .filter((thread): thread is Record<string, unknown> => Boolean(thread?.taskId))
    .map((thread) => {
      const taskId = String(thread.taskId)
      const resourceTask = taskRowsById.get(taskId)
      const boardTask = boardTasksById.get(taskId)
      const taskThreadStatus = normalizeTaskThreadStatus(thread.status)
      return {
        taskId,
        childSessionId: asString(thread.sessionId) ?? null,
        taskThreadId: asString(thread.id) ?? null,
        taskThreadStatus,
        workerInstanceId: asString(thread.workerInstanceId) ?? boardTask?.workerInstanceId ?? null,
        agentId:
          (boardTask?.agentId && boardTask.agentId.trim()) ||
          asString(resourceTask?.agentId) ||
          taskId,
        agentName:
          boardTask?.agentName ||
          asString(resourceTask?.agentName) ||
          'Agent',
        taskTitle:
          boardTask?.title ||
          asString(resourceTask?.title) ||
          taskId,
        status: agentTabStatusFromTaskStatus(
          taskThreadStatus === 'prepared'
            ? 'pending'
            : taskThreadStatus === 'assigned'
              ? 'assigned'
              : taskThreadStatus === 'active'
                ? 'running'
                : taskThreadStatus === 'completed'
                  ? 'done'
                  : taskThreadStatus === 'waiting_for_human'
                    ? 'blocked'
                    : taskThreadStatus === 'failed'
                      ? 'failed'
                      : boardTask?.status ?? 'pending',
        ),
        progress: boardTask?.progress,
        progressStatus: boardTask?.progressStatus,
      } satisfies RunResourceTaskEntry
    })
}

function agentTabsFromRunSnapshot(
  run: OrchestratorRunListItem,
  taskBoard: NonNullable<ChatState['taskBoard']>,
): AgentTab[] {
  const resourceTabs = buildRunResourceTaskEntries(run, taskBoard)
  if (!resourceTabs.length) return agentTabsFromTaskBoard(taskBoard)

  const resourceTabsByTaskId = new Map(resourceTabs.map((tab) => [tab.taskId, tab] as const))
  return taskBoard.tasks.map((task) => {
    const resourceTab = resourceTabsByTaskId.get(task.id)
    if (!resourceTab) {
      return {
        taskId: task.id,
        agentId: task.agentId || task.id,
        agentName: task.agentName,
        taskTitle: task.title,
        status: agentTabStatusFromTaskStatus(task.status),
        childSessionId: task.childSessionId ?? null,
        taskThreadStatus: task.taskThreadStatus ?? null,
        workerInstanceId: task.workerInstanceId ?? null,
        runtimeLeaseId: task.runtimeLeaseId ?? null,
        progress: task.progress,
        progressStatus: task.progressStatus,
      }
    }
    return {
      taskId: resourceTab.taskId,
      agentId: resourceTab.agentId,
      agentName: resourceTab.agentName,
      taskTitle: resourceTab.taskTitle,
      status: resourceTab.status,
      childSessionId: resourceTab.childSessionId,
      taskThreadStatus: resourceTab.taskThreadStatus,
      workerInstanceId: resourceTab.workerInstanceId,
      runtimeLeaseId: task.runtimeLeaseId ?? null,
      progress: resourceTab.progress ?? task.progress,
      progressStatus: resourceTab.progressStatus ?? task.progressStatus,
    }
  })
}

function agentTabStatusFromTaskStatus(status: TaskBoardTask['status']): AgentTab['status'] {
  if (status === 'assigned') return 'assigned'
  if (status === 'running') return 'running'
  if (status === 'blocked') return 'waiting'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  return 'pending'
}

function buildProjectionRunFromResourceSnapshot(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  snapshot: Record<string, unknown>,
): OrchestratorRunListItem {
  return {
    id: taskBoard.runId,
    workspaceId: '',
    groupSessionId: taskBoard.sessionId,
    planMessageId: null,
    status: taskBoard.status as OrchestratorRunListItem['status'],
    plan: null,
    summaryMessageId: null,
    conflictReport: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceName: '',
    sessionTitle: '',
    resourceSnapshot: snapshot as unknown as OrchestratorRunListItem['resourceSnapshot'],
  }
}

function projectRoomResourceSnapshot(
  snapshot: RoomSessionSnapshot,
  agents: WorkspaceAgent[] = [],
): TaskBoardSnapshot | null {
  const resources = snapshot.resources
  const run = resources.run ?? resources.activeRun ?? null
  if (!run || resources.tasks.length === 0) return null

  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name] as const))
  const threadsByTaskId = new Map(resources.taskThreads.map((thread) => [thread.taskId, thread] as const))
  const latestLeaseByTaskId = new Map<string, (typeof resources.runtimeLeases)[number]>()
  for (const lease of resources.runtimeLeases) {
    if (!lease.taskId) continue
    latestLeaseByTaskId.set(lease.taskId, lease)
  }
  const artifactsByTaskId = new Map<string, typeof resources.artifacts>()
  for (const artifact of resources.artifacts) {
    if (!artifact.taskId) continue
    const list = artifactsByTaskId.get(artifact.taskId) ?? []
    list.push(artifact)
    artifactsByTaskId.set(artifact.taskId, list)
  }

  const tasks: TaskBoardTask[] = resources.tasks
    .slice()
    .sort((a, b) => a.orderIdx - b.orderIdx || a.id.localeCompare(b.id))
    .map((task) => {
      const thread = threadsByTaskId.get(task.id)
      const lease = latestLeaseByTaskId.get(task.id)
      const taskArtifacts = artifactsByTaskId.get(task.id) ?? []
      return {
        id: task.id,
        phaseId: task.phaseId ?? 'execution',
        title: task.title || task.id,
        description: task.description ?? '',
        agentId: task.agentId ?? thread?.workspaceAgentId ?? task.id,
        agentName:
          (task.agentId ? agentNames.get(task.agentId) : undefined) ??
          (thread?.workspaceAgentId ? agentNames.get(thread.workspaceAgentId) : undefined) ??
          'Agent',
        status:
          normalizeTaskStatusFromTaskThread(thread?.status) ??
          normalizeTaskStatusFromRun(task.status) ??
          'pending',
        progress: task.progressPercent ?? undefined,
        progressStatus: task.progressStatus ?? undefined,
        dependencies: task.dependencies ?? [],
        childSessionId: thread?.sessionId ?? task.sessionId ?? null,
        taskThreadId: thread?.id ?? null,
        taskThreadStatus: normalizeTaskThreadStatus(thread?.status) ?? null,
        workerInstanceId: thread?.workerInstanceId ?? lease?.workerInstanceId ?? null,
        runtimeLeaseId: lease?.runtimeLeaseId ?? lease?.id ?? null,
        sharedTaskRelativeRoot: thread?.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath: thread?.sharedTaskSpecPath ?? null,
        artifactCount: taskArtifacts.length,
        artifacts: readTaskBoardArtifacts(taskArtifacts),
        outputRef: null,
        resultError: task.errorLog ?? undefined,
      }
    })

  const phaseIds = Array.from(new Set(tasks.map((task) => task.phaseId || 'execution')))
  const taskBoard: NonNullable<ChatState['taskBoard']> = {
    runId: run.id,
    title: snapshot.session.title,
    goal: '',
    collaborationMode: 'manager-worker',
    phases: applyTaskStatusToPhases(
      phaseIds.map((phaseId) => ({
        id: phaseId,
        title: phaseId === 'execution' ? '执行' : phaseId,
        purpose: '',
        taskIds: tasks.filter((task) => (task.phaseId || 'execution') === phaseId).map((task) => task.id),
        status: 'pending' as const,
      })),
      tasks,
    ),
    tasks,
    status: run.status as NonNullable<ChatState['taskBoard']>['status'],
    sessionId: run.groupSessionId,
  }
  const projectionRun = buildProjectionRunFromResourceSnapshot(taskBoard, resources as unknown as Record<string, unknown>)
  return {
    taskBoard,
    agentTabs: agentTabsFromRunSnapshot(projectionRun, taskBoard),
    agUiEvents: [],
    run: projectionRun,
    runtimeActivity: deriveRuntimeActivityFromTaskBoard(taskBoard),
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

function clearRuntimeActivity(): RuntimeActivityProjection {
  return {
    agentTyping: false,
    agentActivity: null,
  }
}

function buildRuntimeActivity(
  sessionId: string,
  input: {
    agentId?: string | undefined
    agentName?: string | undefined
    phase?: string | undefined
  },
): RuntimeActivityProjection {
  return {
    agentTyping: true,
    agentActivity: {
      sessionId,
      agentId: input.agentId,
      agentName: input.agentName,
      phase: input.phase,
      startedAt: new Date().toISOString(),
    },
  }
}

function buildReplyingRuntimeProjection(
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
    streamingMessage: null,
    streamingCodeAgentRun: null,
  }
}

function clearLiveRuntimeProjection(): LiveRuntimeProjection {
  return {
    ...clearRuntimeActivity(),
    streamingMessage: null,
    streamingCodeAgentRun: null,
  }
}

function deriveRuntimeActivityFromTaskBoard(
  taskBoard: NonNullable<ChatState['taskBoard']>,
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
      agentName: 'Manager',
      phase: 'planning',
    })
  }

  if (taskBoard.status === 'synthesizing') {
    return buildRuntimeActivity(taskBoard.sessionId, {
      agentName: 'Manager',
      phase: 'synthesizing',
    })
  }

  return clearRuntimeActivity()
}

function runtimeActivityFromSnapshot(input: {
  taskBoard: NonNullable<ChatState['taskBoard']>
  agUiEvents: AgUiEventPayload[]
  serverRuntimeActivity?: OrchestratorRunListItem['runtimeActivitySnapshot']
}): RuntimeActivityProjection {
  const { taskBoard, agUiEvents, serverRuntimeActivity } = input
  if (serverRuntimeActivity) {
    return {
      agentTyping: serverRuntimeActivity.agentTyping,
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

function applyLiveMessageStreamProjection(
  current: LiveRuntimeProjection,
  pending: {
    messageId: string
    delta: string
    agentId?: string
    agentName?: string
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
    streamingMessage,
    streamingCodeAgentRun: current.streamingCodeAgentRun,
  }
}

function applyLiveMessageMetadataProjection(
  current: LiveRuntimeProjection,
  input: {
    messageId: string
    codeAgentRun: Partial<CodeAgentRunMetadata>
    agentId?: string
    agentName?: string
  },
): LiveRuntimeProjection {
  const nextCodeAgentRun =
    current.streamingCodeAgentRun && input.codeAgentRun
      ? ({ ...current.streamingCodeAgentRun, ...input.codeAgentRun } as CodeAgentRunMetadata)
      : (input.codeAgentRun as CodeAgentRunMetadata)

  return {
    ...clearRuntimeActivity(),
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
    streamingCodeAgentRun: nextCodeAgentRun,
  }
}

function reduceRuntimeActivityProjection(
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
        asString(value.agentName) ?? asString(value.actorName) ?? 'Manager',
      phase: asString(value.phase) ?? asString(value.action) ?? status ?? 'thinking',
    })
  }

  if (event.name === 'agenthub.member_proposal.continue') {
    const status = asString(value.status)
    if (status === 'running') {
      return buildRuntimeActivity(sessionId, {
        agentName: 'Manager',
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

function runStatusDetailLabel(status: NonNullable<ChatState['taskBoard']>['status']) {
  if (status === 'planning') return '规划失败'
  if (status === 'synthesizing') return '汇总中断'
  if (status === 'running') return '运行中断'
  if (status === 'failed') return '运行失败'
  if (status === 'cancelled') return '已停止'
  if (status === 'completed') return '已完成'
  return status
}

export function buildHeaderAgentStatusProjection(input: {
  sessionId: string | null | undefined
  taskBoard: ChatState['taskBoard']
  agentTabs: AgentTab[]
  agentTyping: boolean
  agentActivity: AgentActivity | null
  streamingMessage: ChatState['streamingMessage']
  streamingCodeAgentRun: CodeAgentRunMetadata | null
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
        detail: agentActivity?.agentName ?? 'Manager',
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
    const waiting = currentTask?.status === 'blocked' || currentTab?.status === 'waiting'
    return {
      label: waiting ? '等待补充' : '工作中',
      detail: currentTask?.agentName ?? currentTab?.agentName ?? 'Agent',
      tone: waiting ? 'warning' : 'working',
      live: true,
    }
  }

  if (taskBoard && sessionId === taskBoard.sessionId) {
    if (taskBoard.status === 'planning') {
      return { label: '规划中', detail: 'Manager', tone: 'thinking', live: true }
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

export function buildControlPanelProjection(input: {
  taskBoard: ChatState['taskBoard']
  agentTabs: AgentTab[]
  agentTyping: boolean
  agentActivity: AgentActivity | null
}): ControlPanelProjection | null {
  const { taskBoard, agentTabs, agentTyping, agentActivity } = input
  if (!taskBoard) return null

  let tabs = mergeAgentTabsFromTaskBoard(agentTabs, taskBoard)
  const executingAgentId = agentTyping && agentActivity?.phase === 'executing' ? agentActivity.agentId : null
  const executingAgentName =
    agentTyping && agentActivity?.phase === 'executing' ? agentActivity.agentName : null

  if (executingAgentId || executingAgentName) {
    tabs = tabs.map((tab) => {
      const matchesAgent =
        (executingAgentId && tab.agentId === executingAgentId) ||
        (executingAgentName && tab.agentName === executingAgentName)
      if (!matchesAgent || tab.status === 'done' || tab.status === 'failed' || tab.status === 'waiting') return tab
      return {
        ...tab,
        status: 'running',
      }
    })
  }

  const activeAgentIds = new Set(
    tabs
      .filter((tab) => tab.status === 'assigned' || tab.status === 'running' || tab.status === 'waiting')
      .map((tab) => tab.agentId),
  )

  return {
    tabs,
    runStatus: taskBoard.status,
    activeAgentCount: activeAgentIds.size,
    currentActivity: agentTyping ? describeRuntimeActivity(agentActivity) : null,
  }
}

export function buildTaskBoardPanelProjection(
  taskBoard: ChatState['taskBoard'],
): TaskBoardPanelProjection | null {
  if (!taskBoard) return null

  const phases = taskBoard.phases.map((phase) => {
    const tasks = taskBoard.tasks
      .filter((task) => task.phaseId === phase.id)
      .map((task) => {
        const artifactCountResolved = task.artifactCount ?? task.artifacts?.length ?? 0
        const hasResultLine =
          artifactCountResolved > 0 ||
          Boolean(task.outputSummary) ||
          Boolean(task.validationStatus) ||
          Boolean(task.childSessionId) ||
          Boolean(task.taskThreadId) ||
          Boolean(task.workerInstanceId) ||
          Boolean(task.runtimeLeaseId) ||
          Boolean(task.resultError) ||
          Boolean(task.executionConfig)
        const progressTone: TaskBoardTaskPanelProjection['progressTone'] =
          task.progress === undefined
            ? 'blue'
            : task.progress < 30
              ? 'red'
              : task.progress < 70
                ? 'yellow'
                : 'green'
        const statusTone: TaskBoardTaskPanelProjection['statusTone'] =
          task.status === 'blocked'
            ? 'waiting'
            : task.status === 'running'
            ? 'running'
            : task.status === 'failed'
              ? 'failed'
              : 'default'

        return {
          ...task,
          artifactCountResolved,
          hasResultLine,
          progressTone,
          statusTone,
        }
      })

    return {
      ...phase,
      completedTaskCount: tasks.filter((task) => task.status === 'done').length,
      totalTaskCount: tasks.length,
      tasks,
    }
  })

  return {
    runId: taskBoard.runId,
    title: taskBoard.title,
    goal: taskBoard.goal,
    collaborationMode: taskBoard.collaborationMode,
    status: taskBoard.status,
    sessionId: taskBoard.sessionId,
    taskCount: taskBoard.tasks.length,
    phaseCount: taskBoard.phases.length,
    hasFailedTasks: taskBoard.tasks.some((task) => task.status === 'failed'),
    emptyStateLabel: taskBoard.status === 'planning' ? '正在生成执行计划...' : '暂无阶段信息',
    phases,
  }
}

interface TaskBoardSnapshot {
  taskBoard: NonNullable<ChatState['taskBoard']>
  agentTabs: AgentTab[]
  agUiEvents: AgUiEventPayload[]
  run: OrchestratorRunListItem
  runtimeActivity: RuntimeActivityProjection
}

interface RunResourceTaskEntry {
  taskId: string
  childSessionId: string | null
  taskThreadId: string | null
  taskThreadStatus: TaskBoardTask['taskThreadStatus']
  workerInstanceId: string | null
  agentId: string
  agentName: string
  taskTitle: string
  status: AgentTab['status']
  progress?: number
  progressStatus?: string
}

interface RoomTimelineWsPayload {
  sessionId?: string
  room?: Room
  event?: TimelineEvent
  participants?: RoomParticipant[]
}

function projectRoomTimelineWsPayload(
  payload: RoomTimelineWsPayload,
  fallbackSessionId: string | null,
) {
  const room = payload.room
  const event = payload.event
  if (!room || !event) return null
  const sessionId = room.sessionId ?? payload.sessionId ?? fallbackSessionId
  if (!sessionId) return null
  return {
    sessionId,
    projection: projectRoomTimeline({
      room,
      participants: payload.participants ?? [],
      timeline: [event],
      sessionId,
    }),
  }
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

function readExecutionConfig(value: unknown): TaskExecutionConfig | undefined {
  const item = asRecord(value)
  if (!item) return undefined
  return {
    runtimeType: asString(item.runtimeType),
    codeAgentType: asString(item.codeAgentType),
    adapterName: asString(item.adapterName),
    command: asString(item.command),
    modelId: asString(item.modelId) ?? null,
    modelProvider: asString(item.modelProvider) ?? null,
    modelLabel: asString(item.modelLabel),
    baseUrlHost: asString(item.baseUrlHost) ?? null,
    readinessStatus: asString(item.readinessStatus),
    installed: typeof item.installed === 'boolean' ? item.installed : undefined,
    configured: typeof item.configured === 'boolean' ? item.configured : undefined,
    executionEnabled:
      typeof item.executionEnabled === 'boolean' ? item.executionEnabled : undefined,
    canExecute: typeof item.canExecute === 'boolean' ? item.canExecute : undefined,
    sandboxPolicy: asString(item.sandboxPolicy),
    sandboxProvider: asString(item.sandboxProvider),
    isolation: asString(item.isolation),
    executionPath: asString(item.executionPath) ?? null,
    workdirRelativePath: asString(item.workdirRelativePath) ?? null,
    skillCount: asNumber(item.skillCount),
    toolPermissions: asStringArray(item.toolPermissions),
    approvalRequired:
      typeof item.approvalRequired === 'boolean' ? item.approvalRequired : undefined,
  }
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
      path: asString(item.path),
      sourcePath: asString(item.sourcePath),
      handoffPath: asString(item.handoffPath),
      handoffRelativePath: asString(item.handoffRelativePath),
      roomId: asString(item.roomId) ?? null,
      storageProvider: asString(item.storageProvider),
      bucket: asString(item.bucket),
      objectKey: asString(item.objectKey),
      storagePath: asString(item.storagePath),
      artifactKind: asString(item.artifactKind),
      kind: asString(item.kind),
      type: asString(item.type),
      source: asString(item.source),
      url: asString(item.url),
      size: asNumber(item.size),
      status: asString(item.status),
      visibility: asString(item.visibility),
      taskTitle: asString(item.taskTitle),
      taskId: asString(item.taskId) ?? null,
      taskThreadId: asString(item.taskThreadId) ?? null,
      childSessionId: asString(item.childSessionId) ?? null,
      workerInstanceId: asString(item.workerInstanceId) ?? null,
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
      artifact.artifactId ??
      artifact.id ??
      artifact.objectKey ??
      artifact.storagePath ??
      artifact.filePath ??
      artifact.url ??
      artifact.title
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
    filePath:
      asString(payload.filePath) ??
      asString(payload.handoffRelativePath) ??
      asString(payload.handoffPath) ??
      asString(artifact.filePath) ??
      asString(artifact.path),
    path: asString(artifact.path),
    sourcePath: asString(payload.sourcePath) ?? asString(artifact.sourcePath),
    handoffPath: asString(payload.handoffPath) ?? asString(artifact.handoffPath),
    handoffRelativePath: asString(payload.handoffRelativePath) ?? asString(artifact.handoffRelativePath),
    roomId: asString(payload.roomId) ?? asString(artifact.roomId) ?? null,
    storageProvider: asString(payload.storageProvider) ?? asString(artifact.storageProvider),
    bucket: asString(payload.bucket) ?? asString(artifact.bucket),
    objectKey: asString(payload.objectKey) ?? asString(artifact.objectKey),
    storagePath: asString(payload.storagePath) ?? asString(artifact.storagePath),
    artifactKind: asString(payload.artifactKind),
    kind: asString(artifact.kind),
    type: asString(artifact.type),
    source: asString(payload.source),
    url: asString(payload.url) ?? asString(artifact.url),
    size: asNumber(payload.size) ?? asNumber(artifact.size),
    status: asString(payload.artifactStatus) ?? asString(payload.status) ?? asString(artifact.status),
    visibility: asString(payload.visibility) ?? asString(artifact.visibility),
    taskTitle: asString(payload.taskTitle),
    taskId: asString(payload.taskId) ?? null,
    taskThreadId: asString(payload.taskThreadId) ?? null,
    childSessionId: asString(payload.childSessionId) ?? null,
    workerInstanceId: asString(payload.workerInstanceId) ?? asString(artifact.workerInstanceId) ?? null,
  }
  return item.artifactId || item.id || item.filePath || item.url || item.title ? item : null
}

function normalizeAgUiTaskStatus(value: string | undefined): TaskBoardTask['status'] | null {
  if (
    value === 'pending' ||
    value === 'assigned' ||
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
  const value = asRecord(event.value)
  const threadId = asString(event.threadId)
  if (runId && runId !== taskBoard.runId) return false
  const valueThreadId = asString(value?.threadId)
  const taskThreadId = asString(value?.taskThreadId)
  const childSessionId = asString(value?.childSessionId) ?? asString(value?.sessionId)
  const ids = [threadId, valueThreadId, taskThreadId, childSessionId].filter(
    (id): id is string => Boolean(id),
  )
  if (!ids.length) return true
  const matchesKnownThread = ids.some(
    (id) =>
      id === taskBoard.sessionId ||
      id === currentSessionId ||
      taskBoard.tasks.some(
        (task) =>
          id === task.childSessionId ||
          id === task.taskThreadId,
      ),
  )
  if (!matchesKnownThread) return false
  return true
}

function applyTaskStatusToPhases(
  phases: NonNullable<ChatState['taskBoard']>['phases'],
  tasks: TaskBoardTask[],
) {
  return phases.map((phase) => {
    const phaseTasks = phase.taskIds
      .map((id) => tasks.find((item) => item.id === id))
      .filter((task): task is TaskBoardTask => Boolean(task))
    if (!phaseTasks.length) return { ...phase, status: 'pending' as const }
    if (phaseTasks.some((task) => task.status === 'assigned' || task.status === 'running' || task.status === 'blocked')) {
      return { ...phase, status: 'active' as const }
    }
    if (
      phaseTasks.every(
        (task) =>
          task.status === 'done' ||
          task.status === 'failed' ||
          task.status === 'cancelled',
      )
    ) {
      return { ...phase, status: 'completed' as const }
    }
    return { ...phase, status: 'pending' as const }
  })
}

function ensureTaskBoardPhase(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  phaseId: string,
  taskId: string,
) {
  const phaseExists = taskBoard.phases.some((phase) => phase.id === phaseId)
  if (phaseExists) {
    return taskBoard.phases.map((phase) =>
      phase.id === phaseId && !phase.taskIds.includes(taskId)
        ? { ...phase, taskIds: [...phase.taskIds, taskId] }
        : phase,
    )
  }
  return [
    ...taskBoard.phases,
    {
      id: phaseId,
      title: phaseTitleFromId(phaseId),
      purpose: phasePurposeFromId(phaseId),
      taskIds: [taskId],
      status: 'pending' as const,
    },
  ]
}

function applyTaskBoardTasks(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  tasks: TaskBoardTask[],
  options?: {
    ensurePhaseId?: string | null
    ensureTaskId?: string | null
    status?: NonNullable<ChatState['taskBoard']>['status']
  },
) {
  const phases =
    options?.ensurePhaseId && options?.ensureTaskId
      ? ensureTaskBoardPhase(taskBoard, options.ensurePhaseId, options.ensureTaskId)
      : taskBoard.phases
  return {
    ...taskBoard,
    status: options?.status ?? taskBoard.status,
    phases: applyTaskStatusToPhases(phases, tasks),
    tasks,
  }
}

function applyTaskBoardRunStatus(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  status: NonNullable<ChatState['taskBoard']>['status'] | null | undefined,
) {
  if (!status) return taskBoard
  return {
    ...taskBoard,
    status,
  }
}

function ensureTaskBoardForTaskEvent(
  taskBoard: ChatState['taskBoard'],
  event: AgUiEventPayload,
  currentSessionId: string,
): ChatState['taskBoard'] {
  if (taskBoard) return taskBoard
  if (event.type !== 'CUSTOM') return taskBoard
  if (event.name !== 'agenthub.task.status' && event.name !== 'agenthub.artifact.created') {
    return taskBoard
  }
  const value = asRecord(event.value)
  if (!value) return taskBoard
  const taskId = asString(value.taskId)
  const runId = asString(event.runId) ?? asString(value.runId)
  if (!taskId || !runId) return taskBoard

  const phaseId = asString(value.phaseId) ?? 'execution'
  const taskTitle = asString(value.taskTitle) ?? asString(value.title) ?? taskId
  const taskStatus =
    normalizeAgUiTaskStatus(asString(value.status)) ??
    normalizeTaskStatusFromTaskThread(asString(value.taskThreadStatus)) ??
    'pending'
  const taskThreadStatus =
    normalizeTaskThreadStatus(value.taskThreadStatus) ??
    normalizeTaskThreadStatus(value.threadStatus) ??
    (taskStatus === 'assigned'
      ? 'assigned'
      : taskStatus === 'running'
        ? 'active'
        : taskStatus === 'blocked'
          ? 'waiting_for_human'
        : taskStatus === 'done'
          ? 'completed'
          : taskStatus === 'failed' || taskStatus === 'cancelled'
            ? taskStatus
            : null)
  const task: TaskBoardTask = {
    id: taskId,
    phaseId,
    title: taskTitle,
    description: asString(value.taskDescription) ?? asString(value.description) ?? '',
    agentId: asString(value.agentId) ?? taskId,
    agentName: asString(value.agentName) ?? asString(value.workerName) ?? 'Agent',
    taskType: asString(value.taskType),
    status: taskStatus,
    progress: asNumber(value.progressPercent),
    progressStatus: asString(value.progressStatus),
    dependencies: asStringArray(value.dependencies) ?? [],
    childSessionId: asString(value.childSessionId) ?? asString(value.sessionId) ?? null,
    taskThreadId: asString(value.taskThreadId) ?? null,
    taskThreadStatus,
    workerInstanceId: asString(value.workerInstanceId) ?? null,
    runtimeLeaseId: asString(value.runtimeLeaseId) ?? null,
    sharedTaskRelativeRoot: asString(value.sharedTaskRelativeRoot) ?? null,
    sharedTaskSpecPath: asString(value.sharedTaskSpecPath) ?? null,
    artifactCount: event.name === 'agenthub.artifact.created' ? 0 : asNumber(value.artifactCount),
    artifacts: [],
    executionConfig: readExecutionConfig(value.executionConfig),
  }
  return {
    runId,
    title: asString(value.runTitle) ?? asString(value.planTitle) ?? '协作任务',
    goal: asString(value.goal) ?? asString(value.taskDescription) ?? taskTitle,
    collaborationMode: 'room-timeline',
    phases: [
      {
        id: phaseId,
        title: phaseTitleFromId(phaseId),
        purpose: phasePurposeFromId(phaseId),
        taskIds: [taskId],
        status:
          task.status === 'assigned' || task.status === 'running' || task.status === 'blocked'
            ? 'active'
            : task.status === 'done' || task.status === 'failed' || task.status === 'cancelled'
              ? 'completed'
              : 'pending',
      },
    ],
    tasks: [task],
    status:
      task.status === 'done'
        ? 'completed'
        : task.status === 'failed'
          ? 'failed'
          : task.status === 'cancelled'
            ? 'cancelled'
            : 'running',
    sessionId: currentSessionId,
  }
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
  const executionConfig = readExecutionConfig(value.executionConfig)
  const taskThreadStatus =
    normalizeTaskThreadStatus(value.taskThreadStatus) ??
    normalizeTaskThreadStatus(value.threadStatus) ??
    (status === 'assigned'
      ? 'assigned'
      : status === 'running'
        ? 'active'
        : status === 'blocked'
          ? 'waiting_for_human'
        : status === 'done'
          ? 'completed'
          : status === 'failed' || status === 'cancelled'
            ? status
            : existingTask?.taskThreadStatus ?? null)
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
    taskThreadId: asString(value.taskThreadId) ?? existingTask?.taskThreadId ?? null,
    taskThreadStatus,
    workerInstanceId: asString(value.workerInstanceId) ?? existingTask?.workerInstanceId ?? null,
    runtimeLeaseId: asString(value.runtimeLeaseId) ?? existingTask?.runtimeLeaseId ?? null,
    sharedTaskRelativeRoot:
      asString(value.sharedTaskRelativeRoot) ?? existingTask?.sharedTaskRelativeRoot ?? null,
    sharedTaskSpecPath:
      asString(value.sharedTaskSpecPath) ?? existingTask?.sharedTaskSpecPath ?? null,
    artifactCount: artifactCount ?? existingTask?.artifactCount,
    artifacts: existingTask?.artifacts,
    outputSummary: existingTask?.outputSummary,
    outputRef: existingTask?.outputRef,
    validationStatus: existingTask?.validationStatus,
    validationResults: existingTask?.validationResults,
    contractStatus: existingTask?.contractStatus,
    contractViolations: existingTask?.contractViolations,
    resultError: existingTask?.resultError,
    executionConfig: executionConfig ?? existingTask?.executionConfig,
  }

  const tasks = existingTask
    ? taskBoard.tasks.map((task) => (task.id === taskId ? nextTask : task))
    : [...taskBoard.tasks, nextTask]
  return applyTaskBoardTasks(taskBoard, tasks, {
    ensurePhaseId: phaseId,
    ensureTaskId: taskId,
    status:
      status === 'assigned' || status === 'running' || status === 'blocked'
        ? 'running'
        : taskBoard.status,
  })
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
        taskThreadId: artifact.taskThreadId ?? task.taskThreadId ?? null,
        workerInstanceId: artifact.workerInstanceId ?? task.workerInstanceId ?? null,
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
  return applyTaskBoardRunStatus(taskBoard, status)
}

function applyResourceSnapshotToTaskBoard(
  taskBoard: NonNullable<ChatState['taskBoard']>,
  snapshot: Record<string, unknown>,
) {
  const threadsByTaskId = new Map(
    (Array.isArray(snapshot.taskThreads) ? snapshot.taskThreads : [])
      .map((thread) => asRecord(thread))
      .filter((thread): thread is Record<string, unknown> => Boolean(thread?.taskId))
      .map((thread) => [String(thread.taskId), thread] as const),
  )
  const artifactsByTaskId = new Map<string, Record<string, unknown>[]>()
  for (const artifact of Array.isArray(snapshot.artifacts) ? snapshot.artifacts : []) {
    const item = asRecord(artifact)
    const taskId = asString(item?.taskId)
    if (!item || !taskId) continue
    const artifacts = artifactsByTaskId.get(taskId) ?? []
    artifacts.push(item)
    artifactsByTaskId.set(taskId, artifacts)
  }
  const latestLeaseByTaskId = new Map<string, Record<string, unknown>>()
  for (const lease of Array.isArray(snapshot.runtimeLeases) ? snapshot.runtimeLeases : []) {
    const item = asRecord(lease)
    const taskId = asString(item?.taskId)
    if (!item || !taskId) continue
    latestLeaseByTaskId.set(taskId, item)
  }
  const run = asRecord(snapshot.run)
  const runStatus = normalizeAgUiBoardStatus(asString(run?.status))

  const tasks = taskBoard.tasks.map((task) => {
      const thread = threadsByTaskId.get(task.id)
      const lease = latestLeaseByTaskId.get(task.id)
      const artifacts = artifactsByTaskId.get(task.id)
      const status = normalizeTaskStatusFromTaskThread(asString(thread?.status)) ?? task.status
      return {
        ...task,
        status,
        childSessionId: asString(thread?.sessionId) ?? task.childSessionId ?? null,
        taskThreadId: asString(thread?.id) ?? task.taskThreadId ?? null,
        taskThreadStatus: normalizeTaskThreadStatus(thread?.status) ?? task.taskThreadStatus ?? null,
        workerInstanceId:
          asString(thread?.workerInstanceId) ??
          asString(lease?.workerInstanceId) ??
          task.workerInstanceId ??
          null,
        runtimeLeaseId:
          asString(lease?.runtimeLeaseId) ??
          asString(lease?.id) ??
          task.runtimeLeaseId ??
          null,
        sharedTaskRelativeRoot:
          asString(thread?.sharedTaskRelativeRoot) ?? task.sharedTaskRelativeRoot ?? null,
        sharedTaskSpecPath:
          asString(thread?.sharedTaskSpecPath) ?? task.sharedTaskSpecPath ?? null,
        artifactCount: artifacts?.length ?? task.artifactCount,
        artifacts: artifacts ? readTaskBoardArtifacts(artifacts) : task.artifacts,
      }
    })

  return applyTaskBoardTasks(taskBoard, tasks, {
    status: runStatus ?? taskBoard.status,
  })
}

export const __chatStoreTestHooks = {
  applyAgUiEventToState,
  applyAgUiRunStatus,
  applyTaskBoardRunStatus,
  applyResourceSnapshotToTaskBoard,
  buildRunResourceTaskEntries,
  buildControlPanelProjection,
  buildHeaderAgentStatusProjection,
  buildTaskBoardPanelProjection,
  buildOptimisticOrchestratorTaskSessions,
  deriveRuntimeActivityFromTaskBoard,
  describeRuntimeActivity,
  mergeSessionsWithRunProjection,
  mergeSessionsWithRuntimeProjection,
  reduceRuntimeActivityProjection,
  runtimeActivityLabel,
  runtimeActivityFromSnapshot,
  taskBoardFromRun,
}

function applyMemberProposalContinueEvent(messages: Message[], value: Record<string, unknown>) {
  const messageId = asString(value.messageId)
  const status = asString(value.status)
  if (!messageId || !status) return messages
  let changed = false
  const nextMessages = messages.map((message) => {
    if (message.id !== messageId) return message
    changed = true
    const metadata = message.metadata ?? {}
    return {
      ...message,
      metadata: {
        ...metadata,
        memberProposalContinueStatus: status,
        memberProposalGoal: asString(value.goal) ?? metadata.memberProposalGoal,
        continuedRunId: asString(value.runId) ?? metadata.continuedRunId,
        continuedTaskIds: asStringArray(value.taskIds) ?? metadata.continuedTaskIds,
        memberProposalContinueError:
          asString(value.error) ?? metadata.memberProposalContinueError,
        memberProposalContinueUpdatedAt: new Date().toISOString(),
      },
    }
  })
  return changed ? nextMessages : messages
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
        taskThreadId: asString(task.taskThreadId) ?? null,
        workerInstanceId: asString(task.workerInstanceId) ?? null,
        runtimeLeaseId: asString(task.runtimeLeaseId) ?? null,
        sharedTaskRelativeRoot: asString(task.sharedTaskRelativeRoot) ?? null,
        sharedTaskSpecPath: asString(task.sharedTaskSpecPath) ?? null,
        artifactCount: asNumber(task.artifactCount) ?? undefined,
        artifacts: readTaskBoardArtifacts(task.artifacts),
        outputSummary: asString(task.outputSummary) ?? undefined,
        outputRef: null,
        validationStatus: normalizeTaskBoardValidationStatus(asString(task.validationStatus)),
        contractStatus: normalizeTaskBoardContractStatus(asString(task.contractStatus)),
        contractViolations: undefined,
        resultError: undefined,
        executionConfig: readExecutionConfig(task.executionConfig),
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
            childSessionId: task.childSessionId ?? existing.childSessionId,
            taskThreadId: task.taskThreadId ?? existing.taskThreadId,
            taskThreadStatus: task.taskThreadStatus ?? existing.taskThreadStatus,
            workerInstanceId: task.workerInstanceId ?? existing.workerInstanceId,
            runtimeLeaseId: task.runtimeLeaseId ?? existing.runtimeLeaseId,
            sharedTaskRelativeRoot: task.sharedTaskRelativeRoot ?? existing.sharedTaskRelativeRoot,
            sharedTaskSpecPath: task.sharedTaskSpecPath ?? existing.sharedTaskSpecPath,
            executionConfig: task.executionConfig ?? existing.executionConfig,
          }
        }),
      }
    : board
}

function buildOptimisticOrchestratorTaskSessions(
  input: {
    sessions: Session[]
    currentSession: Session | null
  },
  taskBoard: NonNullable<ChatState['taskBoard']> | null,
) {
  if (!taskBoard?.sessionId) return input.sessions
  const groupSession =
    input.sessions.find((session) => session.id === taskBoard.sessionId) ??
    (input.currentSession?.id === taskBoard.sessionId ? input.currentSession : null)
  if (!groupSession) return input.sessions

  const workspaceId = groupSession.workspaceId ?? null
  if (!workspaceId) return input.sessions

  const now = new Date().toISOString()
  const nextSessions = taskBoard.tasks.reduce((sessions, task) => {
    if (!task.childSessionId) return sessions
    const existing = sessions.find((session) => session.id === task.childSessionId) ?? null
    const assignedWorkspaceAgentId =
      task.taskThreadStatus === 'assigned' ||
      task.taskThreadStatus === 'active' ||
      task.taskThreadStatus === 'waiting_for_human' ||
      task.taskThreadStatus === 'completed' ||
      task.taskThreadStatus === 'failed' ||
      task.taskThreadStatus === 'cancelled' ||
      task.status === 'assigned' ||
      task.status === 'running' ||
      task.status === 'blocked' ||
      task.status === 'done' ||
      task.status === 'failed' ||
      task.status === 'cancelled'
        ? task.agentId
        : null
    const computedTitle = `${assignedWorkspaceAgentId ? task.agentName : '准备中'} · ${task.title}`
    const session: Session = {
      id: task.childSessionId,
      ownerId: existing?.ownerId ?? groupSession.ownerId,
      title:
        existing?.metadata?.kind === 'orchestrator-task'
          ? computedTitle
          : existing?.title || computedTitle,
      type: SessionType.Direct,
      workspaceId: existing?.workspaceId ?? workspaceId,
      workspaceAgentId: assignedWorkspaceAgentId,
      metadata: {
        ...(existing?.metadata ?? {}),
        kind: 'orchestrator-task',
        groupSessionId: taskBoard.sessionId,
        taskThreadId: task.taskThreadId ?? existing?.metadata?.taskThreadId,
        orchestratorRunId: taskBoard.runId,
        orchestratorTaskId: task.id,
        workspaceAgentId: assignedWorkspaceAgentId ?? undefined,
        workerInstanceId: task.workerInstanceId ?? existing?.metadata?.workerInstanceId,
        taskThreadStatus: deriveTaskThreadStatus(task),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastMessage: existing?.lastMessage ?? null,
    }
    return upsertSessionList(sessions, session)
  }, input.sessions)
  return nextSessions
}

function mergeSessionsWithRuntimeProjection(
  sessions: Session[],
  currentSession: Session | null,
  taskBoard: ChatState['taskBoard'],
) {
  return taskBoard
    ? buildOptimisticOrchestratorTaskSessions({ sessions, currentSession }, taskBoard)
    : sessions
}

function mergeSessionsWithRunProjection(
  sessions: Session[],
  currentSession: Session | null,
  run: OrchestratorRunListItem | null | undefined,
  taskBoard: ChatState['taskBoard'],
) {
  if (!taskBoard) return sessions
  const nextSessions = mergeSessionsWithRuntimeProjection(sessions, currentSession, taskBoard)
  if (!run) return nextSessions

  const resourceEntries = buildRunResourceTaskEntries(run, taskBoard)
  if (!resourceEntries.length) return nextSessions

  const groupSession =
    nextSessions.find((session) => session.id === taskBoard.sessionId) ??
    (currentSession?.id === taskBoard.sessionId ? currentSession : null)
  if (!groupSession?.workspaceId) return nextSessions

  return resourceEntries.reduce((items, entry) => {
    if (!entry.childSessionId) return items
    const existing = items.find((session) => session.id === entry.childSessionId) ?? null
    const assignedWorkspaceAgentId =
      entry.taskThreadStatus === 'assigned' ||
      entry.taskThreadStatus === 'active' ||
      entry.taskThreadStatus === 'waiting_for_human' ||
      entry.taskThreadStatus === 'completed' ||
      entry.taskThreadStatus === 'failed' ||
      entry.taskThreadStatus === 'cancelled'
        ? entry.agentId
        : null
    const computedTitle = `${assignedWorkspaceAgentId ? entry.agentName : '准备中'} · ${entry.taskTitle}`
    const session: Session = {
      id: entry.childSessionId,
      ownerId: existing?.ownerId ?? groupSession.ownerId,
      title:
        existing?.metadata?.kind === 'orchestrator-task'
          ? computedTitle
          : existing?.title || computedTitle,
      type: SessionType.Direct,
      workspaceId: existing?.workspaceId ?? groupSession.workspaceId,
      workspaceAgentId: assignedWorkspaceAgentId,
      metadata: {
        ...(existing?.metadata ?? {}),
        kind: 'orchestrator-task',
        groupSessionId: taskBoard.sessionId,
        taskThreadId: entry.taskThreadId ?? existing?.metadata?.taskThreadId,
        orchestratorRunId: taskBoard.runId,
        orchestratorTaskId: entry.taskId,
        workspaceAgentId: assignedWorkspaceAgentId ?? undefined,
        workerInstanceId: entry.workerInstanceId ?? existing?.metadata?.workerInstanceId,
        taskThreadStatus: entry.taskThreadStatus ?? undefined,
      },
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessage: existing?.lastMessage ?? null,
    }
    return upsertSessionList(items, session)
  }, nextSessions)
}

function reprojectRunResourcesIntoUi(
  state: Pick<ChatState, 'agentTabs' | 'currentSession' | 'sessions' | 'taskBoard'>,
  taskBoard: ChatState['taskBoard'],
  projectionRun: OrchestratorRunListItem | null,
) {
  if (!taskBoard) {
    return {
      agentTabs: state.agentTabs,
      sessions: state.sessions,
    }
  }

  return {
    agentTabs: projectionRun
      ? agentTabsFromRunSnapshot(projectionRun, taskBoard)
      : agentTabsFromTaskBoard(taskBoard),
    sessions: projectionRun
      ? mergeSessionsWithRunProjection(
          state.sessions,
          state.currentSession,
          projectionRun,
          taskBoard,
        )
      : mergeSessionsWithRuntimeProjection(
          state.sessions,
          state.currentSession,
          taskBoard,
        ),
  }
}

function applyAgUiEventToState(
  state: ChatState,
  event: AgUiEventPayload,
  sessionId: string,
): ChatState {
  let nextTaskBoard = state.taskBoard
  let runtimeActivity: RuntimeActivityProjection = {
    agentTyping: state.agentTyping,
    agentActivity: state.agentActivity,
  }
  let projectionRun: OrchestratorRunListItem | null = null
  let selectedAgentTab = state.selectedAgentTab
  let nextMessages = state.messages
  let nextSessions = state.sessions

  const currentSessionMatches =
    asString(event.threadId) === sessionId ||
    (nextTaskBoard ? taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId) : true)

  if (!currentSessionMatches) return state

  runtimeActivity = reduceRuntimeActivityProjection(runtimeActivity, event, sessionId)

  if (event.type === 'RUN_STARTED') {
    if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
      nextTaskBoard = applyTaskBoardRunStatus(nextTaskBoard, 'running')
    }
  }

  if (event.type === 'RUN_FINISHED') {
    const result = asRecord(event.result)
    const boardStatus =
      normalizeAgUiBoardStatus(asString(result?.status)) ??
      (asString(result?.status) === 'cancelled' ? 'cancelled' : 'completed')
    if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
      nextTaskBoard = applyTaskBoardRunStatus(nextTaskBoard, boardStatus)
    }
  }

  if (event.type === 'RUN_ERROR') {
    if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
      nextTaskBoard = applyTaskBoardRunStatus(nextTaskBoard, 'failed')
    }
  }

  if (event.type === 'CUSTOM') {
    const value = asRecord(event.value)
    nextTaskBoard = ensureTaskBoardForTaskEvent(nextTaskBoard, event, sessionId)
    if (value && event.name === 'agenthub.plan.created') {
      const previousRunId = nextTaskBoard?.runId
      nextTaskBoard = applyAgUiPlanCreated(nextTaskBoard, event, sessionId)
      if (nextTaskBoard?.runId && previousRunId !== nextTaskBoard.runId) {
        selectedAgentTab = null
      }
    }
    if (value && event.name === 'agenthub.task.status') {
      const taskStatus = normalizeAgUiTaskStatus(asString(value.status))
      const boardStatus = normalizeAgUiBoardStatus(asString(value.status))
      if (nextTaskBoard && taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)) {
        nextTaskBoard = taskStatus
          ? applyAgUiTaskStatus(nextTaskBoard, value)
          : boardStatus
            ? applyTaskBoardRunStatus(nextTaskBoard, boardStatus)
            : nextTaskBoard
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
    }
    if (value && event.name === 'agenthub.manager.status') {
      const resourceSnapshot = asRecord(value.resourceSnapshot)
      if (
        resourceSnapshot &&
        asString(value.action) === 'observe_resources' &&
        nextTaskBoard &&
        taskBoardMatchesAgUiEvent(nextTaskBoard, event, sessionId)
      ) {
        nextTaskBoard = applyResourceSnapshotToTaskBoard(nextTaskBoard, resourceSnapshot)
        projectionRun = buildProjectionRunFromResourceSnapshot(nextTaskBoard, resourceSnapshot)
      }
    }
    if (value && event.name === 'agenthub.member_proposal.continue') {
      nextMessages = applyMemberProposalContinueEvent(nextMessages, value)
    }
  }

  const reprojected =
    nextTaskBoard && nextTaskBoard !== state.taskBoard
      ? reprojectRunResourcesIntoUi(
          {
            agentTabs: state.agentTabs,
            currentSession: state.currentSession,
            sessions: nextSessions,
            taskBoard: state.taskBoard,
          },
          nextTaskBoard,
          projectionRun,
        )
      : null
  const nextAgentTabs = reprojected?.agentTabs ?? state.agentTabs
  nextSessions = reprojected?.sessions ?? nextSessions

  if (
    nextTaskBoard !== state.taskBoard ||
    nextAgentTabs !== state.agentTabs ||
    nextSessions !== state.sessions ||
    nextMessages !== state.messages ||
    runtimeActivity.agentTyping !== state.agentTyping ||
    runtimeActivity.agentActivity !== state.agentActivity ||
    selectedAgentTab !== state.selectedAgentTab
  ) {
    return {
      ...state,
      taskBoard: nextTaskBoard,
      agentTabs: nextAgentTabs,
      sessions: nextSessions,
      messages: nextMessages,
      agentTyping: runtimeActivity.agentTyping,
      agentActivity: runtimeActivity.agentActivity,
      selectedAgentTab,
    }
  }

  return state
}

interface ChatState {
  sessions: Session[]
  currentSession: Session | null
  currentWorkspace: Workspace | null
  currentWorkspaceAgents: WorkspaceAgent[]
  currentWorkspaceWorkers: WorkspaceFull['workerInstances']
  currentSessionId: string | null
  messages: Message[]
  streamingMessage: { id: string; content: string; agentId?: string; agentName?: string } | null
  streamingCodeAgentRun: CodeAgentRunMetadata | null
  pendingAttachments: ChatAttachment[]
  safetyMode: string
  loadingSessions: boolean
  loadingMessages: boolean
  agentTyping: boolean
  agentActivity: AgentActivity | null
  replyingToMessageId: string | null
  replyingToMessage: Message | null
  replyingToKind: NonNullable<QuotedMessagePreview['kind']>
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
      mentions?: string[]
      replyToMessageId?: string | null
      quotedMessage?: QuotedMessagePreview | null
      safetyMode?: string
      usePendingAttachments?: boolean
    },
  ) => Promise<void>
  sendMessageToSession: (
    sessionId: string,
    content: string,
    options?: {
      displayContent?: string
      mentions?: string[]
      replyToMessageId?: string | null
      quotedMessage?: QuotedMessagePreview | null
      safetyMode?: string
      usePendingAttachments?: boolean
    },
  ) => Promise<void>
  editMessage: (messageId: string, content: string) => Promise<void>
  resendMessage: (messageId: string) => Promise<void>
  withdrawMessage: (messageId: string) => Promise<{ reverted: number; failed: number } | null>
  regenerateMessage: (messageId: string) => Promise<void>
  pinMessage: (messageId: string) => Promise<void>
  unpinMessage: (messageId: string) => Promise<void>
  addPendingAttachments: (attachments: ChatAttachment[]) => void
  removePendingAttachment: (id: string) => void
  clearPendingAttachments: () => void
  setSafetyMode: (mode: string) => void
  cancelRun: () => Promise<void>
  setReplyingTo: (
    messageId: string | null,
    kind?: NonNullable<QuotedMessagePreview['kind']>,
  ) => void
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
  currentWorkspaceWorkers: [],
  currentSessionId: null,
  messages: [],
  streamingMessage: null,
  streamingCodeAgentRun: null,
  pendingAttachments: [],
  safetyMode: 'ask',
  loadingSessions: false,
  loadingMessages: false,
  agentTyping: false,
  agentActivity: null,
  replyingToMessageId: null,
  replyingToMessage: null,
  replyingToKind: 'reply',
  sessionsBootstrapped: false,
  taskBoard: null,
  previewUrl: null,
  previewFileName: null,
  selectedAgentTab: null,
  agentTabs: [],

  async fetchSessions() {
    set({ loadingSessions: true })
    try {
      const { items } = await api.listSessions()
      set((state) => ({
        sessions: mergeSessionsWithRuntimeProjection(
          items,
          state.currentSession,
          state.taskBoard,
        ),
        loadingSessions: false,
        sessionsBootstrapped: true,
      }))
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
      (state.currentSession?.id === sessionId ? state.currentSession : null) ??
      buildOptimisticOrchestratorTaskSession(state, sessionId)
    const cachedWorkspace = optimisticSession?.workspaceId
      ? workspaceDetailsCache.get(optimisticSession.workspaceId)
      : null
    const canReuseWorkspace =
      optimisticSession?.workspaceId &&
      state.currentSession?.workspaceId === optimisticSession.workspaceId
    const cachedMessages = messageCache.get(sessionId)

    set({
      sessions: optimisticSession
        ? upsertSessionList(state.sessions, optimisticSession)
        : state.sessions,
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
      currentWorkspaceWorkers: optimisticSession?.workspaceId
        ? (cachedWorkspace?.workerInstances ?? (canReuseWorkspace ? state.currentWorkspaceWorkers : []))
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
      replyingToKind: 'reply',
      taskBoard: keepTaskBoard ? state.taskBoard : null,
      agentTabs: keepTaskBoard ? state.agentTabs : [],
      selectedAgentTab: keepTaskBoard
        ? selectedTaskForSession(sessionId, state.taskBoard, state.agentTabs)
        : null,
    })
    wsClient.joinSessions(taskBoardSessionIds(keepTaskBoard ? state.taskBoard : null, sessionId))
    try {
      const roomSnapshot = await api.getRoomSessionSnapshot(sessionId)
      const session = roomSnapshot.session
      const roomProjection = projectRoomTimeline({
        room: roomSnapshot.room,
        participants: roomSnapshot.participants,
        timeline: roomSnapshot.timeline,
        sessionId: session.id,
      })
      if (session.workspaceId) {
        const full = await api.getWorkspace(session.workspaceId)
        workspaceDetailsCache.set(session.workspaceId, {
          workspace: full.workspace,
          agents: full.agents,
          workerInstances: full.workerInstances,
        })
        if (get().currentSessionId !== sessionId) return
        const currentAgents = sessionWorkspaceAgents(session, full.agents)
        const resolvedSnapshot = projectRoomResourceSnapshot(roomSnapshot, currentAgents)
        const normalizedMessages = sortMessages(roomProjection.messages)
        messageCache.set(sessionId, normalizedMessages)
        if (resolvedSnapshot) {
          wsClient.joinSessions(taskBoardSessionIds(resolvedSnapshot.taskBoard, sessionId))
        }
        set((s) => ({
          currentSession: session,
          currentWorkspace: full.workspace,
          currentWorkspaceAgents: currentAgents,
          currentWorkspaceWorkers: full.workerInstances,
          sessions: resolvedSnapshot
            ? mergeSessionsWithRunProjection(
                upsertSessionList(s.sessions, session),
                session,
                resolvedSnapshot.run,
                resolvedSnapshot.taskBoard,
              )
            : upsertSessionList(s.sessions, session),
          messages: normalizedMessages,
          loadingMessages: false,
          ...(resolvedSnapshot
              ? {
                  taskBoard: resolvedSnapshot.taskBoard,
                  agentTabs: resolvedSnapshot.agentTabs,
                  agentTyping: resolvedSnapshot.runtimeActivity.agentTyping,
                  agentActivity: resolvedSnapshot.runtimeActivity.agentActivity,
                  selectedAgentTab: selectedTaskForSession(
                    sessionId,
                    resolvedSnapshot.taskBoard,
                    resolvedSnapshot.agentTabs,
                  ),
                }
              : {}),
        }))
      } else {
        if (get().currentSessionId !== sessionId) return
        const resolvedSnapshot = projectRoomResourceSnapshot(roomSnapshot, [])
        const normalizedMessages = sortMessages(roomProjection.messages)
        messageCache.set(sessionId, normalizedMessages)
        if (resolvedSnapshot) {
          wsClient.joinSessions(taskBoardSessionIds(resolvedSnapshot.taskBoard, sessionId))
        }
        set((s) => ({
          currentSession: session,
          currentWorkspace: null,
          currentWorkspaceAgents: [],
          sessions: resolvedSnapshot
            ? mergeSessionsWithRunProjection(
                upsertSessionList(s.sessions, session),
                session,
                resolvedSnapshot.run,
                resolvedSnapshot.taskBoard,
              )
            : upsertSessionList(s.sessions, session),
          messages: normalizedMessages,
          loadingMessages: false,
          ...(resolvedSnapshot
            ? {
                taskBoard: resolvedSnapshot.taskBoard,
                agentTabs: resolvedSnapshot.agentTabs,
                agentTyping: resolvedSnapshot.runtimeActivity.agentTyping,
                agentActivity: resolvedSnapshot.runtimeActivity.agentActivity,
                selectedAgentTab: selectedTaskForSession(
                  sessionId,
                  resolvedSnapshot.taskBoard,
                  resolvedSnapshot.agentTabs,
                ),
              }
            : {}),
        }))
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
    let full: WorkspaceDetailsCacheEntry | null = null
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
        workerInstances: full.workerInstances,
      })
    }
    set((s) => ({
      sessions: s.sessions.map((item) => (item.id === session.id ? session : item)),
      currentSession: s.currentSessionId === session.id ? session : s.currentSession,
      currentWorkspace:
        s.currentSessionId === session.id ? (full?.workspace ?? null) : s.currentWorkspace,
      currentWorkspaceAgents:
        s.currentSessionId === session.id ? (full?.agents ?? []) : s.currentWorkspaceAgents,
      currentWorkspaceWorkers:
        s.currentSessionId === session.id ? (full?.workerInstances ?? []) : s.currentWorkspaceWorkers,
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
      currentWorkspaceWorkers: s.currentSessionId === sessionId ? [] : s.currentWorkspaceWorkers,
      messages: s.currentSessionId === sessionId ? [] : s.messages,
      streamingMessage: s.currentSessionId === sessionId ? null : s.streamingMessage,
      streamingCodeAgentRun: s.currentSessionId === sessionId ? null : s.streamingCodeAgentRun,
      agentTyping: s.currentSessionId === sessionId ? false : s.agentTyping,
      agentActivity: s.currentSessionId === sessionId ? null : s.agentActivity,
    }))
  },

  async clearMessages(sessionId) {
    await api.clearMessages(sessionId)
    messageCache.delete(sessionId)
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
    if (!sessionId) return
    return get().sendMessageToSession(sessionId, content, options)
  },

  async sendMessageToSession(sessionId, content, options) {
    cancelledSessions.delete(sessionId)
    const targetSession =
      get().currentSession?.id === sessionId
        ? get().currentSession
        : (get().sessions.find((item) => item.id === sessionId) ?? null)
    const isGroupSession =
      targetSession?.type === SessionType.Group && Boolean(targetSession.workspaceId)
    set({
      agentTyping: !isGroupSession,
      selectedAgentTab: isGroupSession ? null : get().selectedAgentTab,
      agentActivity: null,
    })
    const attachments = get().pendingAttachments
    const contentForAgent = attachments.length
      ? appendAttachmentNote(content, attachments)
      : content
    const displayContent =
      options?.displayContent ?? (attachments.length ? content : contentForAgent)
    const state = get()
    const replyToMessageId = options?.replyToMessageId ?? state.replyingToMessageId
    const replyToKind = options?.quotedMessage?.kind ?? state.replyingToKind ?? 'reply'
    const quotedSource =
      replyToMessageId && state.replyingToMessage?.id === replyToMessageId
        ? state.replyingToMessage
        : replyToMessageId
          ? state.messages.find((message) => message.id === replyToMessageId) ?? null
          : null
    const quotedMessage =
      options?.quotedMessage ??
      (replyToMessageId && quotedSource ? createQuotedMessagePreview(quotedSource, replyToKind) : null)
    const optimisticMetadataValue = {
      ...(attachments.length ? { attachments } : {}),
      ...(options?.displayContent !== undefined || attachments.length ? { displayContent } : {}),
      ...(quotedMessage ? { quotedMessage } : {}),
    }
    const optimisticMetadata =
      Object.keys(optimisticMetadataValue).length > 0 ? optimisticMetadataValue : null
    const optimisticId = `local-${crypto.randomUUID()}`
    const optimisticMessage: Message = {
      id: optimisticId,
      sessionId,
      senderId: 'default-user',
      senderType: SenderType.User,
      type: MessageType.Text,
      content: displayContent,
      metadata: optimisticMetadata,
      replyToMessageId,
      createdAt: new Date().toISOString(),
    }
    set((s) => ({
      messages: upsertMessage(s.messages, optimisticMessage),
      pendingAttachments: [],
      replyingToMessageId: null,
      replyingToMessage: null,
      replyingToKind: 'reply',
    }))
    try {
      const msg = await api.sendMessageWithModel(sessionId, {
        content: contentForAgent,
        attachments,
        displayContent: options?.displayContent ?? (attachments.length ? content : undefined),
        replyToMessageId: replyToMessageId ?? undefined,
        quotedMessage,
        safetyMode: options?.safetyMode,
        mentions: options?.mentions,
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
          (state.agentActivity.phase === 'planning' || state.agentActivity.phase === 'thinking')
        ) {
          return { agentTyping: true, taskBoard: state.taskBoard, agentTabs: state.agentTabs }
        }
        return {
          agentTyping: false,
          agentActivity: null,
        }
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

  async resendMessage(messageId) {
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
    try {
      const result = await api.resendMessage(sessionId, messageId)
      const removed = new Set(result.removedMessageIds)
      if (removed.size) {
        updateCachedMessages(sessionId, (messages) =>
          messages.filter((message) => !removed.has(message.id)),
        )
        set((s) => ({
          messages: s.messages.filter((message) => !removed.has(message.id)),
        }))
      }
      await get().fetchSessions()
    } catch (error) {
      set({ agentTyping: false })
      throw error
    }
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
    try {
      const result = await api.withdrawMessage(sessionId, messageId, { rollback: true })
      const removed = new Set(result.removedMessageIds)
      updateCachedMessages(sessionId, (messages) =>
        messages.filter((message) => !removed.has(message.id)),
      )
      set((s) => ({ messages: s.messages.filter((message) => !removed.has(message.id)) }))
      return result.rollback
    } catch {
      cancelledSessions.delete(sessionId)
      return null
    }
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
    try {
      const result = await api.regenerateMessage(sessionId, messageId)
      updateCachedMessages(sessionId, (messages) =>
        messages.filter((message) => message.id !== result.removedMessageId),
      )
      set((s) => ({
        messages: s.messages.filter((message) => message.id !== result.removedMessageId),
      }))
    } catch {
      set({ agentTyping: false })
    }
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

  setSafetyMode(mode: string) {
    set({ safetyMode: mode })
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

  setReplyingTo(messageId, kind = 'reply') {
    if (!messageId) {
      set({ replyingToMessageId: null, replyingToMessage: null, replyingToKind: 'reply' })
      return
    }
    const msg = get().messages.find((m) => m.id === messageId) ?? null
    set({ replyingToMessageId: messageId, replyingToMessage: msg, replyingToKind: kind })
  },

  setPreviewUrl(url, _fileType = null, fileName = null) {
    set({ previewUrl: url, previewFileName: fileName })
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
      const isTaskBoardEvent = e.type === WsEvent.AgUiEvent
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
        set((s) => ({
          ...buildReplyingRuntimeProjection(eventSessionId, {
            agentId: typeof e.payload?.agentId === 'string' ? e.payload.agentId : undefined,
            agentName: typeof e.payload?.agentName === 'string' ? e.payload.agentName : undefined,
            phase: typeof e.payload?.phase === 'string' ? e.payload.phase : 'replying',
          }),
          streamingMessage: s.streamingMessage,
          streamingCodeAgentRun: s.streamingCodeAgentRun,
        }))
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
            return applyLiveMessageStreamProjection(
              {
                agentTyping: s.agentTyping,
                agentActivity: s.agentActivity,
                streamingMessage: s.streamingMessage,
                streamingCodeAgentRun: s.streamingCodeAgentRun,
              },
              pending,
            )
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
        set((s) =>
          applyLiveMessageMetadataProjection(
            {
              agentTyping: s.agentTyping,
              agentActivity: s.agentActivity,
              streamingMessage: s.streamingMessage,
              streamingCodeAgentRun: s.streamingCodeAgentRun,
            },
            {
              messageId,
              codeAgentRun,
              agentId,
              agentName,
            },
          ),
        )
        break
      }
      case WsEvent.MessageCompleted: {
        const { message } = e.payload as { message: Message }
        cancelledSessions.delete(sessionId)
        clearPendingStream()
        updateCachedMessages(sessionId, (messages) => upsertMessage(messages, message))
        set((s) => ({
          messages: upsertMessage(s.messages, message),
          ...clearLiveRuntimeProjection(),
        }))
        break
      }
      case WsEvent.RoomTimelineEvent: {
        const roomTimelinePayload = (e.payload ?? {}) as RoomTimelineWsPayload
        const projected = projectRoomTimelineWsPayload(roomTimelinePayload, eventSessionId)
        if (!projected) break
        const projectedSessionId = projected.sessionId
        const messageControl = projected.projection.messageControl
        if (messageControl) {
          updateCachedMessages(projectedSessionId, (messages) =>
            applyRoomTimelineMessageControl(messages, messageControl),
          )
          if (projectedSessionId === sessionId) {
            set((s) => ({
              messages: applyRoomTimelineMessageControl(s.messages, messageControl),
              ...(messageControl.kind === 'message.redact' || messageControl.kind === 'message.clear'
                ? clearLiveRuntimeProjection()
                : {}),
            }))
          }
        }
        const projectedMessages = projected.projection.messages
        if (projectedMessages.length) {
          updateCachedMessages(projectedSessionId, (messages) =>
            mergeMessages(messages, projectedMessages),
          )
          if (projectedSessionId === sessionId) {
            set((s) => ({
              messages: mergeMessages(s.messages, projectedMessages),
            }))
          }
        }
        if (roomTimelineShouldRefreshResources(projected.projection, projectedSessionId, sessionId)) {
          scheduleSessionRefresh(async () => {
            if (get().currentSessionId === projectedSessionId) {
              const roomSnapshot = await api.getRoomSessionSnapshot(projectedSessionId)
              if (get().currentSessionId !== projectedSessionId) return
              const session = roomSnapshot.session
              const roomProjection = projectRoomTimeline({
                room: roomSnapshot.room,
                participants: roomSnapshot.participants,
                timeline: roomSnapshot.timeline,
                sessionId: session.id,
              })
              let full: WorkspaceDetailsCacheEntry | null = null
              if (session.workspaceId) {
                full =
                  workspaceDetailsCache.get(session.workspaceId) ??
                  (await api.getWorkspace(session.workspaceId).catch(() => null))
                if (full) {
                  workspaceDetailsCache.set(session.workspaceId, {
                    workspace: full.workspace,
                    agents: full.agents,
                    workerInstances: full.workerInstances,
                  })
                }
              }
              if (get().currentSessionId !== projectedSessionId) return
              const currentAgents =
                session.workspaceId && full ? sessionWorkspaceAgents(session, full.agents) : []
              const resolvedSnapshot = projectRoomResourceSnapshot(roomSnapshot, currentAgents)
              const normalizedMessages = sortMessages(roomProjection.messages)
              messageCache.set(projectedSessionId, normalizedMessages)
              if (resolvedSnapshot) {
                wsClient.joinSessions(taskBoardSessionIds(resolvedSnapshot.taskBoard, projectedSessionId))
              }
              set((s) => ({
                currentSession: session,
                currentWorkspace: full?.workspace ?? (session.workspaceId ? s.currentWorkspace : null),
                currentWorkspaceAgents: currentAgents,
                currentWorkspaceWorkers: full?.workerInstances ?? s.currentWorkspaceWorkers,
                sessions: resolvedSnapshot
                  ? mergeSessionsWithRunProjection(
                      upsertSessionList(s.sessions, session),
                      session,
                      resolvedSnapshot.run,
                      resolvedSnapshot.taskBoard,
                    )
                  : upsertSessionList(s.sessions, session),
                messages: normalizedMessages,
                ...(resolvedSnapshot
                  ? {
                      taskBoard: resolvedSnapshot.taskBoard,
                      agentTabs: resolvedSnapshot.agentTabs,
                      agentTyping: resolvedSnapshot.runtimeActivity.agentTyping,
                      agentActivity: resolvedSnapshot.runtimeActivity.agentActivity,
                      selectedAgentTab: selectedTaskForSession(
                        projectedSessionId,
                        resolvedSnapshot.taskBoard,
                        resolvedSnapshot.agentTabs,
                      ),
                    }
                  : {}),
              }))
            } else {
              await get().fetchSessions()
            }
          })
        }
        if (roomTimelinePayload.event?.metadata?.hiddenFromChat !== true) {
          wsClient.send({
            type: WsEvent.TimelineRendered,
            payload: {
              sessionId: projectedSessionId,
              roomId: projected.projection.room.id,
              eventId: roomTimelinePayload.event?.id ?? null,
            },
          })
        }
        break
      }
      case WsEvent.MessageCancelled: {
        const removedMessageIds = Array.isArray(e.payload?.removedMessageIds)
          ? e.payload.removedMessageIds.filter((id: unknown): id is string => typeof id === 'string')
          : []
        if (removedMessageIds.length) {
          const removed = new Set(removedMessageIds)
          clearPendingStream()
          updateCachedMessages(eventSessionId, (messages) =>
            messages.filter((message) => !removed.has(message.id)),
          )
          set((s) => ({
            messages: s.messages.filter((message) => !removed.has(message.id)),
            ...clearLiveRuntimeProjection(),
          }))
          break
        }
        cancelledSessions.add(sessionId)
        clearPendingStream()
        set(clearLiveRuntimeProjection())
        break
      }
      case WsEvent.AgUiEvent: {
        const event = (e.payload ?? {}) as AgUiEventPayload
        set((s) => applyAgUiEventToState(s, event, sessionId))
        wsClient.joinSessions(taskBoardSessionIds(get().taskBoard, get().currentSessionId))
        if (agUiEventShouldRefreshSessions(event)) {
          scheduleSessionRefresh(() => get().fetchSessions())
        }
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
