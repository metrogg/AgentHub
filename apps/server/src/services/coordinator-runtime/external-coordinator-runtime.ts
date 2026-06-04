import type {
  CoordinatorAction,
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

  async step(input: CoordinatorStepInput, signal?: AbortSignal): Promise<CoordinatorStepResult> {
    if (this.options.endpoint) {
      return this.stepViaEndpoint(input, signal)
    }
    if (this.options.command) {
      return this.stepViaCommand(input, signal)
    }
    throw new Error(
      `${this.runtimeType} CoordinatorRuntime requires a live Manager runtime. ` +
        'Configure AGENTHUB_OPENCLAW_COORDINATOR_ENDPOINT or AGENTHUB_OPENCLAW_COORDINATOR_COMMAND. ' +
        'AgentHub no longer falls back to an internal LLM Manager.',
    )
  }

  private async stepViaEndpoint(input: CoordinatorStepInput, signal?: AbortSignal): Promise<CoordinatorStepResult> {
    const endpoint = this.options.endpoint
    if (!endpoint) throw new Error(`${this.runtimeType} endpoint is not configured`)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtimeType: this.runtimeType,
        input,
      }),
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${this.runtimeType} CoordinatorRuntime endpoint failed: ${response.status} ${text.slice(0, 500)}`)
    }
    return this.normalizeRuntimeResult(parseJson(text), text)
  }

  private async stepViaCommand(input: CoordinatorStepInput, signal?: AbortSignal): Promise<CoordinatorStepResult> {
    const command = this.options.command
    if (!command) throw new Error(`${this.runtimeType} command is not configured`)
    const proc = Bun.spawn(commandShell(command), {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const abort = () => proc.kill()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      proc.stdin.write(
        JSON.stringify({
          runtimeType: this.runtimeType,
          input,
        }),
      )
      proc.stdin.end()
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) {
        throw new Error(`${this.runtimeType} CoordinatorRuntime command failed (${code}): ${stderr.slice(0, 1000)}`)
      }
      return this.normalizeRuntimeResult(parseJson(stdout), stdout)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private normalizeRuntimeResult(value: unknown, rawOutput: string): CoordinatorStepResult {
    if (!value || typeof value !== 'object') {
      throw new Error(`${this.runtimeType} CoordinatorRuntime returned non-object output`)
    }
    const record = value as Record<string, unknown>
    const actions = normalizeActions(record.actions)
    return {
      runtimeType: this.runtimeType,
      actions,
      rawOutput,
    }
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

const ACTION_TYPES = new Set(['reply', 'clarify', 'propose_members', 'assign', 'wait'])

function normalizeActions(value: unknown): CoordinatorAction[] {
  if (!Array.isArray(value)) {
    throw new Error('CoordinatorRuntime output must include actions[]')
  }
  const actions = value.map(normalizeAction).filter(Boolean) as CoordinatorAction[]
  if (!actions.length) throw new Error('CoordinatorRuntime returned empty actions[]')
  return actions
}

function normalizeAction(value: unknown): CoordinatorAction | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (!ACTION_TYPES.has(type)) throw new Error(`Invalid CoordinatorRuntime action: ${type || 'unknown'}`)
  return {
    type: type as CoordinatorAction['type'],
    message: optionalText(record.message),
    reason: optionalText(record.reason),
    targetWorkerId: optionalText(record.targetWorkerId),
    taskKey: optionalText(record.taskKey),
    dependsOn: stringArray(record.dependsOn),
    taskTitle: optionalText(record.taskTitle),
    taskDescription: optionalText(record.taskDescription),
    memberProposals: memberProposals(record.memberProposals),
    metadata:
      record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : undefined,
  }
}

function memberProposals(value: unknown): CoordinatorAction['memberProposals'] {
  if (!Array.isArray(value)) return undefined
  const proposals = value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const name = optionalText(record.name)
      const role = optionalText(record.role)
      const reason = optionalText(record.reason)
      if (!name || !role || !reason) return null
      return {
        name,
        role,
        reason,
        expectedContribution: optionalText(record.expectedContribution),
      }
    })
    .filter(Boolean) as NonNullable<CoordinatorAction['memberProposals']>
  return proposals.length ? proposals : undefined
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const values = value.map((item) => optionalText(item)).filter(Boolean) as string[]
  return values.length ? values : undefined
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseJson(value: string) {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`CoordinatorRuntime returned invalid JSON: ${(error as Error).message}. Output: ${value.slice(0, 500)}`)
  }
}

function commandShell(command: string) {
  if (process.platform === 'win32') return ['powershell.exe', '-NoProfile', '-Command', command]
  return ['sh', '-lc', command]
}
