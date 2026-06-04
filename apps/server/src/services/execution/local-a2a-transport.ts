import type { AgentExecutionEnvelope } from './agent-execution-envelope'
import type { AgentRunResult, MessageRow } from '../agent-runner'
import { runAgentReply } from '../agent-runner'
import type { AgentProfile } from '../runtime'
import type { AgentHubA2AEnvelope } from '../protocols/a2a-internal'

// Migration-only local transport.
//
// A2A is no longer the target internal communication backbone for the
// HiClaw-lite kernel. New internal collaboration should go through RoomService
// / Matrix-compatible timeline events. Keep this adapter for old execution
// compatibility and future external interoperability only.

export interface LocalA2ASendInput {
  sessionId: string
  userMessage: MessageRow
  profile?: AgentProfile
  envelope?: AgentExecutionEnvelope
  a2a?: AgentHubA2AEnvelope
  signal?: AbortSignal
}

export class LocalA2ATransport {
  async sendMessage(input: LocalA2ASendInput): Promise<AgentRunResult> {
    const envelope = input.envelope
      ? {
          ...input.envelope,
          a2a: input.a2a ?? input.envelope.a2a,
        }
      : undefined
    return runAgentReply(
      input.sessionId,
      input.userMessage,
      input.profile,
      envelope,
      input.signal,
    )
  }
}

export const localA2ATransport = new LocalA2ATransport()
