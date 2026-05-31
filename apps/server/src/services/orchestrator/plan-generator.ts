import { db, workspaceAgents, workspaceAgentRelations, workspaces, eq } from '@agenthub/db'
import {
  AgentRoleType,
  RuntimeType,
  CodeAgentType,
  SandboxPolicy,
  TaskStatus,
  TaskType,
} from '@agenthub/shared'
import { Planner } from './planner'
import type { CollaborationMode, ExecutionPlan, TaskOutputContract, TaskValidation } from './types'

type PlanAgent = {
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

type PlanTask = {
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

type PlanPhase = {
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

export async function buildDynamicOrchestratorPlan(
  content: string,
  agents: PlanningAgentInput[],
  workspaceId?: string | null,
): Promise<OrchestratorPlan> {
  const goal = normalizeOrchestratorGoal(content)
  if (!agents.length) {
    throw new Error('当前群聊没有可调度的 Agent，请先添加成员后再发起编排')
  }
  const planningAgents = agents.map(planAgentFromInput)
  const orchestratorAgent =
    planningAgents.find((agent) => agent.roleType === 'orchestrator') ??
    planningAgents.find((agent) => agent.name.toLowerCase().includes('orchestrator'))
  const workerPlanningAgents = planningAgents.filter((agent) => agent.roleType !== 'orchestrator')
  if (!workerPlanningAgents.length) {
    throw new Error('当前群聊只有 Orchestrator，没有可执行任务的 Agent')
  }

  let workspacePath: string | null = null
  if (workspaceId) {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    workspacePath = ws?.projectPath ?? null
  }

  const planner = new Planner()
  const executionPlan = await planner.createPlan({
    goal,
    agents: workerPlanningAgents.map(toExecutionAgent),
    workspacePath,
    useSpecFirst: false,
    plannerModelId: orchestratorAgent?.modelId,
    plannerSystemPrompt: orchestratorAgent?.systemPrompt,
  })

  return executionPlanToOrchestratorPlan(executionPlan, workerPlanningAgents)
}

function normalizeOrchestratorGoal(content: string) {
  return (
    content
      .replace(/@orchestrator/gi, '')
      .replace(/@协调器/g, '')
      .trim() || '完成一个多 Agent 协作任务'
  )
}

function planAgentFromInput(agent: PlanningAgentInput): PlanAgent {
  return {
    key: agent.id,
    name: agent.name,
    role: agent.role || '助手',
    roleType: (agent.roleType as PlanAgent['roleType']) ?? undefined,
    description: agent.description ?? undefined,
    roleProfile: agent.roleProfile ?? null,
    color: agent.color ?? undefined,
    systemPrompt: agent.systemPrompt ?? undefined,
    modelId: agent.modelId ?? undefined,
    runtimeType: (agent.runtimeType as PlanAgent['runtimeType']) ?? 'llm',
    codeAgentType: (agent.codeAgentType as PlanAgent['codeAgentType']) ?? undefined,
    capabilityTags: agent.capabilityTags ?? [],
    toolPermissions: agent.toolPermissions ?? [],
    sandboxPolicy: (agent.sandboxPolicy as PlanAgent['sandboxPolicy']) ?? 'workspace-write',
  }
}

export async function loadWorkspaceAgentRelationsForPlanning(workspaceId: string) {
  return db
    .select({
      sourceAgentId: workspaceAgentRelations.sourceAgentId,
      targetAgentId: workspaceAgentRelations.targetAgentId,
      relationType: workspaceAgentRelations.relationType,
      note: workspaceAgentRelations.note,
    })
    .from(workspaceAgentRelations)
    .where(eq(workspaceAgentRelations.workspaceId, workspaceId))
}

function executionPlanToOrchestratorPlan(
  plan: ExecutionPlan,
  planAgents: PlanAgent[],
): OrchestratorPlan {
  return {
    kind: 'orchestrator_plan',
    title: plan.title,
    goal: plan.goal,
    summary: `我已根据当前 Agent 团队把「${plan.title}」拆成 ${plan.tasks.length} 个子任务。确认后会创建或复用 Agent Group 并分发执行。`,
    agents: planAgents,
    phases: plan.phases?.map((p) => ({
      id: p.id,
      title: p.title,
      purpose: p.purpose,
      taskIds: p.taskIds,
    })),
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      phaseId: t.phaseId,
      title: t.title,
      description: t.description,
      agentKey: t.agentId,
      taskType: t.taskType,
      dependencies: t.dependencies ?? [],
      parallelGroup: t.parallelGroup,
      maxRetries: t.maxRetries ?? 2,
      fallbackAgentId: t.fallbackAgentId,
      outputContract: t.outputContract,
      validation: t.validation,
    })),
    collaborationMode: plan.collaborationMode,
  }
}

function toExecutionAgent(agent: PlanAgent): import('./types').ExecutionAgent {
  return {
    id: agent.key,
    key: agent.key,
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType,
    description: agent.description,
    color: agent.color,
    systemPrompt: agent.systemPrompt,
    roleProfile: agent.roleProfile,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType ?? 'llm',
    codeAgentType: agent.codeAgentType ?? undefined,
    capabilityTags: agent.capabilityTags ?? [],
    toolPermissions: agent.toolPermissions ?? [],
    sandboxPolicy: agent.sandboxPolicy ?? 'workspace-write',
  }
}
