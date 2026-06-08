import { describe, expect, test } from 'bun:test'
import { MessageType, SenderType } from '../packages/shared/src/index'
import type { Room, RoomParticipant, TimelineEvent } from '../apps/web/src/lib/api'
import { codeAgentRunFromWorkerRuntimeEvent, projectRoomTimeline } from '../apps/web/src/lib/roomTimeline'

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
  title: 'Task: Generate report',
  topic: null,
  status: 'active',
  metadata: {},
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
}

const directRoom: Room = {
  ...room,
  id: 'direct-room-1',
  kind: 'direct',
  sessionId: 'direct-session-1',
  runId: null,
  taskId: null,
  taskThreadId: null,
  title: 'Direct Builder',
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

const manager: RoomParticipant = {
  id: 'participant-manager-1',
  roomId: 'room-1',
  providerUserId: '@manager:local.agenthub',
  participantType: 'manager',
  userId: null,
  workspaceAgentId: null,
  workerInstanceId: null,
  displayName: 'Manager',
  role: 'manager',
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
  test('collapses consecutive manager partial messages with the same trace into one bubble', () => {
    const projection = projectRoomTimeline({
      room,
      participants: [manager],
      sessionId: 'child-session-1',
      timeline: [
        event({
          id: 'manager-partial-1',
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

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.id).toBe('room:manager-partial-1')
    expect(projection.messages[0]?.content).toBe('Thinking through the plan')
    expect(projection.messages[0]?.metadata?.roomTimeline).toMatchObject({
      eventId: 'manager-partial-2',
      eventType: 'manager.message',
    })
    expect(projection.messages[0]?.metadata?.roomTimelineStream).toMatchObject({
      traceId: 'trace-1',
      senderParticipantId: 'participant-manager-1',
      eventIds: ['manager-partial-1', 'manager-partial-2'],
    })
  })

  test('does not collapse same-trace messages across a visible boundary', () => {
    const projection = projectRoomTimeline({
      room,
      participants: [manager],
      sessionId: 'child-session-1',
      timeline: [
        event({
          id: 'manager-partial-1',
          type: 'manager.message',
          sequence: 1,
          senderParticipantId: 'participant-manager-1',
          senderType: 'manager',
          body: 'First',
          metadata: {
            kind: 'manager-runtime.room_message',
            traceId: 'trace-2',
            messageType: 'reply',
          },
        }),
        event({
          id: 'human-message',
          type: 'human.message',
          sequence: 2,
          senderParticipantId: null,
          senderType: 'human',
          body: 'Interrupt',
          metadata: {},
        }),
        event({
          id: 'manager-partial-2',
          type: 'manager.message',
          sequence: 3,
          senderParticipantId: 'participant-manager-1',
          senderType: 'manager',
          body: 'Second',
          metadata: {
            kind: 'manager-runtime.room_message',
            traceId: 'trace-2',
            messageType: 'reply',
          },
        }),
      ],
    })

    expect(projection.messages.map((message) => message.id)).toEqual([
      'room:manager-partial-1',
      'room:human-message',
      'room:manager-partial-2',
    ])
  })

  test('projects direct room final worker runtime events as code-agent cards and hides live metadata', () => {
    const liveMetadataEvent = event({
      id: 'event-live-metadata',
      type: 'task.progress',
      sequence: 2,
      body: 'Worker runtime metadata updated.',
      metadata: {
        kind: 'worker-runtime.progress',
        hiddenFromChat: true,
        type: 'code-agent-run',
        status: 'running',
        runtime: 'opencode',
        command: 'opencode run',
        durationMs: 20,
        exitCode: 0,
        commands: [{ id: 'cmd-1', command: 'bun test' }],
        files: [{ path: 'src/app.ts', status: 'modified' }],
        steps: [{ id: 'step-1', kind: 'command', status: 'running', title: 'Run tests' }],
      },
    })
    const liveRun = codeAgentRunFromWorkerRuntimeEvent(liveMetadataEvent)
    expect(liveRun).toMatchObject({
      type: 'code-agent-run',
      status: 'running',
      runtime: 'opencode',
      command: 'opencode run',
    })

    const projection = projectRoomTimeline({
      room: directRoom,
      participants: [worker],
      sessionId: 'direct-session-1',
      timeline: [
        event({
          id: 'event-started',
          type: 'task.progress',
          sequence: 1,
          body: 'Direct Builder started opencode runtime.',
          metadata: {
            kind: 'worker-runtime.started',
            status: 'running',
            runtimeType: 'opencode',
            workspaceAgentId: 'agent-1',
          },
        }),
        liveMetadataEvent,
        event({
          id: 'event-completed',
          type: 'worker.message',
          sequence: 3,
          body: 'done',
          metadata: {
            kind: 'worker-runtime.completed',
            status: 'completed',
            runtimeType: 'opencode',
            workspaceAgentId: 'agent-1',
            codeAgentRun: {
              ...liveRun,
              status: 'completed',
              finalMessage: 'done',
            },
          },
        }),
      ],
    })

    expect(projection.messages.map((message) => message.id)).toEqual(['room:event-completed'])
    expect(projection.messages[0]?.metadata?.codeAgentRun).toMatchObject({
      type: 'code-agent-run',
      status: 'completed',
      runtime: 'opencode',
      command: 'opencode run',
      finalMessage: 'done',
    })
  })

  test('projects task room code-agent process metadata without live metadata bubbles', () => {
    const liveMetadataEvent = event({
      id: 'task-live-metadata',
      type: 'task.progress',
      sequence: 1,
      body: 'Worker runtime metadata updated.',
      metadata: {
        kind: 'worker-runtime.progress',
        hiddenFromChat: true,
        type: 'code-agent-run',
        status: 'running',
        runtime: 'claude-code',
        command: 'claude --print',
        durationMs: 50,
        exitCode: 0,
        commands: [{ id: 'cmd-1', command: 'bun run build' }],
        files: [{ path: 'index.html', status: 'modified', diff: '@@ -1 +1 @@\n-old\n+new' }],
        artifacts: [
          {
            id: 'preview:index.html',
            type: 'preview',
            title: 'Preview: index.html',
            url: 'file:///F:/demo/index.html',
            previewKind: 'static-html',
          },
        ],
        logs: [{ id: 'log-1', stream: 'stdout', text: 'Published index.html' }],
        steps: [{ id: 'step-1', kind: 'file', status: 'completed', title: 'Updated index.html' }],
      },
    })
    const liveRun = codeAgentRunFromWorkerRuntimeEvent(liveMetadataEvent)
    expect(liveRun).toMatchObject({
      type: 'code-agent-run',
      status: 'running',
      runtime: 'claude-code',
      command: 'claude --print',
    })
    expect(liveRun?.files).toHaveLength(1)
    expect(liveRun?.artifacts).toHaveLength(1)

    const projection = projectRoomTimeline({
      room,
      participants: [worker],
      sessionId: 'child-session-1',
      timeline: [
        liveMetadataEvent,
        event({
          id: 'task-completed',
          type: 'worker.message',
          sequence: 2,
          body: 'Page completed.',
          metadata: {
            kind: 'worker-runtime.completed',
            status: 'completed',
            runtimeType: 'claude-code',
            workspaceAgentId: 'agent-1',
            codeAgentRun: {
              ...liveRun,
              status: 'completed',
              finalMessage: 'Page completed.',
            },
          },
        }),
      ],
    })

    expect(projection.messages.map((message) => message.id)).toEqual(['room:task-completed'])
    expect(projection.messages[0]?.metadata?.codeAgentRun).toMatchObject({
      type: 'code-agent-run',
      status: 'completed',
      runtime: 'claude-code',
      files: [{ path: 'index.html', status: 'modified' }],
      artifacts: [{ id: 'preview:index.html', type: 'preview' }],
      logs: [{ id: 'log-1', stream: 'stdout' }],
    })
  })

  test('merges final empty worker runtime card into the streamed text bubble', () => {
    const projection = projectRoomTimeline({
      room,
      participants: [worker],
      sessionId: 'child-session-1',
      timeline: [
        event({
          id: 'worker-output',
          type: 'worker.message',
          sequence: 1,
          body: 'Page enhanced with animated numbers and theme switching.',
          metadata: {
            kind: 'worker-runtime.message',
            traceId: 'runtime-started-1',
            senderParticipantId: 'participant-worker-1',
            workspaceAgentId: 'agent-1',
            runtimeType: 'claude-code',
          },
        }),
        event({
          id: 'worker-completed',
          type: 'worker.message',
          sequence: 2,
          body: '',
          metadata: {
            kind: 'worker-runtime.completed',
            status: 'completed',
            traceId: 'runtime-started-1',
            senderParticipantId: 'participant-worker-1',
            workspaceAgentId: 'agent-1',
            runtimeType: 'claude-code',
            codeAgentRun: {
              type: 'code-agent-run',
              status: 'completed',
              runtime: 'claude-code',
              command: 'claude --print',
              cwd: 'C:\\Users\\Mozero\\AppData\\Local\\AgentHub\\workspaces\\2026-06-06-task-1',
              durationMs: 21000,
              exitCode: 0,
              commands: [],
              files: [{ path: 'index.html', status: 'modified' }],
              toolCalls: [],
              artifacts: [],
              steps: [{ id: 'step-1', kind: 'file', status: 'completed', title: 'Updated index.html' }],
            },
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.id).toBe('room:worker-output')
    expect(projection.messages[0]?.content).toBe('Page enhanced with animated numbers and theme switching.')
    expect(projection.messages[0]?.metadata?.codeAgentRun).toMatchObject({
      type: 'code-agent-run',
      status: 'completed',
      runtime: 'claude-code',
      files: [{ path: 'index.html', status: 'modified' }],
    })
    expect(projection.messages[0]?.metadata?.roomTimelineStream).toMatchObject({
      traceId: 'runtime-started-1',
      eventIds: ['worker-output', 'worker-completed'],
    })
  })

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
          body: 'Builder accepted the task.',
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

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.senderType).toBe(SenderType.Agent)
    expect(projection.messages[0]?.type).toBe(MessageType.Text)
    expect(projection.messages[0]?.metadata?.agentName).toBe('Builder')
    expect(projection.messages[0]?.metadata?.roomTimeline).toMatchObject({
      roomId: 'room-1',
      sequence: 2,
      eventType: 'artifact.created',
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
          body: 'Builder accepted the task.',
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

    expect(projection.messages).toHaveLength(0)
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
          body: 'Please confirm the report path.',
          metadata: {
            kind: 'worker-runtime.clarification-requested',
            clarificationId: 'clarification-1',
            workspaceAgentId: 'agent-1',
            workerInstanceId: 'worker-instance-1',
            runtimeType: 'opencode',
            question: 'Please confirm the report path.',
          },
        }),
        event({
          id: 'event-waiting',
          type: 'task.progress',
          sequence: 4,
          body: 'Waiting for human clarification before continuing.',
          metadata: {
            kind: 'worker-runtime.waiting-for-human',
            status: 'waiting_for_human',
            waitingForHuman: true,
            clarificationId: 'clarification-1',
            clarificationQuestion: 'Please confirm the report path.',
            workspaceAgentId: 'agent-1',
            workerInstanceId: 'worker-instance-1',
            runtimeType: 'opencode',
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.content).toBe('Please confirm the report path.')
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
        clarificationQuestion: 'Please confirm the report path.',
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

  test('merges member proposal update controls into the original approval card', () => {
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
          id: 'event-proposal',
          type: 'approval.requested',
          sequence: 1,
          senderType: 'manager',
          body: 'I suggest adding more suitable members. Please confirm.',
          metadata: {
            kind: 'coordinator.action',
            actionType: 'propose_members',
            memberProposalStatus: 'pending',
            memberProposals: [
              {
                profileId: 'frontend-engineer',
                name: 'Frontend Engineer',
                reason: 'Frontend implementation capacity is needed.',
              },
            ],
          },
        }),
        event({
          id: 'event-proposal-update',
          type: 'system',
          sequence: 2,
          senderType: 'manager',
          body: 'Added: Frontend Engineer. Manager can now re-plan and assign tasks.',
          metadata: {
            kind: 'member-proposal.update',
            targetEventId: 'event-proposal',
            content: 'Added: Frontend Engineer. Manager can now re-plan and assign tasks.',
            patch: {
              memberProposalStatus: 'confirmed',
              confirmedProfileIds: ['frontend-engineer'],
              createdAgentIds: ['agent-new'],
            },
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.id).toBe('room:event-proposal')
    expect(projection.messages[0]?.content).toBe('Added: Frontend Engineer. Manager can now re-plan and assign tasks.')
    expect(projection.messages[0]?.metadata).toMatchObject({
      actionType: 'propose_members',
      memberProposalStatus: 'confirmed',
      confirmedProfileIds: ['frontend-engineer'],
      createdAgentIds: ['agent-new'],
      roomTimelineMemberProposalUpdate: {
        source: 'room-timeline-control',
        targetMessageId: 'room:event-proposal',
      },
    })
  })

  test('projects Controller approval requests as Room-native confirmation messages', () => {
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
          id: 'event-controller-approval',
          type: 'approval.requested',
          sequence: 1,
          senderType: 'manager',
          body: '',
          metadata: {
            kind: 'controller.apply.approval.requested',
            actionType: 'controller_apply',
            status: 'pending',
            summary: [
              {
                kind: 'Worker',
                name: 'Builder',
                operationId: 'workers.create',
                danger: 'write',
                approval: 'recommended',
              },
            ],
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.id).toBe('room:event-controller-approval')
    expect(projection.messages[0]?.content).toBe('需要确认 Controller 变更。')
    expect(projection.messages[0]?.metadata).toMatchObject({
      kind: 'controller.apply.approval.requested',
      actionType: 'controller_apply',
      status: 'pending',
      roomTimeline: {
        eventId: 'event-controller-approval',
        eventType: 'approval.requested',
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
          body: 'Dependency task is waiting for human clarification; dispatch paused: upstream-task',
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
          body: 'Dependency task did not complete successfully; skipped execution: upstream-task',
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

    expect(projection.messages).toHaveLength(0)
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
          body: 'Manager final review: all tasks completed.',
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

  test('keeps manager slow and timeout status out of the main chat projection', () => {
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
          id: 'event-pending',
          type: 'manager.message',
          sequence: 1,
          senderType: 'manager',
          body: 'Manager received the message and is processing...',
          metadata: {
            kind: 'manager.status.pending',
            sourceEventId: 'source-1',
          },
        }),
        event({
          id: 'event-slow',
          type: 'manager.message',
          sequence: 2,
          senderType: 'manager',
          body: 'Manager is still processing; OpenClaw queue or model response may be slow.',
          metadata: {
            kind: 'manager.status.slow',
            sourceEventId: 'source-1',
          },
        }),
        event({
          id: 'event-timeout',
          type: 'manager.message',
          sequence: 3,
          senderType: 'manager',
          body: 'Manager timed out. Check OpenClaw Manager, Matrix, and model status in Settings.',
          metadata: {
            kind: 'manager.status.timeout',
            sourceEventId: 'source-1',
          },
        }),
      ],
    })

    expect(projection.messages).toHaveLength(0)
    expect(projection.events).toHaveLength(3)
  })

  test('projects manager runtime errors as visible manager messages', () => {
    const projection = projectRoomTimeline({
      room: {
        ...room,
        kind: 'group',
        sessionId: 'group-session-1',
        taskId: null,
        taskThreadId: null,
      },
      participants: [manager],
      sessionId: 'group-session-1',
      timeline: [
        event({
          id: 'manager-error',
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

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.id).toBe('room:manager-error')
    expect(projection.messages[0]?.senderType).toBe(SenderType.Agent)
    expect(projection.messages[0]?.content).toContain('provider rejected the request schema')
    expect(projection.messages[0]?.metadata).toMatchObject({
      kind: 'manager-runtime.error',
      status: 'failed',
      senderName: 'Manager',
    })
  })

  test('keeps manager startup diagnostics out of the main chat projection', () => {
    const projection = projectRoomTimeline({
      room: {
        ...room,
        kind: 'group',
        sessionId: 'group-session-1',
        taskId: null,
        taskThreadId: null,
      },
      participants: [],
      sessionId: 'group-session-1',
      timeline: [
        event({
          id: 'manager-diagnostic',
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

    expect(projection.messages).toHaveLength(0)
  })

  test('projects manager failure diagnostics as visible system messages', () => {
    const projection = projectRoomTimeline({
      room: {
        ...room,
        kind: 'group',
        sessionId: 'group-session-1',
        taskId: null,
        taskThreadId: null,
      },
      participants: [],
      sessionId: 'group-session-1',
      timeline: [
        event({
          id: 'manager-diagnostic',
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

    expect(projection.messages).toHaveLength(1)
    expect(projection.messages[0]?.id).toBe('room:manager-diagnostic')
    expect(projection.messages[0]?.senderType).toBe(SenderType.System)
    expect(projection.messages[0]?.content).toContain('Manager failed')
    expect(projection.messages[0]?.metadata).toMatchObject({
      kind: 'manager.dispatch.diagnostic',
      reason: 'resident-manager-start-failed',
    })
  })
})
