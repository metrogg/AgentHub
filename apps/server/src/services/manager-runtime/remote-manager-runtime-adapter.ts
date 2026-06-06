import type {
  ManagerAction,
  ManagerRuntime,
  ManagerRuntimeEvent,
  ManagerRuntimeType,
  ManagerStepInput,
  ManagerStepResult,
} from './types'

export interface RemoteManagerRuntimeAdapterOptions {
  endpoint?: string | null
  stepPath?: string
}

/**
 * Generic adapter for ManagerRuntime providers backed by an external service.
 *
 * OpenClaw/QwenPaw are provider implementations of the ManagerRuntime
 * abstraction; this class is only the HTTP adapter used by those providers.
 */
export class RemoteManagerRuntimeAdapter implements ManagerRuntime {
  constructor(
    readonly runtimeType: ManagerRuntimeType,
    private readonly options: RemoteManagerRuntimeAdapterOptions = {},
  ) {}

  async *step(
    input: ManagerStepInput,
    signal?: AbortSignal,
  ): AsyncGenerator<ManagerRuntimeEvent, ManagerStepResult> {
    yield {
      type: 'thinking',
      content: `${this.runtimeType} Manager provider is observing the room timeline.`,
    }
    const result = await this.stepViaEndpoint(input, signal)
    yield { type: 'completed', actions: result.actions }
    return result
  }

  private async stepViaEndpoint(
    input: ManagerStepInput,
    signal?: AbortSignal,
  ): Promise<ManagerStepResult> {
    const endpoint = this.options.endpoint
    if (!endpoint) {
      throw new Error(
        `${this.runtimeType} ManagerRuntime provider requires an endpoint. ` +
          'Configure AGENTHUB_OPENCLAW_MANAGER_ENDPOINT or AGENTHUB_QWENPAW_MANAGER_ENDPOINT. ' +
          'AgentHub will not silently fall back to an internal LLM Manager.',
      )
    }
    const response = await fetch(resolveStepEndpoint(endpoint, this.options.stepPath), {
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
      throw new Error(`${this.runtimeType} ManagerRuntime endpoint failed: ${response.status} ${text.slice(0, 500)}`)
    }
    return this.normalizeRuntimeResult(parseJson(text), text)
  }

  private normalizeRuntimeResult(value: unknown, rawOutput: string): ManagerStepResult {
    if (!value || typeof value !== 'object') {
      throw new Error(`${this.runtimeType} ManagerRuntime returned non-object output`)
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

const ACTION_TYPES = new Set([
  'reply',
  'clarify',
  'propose_members',
  'assign',
  'wait',
  'create_worker',
  'cancel_task',
  'request_approval',
])

function normalizeActions(value: unknown): ManagerAction[] {
  if (!Array.isArray(value)) {
    throw new Error('ManagerRuntime output must include actions[]')
  }
  const actions = value.map(normalizeAction).filter(Boolean) as ManagerAction[]
  if (!actions.length) throw new Error('ManagerRuntime returned empty actions[]')
  return actions
}

function normalizeAction(value: unknown): ManagerAction | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (!ACTION_TYPES.has(type)) throw new Error(`Invalid ManagerRuntime action: ${type || 'unknown'}`)
    return {
      type: type as ManagerAction['type'],
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

function memberProposals(value: unknown): ManagerAction['memberProposals'] {
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
        expertProfileId: optionalText(record.expertProfileId),
        name,
        role,
        reason,
        category: optionalText(record.category),
        roleType: optionalText(record.roleType) as NonNullable<ManagerAction['memberProposals']>[number]['roleType'],
        description: optionalText(record.description),
        systemPrompt: optionalText(record.systemPrompt),
        runtimeType: optionalText(record.runtimeType) as NonNullable<ManagerAction['memberProposals']>[number]['runtimeType'],
        codeAgentType: optionalText(record.codeAgentType) as NonNullable<ManagerAction['memberProposals']>[number]['codeAgentType'],
        workerRuntimeBase: optionalText(record.workerRuntimeBase) as NonNullable<ManagerAction['memberProposals']>[number]['workerRuntimeBase'],
        color: optionalText(record.color),
        modelId: optionalText(record.modelId) ?? null,
        capabilityTags: stringArray(record.capabilityTags),
        skillIds: stringArray(record.skillIds),
        toolPermissions: stringArray(record.toolPermissions),
        sandboxPolicy: optionalText(record.sandboxPolicy) as NonNullable<ManagerAction['memberProposals']>[number]['sandboxPolicy'],
        contextPolicy: optionalText(record.contextPolicy) as NonNullable<ManagerAction['memberProposals']>[number]['contextPolicy'],
        expectedContribution: optionalText(record.expectedContribution),
      }
    })
    .filter(Boolean) as NonNullable<ManagerAction['memberProposals']>
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
    throw new Error(`ManagerRuntime returned invalid JSON: ${(error as Error).message}. Output: ${value.slice(0, 500)}`)
  }
}

export function resolveStepEndpoint(endpoint: string, stepPath = '/step') {
  const trimmed = endpoint.trim()
  if (!trimmed) return trimmed
  const url = new URL(trimmed)
  const normalizedPath = url.pathname.replace(/\/+$/, '')
  if (/\/step$/i.test(normalizedPath)) return url.toString()
  url.pathname = `${normalizedPath || ''}${stepPath.startsWith('/') ? stepPath : `/${stepPath}`}`
  return url.toString()
}

export function resolveHealthEndpoint(endpoint: string) {
  const trimmed = endpoint.trim()
  if (!trimmed) return trimmed
  const url = new URL(trimmed)
  const normalizedPath = url.pathname.replace(/\/+$/, '')
  url.pathname = /\/step$/i.test(normalizedPath)
    ? normalizedPath.replace(/\/step$/i, '/health')
    : `${normalizedPath || ''}/health`
  return url.toString()
}
