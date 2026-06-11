import { describe, expect, test } from 'bun:test'
import {
  codeAgentRunStatusFromWorkerStatus,
  sharedTaskStatusFromWorkerResult,
  terminalSharedTaskTimestamps,
  workerRuntimeTerminalKind,
} from '../apps/server/src/services/worker-runtime/worker-runtime-status'

describe('worker runtime status projections', () => {
  test('maps WorkerRuntimeResult status to shared task directory status', () => {
    expect(sharedTaskStatusFromWorkerResult('completed')).toBe('completed')
    expect(sharedTaskStatusFromWorkerResult('failed')).toBe('failed')
    expect(sharedTaskStatusFromWorkerResult('cancelled')).toBe('cancelled')
    expect(sharedTaskStatusFromWorkerResult('waiting_for_human')).toBe('blocked')
  })

  test('returns terminal shared task timestamps for each terminal worker outcome', () => {
    const now = '2026-06-12T00:00:00.000Z'

    expect(terminalSharedTaskTimestamps('completed', now)).toEqual({
      completedAt: now,
      updatedAt: now,
    })
    expect(terminalSharedTaskTimestamps('failed', now)).toEqual({
      failedAt: now,
      updatedAt: now,
    })
    expect(terminalSharedTaskTimestamps('cancelled', now)).toEqual({
      cancelledAt: now,
      updatedAt: now,
    })
    expect(terminalSharedTaskTimestamps('waiting_for_human', now)).toEqual({
      updatedAt: now,
    })
  })

  test('maps WorkerRuntimeResult status to terminal timeline event kind', () => {
    expect(workerRuntimeTerminalKind('completed')).toBe('worker-runtime.completed')
    expect(workerRuntimeTerminalKind('failed')).toBe('worker-runtime.failed')
    expect(workerRuntimeTerminalKind('cancelled')).toBe('worker-runtime.cancelled')
    expect(workerRuntimeTerminalKind('waiting_for_human')).toBe('worker-runtime.waiting-for-human')
  })

  test('maps WorkerRuntimeResult status to code-agent run status', () => {
    expect(codeAgentRunStatusFromWorkerStatus('completed')).toBe('completed')
    expect(codeAgentRunStatusFromWorkerStatus('cancelled')).toBe('cancelled')
    expect(codeAgentRunStatusFromWorkerStatus('failed')).toBe('failed')
    expect(codeAgentRunStatusFromWorkerStatus('waiting_for_human')).toBe('failed')
  })
})
