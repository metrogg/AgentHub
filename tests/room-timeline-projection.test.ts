import { describe, expect, test } from 'bun:test'
import { MessageType, SenderType } from '../packages/shared/src/index'
import type { Room, RoomParticipant, TimelineEvent } from '../apps/web/src/lib/api'
import { projectRoomTimeline } from '../apps/web/src/lib/roomTimeline'

const room: Room = {
  id: 'room-1',
  provider: 'matrix',
  providerRoomId: '!room-1:test.agenthub',
  kind: 'task',
  ownerId: 'user-1',
  workspaceId: 'workspace-1',
  sessionId: 'child-session-1',
  runId: 'run-1',
  taskId: 'task-1',
  taskThreadId: 'thread-1',
  title: '任务：生成报告',
  topic: null,
  status: 'active',
  metadata: {},
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
}

const worker: RoomParticipant = {
  id: 'participant-worker-1',
  roomId: 'room-1',
  providerUserId: '@worker-builder:local.agenthub',
  participantType: 'worker',
  userId: null,
  workspaceAgentId: 'agent-1',
  workerInstanceId: 'worker-instance-1',
  displayName: 'Builder',
  role: 'member',
  status: 'joined',
  metadata: {},
  joinedAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
}

function event(partial: Partial<TimelineEvent> & Pick<TimelineEvent, 'id' | 'type' | 'sequence'>): TimelineEvent {
  return {
    roomId: 'room-1',
    providerEventId: `$${partial.id}`,
    senderParticipantId: 'participant-worker-1',
    senderType: 'worker',
    body: '',
    metadata: {},
    createdAt: '2026-06-04T00:00:00.000Z',
    ...partial,
  }
}

