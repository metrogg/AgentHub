import { LocalCoordinatorRuntime } from './local-coordinator-runtime'
import { OpenClawCoordinatorRuntime, QwenPawCoordinatorRuntime } from './external-coordinator-runtime'
import type { CoordinatorRuntime, CoordinatorRuntimeType } from './types'

export interface CoordinatorRuntimeSelection {
  type?: CoordinatorRuntimeType | null
  endpoint?: string | null
  command?: string | null
}

export function resolveCoordinatorRuntime(
  selection: CoordinatorRuntimeSelection = {},
): CoordinatorRuntime {
  const type = normalizeCoordinatorRuntimeType(selection.type)
  if (type === 'openclaw') {
    return new OpenClawCoordinatorRuntime({
      endpoint: selection.endpoint ?? process.env.AGENTHUB_OPENCLAW_COORDINATOR_ENDPOINT,
      command: selection.command ?? process.env.AGENTHUB_OPENCLAW_COORDINATOR_COMMAND,
    })
  }
  if (type === 'qwenpaw') {
    return new QwenPawCoordinatorRuntime({
      endpoint: selection.endpoint ?? process.env.AGENTHUB_QWENPAW_COORDINATOR_ENDPOINT,
      command: selection.command ?? process.env.AGENTHUB_QWENPAW_COORDINATOR_COMMAND,
    })
  }
  return new LocalCoordinatorRuntime()
}

export function getDefaultCoordinatorRuntime(): CoordinatorRuntime {
  return resolveCoordinatorRuntime({
    type: normalizeCoordinatorRuntimeType(process.env.AGENTHUB_COORDINATOR_RUNTIME),
  })
}

export function normalizeCoordinatorRuntimeType(value: unknown): CoordinatorRuntimeType {
  if (value === 'openclaw' || value === 'qwenpaw' || value === 'local-llm') {
    return value
  }
  return 'local-llm'
}
