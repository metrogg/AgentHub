import type { TimelineEventType } from '../rooms'

// ─── Manager Runtime Types ───────────────────────────────────────────

export type ManagerRuntimeType = 'openclaw' | 'qwenpaw'

/**
 * Events emitted during a Manager runtime step.
 * Aligned with HiClaw's Manager execution pattern:
 * OpenClaw/QwenPaw process emits thinking, tool calls, and final actions.
 */
export type ManagerRuntimeEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; call: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: 'tool_result'; result: { callId: string; toolName: string; success: boolean; output: string; metadata?: Record<string, unknown> } }
  | { type: 'room_message'; content: string; messageType: 'reply' | 'clarify' | 'status' }
  | { type: 'task_assigned'; targetWorkerId: string; taskTitle: string; taskDescription: string }
  | { type: 'member_proposed'; proposals: MemberProposal[] }
  | { type: 'completed'; actions: ManagerAction[] }

export interface MemberProposal {
  expertProfileId?: string
  name: string
  role: string
  reason: string
  category?: string
  roleType?: 'orchestrator' | 'clarifier' | 'architect' | 'researcher' | 'coder' | 'verifier' | 'reviewer' | 'integrator' | 'custom'
  description?: string
  systemPrompt?: string
  runtimeType?: 'code-agent'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  workerRuntimeBase?: 'openclaw' | 'qwenpaw' | 'copaw' | 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  color?: string
  modelId?: string | null
  capabilityTags?: string[]
  skillIds?: string[]
  toolPermissions?: string[]
  sandboxPolicy?: 'workspace-write' | 'danger-full-access'
  contextPolicy?: 'recent-only' | 'pinned-recent' | 'workspace-aware'
  expectedContribution?: string
}

/**
 * Final actions the Manager wants to take.
 * These are resource/control-plane intents produced by OpenClaw/QwenPaw style
 * Manager runtimes, then validated and applied by AgentHub controllers.
 */
export type ManagerActionType =
  | 'reply'
  | 'clarify'
  | 'propose_members'
  | 'assign'
  | 'wait'
  | 'create_worker'
  | 'cancel_task'
  | 'rework'
  | 'request_approval'

export interface ManagerAction {
  type: ManagerActionType
  message?: string
  reason?: string
  targetWorkerId?: string
  taskKey?: string
  dependsOn?: string[]
  taskTitle?: string
  taskDescription?: string
  memberProposals?: MemberProposal[]
  metadata?: Record<string, unknown>
}

// ─── Input / Output ──────────────────────────────────────────────────

export interface ManagerObservedEvent {
  id: string
  sequence: number
  type: TimelineEventType
  senderType: 'human' | 'manager' | 'worker' | 'system'
  body: string
  metadata?: Record<string, unknown> | null
}

export interface ManagerWorkerCandidate {
  workspaceAgentId: string
  name: string
  role: string
  runtimeType: 'code-agent'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  capabilityTags: string[]
  status?: string | null
}

export interface ManagerRunState {
  runId: string
  status: string
  goal?: string | null
  tasks: Array<{
    taskId: string
    title: string
    status: string
    progressStatus: string | null
    assignedTo: string | null
    result?: string | null
  }>
  workers: Array<{
    workspaceAgentId: string
    name: string
    observedState: string
    lastHeartbeatAt: string | null
  }>
}

export interface ManagerStepInput {
  context: {
    roomId: string
    ownerId: string
    workspaceId?: string | null
    runId?: string | null
    groupSessionId?: string | null
    goal?: string | null
    managerName?: string | null
    workers?: ManagerWorkerCandidate[]
  }
  timeline: ManagerObservedEvent[]
  runState?: ManagerRunState
  signal?: AbortSignal
}

export interface ManagerStepResult {
  runtimeType: ManagerRuntimeType
  actions: ManagerAction[]
  rawOutput?: string
}

// ─── Manager Runtime Interface ───────────────────────────────────────

/**
 * The core Manager runtime interface.
 * Aligned with HiClaw's Manager concept:
 * - observe room timeline + resource snapshot
 * - select and invoke skills (tools)
 * - produce actions that change real resources
 *
 * ManagerRuntime supports iterative tool-calling loops instead of a local LLM
 * planner hidden inside AgentHub.
 */
export interface ManagerRuntime {
  readonly runtimeType: ManagerRuntimeType
  step(input: ManagerStepInput, signal?: AbortSignal): AsyncGenerator<ManagerRuntimeEvent, ManagerStepResult>
}

// ─── Skill Definition ────────────────────────────────────────────────

// SkillDefinition removed — Manager skills live in the OpenClaw/QwenPaw process workspace,
// not in AgentHub's local LLM prompt layer.
