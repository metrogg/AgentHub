import type { BlackboardRef } from '../blackboard'
import type { AgentProfile } from '../runtime'

export interface ClarificationQuestion {
  id: string
  question: string
  options?: string[]
  answer?: string
}

export interface ExecutionPlan {
  runId: string
  title: string
  goal: string
  phases?: OrchestratorPhase[]
  agents: ExecutionAgent[]
  tasks: ExecutionTask[]
  agentRelations?: AgentRelation[]
  clarificationQuestions?: ClarificationQuestion[]
  taskLedger?: TaskLedger
  progressLedger?: ProgressLedger
}

export interface OrchestratorPhase {
  id: string
  title: string
  purpose: string
  taskIds: string[]
}

export interface ExecutionAgent {
  id: string
  key: string
  name: string
  role: string
  roleType?: 'clarifier' | 'architect' | 'researcher' | 'coder' | 'reviewer' | 'integrator' | 'custom'
  description?: string
  color?: string
  systemPrompt?: string
  roleProfile?: Record<string, unknown> | null
  modelId?: string | null
  runtimeType: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini'
  capabilityTags: string[]
  toolPermissions: string[]
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export interface AgentRelation {
  sourceAgentId: string
  targetAgentId: string
  relationType: 'handoff_to' | 'reviewed_by' | 'fallback_to' | 'reports_to' | 'blocks'
  note?: string | null
}

export interface ExecutionTask {
  id: string
  phaseId?: string
  title: string
  description: string
  agentId: string
  dependencies: string[]
  taskType?: 'read' | 'research' | 'design' | 'code' | 'test' | 'review' | 'synthesize'
  parallelGroup?: string
  maxRetries: number
  retryCount?: number
  timeout?: number
  fallbackAgentId?: string
  inputRefs?: BlackboardRef[]
  outputContract?: TaskOutputContract
  validation?: TaskValidation
  agentSelection?: AgentSelection
}

export interface AgentSelection {
  selectedAgentKey: string
  score: number
  rationale: string[]
  reviewerAgentKey?: string
  fallbackAgentKey?: string
}

export interface TaskOutputContract {
  requiredBlackboardWrites: Array<{
    key: string
    schemaType: 'fact' | 'decision' | 'risk' | 'artifact_ref' | 'diff_summary' | 'test_result' | 'task_output'
  }>
  requiredArtifacts?: string[]
  allowedPaths?: string[]
  acceptanceCriteria?: string[]
}

export interface TaskValidation {
  commands?: string[]
  requiresReview?: boolean
}

export interface TaskLedger {
  runId: string
  title: string
  goal: string
  assumptions: string[]
  constraints: string[]
  phases: OrchestratorPhase[]
  tasks: Array<{
    id: string
    phaseId: string
    title: string
    description: string
    agentId: string
    dependencies: string[]
    taskType: NonNullable<ExecutionTask['taskType']>
    status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
    outputContract: TaskOutputContract
    validation: TaskValidation
  }>
  agentAssignments: Array<{
    agentId: string
    taskIds: string[]
  }>
  createdAt: string
  updatedAt: string
}

export interface ProgressLedger {
  runId: string
  status: 'planning' | 'running' | 'synthesizing' | 'completed' | 'failed' | 'cancelled'
  currentPhaseId?: string
  pendingTaskIds: string[]
  runningTaskIds: string[]
  completedTaskIds: string[]
  failedTaskIds: string[]
  cancelledTaskIds: string[]
  blockedTaskIds: string[]
  blackboardKeys: string[]
  artifactIds: string[]
  conflicts: Array<{ filePath?: string; resolution?: string; severity?: string }>
  retryHistory: Array<{ taskId?: string; attempt?: number; reason?: string; at: string }>
  agentSubstitutions: Array<{ taskId?: string; fromAgentId?: string; toAgentId?: string; reason?: string; at: string }>
  replanHistory: Array<{ strategy?: string; reason?: string; changedTaskIds: string[]; at: string }>
  startedAt?: string
  updatedAt: string
  completedAt?: string
}

export interface TaskResult {
  taskId: string
  agentId: string
  agentName: string
  status: 'done' | 'failed' | 'cancelled' | 'blocked' | 'skipped'
  output: string
  artifacts: Array<Record<string, unknown>>
  outputRef?: BlackboardRef
  startedAt?: Date
  completedAt?: Date
  error?: string
}

export interface SchedulerCallbacks {
  onTaskStart(task: ExecutionTask): void | Promise<void>
  onTaskComplete(task: ExecutionTask, result: TaskResult): void | Promise<void>
  onTaskRetry(task: ExecutionTask, attempt: number): void | Promise<void>
  onTaskFallback(task: ExecutionTask, fallbackAgentId: string): void | Promise<void>
  onTaskFailed(task: ExecutionTask, error: Error): void | Promise<void>
}
