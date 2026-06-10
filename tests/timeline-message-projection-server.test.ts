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

const manager = {
  id: 'participant-manager-1',
  roomId: 'direct-room-1',
  providerUserId: '@manager:agenthub.local',
  participantType: 'manager',
  userId: null,
  workspaceAgentId: null,
  workerInstanceId: null,
  displayName: 'Manager',
  role: 'manager',
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
  test('collapses consecutive manager partial messages with the same trace into one bubble', () => {
    const messages = projectTimelineMessages({
      room: directRoom as any,
      participants: [manager as any],
      sessionId: 'direct-session-1',
      timeline: [
        event({
          id: 'manager-partial-1',
          providerEventId: '$manager-partial-1',
          type: 'manager.message',
          sequence: 1,
          senderParticipantId: 'participant-manager-1',
          senderType: 'manager',
          body: 'Thinking',
          metadata: {
            kind: 'manager-runtime.room_message',
            traceId: 'trace-1',
            messageType: 'reply',
          },
        }),
        event({
          id: 'manager-partial-2',
          providerEventId: '$manager-partial-2',
          type: 'manager.message',
          sequence: 2,
          senderParticipantId: 'participant-manager-1',
          senderType: 'manager',
          body: 'Thinking through the plan',
          metadata: {
            kind: 'manager-runtime.room_message',
            traceId: 'trace-1',
            messageType: 'reply',
          },
        }),
      ],
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe('room:manager-partial-1')
    expect(messages[0]?.content).toBe('Thinking through the plan')
    expect(messages[0]?.metadata?.roomTimeline).toMatchObject({
      eventId: 'manager-partial-2',
      eventType: 'manager.message',
    })
    expect(messages[0]?.metadata?.roomTimelineStream).toMatchObject({
      traceId: 'trace-1',
      senderParticipantId: 'participant-manager-1',
      eventIds: ['manager-partial-1', 'manager-partial-2'],
    })
  })

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

  test('restores worker runtime cards from Matrix imported sourceKind metadata', () => {
    const messages = projectTimelineMessages({
      room: directRoom as any,
      participants: [worker as any],
      sessionId: 'direct-session-1',
      timeline: [
        event({
          id: 'matrix-started',
          providerEventId: '$matrix-started',
          sequence: 1,
          body: 'Builder started claude-code runtime.',
          metadata: {
            kind: 'matrix.sync.imported',
            sourceKind: 'worker-runtime.started',
            status: 'running',
            runtimeType: 'claude-code',
            workspaceAgentId: 'agent-1',
          },
        }),
        event({
          id: 'matrix-progress',
          providerEventId: '$matrix-progress',
          sequence: 2,
          body: 'Worker runtime metadata updated.',
          metadata: {
            kind: 'matrix.sync.imported',
            sourceKind: 'worker-runtime.progress',
            status: 'running',
            runtimeType: 'claude-code',
            workspaceAgentId: 'agent-1',
          },
        }),
        event({
          id: 'matrix-failed',
          providerEventId: '$matrix-failed',
          type: 'worker.message',
          sequence: 3,
          body: 'Claude Code API connection failed.',
          metadata: {
            kind: 'matrix.sync.imported',
            sourceKind: 'worker-runtime.failed',
            status: 'failed',
            runtimeType: 'claude-code',
            workspaceAgentId: 'agent-1',
          },
        }),
      ],
    })

    expect(messages.map((message) => message.id)).toEqual(['room:matrix-failed'])
    expect(messages[0]?.metadata?.codeAgentRun).toMatchObject({
      type: 'code-agent-run',
      status: 'failed',
      runtime: 'claude-code',
    })
  })

  test('projects manager runtime errors as visible manager messages', () => {
    const messages = projectTimelineMessages({
      room: directRoom as any,
      participants: [manager as any],
      sessionId: 'direct-session-1',
      timeline: [
        event({
          id: 'manager-error',
          providerEventId: '$manager-error',
          type: 'manager.message',
          sequence: 1,
          senderParticipantId: 'participant-manager-1',
          senderType: 'manager',
          body: 'Manager Runtime failed: provider rejected the request schema',
          metadata: {
            kind: 'manager-runtime.error',
            status: 'failed',
            runtimeType: 'openclaw',
            hiddenFromChat: false,
            skipAutoDispatch: true,
            uiPresentation: 'message',
            messageType: 'text',
          },
        }),
      ],
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe('room:manager-error')
    expect(messages[0]?.senderType).toBe('agent')
    expect(messages[0]?.content).toContain('provider rejected the request schema')
    expect(messages[0]?.metadata).toMatchObject({
      kind: 'manager-runtime.error',
      status: 'failed',
      senderName: 'Manager',
    })
  })

  test('keeps manager startup diagnostics out of the main chat projection', () => {
    const messages = projectTimelineMessages({
      room: directRoom as any,
      participants: [],
      sessionId: 'direct-session-1',
      timeline: [
        event({
          id: 'manager-diagnostic',
          providerEventId: '$manager-diagnostic',
          type: 'system',
          sequence: 1,
          senderParticipantId: null,
          senderType: 'system',
          body: 'Manager is starting and will reply after joining this room.',
          metadata: {
            kind: 'manager.dispatch.diagnostic',
            reason: 'resident-manager-started',
            hiddenFromChat: false,
            skipAutoDispatch: true,
            uiPresentation: 'message',
            messageType: 'text',
          },
        }),
      ],
    })

    expect(messages).toHaveLength(0)
  })

  test('projects manager failure diagnostics as visible system messages', () => {
    const messages = projectTimelineMessages({
      room: directRoom as any,
      participants: [],
      sessionId: 'direct-session-1',
      timeline: [
        event({
          id: 'manager-diagnostic',
          providerEventId: '$manager-diagnostic',
          type: 'system',
          sequence: 1,
          senderParticipantId: null,
          senderType: 'system',
          body: 'Manager failed to start.',
          metadata: {
            kind: 'manager.dispatch.diagnostic',
            reason: 'resident-manager-start-failed',
            hiddenFromChat: false,
            skipAutoDispatch: true,
            uiPresentation: 'message',
            messageType: 'text',
          },
        }),
      ],
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe('room:manager-diagnostic')
    expect(messages[0]?.senderType).toBe('system')
    expect(messages[0]?.content).toContain('Manager failed')
    expect(messages[0]?.metadata).toMatchObject({
      kind: 'manager.dispatch.diagnostic',
      reason: 'resident-manager-start-failed',
    })
  })
})
