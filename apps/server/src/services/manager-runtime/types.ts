import type { TimelineEventType } from '../rooms'

// ─── Manager Runtime Types ───────────────────────────────────────────

export type ManagerRuntimeType = 'local-skill-runtime' | 'openclaw' | 'qwenpaw'

/**
 * A tool that the Manager LLM can invoke.
 * Aligned with HiClaw's skill-as-tool pattern:
 * each SKILL.md becomes one or more callable tools.
 */
export interface ManagerTool {
  name: string
  description: string
  parameters: ManagerToolParameter[]
  skillName: string
}

export interface ManagerToolParameter {
  name: string
  type: 'string' | 'number' | 'boolean' | 'string[]'
  description: string
  required?: boolean
  enum?: string[]
}

/**
 * A tool call emitted by the LLM.
 */
export interface ManagerToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/**
 * The result of executing a tool call.
 */
export interface ManagerToolResult {
  callId: string
  toolName: string
  success: boolean
  output: string
  metadata?: Record<string, unknown>
}

/**
 * Events emitted during a Manager runtime step.
 */
export type ManagerRuntimeEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; call: ManagerToolCall }
  | { type: 'tool_result'; result: ManagerToolResult }
  | { type: 'room_message'; content: string; messageType: 'reply' | 'clarify' | 'status' }
  | { type: 'task_assigned'; targetWorkerId: string; taskTitle: string; taskDescription: string }
  | { type: 'member_proposed'; proposals: MemberProposal[] }
  | { type: 'completed'; actions: ManagerAction[] }

export interface MemberProposal {
  name: string
  role: string
  reason: string
  expectedContribution?: string
}

/**
 * Final actions the Manager wants to take.
 * Superset of CoordinatorAction types.
 */
export type ManagerActionType =
  | 'reply'
  | 'clarify'
  | 'propose_members'
  | 'assign'
  | 'wait'
  | 'create_worker'
  | 'cancel_task'
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
  runtimeType: 'llm' | 'code-agent'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini' | null
  capabilityTags: string[]
  status?: string | null
}

export interface ManagerStepInput {
  context: {
    roomId: string
    workspaceId?: string | null
    runId?: string | null
    goal?: string | null
    managerName?: string | null
    workers?: ManagerWorkerCandidate[]
  }
  timeline: ManagerObservedEvent[]
  tools?: ManagerTool[]
  maxIterations?: number
  signal?: AbortSignal
}

export interface ManagerStepResult {
  runtimeType: ManagerRuntimeType
  actions: ManagerAction[]
  toolCalls: ManagerToolCall[]
  toolResults: ManagerToolResult[]
  iterations: number
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
 * Unlike CoordinatorRuntime (single-step), ManagerRuntime
 * supports iterative tool-calling loops.
 */
export interface ManagerRuntime {
  readonly runtimeType: ManagerRuntimeType
  step(input: ManagerStepInput, signal?: AbortSignal): AsyncGenerator<ManagerRuntimeEvent, ManagerStepResult>
}

// ─── Skill Definition ────────────────────────────────────────────────

/**
 * A parsed SKILL.md definition.
 * Mirrors HiClaw's SKILL.md structure:
 * - YAML frontmatter (name, description)
 * - Purpose section
 * - Controller API surface
 * - Rules
 * - Decision pattern
 */
export interface SkillDefinition {
  name: string
  description: string
  purpose: string
  controllerApi: string[]
  rules: string[]
  decisionPattern: string
  tools: ManagerTool[]
  raw: string
}
