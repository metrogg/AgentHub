import { describe, expect, test } from 'bun:test'
import {
  projectWorkerRuntimeArtifactTimelineEvent,
  projectWorkerRuntimeClarificationLeaseWait,
  projectWorkerRuntimeClarificationTimelineEvent,
  projectWorkerRuntimeMessageTimelineEvent,
  projectWorkerRuntimeProgressTimelineEvent,
} from '../apps/server/src/services/worker-runtime/worker-runtime-event-projection'

const base = {
  roomId: 'room-1',
  participantId: 'participant-1',
  workspaceAgentId: 'agent-1',
  workerInstanceId: 'worker-1',
  runtimeLeaseId: 'lease-1',
  runtimeType: 'code-agent',
}

describe('worker runtime event projection', () => {
  test('projects artifact events into artifact.created timeline events', () => {
    expect(projectWorkerRuntimeArtifactTimelineEvent({
      ...base,
      event: {
        type: 'artifact',
        artifact: { id: 'artifact-input', kind: 'file', title: 'result.md', path: 'result.md' },
        status: 'registered',
        message: 'Registered artifact',
        metadata: { storageProvider: 'filesystem' },
      },
      registeredArtifact: { id: 'artifact-db', status: 'verified' },
      canonicalArtifact: { id: 'artifact-db', kind: 'file', title: 'result.md', path: 'result.md' },
    })).toMatchObject({
      type: 'artifact.created',
      body: 'Registered artifact',
      metadata: {
        kind: 'worker-runtime.artifact',
        artifactId: 'artifact-db',
        status: 'registered',
        workspaceAgentId: 'agent-1',
        workerInstanceId: 'worker-1',
        runtimeType: 'code-agent',
        storageProvider: 'filesystem',
      },
    })
  })

  test('projects clarification events into lease wait metadata and approval timeline events', () => {
    const event = {
      type: 'clarification' as const,
      message: 'Need a decision',
      question: 'Which file?',
      options: ['a.ts', 'b.ts'],
      metadata: { reason: 'ambiguous-target' },
    }

    expect(projectWorkerRuntimeClarificationLeaseWait({
      roomId: 'room-1',
      runId: 'run-1',
      taskId: 'task-1',
      event,
      clarificationId: 'clarification-1',
    })).toEqual({
      message: 'Which file?',
      metadata: {
        waitingForHuman: true,
        clarificationId: 'clarification-1',
        question: 'Which file?',
        roomId: 'room-1',
        runId: 'run-1',
        taskId: 'task-1',
      },
    })

    expect(projectWorkerRuntimeClarificationTimelineEvent({
      ...base,
      event,
      clarificationId: 'clarification-1',
    })).toMatchObject({
      type: 'approval.requested',
      body: 'Need a decision',
      metadata: {
        kind: 'worker-runtime.clarification-requested',
        clarificationId: 'clarification-1',
        question: 'Which file?',
        options: ['a.ts', 'b.ts'],
        reason: 'ambiguous-target',
      },
    })
  })

  test('projects message events as hidden worker messages', () => {
    expect(projectWorkerRuntimeMessageTimelineEvent({
      ...base,
      event: { type: 'message', message: 'Internal update' },
    })).toMatchObject({
      type: 'worker.message',
      body: 'Internal update',
      metadata: {
        kind: 'worker-runtime.message',
        hiddenFromChat: true,
      },
    })
  })

  test('projects progress and failed events as hidden task progress', () => {
    expect(projectWorkerRuntimeProgressTimelineEvent({
      ...base,
      event: { type: 'progress', message: 'Halfway', progressPercent: 50 },
    })).toMatchObject({
      type: 'task.progress',
      body: 'Halfway',
      metadata: {
        kind: 'worker-runtime.progress',
        progressPercent: 50,
        hiddenFromChat: true,
      },
    })

    expect(projectWorkerRuntimeProgressTimelineEvent({
      ...base,
      event: { type: 'failed', message: 'Tool failed' },
    })).toMatchObject({
      type: 'task.progress',
      body: 'Tool failed',
      metadata: {
        kind: 'worker-runtime.failed',
        progressPercent: null,
        hiddenFromChat: true,
      },
    })
  })
})
