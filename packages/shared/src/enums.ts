export const RuntimeType = {
  Llm: 'llm',
  CodeAgent: 'code-agent',
} as const
export type RuntimeType = (typeof RuntimeType)[keyof typeof RuntimeType]

export const SandboxPolicy = {
  ReadOnly: 'read-only',
  WorkspaceWrite: 'workspace-write',
  DangerFullAccess: 'danger-full-access',
} as const
export type SandboxPolicy = (typeof SandboxPolicy)[keyof typeof SandboxPolicy]

export const ContextPolicy = {
  RecentOnly: 'recent-only',
  PinnedRecent: 'pinned-recent',
  WorkspaceAware: 'workspace-aware',
} as const
export type ContextPolicy = (typeof ContextPolicy)[keyof typeof ContextPolicy]

export const CodeAgentType = {
  Codex: 'codex',
  ClaudeCode: 'claude-code',
  Opencode: 'opencode',
  Gemini: 'gemini',
} as const
export type CodeAgentType = (typeof CodeAgentType)[keyof typeof CodeAgentType]

export const OrchestratorRunStatus = {
  Planning: 'planning',
  Running: 'running',
  Synthesizing: 'synthesizing',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const
export type OrchestratorRunStatus = (typeof OrchestratorRunStatus)[keyof typeof OrchestratorRunStatus]

export const ExecutionLogType = {
  LlmCall: 'llm_call',
  ToolCall: 'tool_call',
  BlackboardRead: 'blackboard_read',
  BlackboardWrite: 'blackboard_write',
  Error: 'error',
  TaskStart: 'task_start',
  TaskEnd: 'task_end',
} as const
export type ExecutionLogType = (typeof ExecutionLogType)[keyof typeof ExecutionLogType]

export const BlackboardSchemaType = {
  Fact: 'fact',
  Decision: 'decision',
  Risk: 'risk',
  ArtifactRef: 'artifact_ref',
  DiffSummary: 'diff_summary',
  TestResult: 'test_result',
  TaskOutput: 'task_output',
} as const
export type BlackboardSchemaType = (typeof BlackboardSchemaType)[keyof typeof BlackboardSchemaType]

export const ArtifactFileStatus = {
  Created: 'created',
  Modified: 'modified',
  Deleted: 'deleted',
  Renamed: 'renamed',
  Untracked: 'untracked',
} as const
export type ArtifactFileStatus = (typeof ArtifactFileStatus)[keyof typeof ArtifactFileStatus]

export const CodeAgentRunStatus = {
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  TimedOut: 'timed-out',
} as const
export type CodeAgentRunStatus = (typeof CodeAgentRunStatus)[keyof typeof CodeAgentRunStatus]

export const TaskType = {
  Read: 'read',
  Research: 'research',
  Design: 'design',
  Code: 'code',
  Test: 'test',
  Verify: 'verify',
  Review: 'review',
  Synthesize: 'synthesize',
} as const
export type TaskType = (typeof TaskType)[keyof typeof TaskType]

export const OrchestratorRunEventSeverity = {
  Debug: 'debug',
  Info: 'info',
  Warning: 'warning',
  Error: 'error',
} as const
export type OrchestratorRunEventSeverity = (typeof OrchestratorRunEventSeverity)[keyof typeof OrchestratorRunEventSeverity]

export const OrchestratorRunEventType = {
  RunStarted: 'run.started',
  PlanCreated: 'plan.created',
  PlanValidated: 'plan.validated',
  ApprovalRequested: 'approval.requested',
  ApprovalGranted: 'approval.granted',
  PhaseStarted: 'phase.started',
  TaskQueued: 'task.queued',
  TaskStarted: 'task.started',
  TaskStream: 'task.stream',
  BlackboardWritten: 'blackboard.written',
  ArtifactCreated: 'artifact.created',
  TaskCompleted: 'task.completed',
  TaskFailed: 'task.failed',
  TaskCancelled: 'task.cancelled',
  TaskRetrying: 'task.retrying',
  TaskReassigned: 'task.reassigned',
  RunReplanned: 'run.replanned',
  ConflictDetected: 'conflict.detected',
  ConflictResolved: 'conflict.resolved',
  RunSynthesizing: 'run.synthesizing',
  RunCompleted: 'run.completed',
  RunCancelled: 'run.cancelled',
  RunFailed: 'run.failed',
} as const
export type OrchestratorRunEventType = (typeof OrchestratorRunEventType)[keyof typeof OrchestratorRunEventType]
