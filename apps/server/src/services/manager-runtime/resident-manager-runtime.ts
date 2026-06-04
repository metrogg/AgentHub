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
 * This runtime's step() is a no-op: OpenClaw itself is the decision maker.
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
    yield {
      type: 'thinking',
      content: `${this.runtimeType} is a resident process; AgentHub does not invoke its step directly.`,
    }
    return {
      runtimeType: this.runtimeType,
      actions: [{ type: 'wait', reason: 'Resident Manager process handles coordination autonomously.' }],
    }
  }
}