describe('room timeline projection', () => {
  test('projects manager/worker timeline into visible messages and task board events', () => {
    const projection = projectRoomTimeline({
      room,
      participants: [worker],
      sessionId: 'child-session-1',
      timeline: [
        event({
          id: 'event-1',
          type: 'task.progress',
          sequence: 1,
          body: 'Builder 已接单。',
          metadata: {
            workspaceAgentId: 'agent-1',
            workerInstanceId: 'worker-instance-1',
            runtimeType: 'opencode',
            progressPercent: 20,
          },
        }),
        event({
          id: 'event-2',
          type: 'artifact.created',
          sequence: 2,
          body: 'report.html',
          metadata: {
            artifactId: 'artifact-1',
            workspaceAgentId: 'agent-1',
            artifact: {
              id: 'artifact-1',
              title: 'report.html',
              objectKey: 'runs/run-1/tasks/task-1/report.html',
              storageProvider: 'filesystem',
              bucket: 'agenthub-artifacts',
              storagePath: 'C:/Users/wzd/AppData/Local/AgentHub/storage/objects/report.html',
              artifactKind: 'file',
              size: 1024,
              taskId: 'task-1',
              taskThreadId: 'thread-1',
            },
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(2)
    expect(projection.messages[0]?.senderType).toBe(SenderType.Agent)
    expect(projection.messages[0]?.type).toBe(MessageType.Text)
    expect(projection.messages[0]?.metadata?.agentName).toBe('Builder')
    expect(projection.messages[0]?.metadata?.roomTimeline).toMatchObject({
      roomId: 'room-1',
      sequence: 1,
      eventType: 'task.progress',
    })

    expect(projection.events).toHaveLength(2)
    expect(projection.events[0]).toMatchObject({
      type: 'CUSTOM',
      name: 'agenthub.task.status',
      runId: 'run-1',
      threadId: 'child-session-1',
      value: {
        taskId: 'task-1',
        taskThreadId: 'thread-1',
        childSessionId: 'child-session-1',
        status: 'running',
        taskThreadStatus: 'active',
        progressPercent: 20,
      },
    })
    expect(projection.events[1]).toMatchObject({
      name: 'agenthub.artifact.created',
      value: {
        artifactId: 'artifact-1',
        objectKey: 'runs/run-1/tasks/task-1/report.html',
        storageProvider: 'filesystem',
        bucket: 'agenthub-artifacts',
      },
    })
  })

  test('projects worker-runtime.started as an immediate running task state', () => {
    const projection = projectRoomTimeline({
      room,
      participants: [worker],
      sessionId: 'child-session-1',
      timeline: [
        event({
          id: 'event-started',
          type: 'task.progress',
          sequence: 1,
          body: 'Builder 已接单。',
          metadata: {
            kind: 'worker-runtime.started',
            status: 'running',
            taskThreadStatus: 'active',
            progressPercent: 5,
            runId: 'run-1',
            taskId: 'task-1',
            taskThreadId: 'thread-1',
            workspaceAgentId: 'agent-1',
            workerInstanceId: 'worker-instance-1',
            runtimeLeaseId: 'runtime-lease-1',
            runtimeType: 'opencode',
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.content).toBe('Builder 已接单。')
    expect(projection.events).toHaveLength(1)
    expect(projection.events[0]).toMatchObject({
      type: 'CUSTOM',
      name: 'agenthub.task.status',
      runId: 'run-1',
      threadId: 'child-session-1',
      value: {
        taskId: 'task-1',
        taskThreadId: 'thread-1',
        childSessionId: 'child-session-1',
        status: 'running',
        taskThreadStatus: 'active',
        progressPercent: 5,
        workerInstanceId: 'worker-instance-1',
        runtimeLeaseId: 'runtime-lease-1',
        runtimeType: 'opencode',
      },
    })
  })

  test('projects worker clarification requests as a waiting-for-human task state', () => {
    const projection = projectRoomTimeline({
      room,
      participants: [worker],
      sessionId: 'child-session-1',
      timeline: [
        event({
          id: 'event-clarify',
          type: 'approval.requested',
          sequence: 3,
          body: '需要确认报告口径吗？',
          metadata: {
            kind: 'worker-runtime.clarification-requested',
            clarificationId: 'clarification-1',
            workspaceAgentId: 'agent-1',
            workerInstanceId: 'worker-instance-1',
            runtimeType: 'opencode',
            question: '需要确认报告口径吗？',
          },
        }),
        event({
          id: 'event-waiting',
          type: 'task.progress',
          sequence: 4,
          body: '等待用户澄清后继续。',
          metadata: {
            kind: 'worker-runtime.waiting-for-human',
            status: 'waiting_for_human',
            waitingForHuman: true,
            clarificationId: 'clarification-1',
            clarificationQuestion: '需要确认报告口径吗？',
            workspaceAgentId: 'agent-1',
            workerInstanceId: 'worker-instance-1',
            runtimeType: 'opencode',
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(2)
    expect(projection.messages[0]?.content).toBe('需要确认报告口径吗？')
    expect(projection.events).toHaveLength(2)
    expect(projection.events[0]).toMatchObject({
      name: 'agenthub.task.status',
      value: {
        taskId: 'task-1',
        taskThreadId: 'thread-1',
        childSessionId: 'child-session-1',
        status: 'blocked',
        taskThreadStatus: 'waiting_for_human',
        waitingForHuman: true,
        clarificationId: 'clarification-1',
        clarificationQuestion: '需要确认报告口径吗？',
      },
    })
    expect(projection.events[1]).toMatchObject({
      name: 'agenthub.task.status',
      value: {
        status: 'blocked',
        taskThreadStatus: 'waiting_for_human',
        waitingForHuman: true,
        clarificationId: 'clarification-1',
      },
    })
  })

  test('projects dependency waiting and skipped states without pretending the task is running', () => {
    const projection = projectRoomTimeline({
      room,
      participants: [worker],
      sessionId: 'child-session-1',
      timeline: [
        event({
          id: 'event-waiting-dependency',
          type: 'task.progress',
          sequence: 5,
          body: '依赖任务正在等待用户澄清，当前任务暂停分发：upstream-task',
          metadata: {
            kind: 'worker-runtime.waiting-on-human-dependency',
            taskId: 'task-2',
            taskThreadId: 'thread-2',
            waitingTaskIds: ['upstream-task'],
            dependencyTaskIds: ['upstream-task'],
            workspaceAgentId: 'agent-1',
          },
        }),
        event({
          id: 'event-skipped-dependency',
          type: 'task.progress',
          sequence: 6,
          body: '依赖任务未成功完成，跳过执行：upstream-task',
          metadata: {
            kind: 'worker-runtime.skipped-by-dependency',
            taskId: 'task-3',
            taskThreadId: 'thread-3',
            dependencyTaskIds: ['upstream-task'],
            workspaceAgentId: 'agent-1',
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(2)
    expect(projection.events).toHaveLength(2)
    expect(projection.events[0]).toMatchObject({
      name: 'agenthub.task.status',
      value: {
        taskId: 'task-2',
        taskThreadId: 'thread-2',
        status: 'blocked',
        taskThreadStatus: 'waiting_for_human',
        waitingForHuman: true,
      },
    })
    expect(projection.events[1]).toMatchObject({
      name: 'agenthub.task.status',
      value: {
        taskId: 'task-3',
        taskThreadId: 'thread-3',
        status: 'failed',
        taskThreadStatus: 'failed',
      },
    })
  })

  test('projects manager review room events into run status updates', () => {
    const projection = projectRoomTimeline({
      room: {
        ...room,
        kind: 'group',
        sessionId: 'group-session-1',
        taskId: null,
        taskThreadId: null,
      },
      participants: [worker],
      sessionId: 'group-session-1',
      timeline: [
        event({
          id: 'event-review-started',
          type: 'manager.message',
          sequence: 7,
          senderType: 'manager',
          body: 'Manager reviewed 2 terminal task(s).',
          metadata: {
            kind: 'manager-review-started',
            runId: 'run-1',
            status: 'synthesizing',
            taskCount: 2,
            artifactCount: 1,
          },
        }),
        event({
          id: 'event-final-review',
          type: 'manager.message',
          sequence: 8,
          senderType: 'manager',
          body: 'Manager 最终复盘：全部完成。',
          metadata: {
            kind: 'manager-final-review',
            runId: 'run-1',
            finalStatus: 'completed',
            doneCount: 2,
            failedCount: 0,
            cancelledCount: 0,
            blockedCount: 0,
            artifactCount: 1,
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(2)
    expect(projection.events).toHaveLength(2)
    expect(projection.events[0]).toMatchObject({
      name: 'agenthub.run.status',
      runId: 'run-1',
      threadId: 'group-session-1',
      value: {
        status: 'synthesizing',
        taskCount: 2,
        artifactCount: 1,
      },
    })
    expect(projection.events[1]).toMatchObject({
      name: 'agenthub.run.status',
      runId: 'run-1',
      threadId: 'group-session-1',
      value: {
        status: 'completed',
        finalStatus: 'completed',
        doneCount: 2,
        artifactCount: 1,
      },
    })
  })
})
