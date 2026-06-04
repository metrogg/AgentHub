import type {
  CoordinatorRuntime,
  CoordinatorRuntimeType,
  CoordinatorStepInput,
  CoordinatorStepResult,
} from './types'

export interface ExternalCoordinatorRuntimeOptions {
  endpoint?: string | null
  command?: string | null
}

abstract class ExternalCoordinatorRuntime implements CoordinatorRuntime {
  constructor(
    readonly runtimeType: Exclude<CoordinatorRuntimeType, 'local-llm'>,
    private readonly options: ExternalCoordinatorRuntimeOptions = {},
  ) {}

  async step(_input: CoordinatorStepInput, _signal?: AbortSignal): Promise<CoordinatorStepResult> {
    const hint = this.options.endpoint
      ? `endpoint=${this.options.endpoint}`
      : this.options.command
        ? `command=${this.options.command}`
        : 'no endpoint or command configured'
    throw new Error(
      `${this.runtimeType} CoordinatorRuntime adapter is a reserved HiClaw-lite integration point (${hint}). ` +
        'It is not wired to a live OpenClaw/QwenPaw runtime yet; use local-llm or finish the external runtime adapter.',
    )
  }
}

export class OpenClawCoordinatorRuntime extends ExternalCoordinatorRuntime {
  constructor(options: ExternalCoordinatorRuntimeOptions = {}) {
    super('openclaw', options)
  }
}

export class QwenPawCoordinatorRuntime extends ExternalCoordinatorRuntime {
  constructor(options: ExternalCoordinatorRuntimeOptions = {}) {
    super('qwenpaw', options)
  }
}
