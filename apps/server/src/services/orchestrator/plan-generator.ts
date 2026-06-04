/**
 * Plan generator — fail-loudly stub.
 *
 * The legacy `buildDynamicOrchestratorPlan()` used the LLM-driven
 * `Planner.createPlan()` (via `manager-planner.ts:createManagerActionPlan`)
 * to synthesize an Orchestrator plan. That path has been removed:
 * AgentHub Manager / Coordinator decisions must come from
 *   - `ManagerRuntimeService.stepRoom()` (OpenClaw / QwenPaw Manager), or
 *   - `ManagerLoop` + Room timeline + Controller API
 * and NOT from AgentHub's own local LLM.
 *
 * Dynamic Orchestrator plans remain a valid *shape* for downstream
 * `startPlanRunWithCoordinatorAssignBatch({ plan })` callers, but they
 * must be produced by an external Manager (OpenClaw / QwenPaw) and passed
 * in explicitly. There is no in-Process LLM fallback that synthesizes
 * a plan for an arbitrary user message.
 *
 * This file is kept so that the `OrchestratorPlan` type and the
 * `buildDynamicOrchestratorPlan` symbol still exist for type-checkers
 * and the existing test surface (`dynamic-plan-coordinator-dispatch.test.ts`
 * passes a pre-built plan and does not call the LLM path).
 */

import type { AgentRoleType, CodeAgentType, RuntimeType, SandboxPolicy, TaskType } from '@agenthub/shared'
import type { CollaborationMode, TaskOutputContract, TaskValidation } from './types'

export type PlanAgent = {
  key: string
  name: string
  role: string
  roleType?: AgentRoleType
  color?: string
  systemPrompt?: string
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

export type OrchestratorPlan = {
  kind: 'orchestrator_plan'
  title: string
  goal: string
  summary: string
  agents: PlanAgent[]
  phases?: PlanPhase[]
  tasks: PlanTask[]
  collaborationMode?: CollaborationMode
}

export interface PlanningAgentInput {
  id: string
  name: string
  role?: string | null
  roleType?: string | null
  description?: string | null
  roleProfile?: Record<string, unknown> | null
  color?: string | null
  systemPrompt?: string | null
  modelId?: string | null
  runtimeType?: string | null
  codeAgentType?: string | null
  capabilityTags?: string[] | null
  toolPermissions?: string[] | null
  sandboxPolicy?: string | null
}

/**
 * Legacy LLM-driven dynamic plan generation has been removed.
 * Dynamic plans must now be produced by an external Manager runtime
 * (OpenClaw / QwenPaw) and passed in explicitly to the dispatcher.
 *
 * This function now throws loudly so callers fail fast instead of
 * silently producing an empty / fake plan via AgentHub's local LLM.
 */
export async function buildDynamicOrchestratorPlan(
  content: string,
  _agents: PlanningAgentInput[],
  _workspaceId?: string | null,
): Promise<OrchestratorPlan> {
  throw new Error(
    'buildDynamicOrchestratorPlan: LLM-driven dynamic plan generation is no longer supported. ' +
      'Dynamic plans must be produced by an external Manager runtime (OpenClaw / QwenPaw) and ' +
      `passed in explicitly to startPlanRunWithCoordinatorAssignBatch({ plan }). ` +
      `Original content for diagnostics: "${content.slice(0, 120)}"`,
  )
}
