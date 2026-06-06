export type WorkerRuntimeBase = 'openclaw' | 'qwenpaw' | 'copaw' | 'claude-code' | 'opencode' | 'gemini' | 'codex'

export function normalizeWorkerRuntimeBase(value?: string | null): WorkerRuntimeBase | null {
  if (
    value === 'openclaw' ||
    value === 'qwenpaw' ||
    value === 'copaw' ||
    value === 'claude-code' ||
    value === 'opencode' ||
    value === 'gemini' ||
    value === 'codex'
  ) {
    return value
  }
  return null
}

export function normalizeCodeAgentType(value?: string | null) {
  if (value === 'claude-code' || value === 'opencode' || value === 'gemini' || value === 'codex') {
    return value
  }
  return null
}

export function codeAgentTypeForRuntime(runtimeBase: string, value?: string | null) {
  if (runtimeBase === 'openclaw' || runtimeBase === 'qwenpaw' || runtimeBase === 'copaw') return null
  return normalizeCodeAgentType(value) ?? normalizeWorkerRuntimeBase(runtimeBase)
}

export function workerRoleProfileFromRuntime(
  runtimeBase?: string | null,
  extra?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(extra ?? {}),
    workerRuntimeBase: normalizeWorkerRuntimeBase(runtimeBase),
  }
}

export function readWorkerRuntimeBase(roleProfile: unknown) {
  if (!roleProfile || typeof roleProfile !== 'object') return null
  const value = (roleProfile as Record<string, unknown>).workerRuntimeBase
  return typeof value === 'string' ? value : null
}
