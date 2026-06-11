import { describe, expect, test } from 'bun:test'
import { projectWorkerRuntimeResultTransition } from '../apps/server/src/services/worker-runtime/worker-runtime-result-transition'

describe('worker runtime result transitions', () => {
  test('projects completed results to completed task and released lease', () => {
    expect(projectWorkerRuntimeResultTransition({
      result: { status: 'completed' },
      source: 'worker-runtime.run',
      taskRoomId: 'room-1',
    })).toEqual({
      task: { kind: 'completed' },
      lease: {
        kind: 'release',
        metadata: { resultStatus: 'completed', source: 'worker-runtime.run' },
      },
    })
  })

  test('projects cancelled results with default reason', () => {
    expect(projectWorkerRuntimeResultTransition({
      result: { status: 'cancelled' },
      source: 'worker-runtime.run',
      taskRoomId: 'room-1',
    })).toEqual({
      task: { kind: 'cancelled', reason: 'worker-runtime-cancelled' },
      lease: {
        kind: 'release',
        metadata: { resultStatus: 'cancelled', source: 'worker-runtime.run' },
      },
    })
  })

  test('projects waiting_for_human clarification metadata into task and lease transitions', () => {
    expect(projectWorkerRuntimeResultTransition({
      result: {
        status: 'waiting_for_human',
        message: 'Need an answer',
        metadata: {
          clarificationId: 'clarification-1',
          clarificationQuestion: 'Which path?',
        },
      },
      source: 'worker-runtime.resume',
      taskRoomId: 'room-1',
    })).toEqual({
      task: {
        kind: 'waiting_for_human',
        clarificationId: 'clarification-1',
        clarificationQuestion: 'Which path?',
      },
      lease: {
        kind: 'waiting_for_human',
        message: 'Which path?',
        metadata: {
          resultStatus: 'waiting_for_human',
          clarificationId: 'clarification-1',
          clarificationQuestion: 'Which path?',
          taskRoomId: 'room-1',
          source: 'worker-runtime.resume',
        },
      },
    })
  })

  test('projects failed results with default error', () => {
    expect(projectWorkerRuntimeResultTransition({
      result: { status: 'failed' },
      source: 'worker-runtime.run',
      taskRoomId: 'room-1',
    })).toEqual({
      task: { kind: 'failed', error: 'WorkerRuntime failed.' },
      lease: {
        kind: 'fail',
        error: 'WorkerRuntime failed.',
        metadata: { resultStatus: 'failed', source: 'worker-runtime.run' },
      },
    })
  })
})
