import { describe, expect, test } from 'bun:test'
import { projectTimelineMessages } from '../apps/server/src/services/rooms/timeline-message-projection'

const directRoom = {
  id: 'direct-room-1',
  provider: 'matrix',
  providerRoomId: '!direct:test',
  kind: 'direct',
  ownerId: 'user-1',
  workspaceId: null,
  sessionId: 'direct-session-1',
  runId: null,
  taskId: null,
  taskThreadId: null,
  title: 'Direct Builder',
  topic: null,
  status: 'active',
  metadata: {},
  createdAt: new Date('2026-06-04T00:00:00.000Z'),
  updatedAt: new Date('2026-06-04T00:00:00.000Z'),
} as const

const worker = {
  id: 'participant-worker-1',
  roomId: 'direct-room-1',
  providerUserId: '@worker-builder:agenthub.local',
  participantType: 'worker',
  userId: null,
  workspaceAgentId: 'agent-1',
  workerInstanceId: 'worker-instance-1',
  displayName: 'Builder',
  role: 'member',
  status: 'joined',
  metadata: {},
  joinedAt: new Date('2026-06-04T00:00:00.000Z'),
  updatedAt: new Date('2026-06-04T00:00:00.000Z'),
} as const

function event(partial: Record<string, unknown>) {
  return {
    id: 'event-1',
    roomId: 'direct-room-1',
    providerEventId: '$event-1',
    senderParticipantId: 'participant-worker-1',
    senderType: 'worker',
    type: 'task.progress',
    body: '',
    metadata: {},
    sequence: 1,
    createdAt: new Date('2026-06-04T00:00:00.000Z'),
    ...partial,
  } as any
}

describe('server room timeline message projection', () => {
  test('hides direct room running worker runtime status events, including old unmarked events', () => {
    const messages = projectTimelineMessages({
      room: directRoom as any,
      participants: [worker as any],
      sessionId: 'direct-session-1',
      timeline: [
        event({
          id: 'event-started',
          providerEventId: '$event-started',
          sequence: 1,
          body: 'Builder started claude-code runtime.',
          metadata: {
            kind: 'worker-runtime.started',
            status: 'running',
            runtimeType: 'claude-code',
            workspaceAgentId: 'agent-1',
          },
        }),
        event({
          id: 'event-progress',
          providerEventId: '$event-progress',
          sequence: 2,
          body: 'Builder started claude-code runtime.',
          metadata: {
            kind: 'worker-runtime.progress',
            runtimeType: 'claude-code',
            workspaceAgentId: 'agent-1',
          },
        }),
        event({
          id: 'event-failed',
          providerEventId: '$event-failed',
          type: 'worker.message',
          sequence: 3,
          body: 'Claude Code API connection failed.',
          metadata: {
            kind: 'worker-runtime.failed',
            status: 'failed',
            runtimeType: 'claude-code',
            workspaceAgentId: 'agent-1',
          },
        }),
      ],
    })

    expect(messages.map((message) => message.id)).toEqual(['room:event-failed'])
    expect(messages[0]?.metadata?.codeAgentRun).toMatchObject({
      type: 'code-agent-run',
      status: 'failed',
      runtime: 'claude-code',
    })
  })
})
