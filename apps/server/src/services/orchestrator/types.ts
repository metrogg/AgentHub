import type { AgentProfile } from '../runtime'

export interface ExecutionPlan {
  runId: string
  title: string
  goal: string
  agents: ExecutionAgent[]
  tasks: ExecutionTask[]
}

export interface ExecutionAgent {
  id: string
  key: string
  name: string
  role: string
  description?: string
  color?: string
  systemPrompt?: string
  modelId?: string | null
  runtimeType: 'llm' | 'code-agent' | 'mcp' | 'a2a'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode'
  capabilityTags: string[]
  toolPermissions: string[]
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export interface ExecutionTask {
  id: string
  title: string
  description: string
  agentId: string
  dependencies: string[]
  parallelGroup?: string
  maxRetries: number
  fallbackAgentId?: string
}

export interface TaskResult {
  taskId: string
  agentId: string
  agentName: string
  status: 'done' | 'failed' | 'cancelled'
  output: string
  artifacts: Array<Record<string, unknown>>
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
