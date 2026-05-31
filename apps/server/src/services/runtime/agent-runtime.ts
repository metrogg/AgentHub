import type { AgentArtifact } from '@agenthub/db'

export interface AgentProfile {
  id: string
  name: string
  role?: string
  roleType?: string
  description?: string
  systemPrompt?: string
  color?: string
  modelId?: string | null
  runtimeType: 'llm' | 'code-agent'
  codeAgentType?: 'codex' | 'claude-code' | 'opencode' | 'gemini'
  a2aEndpoint?: string | null
  capabilityTags: string[]
  toolPermissions: string[]
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
  contextPolicy: 'recent-only' | 'pinned-recent' | 'workspace-aware'
  approvalRequired: boolean
  projectPath?: string | null
  originalProjectPath?: string | null
}

import type { AgentExecutionEnvelope } from '../execution/agent-execution-envelope'

export interface ExecutionContext {
  sessionId: string
  prompt: string
  history: Array<{ senderType: string; content: string }>
  profile: AgentProfile
  signal: AbortSignal
  workspacePath?: string | null
  envelope?: AgentExecutionEnvelope
  continueSession?: boolean
  resumeSessionId?: string
}

export type AgentOutputChunk =
  | { kind: 'text'; text: string }
  | { kind: 'artifact'; artifact: AgentArtifact }
  | { kind: 'metadata'; metadata: Record<string, unknown> }

export interface AgentRuntime {
  readonly runtimeType: string
  readonly displayName: string

  execute(ctx: ExecutionContext): AsyncGenerator<AgentOutputChunk>

  extractArtifacts?(chunks: AgentOutputChunk[]): AgentArtifact[]
}

export function isCodeAgentProfile(profile: AgentProfile): boolean {
  return profile.runtimeType === 'code-agent'
}
