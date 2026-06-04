import './setup'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const taskThreadApi = await import('../apps/server/src/services/orchestrator/task-thread-service')
const agentRunnerApi = await import('../apps/server/src/services/agent-runner')
const sharedApi = await import('../packages/shared/src/index')

const {
  db,
  orchestratorRuns,
  roomParticipants,
  rooms,
  sessions,
  timelineEvents,
  workerInstances,
  workspaceAgents,
  workspaceTasks,
  workspaces,
  eq,
} = dbApi
const { roomController, roomService } = roomsApi
const { MatrixRoomAdapter } = roomsApi
const { ensureTaskThread } = taskThreadApi
const { cleanupWebSocket, joinRoom } = agentRunnerApi
const { WsEvent } = sharedApi

describe('RoomService local Matrix-compatible adapter', () => {
  test('creates a Matrix-compatible room and appends ordered timeline events', async () => {
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'local-matrix-compatible',
        providerRoomId: '!test-room:local.agenthub',
        kind: 'group',
        ownerId: 'default-user',
        title: 'Test Room',
      })
      .returning()
    expect(room).toBeDefined()

    const participant = await roomService.addParticipant({
      roomId: room!.id,
      participantType: 'human',
      userId: 'default-user',
      displayName: 'You',
      role: 'owner',
    })
    await roomService.appendTimelineEvent({
      roomId: room!.id,
      senderParticipantId: participant.id,
      senderType: 'human',
      type: 'human.message',
      body: '大家好',
    })
    await roomService.appendTimelineEvent({
      roomId: room!.id,
      senderType: 'manager',
      type: 'manager.message',
      body: '我来组织。',
    })

    const events = await roomService.listTimelineEvents({ roomId: room!.id })
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
    expect(events.map((event) => event.type)).toEqual(['human.message', 'manager.message'])
  })

  test('creates a task room and task.assigned timeline event for a task thread', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Room Test Workspace',
        goal: 'Test room kernel',
      })
      .returning()
    const [groupSession] = await db
      .insert(sessions)
      .values({
        title: 'Room Test Group',
        type: 'group',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
      })
      .returning()
    const [childSession] = await db
      .insert(sessions)
      .values({
        title: 'Task Thread',
        type: 'direct',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        metadata: { kind: 'orchestrator-task' },
      })
      .returning()
    const [run] = await db
      .insert(orchestratorRuns)
      .values({
        workspaceId: workspace!.id,
        groupSessionId: groupSession!.id,
      })
      .returning()
    const [task] = await db
      .insert(workspaceTasks)
      .values({
        workspaceId: workspace!.id,
        title: 'Research AI tools',
        description: 'Research current AI coding tools',
        runId: run!.id,
        sessionId: childSession!.id,
      })
      .returning()

    const thread = await ensureTaskThread({
      workspaceId: workspace!.id,
      runId: run!.id,
      taskId: task!.id,
      groupSessionId: groupSession!.id,
      sessionId: childSession!.id,
      ownerId: 'default-user',
      taskTitle: task!.title,
      agentName: null,
    })

    const [room] = await db.select().from(rooms).where(eq(rooms.taskThreadId, thread.id)).limit(1)
    expect(room?.kind).toBe('task')
    const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, room!.id))
    expect(participants.map((participant) => participant.participantType).sort()).toEqual(['human', 'manager'])
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room!.id))
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('task.assigned')
    expect(events[0]?.metadata?.kind).toBe('task-thread-prepared')
  })

  test('RoomController reconciles worker participant binding for task rooms', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Room Controller Workspace',
        goal: 'Reconcile task rooms',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Worker One',
        role: 'Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
      })
      .returning()
    const [worker] = await db
      .insert(workerInstances)
      .values({
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        runtimeFamily: 'worker',
        runtimeBase: 'codex',
        modelId: 'test-model',
        observedState: 'ready',
      })
      .returning()
    const [groupSession] = await db
      .insert(sessions)
      .values({
        title: 'Room Controller Group',
        type: 'group',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
      })
      .returning()
    const [childSession] = await db
      .insert(sessions)
      .values({
        title: 'Room Controller Task',
        type: 'direct',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        metadata: { kind: 'orchestrator-task' },
      })
      .returning()
    const [run] = await db
      .insert(orchestratorRuns)
      .values({
        workspaceId: workspace!.id,
        groupSessionId: groupSession!.id,
      })
      .returning()
    const [task] = await db
      .insert(workspaceTasks)
      .values({
        workspaceId: workspace!.id,
        title: 'Reconcile participant',
        description: 'Ensure worker participant is bound to worker instance',
        runId: run!.id,
        sessionId: childSession!.id,
        agentId: agent!.id,
      })
      .returning()

    const thread = await ensureTaskThread({
      workspaceId: workspace!.id,
      runId: run!.id,
      taskId: task!.id,
      groupSessionId: groupSession!.id,
      sessionId: childSession!.id,
      ownerId: 'default-user',
      taskTitle: task!.title,
      workspaceAgentId: agent!.id,
      workerInstanceId: null,
      agentName: agent!.name,
    })

    await db
      .update(workerInstances)
      .set({ observedState: 'ready' })
      .where(eq(workerInstances.id, worker!.id))
    await db
      .update(dbApi.taskThreads)
      .set({ workerInstanceId: worker!.id })
      .where(eq(dbApi.taskThreads.id, thread.id))

    const result = await roomController.reconcileTaskThreadRoom(thread.id, 'default-user')
    expect(result.phase).toBe('task-room')

    const participants = await db.select().from(roomParticipants).where(eq(roomParticipants.roomId, result.roomId))
    const workerParticipant = participants.find((participant) => participant.participantType === 'worker')
    expect(workerParticipant?.workspaceAgentId).toBe(agent!.id)
    expect(workerParticipant?.workerInstanceId).toBe(worker!.id)
  })

  test('broadcasts timeline events to room session subscribers and parent group subscribers', async () => {
    const sentToTaskSession: string[] = []
    const sentToGroupSession: string[] = []
    const taskWs = {
      readyState: 1,
      send: (payload: string) => sentToTaskSession.push(payload),
    } as any
    const groupWs = {
      readyState: 1,
      send: (payload: string) => sentToGroupSession.push(payload),
    } as any

    joinRoom('task-session-realtime', taskWs)
    joinRoom('group-session-realtime', groupWs)
    try {
      await db.insert(sessions).values({
        id: 'group-session-realtime',
        title: 'Realtime Group',
        type: 'group',
        ownerId: 'default-user',
      })
      await db.insert(sessions).values({
        id: 'task-session-realtime',
        title: 'Realtime Task',
        type: 'direct',
        ownerId: 'default-user',
        metadata: { kind: 'orchestrator-task', groupSessionId: 'group-session-realtime' },
      })
      const room = await roomService.createRoom({
        kind: 'task',
        ownerId: 'default-user',
        title: 'Realtime Task Room',
        sessionId: 'task-session-realtime',
        metadata: {
          compatibility: {
            source: 'task_thread',
            groupSessionId: 'group-session-realtime',
          },
        },
      })
      const participant = await roomService.addParticipant({
        roomId: room.id,
        participantType: 'worker',
        displayName: 'Realtime Worker',
        role: 'member',
      })

      await roomService.appendTimelineEvent({
        roomId: room.id,
        senderParticipantId: participant.id,
        senderType: 'worker',
        type: 'task.progress',
        body: 'Worker 正在执行。',
      })

      expect(sentToTaskSession).toHaveLength(1)
      expect(sentToGroupSession).toHaveLength(1)
      const taskPayload = JSON.parse(sentToTaskSession[0]!)
      const groupPayload = JSON.parse(sentToGroupSession[0]!)
      expect(taskPayload.type).toBe(WsEvent.RoomTimelineEvent)
      expect(groupPayload.type).toBe(WsEvent.RoomTimelineEvent)
      expect(taskPayload.payload.sessionId).toBe('task-session-realtime')
      expect(groupPayload.payload.sessionId).toBe('group-session-realtime')
      expect(taskPayload.payload.event.type).toBe('task.progress')
      expect(taskPayload.payload.participants[0].displayName).toBe('Realtime Worker')
    } finally {
      cleanupWebSocket(taskWs)
      cleanupWebSocket(groupWs)
    }
  })

  test('Matrix adapter maps participants to real Matrix user ids without local room simulation', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix Workspace',
        goal: 'Verify Matrix identity mapping',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        id: 'matrix-agent-1',
        workspaceId: workspace!.id,
        name: 'Researcher',
        role: 'Research worker',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
      })
      .returning()
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: '!matrix-room:agenthub.local',
        kind: 'task',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        title: 'Matrix Task Room',
      })
      .returning()
    const adapter = new MatrixRoomAdapter({
      homeserverUrl: 'http://matrix.test',
      accessToken: 'test-token',
      serverName: 'agenthub.local',
      autoInviteParticipants: false,
      autoJoinParticipants: false,
    })

    const human = await adapter.addParticipant({
      roomId: room!.id,
      participantType: 'human',
      userId: 'default-user',
      displayName: 'You',
      role: 'owner',
      metadata: { source: 'test' },
    })
    const manager = await adapter.addParticipant({
      roomId: room!.id,
      participantType: 'manager',
      displayName: 'Manager',
      role: 'manager',
    })
    const worker = await adapter.addParticipant({
      roomId: room!.id,
      participantType: 'worker',
      workspaceAgentId: agent!.id,
      displayName: 'Researcher',
      role: 'member',
    })

    expect(human.providerUserId).toBe('@human-default-user:agenthub.local')
    expect(manager.providerUserId).toBe('@manager-manager:agenthub.local')
    expect(worker.providerUserId).toBe('@worker-matrix-agent-1:agenthub.local')
    expect(human.metadata?.source).toBe('test')
    expect(human.metadata?.matrixMembership?.providerRoomId).toBe('!matrix-room:agenthub.local')
    expect(human.metadata?.matrixMembership?.invited).toBe(false)
  })
})
