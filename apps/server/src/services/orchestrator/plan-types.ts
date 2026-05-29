import type { TaskOutputContract, TaskValidation } from './types'
import { AgentRoleType, RuntimeType, CodeAgentType, SandboxPolicy, TaskStatus, TaskType } from '@agenthub/shared'

export type PlanAgent = {
  key: string
  name: string
  role: string
  roleType?: AgentRoleType
  color: string
  systemPrompt: string
  description?: string
  roleProfile?: Record<string, unknown> | null
  modelId?: string | null
  runtimeType?: RuntimeType
  codeAgentType?: CodeAgentType | null
  capabilityTags?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: SandboxPolicy
}

export type PlanTask = {
  id: string
  phaseId?: string
  title: string
  description: string
  agentKey: string
  status?: TaskStatus
  taskType?: TaskType
  dependencies?: string[]
  parallelGroup?: string
  maxRetries?: number
  fallbackAgentId?: string
  outputContract?: TaskOutputContract
  validation?: TaskValidation
  agentSelection?: {
    selectedAgentKey: string
    score: number
    rationale: string[]
    reviewerAgentKey?: string
    fallbackAgentKey?: string
  }
}

export type PlanPhase = {
  id: string
  title: string
  purpose: string
  taskIds: string[]
}

export type OrchestratorDispatchResult = {
  runId: string
  workspaceId: string
  groupSessionId?: string
  tasks: Array<{ taskId: string; sessionId: string; title: string; agentName: string }>
}

export type OrchestratorPlan = {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: PlanAgent[]
  phases?: PlanPhase[]
  tasks: PlanTask[]
  dispatchResult?: OrchestratorDispatchResult
}
