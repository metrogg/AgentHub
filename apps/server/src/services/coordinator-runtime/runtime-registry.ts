import { LocalCoordinatorRuntime } from './local-coordinator-runtime'
import type { CoordinatorRuntime, CoordinatorRuntimeType } from './types'

export interface CoordinatorRuntimeSelection {
  type?: CoordinatorRuntimeType | null
  endpoint?: string | null
  command?: string | null
}

export function resolveCoordinatorRuntime(
  selection: CoordinatorRuntimeSelection = {},
): CoordinatorRuntime {
  normalizeCoordinatorRuntimeType(selection.type, { allowLocalLlm: true })
  return new LocalCoordinatorRuntime()
}

export function getDefaultCoordinatorRuntime(): CoordinatorRuntime {
  return resolveCoordinatorRuntime({
    type: normalizeCoordinatorRuntimeType(process.env.AGENTHUB_COORDINATOR_RUNTIME),
  })
}

export function normalizeCoordinatorRuntimeType(
  value: unknown,
  options: { allowLocalLlm?: boolean } = {},
): CoordinatorRuntimeType {
  if (value === 'local-llm' && options.allowLocalLlm) return value
  return 'local-llm'
}
