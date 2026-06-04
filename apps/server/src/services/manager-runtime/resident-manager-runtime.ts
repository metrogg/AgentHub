import type { ManagerRuntime, ManagerRuntimeEvent, ManagerStepInput, ManagerStepResult } from './types'

/**
 * Resident Manager Runtime — for OpenClaw / QwenPaw processes.
 *
 * OpenClaw is a long-running process that connects to Matrix and observes
 * rooms via /sync. It does NOT need to be "called" by AgentHub server.
 * AgentHub only needs to:
 *   1. Start the OpenClaw process
 *   2. Provide Matrix identity + config
 *   3. Provide Controller API for OpenClaw's skills to call
 *
 * This runtime's step() THROWS because:
 * - If OpenClaw is running, AgentHub should NOT call step() at all.
 *   The skip logic in room-chat-bridge.ts and manager-loop.ts handles this.
 * - If OpenClaw is NOT running, silent no-op would mask a critical failure.
 *   The Manager is the brain of the system; without it, nothing works.
 */
export class ResidentManagerRuntime implements ManagerRuntime {
  readonly runtimeType

  constructor(runtimeType: 'openclaw' | 'qwenpaw') {
    this.runtimeType = runtimeType
  }

  async *step(
    _input: ManagerStepInput,
    _signal?: AbortSignal,
  ): AsyncGenerator<ManagerRuntimeEvent, ManagerStepResult> {
    throw new Error(
      `Resident Manager (${this.runtimeType}) step() was called, but this should never happen. ` +
        'OpenClaw / QwenPaw is a resident process that handles coordination autonomously via Matrix /sync. ' +
        'AgentHub should skip calling step() when the resident Manager is active. ' +
        'If you see this error, it means either: ' +
        '(1) the resident Manager process is not running, or ' +
        '(2) the skip logic in room-chat-bridge.ts / manager-loop.ts is broken.',
    )
  }
}
