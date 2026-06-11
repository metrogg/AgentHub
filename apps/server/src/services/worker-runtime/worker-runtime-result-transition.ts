import type { WorkerRuntimeResult } from './types'

export type WorkerRuntimeTaskTransition =
  | { kind: 'completed' }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'waiting_for_human'; clarificationId: string | null; clarificationQuestion: string | null }
  | { kind: 'failed'; error: string }

export type WorkerRuntimeLeaseTransition =
  | {
      kind: 'release'
      metadata: { resultStatus: WorkerRuntimeResult['status']; source: string }
    }
  | {
      kind: 'waiting_for_human'
      message: string | null
      metadata: {
        resultStatus: WorkerRuntimeResult['status']
        clarificationId: string | null
        clarificationQuestion: string | null
        taskRoomId: string
        source: string
      }
    }
  | {
      kind: 'fail'
      error: string
      metadata: { resultStatus: WorkerRuntimeResult['status']; source: string }
    }

export interface WorkerRuntimeResultTransition {
  task: WorkerRuntimeTaskTransition
  lease: WorkerRuntimeLeaseTransition
}

export function projectWorkerRuntimeResultTransition(input: {
  result: Pick<WorkerRuntimeResult, 'status' | 'message' | 'metadata'>
  source: string
  taskRoomId: string
}): WorkerRuntimeResultTransition {
  const metadata = input.result.metadata ?? {}
  const resultStatus = input.result.status
  const source = input.source

  if (resultStatus === 'completed') {
    return {
      task: { kind: 'completed' },
      lease: { kind: 'release', metadata: { resultStatus, source } },
    }
  }

  if (resultStatus === 'cancelled') {
    return {
      task: {
        kind: 'cancelled',
        reason: input.result.message ?? 'worker-runtime-cancelled',
      },
      lease: { kind: 'release', metadata: { resultStatus, source } },
    }
  }

  if (resultStatus === 'waiting_for_human') {
    const clarificationId = readString(metadata.clarificationId)
    const clarificationQuestion =
      readString(metadata.clarificationQuestion) ?? input.result.message ?? null
    return {
      task: {
        kind: 'waiting_for_human',
        clarificationId,
        clarificationQuestion,
      },
      lease: {
        kind: 'waiting_for_human',
        message: clarificationQuestion,
        metadata: {
          resultStatus,
          clarificationId,
          clarificationQuestion,
          taskRoomId: input.taskRoomId,
          source,
        },
      },
    }
  }

  const error = input.result.message ?? 'WorkerRuntime failed.'
  return {
    task: { kind: 'failed', error },
    lease: {
      kind: 'fail',
      error,
      metadata: { resultStatus, source },
    },
  }
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
