import type { CodeAgentRunMetadata } from '@agenthub/shared'
import type { UpdateSharedTaskDirectoryStatusInput } from '../orchestrator/shared-task-directory'
import type { WorkerRuntimeResult } from './types'

export type SharedTaskDirectoryRuntimeStatus = UpdateSharedTaskDirectoryStatusInput['status']
export type CodeAgentRunStatus = CodeAgentRunMetadata['status']
export type WorkerRuntimeTerminalEventKind =
  | 'worker-runtime.completed'
  | 'worker-runtime.failed'
  | 'worker-runtime.cancelled'
  | 'worker-runtime.waiting-for-human'

export function sharedTaskStatusFromWorkerResult(
  status: WorkerRuntimeResult['status'],
): SharedTaskDirectoryRuntimeStatus {
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'waiting_for_human') return 'blocked'
  return 'failed'
}

export function terminalSharedTaskTimestamps(
  status: WorkerRuntimeResult['status'],
  now = new Date().toISOString(),
) {
  if (status === 'completed') return { completedAt: now, updatedAt: now }
  if (status === 'cancelled') return { cancelledAt: now, updatedAt: now }
  if (status === 'failed') return { failedAt: now, updatedAt: now }
  return { updatedAt: now }
}

export function workerRuntimeTerminalKind(
  status: WorkerRuntimeResult['status'],
): WorkerRuntimeTerminalEventKind {
  if (status === 'waiting_for_human') return 'worker-runtime.waiting-for-human'
  if (status === 'cancelled') return 'worker-runtime.cancelled'
  if (status === 'failed') return 'worker-runtime.failed'
  return 'worker-runtime.completed'
}

export function codeAgentRunStatusFromWorkerStatus(
  status: WorkerRuntimeResult['status'],
): CodeAgentRunStatus {
  if (status === 'completed') return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}
