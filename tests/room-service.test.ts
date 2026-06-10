import './setup'
import { waitForCondition } from './setup'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const dbApi = await import('../packages/db/src/index')
const roomsApi = await import('../apps/server/src/services/rooms')
const roomBridgeApi = await import('../apps/server/src/services/rooms/room-chat-bridge')
const taskThreadApi = await import('../apps/server/src/services/orchestrator/task-thread-service')
const agentRunnerApi = await import('../apps/server/src/services/agent-runner')
const workerRuntimeApi = await import('../apps/server/src/services/worker-runtime/worker-runtime-service')
const sharedApi = await import('../packages/shared/src/index')

const {
  db,
  matrixIdentities,
  orchestratorRuns,
  roomParticipants,
  rooms,
  sessions,
  timelineEvents,
  workerInstances,
  workspaceAgents,
  workspaceTasks,
  workspaces,
  runtimeLeases,
  artifacts,
  taskClarifications,
  and,
  eq,
} = dbApi
const { roomController, roomService } = roomsApi
const {
  MatrixRoomAdapter,
  MatrixRuntimeListener,
  MatrixRuntimeSupervisor,
  MatrixClient,
  MatrixRoomEventDispatcher,
} = roomsApi
const { appendHumanMessageRoomFirst } = roomBridgeApi
const { ensureTaskThread } = taskThreadApi
const { cleanupWebSocket, joinRoom } = agentRunnerApi
const { workerRuntimeService } = workerRuntimeApi
const { WsEvent } = sharedApi

async function createTaskRoomWithPendingClarification(label: string) {
  const [workspace] = await db
    .insert(workspaces)
    .values({
      ownerId: 'default-user',
      name: `${label} Workspace`,
      goal: 'Resume from Matrix clarification answer',
    })
    .returning()
  const [groupSession] = await db
    .insert(sessions)
    .values({
      title: `${label} Group`,
      type: 'group',
      ownerId: 'default-user',
      workspaceId: workspace!.id,
    })
    .returning()
  const [taskSession] = await db
    .insert(sessions)
    .values({
      title: `${label} Task`,
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
      status: 'running',
    })
    .returning()
  const [agent] = await db
    .insert(workspaceAgents)
    .values({
      workspaceId: workspace!.id,
      name: `${label} Worker`,
      role: 'Worker',
      modelId: 'test-model',
      runtimeType: 'code-agent',
      codeAgentType: 'opencode',
    })
    .returning()
  const [worker] = await db
    .insert(workerInstances)
    .values({
      workspaceId: workspace!.id,
      workspaceAgentId: agent!.id,
      runtimeFamily: 'worker',
      runtimeBase: 'opencode',
      modelId: 'test-model',
      observedState: 'waiting_for_human',
    })
    .returning()
  const [task] = await db
    .insert(workspaceTasks)
    .values({
      workspaceId: workspace!.id,
      runId: run!.id,
      sessionId: taskSession!.id,
      agentId: agent!.id,
      title: `${label} clarification task`,
      description: 'Ask human before continuing',
      status: 'blocked',
    })
    .returning()
  const thread = await ensureTaskThread({
    workspaceId: workspace!.id,
    runId: run!.id,
    taskId: task!.id,
    groupSessionId: groupSession!.id,
    sessionId: taskSession!.id,
    ownerId: 'default-user',
    taskTitle: task!.title,
    workspaceAgentId: agent!.id,
    workerInstanceId: worker!.id,
    agentName: agent!.name,
  })
  const room = await roomController.ensureTaskThreadRoom(thread.id, 'default-user')
  const workerParticipant = await roomService.addWorkerParticipant(room.id, agent!.id)
  const clarificationId = randomUUID()
  await db.insert(taskClarifications).values({
    id: clarificationId,
    runId: run!.id,
    taskId: task!.id,
    agentId: agent!.id,
    question: '是否按当前方案继续？',
    options: ['继续', '停止'],
    status: 'pending',
    createdAt: new Date(),
  })
  await roomService.appendTimelineEvent({
    roomId: room.id,
    senderType: 'worker',
    type: 'approval.requested',
    body: '是否按当前方案继续？',
    metadata: {
      kind: 'worker-runtime.clarification-requested',
      clarificationId,
      question: '是否按当前方案继续？',
      workspaceAgentId: agent!.id,
    },
  })
  return { room, agent: agent!, workerParticipant, clarificationId }
}

describe('RoomService Matrix room adapter contract', () => {
  test('maps text @orchestrator mention to the real Manager room participant without frontend metadata', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Manager Mention Workspace',
        goal: 'Verify Manager mentions',
      })
      .returning()
    const [session] = await db
      .insert(sessions)
      .values({
        title: 'Manager Mention Group',
        type: 'group',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
      })
      .returning()
    await db.insert(workspaceAgents).values({
      workspaceId: workspace!.id,
      name: 'Orchestrator / Team Builder',
      role: '群聊总指挥',
      modelId: 'test-model',
      runtimeType: 'code-agent',
      codeAgentType: 'claude-code',
      roleType: 'orchestrator',
    })

    const { room, event } = await appendHumanMessageRoomFirst({
      session: session!,
      userId: 'default-user',
      userName: 'Tester',
      content: '@Orchestrator / Team Builder 你在吗',
      type: 'text',
      metadata: {},
      skipDispatch: true,
    })

    const [managerParticipant] = await db
      .select()
      .from(roomParticipants)
      .where(and(eq(roomParticipants.roomId, room.id), eq(roomParticipants.participantType, 'manager')))
      .limit(1)
    expect(managerParticipant).toBeDefined()
    expect(event.metadata?.matrix?.mentionedParticipantIds).toEqual([managerParticipant!.id])
  })

  test('creates a Matrix-compatible room and appends ordered timeline events', async () => {
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: '!test-room:test.agenthub',
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
      metadata: { skipAutoDispatch: true },
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

  test('allocates unique timeline sequences under concurrent room imports', async () => {
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: '!concurrent-room:test.agenthub',
        kind: 'group',
        ownerId: 'default-user',
        title: 'Concurrent Timeline Room',
      })
      .returning()
    expect(room).toBeDefined()

    await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        roomService.importTimelineEvent({
          roomId: room!.id,
          providerEventId: `$concurrent-${index}`,
          senderType: 'human',
          type: 'human.message',
          body: `hello ${index}`,
          metadata: {
            kind: 'matrix.sync.imported',
          },
        }),
      ),
    )

    const events = await roomService.listTimelineEvents({ roomId: room!.id, limit: 64 })
    const sequences = events.map((event) => event.sequence)
    expect(events).toHaveLength(32)
    expect(new Set(sequences).size).toBe(32)
    expect(sequences).toEqual(Array.from({ length: 32 }, (_, index) => index + 1))
  })

  test('treats replayed Matrix timeline events as idempotent imports', async () => {
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: '!idempotent-room:test.agenthub',
        kind: 'group',
        ownerId: 'default-user',
        title: 'Idempotent Matrix Room',
      })
      .returning()
    expect(room).toBeDefined()

    const first = await roomService.importTimelineEvent({
      roomId: room!.id,
      providerEventId: '$replayed-matrix-event',
      senderType: 'human',
      type: 'human.message',
      body: 'hello once',
      metadata: { matrix: { eventId: '$replayed-matrix-event' } },
    })
    const replayed = await roomService.importTimelineEvent({
      roomId: room!.id,
      providerEventId: '$replayed-matrix-event',
      senderType: 'human',
      type: 'human.message',
      body: 'hello again',
      metadata: { matrix: { eventId: '$replayed-matrix-event' } },
    })

    expect(replayed.id).toBe(first.id)
    expect(replayed.body).toBe('hello once')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room!.id))
    expect(events).toHaveLength(1)
    expect(events[0]!.providerEventId).toBe('$replayed-matrix-event')
  })

  test('routes direct room human messages to Worker runtime using the session agent over stale room metadata', async () => {
    const [oldWorkspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Old Direct Dispatch Workspace',
        goal: 'Old direct workspace',
        projectPath: 'C:/Users/Mozero/AppData/Local/AgentHub/workspaces/2026-06-06-task-1',
      })
      .returning()
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Direct Dispatch Workspace',
        goal: 'Verify direct agent chat dispatch',
        projectPath: 'F:/Before_Work/Agenthubtest/word',
      })
      .returning()
    const [staleAgent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: oldWorkspace!.id,
        name: 'Old Direct Worker',
        role: 'Old worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
      })
      .returning()
    const [currentAgent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Current Direct Worker',
        role: 'Current worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
      })
      .returning()
    const [session] = await db
      .insert(sessions)
      .values({
        title: 'Current Direct Worker',
        type: 'direct',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        workspaceAgentId: currentAgent!.id,
        metadata: { kind: 'agent-direct' },
      })
      .returning()

    const room = await roomService.ensureRoomForSession(session!.id, 'default-user')
    await roomService.addWorkerParticipant(room.id, staleAgent!.id)
    await db
      .update(rooms)
      .set({
        workspaceId: oldWorkspace!.id,
        metadata: {
          ...(room.metadata ?? {}),
          compatibility: {
            source: 'session',
            sessionType: 'direct',
            workspaceAgentId: staleAgent!.id,
          },
        },
      })
      .where(eq(rooms.id, room.id))

    const directCalls: any[] = []
    const originalRunDirectRoom = workerRuntimeService.runDirectRoom
    ;(workerRuntimeService as any).runDirectRoom = async (input: any) => {
      directCalls.push(input)
      return { roomId: input.roomId, appendedEventIds: [] }
    }

    try {
      const { event } = await appendHumanMessageRoomFirst({
        session: session!,
        userId: 'default-user',
        userName: 'Tester',
        content: 'please respond',
        type: 'text',
      })

      await waitForCondition(
        () => directCalls.length,
        (count) => count === 1,
        { description: 'direct room dispatch should run after appending the human timeline event' },
      )
      expect(directCalls).toHaveLength(1)
      expect(directCalls[0]).toMatchObject({
        roomId: room.id,
        ownerId: 'default-user',
        workspaceAgentId: currentAgent!.id,
        prompt: 'please respond',
      })
      expect(directCalls[0].workspaceAgentId).not.toBe(staleAgent!.id)
      expect(event.metadata?.kind).toBe('chat.message')

      const [reloadedRoom] = await db.select().from(rooms).where(eq(rooms.id, room.id)).limit(1)
      expect(reloadedRoom?.workspaceId).toBe(workspace!.id)
      expect(reloadedRoom?.metadata?.compatibility).toMatchObject({
        source: 'session',
        sessionType: 'direct',
        workspaceAgentId: currentAgent!.id,
      })
    } finally {
      ;(workerRuntimeService as any).runDirectRoom = originalRunDirectRoom
    }
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

  test('Matrix adapter ensures real Matrix identities and sends as the participant token', async () => {
    const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const auth = init?.headers
        ? ((init.headers as Record<string, string>).Authorization ?? null)
        : null
      calls.push({ method: init?.method ?? 'GET', path: parsed.pathname, auth, body })
      if (parsed.pathname.endsWith('/register')) {
        const username = body.username
        return Response.json({
          user_id: `@${username}:agenthub.local`,
          access_token: `token-${username}`,
        })
      }
      if (parsed.pathname.includes('/profile/')) return Response.json({})
      if (parsed.pathname.includes('/invite')) return Response.json({})
      if (parsed.pathname.includes('/_matrix/client/v3/join/')) {
        return Response.json({ room_id: '!matrix-room:agenthub.local' })
      }
      if (parsed.pathname.includes('/send/m.room.message/')) {
        return Response.json({ event_id: '$matrix-event-1' })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

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
      accessToken: 'admin-token',
      serverName: 'agenthub.local',
      autoInviteParticipants: true,
      autoJoinParticipants: true,
    })

    try {
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

      await adapter.appendTimelineEvent({
        roomId: room!.id,
        senderParticipantId: worker.id,
        senderType: 'worker',
        type: 'worker.message',
        body: 'Research done',
      })

      expect(human.providerUserId).toBe('@human-default-user:agenthub.local')
      expect(manager.providerUserId).toMatch(/@manager-manager-.*:agenthub\.local/)
      expect(worker.providerUserId).toBe('@worker-matrix-agent-1:agenthub.local')
      expect(human.metadata?.source).toBe('test')
      expect(human.metadata?.matrixMembership?.providerRoomId).toBe('!matrix-room:agenthub.local')
      expect(human.metadata?.matrixMembership?.invited).toBe(true)
      expect(human.metadata?.matrixMembership?.joinedWithParticipantToken).toBe(true)

      const identities = await db.select().from(matrixIdentities)
      const identityUserIds = identities.map((identity) => identity.userId).sort()
      expect(identityUserIds).toContain('@human-default-user:agenthub.local')
      expect(identityUserIds).toContain('@worker-matrix-agent-1:agenthub.local')
      expect(identityUserIds.some((id) => id.match(/@manager-manager-.*:agenthub\.local/))).toBe(true)
      const inviteCalls = calls.filter((call) => call.path.includes('/invite'))
      const joinCalls = calls.filter((call) => call.path.includes('/join/'))
      const sendCall = calls.find((call) => call.path.includes('/send/m.room.message/'))
      expect(inviteCalls[0]?.auth).toBe('Bearer admin-token')
      expect(joinCalls.some((call) => call.auth?.includes('worker-matrix-agent-1'))).toBe(true)
      expect(sendCall?.auth).toContain('Bearer ')

      const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room!.id))
      expect(events[0]?.metadata?.matrix?.usedParticipantToken).toBe(true)
      expect(events[0]?.metadata?.matrix?.senderUserId).toBe('@worker-matrix-agent-1:agenthub.local')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Matrix adapter rejoins a locally joined sender before sending when homeserver membership drifted to leave', async () => {
    const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = []
    const originalFetch = globalThis.fetch
    let joinsBeforeAppend = 0
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const auth = init?.headers
        ? ((init.headers as Record<string, string>).Authorization ?? null)
        : null
      calls.push({ method: init?.method ?? 'GET', path: parsed.pathname, auth, body })
      if (parsed.pathname.endsWith('/register')) {
        const username = body.username
        return Response.json({
          user_id: `@${username}:agenthub.local`,
          access_token: `token-${username}`,
        })
      }
      if (parsed.pathname.includes('/profile/')) return Response.json({})
      if (parsed.pathname.includes('/invite')) return Response.json({})
      if (parsed.pathname.includes('/_matrix/client/v3/join/')) {
        return Response.json({ room_id: '!drift-room:agenthub.local' })
      }
      if (parsed.pathname.includes('/send/m.room.message/')) {
        const joinCalls = calls.filter((call) => call.path.includes('/join/')).length
        if (joinCalls <= joinsBeforeAppend) {
          return Response.json(
            {
              errcode: 'M_FORBIDDEN',
              error: "Auth check failed: sender's membership `leave` is not `join`",
            },
            { status: 403 },
          )
        }
        return Response.json({ event_id: '$drift-event-1' })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix Drift Workspace',
        goal: 'Verify Matrix rejoin before send',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        id: 'matrix-drift-agent-1',
        workspaceId: workspace!.id,
        name: 'Drift Worker',
        role: 'Worker',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
      })
      .returning()
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: '!drift-room:agenthub.local',
        kind: 'direct',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        title: 'Drift Direct Room',
      })
      .returning()
    const adapter = new MatrixRoomAdapter({
      homeserverUrl: 'http://matrix.test',
      accessToken: 'admin-token',
      serverName: 'agenthub.local',
      autoInviteParticipants: true,
      autoJoinParticipants: true,
    })

    try {
      const worker = await adapter.addParticipant({
        roomId: room!.id,
        participantType: 'worker',
        workspaceAgentId: agent!.id,
        displayName: 'Drift Worker',
        role: 'member',
      })
      joinsBeforeAppend = calls.filter((call) => call.path.includes('/join/')).length

      await adapter.appendTimelineEvent({
        roomId: room!.id,
        senderParticipantId: worker.id,
        senderType: 'worker',
        type: 'worker.message',
        body: 'still here',
      })

      const joinCalls = calls.filter((call) => call.path.includes('/join/'))
      const sendCalls = calls.filter((call) => call.path.includes('/send/m.room.message/'))
      expect(joinCalls.length).toBeGreaterThan(joinsBeforeAppend)
      expect(sendCalls).toHaveLength(1)
      expect(sendCalls[0]?.auth).toContain('worker-matrix-drift-agent-1')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Matrix runtime listener imports real room events with mentions and file refs without echoing them', async () => {
    const calls: Array<{ method: string; path: string; auth: string | null }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      const auth = init?.headers
        ? ((init.headers as Record<string, string>).Authorization ?? null)
        : null
      calls.push({ method: init?.method ?? 'GET', path: parsed.pathname, auth })
      if (parsed.pathname.endsWith('/sync')) {
        return Response.json({
          next_batch: 'batch-2',
          rooms: {
            join: {
              '!sync-room:agenthub.local': {
                timeline: {
                  events: [
                    {
                      type: 'm.room.message',
                      event_id: '$human-mention',
                      sender: '@human-default-user:agenthub.local',
                      origin_server_ts: 1,
                      content: {
                        msgtype: 'm.text',
                        body: '@worker-matrix-agent-2:agenthub.local 请看这个文件',
                        format: 'org.matrix.custom.html',
                        formatted_body:
                          '<a href="https://matrix.to/#/@worker-matrix-agent-2:agenthub.local">Researcher</a> 请看这个文件',
                        'm.mentions': {
                          user_ids: ['@worker-matrix-agent-2:agenthub.local'],
                        },
                      },
                    },
                    {
                      type: 'm.room.message',
                      event_id: '$file-ref',
                      sender: '@human-default-user:agenthub.local',
                      origin_server_ts: 2,
                      content: {
                        msgtype: 'm.file',
                        body: 'report.pdf',
                        url: 'mxc://agenthub.local/report',
                        info: { mimetype: 'application/pdf', size: 1234 },
                      },
                    },
                    {
                      type: 'm.room.message',
                      event_id: '$worker-progress',
                      sender: '@worker-matrix-agent-2:agenthub.local',
                      origin_server_ts: 3,
                      content: {
                        msgtype: 'm.text',
                        body: 'Worker runtime metadata updated.',
                        'org.agenthub.metadata': {
                          kind: 'worker-runtime.progress',
                          hiddenFromChat: true,
                          type: 'code-agent-run',
                          status: 'running',
                          runtime: 'opencode',
                          command: 'opencode run',
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix Sync Workspace',
        goal: 'Import Matrix sync events',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        id: 'matrix-agent-2',
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
        providerRoomId: '!sync-room:agenthub.local',
        kind: 'task',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        title: 'Matrix Sync Room',
      })
      .returning()
    await db.insert(roomParticipants).values({
      roomId: room!.id,
      providerUserId: '@worker-matrix-agent-2:agenthub.local',
      participantType: 'worker',
      workspaceAgentId: agent!.id,
      displayName: 'Researcher',
      role: 'member',
    })
    const [identity] = await db
      .insert(matrixIdentities)
      .values({
        ownerType: 'manager',
        ownerId: 'sync-manager',
        serverName: 'agenthub.local',
        localpart: 'manager-sync-manager',
        userId: '@manager-sync-manager:agenthub.local',
        accessToken: 'manager-token',
        password: 'manager-password',
        displayName: 'Manager',
      })
      .returning()

    try {
      const listener = new MatrixRuntimeListener(
        new MatrixClient({
          homeserverUrl: 'http://matrix.test',
          serverName: 'agenthub.local',
          autoInviteParticipants: true,
          autoJoinParticipants: true,
        }),
      )
      const result = await listener.syncOnce({ identityId: identity!.id, dispatch: false })

      expect(result.nextBatch).toBe('batch-2')
      expect(result.importedEventIds).toHaveLength(3)
      expect(result.dispatchedEventIds).toHaveLength(0)
      expect(calls.filter((call) => call.path.includes('/send/m.room.message/'))).toHaveLength(0)
      const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room!.id))
      expect(events.map((event) => event.type)).toEqual(['human.message', 'file.shared', 'worker.message'])
      expect(events[0]?.metadata?.matrix?.mentions).toEqual(['@worker-matrix-agent-2:agenthub.local'])
      expect(events[0]?.metadata?.matrix?.mentionedParticipantIds).toHaveLength(1)
      expect(events[1]?.metadata?.matrix?.file?.url).toBe('mxc://agenthub.local/report')
      expect(events[2]?.metadata).toMatchObject({
        kind: 'matrix.sync.imported',
        sourceKind: 'worker-runtime.progress',
        type: 'code-agent-run',
        status: 'running',
        runtime: 'opencode',
        command: 'opencode run',
        hiddenFromChat: true,
        matrix: {
          importedMetadataKind: 'worker-runtime.progress',
          eventId: '$worker-progress',
        },
      })
      const [updatedIdentity] = await db
        .select()
        .from(matrixIdentities)
        .where(eq(matrixIdentities.id, identity!.id))
        .limit(1)
      expect(updatedIdentity?.metadata?.matrixSync?.nextBatch).toBe('batch-2')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Matrix adapter sends manager assignment as a real Matrix mention', async () => {
    const calls: Array<{ method: string; path: string; auth: string | null; body: any }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const auth = init?.headers
        ? ((init.headers as Record<string, string>).Authorization ?? null)
        : null
      calls.push({ method: init?.method ?? 'GET', path: parsed.pathname, auth, body })
      if (parsed.pathname.endsWith('/register')) {
        const username = body.username
        return Response.json({
          user_id: `@${username}:agenthub.local`,
          access_token: `token-${username}`,
        })
      }
      if (parsed.pathname.includes('/profile/')) return Response.json({})
      if (parsed.pathname.includes('/invite')) return Response.json({})
      if (parsed.pathname.includes('/_matrix/client/v3/join/')) {
        return Response.json({ room_id: '!mention-room:agenthub.local' })
      }
      if (parsed.pathname.includes('/send/m.room.message/')) {
        return Response.json({ event_id: '$matrix-mention-event' })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix Mention Workspace',
        goal: 'Verify mention send',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        id: 'matrix-agent-mention',
        workspaceId: workspace!.id,
        name: 'Mention Worker',
        role: 'Worker',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
      })
      .returning()
    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: '!mention-room:agenthub.local',
        kind: 'task',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        title: 'Matrix Mention Room',
      })
      .returning()
    const adapter = new MatrixRoomAdapter({
      homeserverUrl: 'http://matrix.test',
      accessToken: 'admin-token',
      serverName: 'agenthub.local',
      autoInviteParticipants: true,
      autoJoinParticipants: true,
    })

    try {
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
        displayName: 'Mention Worker',
        role: 'member',
      })

      await adapter.appendMentionTimelineEvent({
        roomId: room!.id,
        senderParticipantId: manager.id,
        senderType: 'manager',
        type: 'task.assigned',
        body: '请接手这个任务',
        mentionParticipantId: worker.id,
        metadata: { kind: 'coordinator.action', actionType: 'assign' },
      })

      const sendCall = calls.find((call) => call.path.includes('/send/m.room.message/'))
      expect(sendCall?.auth).toContain('Bearer ')
      expect(sendCall?.body.body).toContain('@Mention Worker')
      expect(sendCall?.body.body).not.toContain('@worker-matrix-agent-mention:agenthub.local')
      expect(sendCall?.body.formatted_body).toContain('matrix.to/#/@worker-matrix-agent-mention:agenthub.local')
      expect(sendCall?.body['m.mentions'].user_ids).toEqual(['@worker-matrix-agent-mention:agenthub.local'])
      const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room!.id))
      expect(events[0]?.metadata?.matrix?.mentions).toEqual(['@worker-matrix-agent-mention:agenthub.local'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Matrix dispatcher routes human group messages to Manager and worker mentions to Worker runtime', async () => {
    const managerCalls: any[] = []
    const workerCalls: any[] = []
    const dispatcher = new MatrixRoomEventDispatcher({
      stepManagerRoom: async (input: any) => {
        managerCalls.push(input)
      },
      runWorkerTaskRoom: async (input: any) => {
        workerCalls.push(input)
      },
    })

    const groupRoom = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Matrix Dispatcher Group',
    })
    const [groupEvent] = await db
      .insert(timelineEvents)
      .values({
        roomId: groupRoom.id,
        providerEventId: '$dispatcher-human-group',
        senderType: 'human',
        type: 'human.message',
        body: 'Manager，帮我组织一下',
        metadata: {
          kind: 'matrix.sync.imported',
          matrix: {
            eventId: '$dispatcher-human-group',
          },
        },
        sequence: 1,
      })
      .returning()

    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix Dispatch Workspace',
        goal: 'Dispatch mentions',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Worker Mention Target',
        role: 'Worker',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
      })
      .returning()
    const taskRoom = await roomService.createRoom({
      kind: 'task',
      ownerId: 'default-user',
      workspaceId: workspace!.id,
      title: 'Matrix Dispatcher Task',
    })
    const [workerInstance] = await db
      .insert(workerInstances)
      .values({
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        runtimeFamily: 'worker',
        runtimeBase: 'opencode',
        observedState: 'listening',
      })
      .returning()
    const worker = await roomService.addWorkerParticipant(taskRoom.id, agent!.id, workerInstance!.id)
    const [taskEvent] = await db
      .insert(timelineEvents)
      .values({
        roomId: taskRoom.id,
        providerEventId: '$dispatcher-worker-mention',
        senderType: 'human',
        type: 'human.message',
        body: `${worker.providerUserId} 请接单`,
        metadata: {
          kind: 'matrix.sync.imported',
          matrix: {
            eventId: '$dispatcher-worker-mention',
            mentionedParticipantIds: [worker.id],
          },
        },
        sequence: 1,
      })
      .returning()

    const result = await dispatcher.dispatchImportedEvents({
      eventIds: [groupEvent!.id, taskEvent!.id],
    })

    expect(result.dispatchedEventIds).toEqual([groupEvent!.id, taskEvent!.id])
    expect(managerCalls).toEqual([
      {
        roomId: groupRoom.id,
        ownerId: 'default-user',
        afterSequence: 0,
        source: 'matrix-sync',
        sourceEventId: groupEvent!.id,
      },
    ])
    // HiClaw model: Worker picks up @mention via /sync, no platform dispatch
    expect(workerCalls).toEqual([])
  })

  test('Matrix dispatcher replays the triggering human message after resident Manager cold start', async () => {
    const dispatcher = new MatrixRoomEventDispatcher({
      stepManagerRoom: async () => ({
        consumed: false,
        skipped: true,
        reason: 'resident-manager-started',
      }),
    })

    const groupRoom = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Manager Cold Start Replay',
    })
    const human = await roomService.addParticipant({
      roomId: groupRoom.id,
      participantType: 'human',
      displayName: 'You',
      role: 'owner',
    })
    const [groupEvent] = await db
      .insert(timelineEvents)
      .values({
        roomId: groupRoom.id,
        providerEventId: '$dispatcher-manager-cold-start',
        senderParticipantId: human.id,
        senderType: 'human',
        type: 'human.message',
        body: 'Manager, please handle this after startup',
        metadata: {
          kind: 'matrix.sync.imported',
          matrix: {
            eventId: '$dispatcher-manager-cold-start',
          },
        },
        sequence: 1,
      })
      .returning()

    const result = await dispatcher.dispatchImportedEvents({
      eventIds: [groupEvent!.id],
    })

    expect(result.dispatchedEventIds).toEqual([groupEvent!.id])
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, groupRoom.id))
    const replay = events.find((event) => event.metadata?.kind === 'manager.dispatch.startup-replay')
    expect(replay).toMatchObject({
      senderParticipantId: human.id,
      senderType: 'human',
      type: 'human.message',
      body: 'Manager, please handle this after startup',
    })
    expect(replay?.metadata).toMatchObject({
      sourceEventId: groupEvent!.id,
      sourceEventSequence: 1,
      hiddenFromChat: true,
      skipAutoDispatch: true,
    })
    expect(events.some((event) => event.metadata?.kind === 'manager.dispatch.diagnostic')).toBe(false)
  })

  test('Manager recovery scan replays recent unhandled group human messages', async () => {
    const dispatcher = new MatrixRoomEventDispatcher({})
    const groupRoom = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Manager Recovery Replay',
    })
    const human = await roomService.addParticipant({
      roomId: groupRoom.id,
      participantType: 'human',
      displayName: 'You',
      role: 'owner',
    })
    const [groupEvent] = await db
      .insert(timelineEvents)
      .values({
        roomId: groupRoom.id,
        providerEventId: '$manager-recovery-replay',
        senderParticipantId: human.id,
        senderType: 'human',
        type: 'human.message',
        body: 'Handle this after Manager restart',
        metadata: { kind: 'chat.message' },
        sequence: 1,
      })
      .returning()

    const recovered = await dispatcher.recoverRecentUnhandledManagerMessages({
      roomId: groupRoom.id,
      reason: 'test-manager-recovery',
      lookbackMs: 60_000,
      timeoutMs: 60_000,
      replayThrottleMs: 60_000,
    })

    expect(recovered.replayed).toBe(1)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, groupRoom.id))
    const replay = events.find((event) => event.metadata?.kind === 'manager.dispatch.startup-replay')
    expect(replay).toMatchObject({
      senderParticipantId: human.id,
      senderType: 'human',
      type: 'human.message',
      body: 'Handle this after Manager restart',
    })
    expect(replay?.metadata).toMatchObject({
      sourceEventId: groupEvent!.id,
      recoveryReason: 'test-manager-recovery',
      hiddenFromChat: true,
      skipAutoDispatch: true,
    })
  })

  test('Manager recovery scan turns stale pending messages into visible retryable timeout failures', async () => {
    const dispatcher = new MatrixRoomEventDispatcher({})
    const groupRoom = await roomService.createRoom({
      kind: 'group',
      ownerId: 'default-user',
      title: 'Manager Recovery Timeout',
    })
    const human = await roomService.addParticipant({
      roomId: groupRoom.id,
      participantType: 'human',
      displayName: 'You',
      role: 'owner',
    })
    const staleCreatedAt = new Date(Date.now() - 10_000)
    const [groupEvent] = await db
      .insert(timelineEvents)
      .values({
        roomId: groupRoom.id,
        providerEventId: '$manager-recovery-timeout',
        senderParticipantId: human.id,
        senderType: 'human',
        type: 'human.message',
        body: 'This pending message should become failed',
        metadata: { kind: 'chat.message' },
        sequence: 1,
        createdAt: staleCreatedAt,
      })
      .returning()
    await roomService.appendTimelineEvent({
      roomId: groupRoom.id,
      senderType: 'manager',
      type: 'manager.message',
      body: 'Manager pending',
      metadata: {
        kind: 'manager.status.pending',
        sourceEventId: groupEvent!.id,
        hiddenFromChat: true,
        skipAutoDispatch: true,
      },
    })
    await roomService.appendTimelineEvent({
      roomId: groupRoom.id,
      senderParticipantId: human.id,
      senderType: 'human',
      type: 'human.message',
      body: 'A later unrelated user message',
      metadata: { kind: 'chat.message', skipAutoDispatch: true },
    })
    await roomService.appendTimelineEvent({
      roomId: groupRoom.id,
      senderType: 'manager',
      type: 'manager.message',
      body: 'Reply to the later unrelated user message',
      metadata: { kind: 'matrix.sync.imported', skipAutoDispatch: true },
    })

    const recovered = await dispatcher.recoverRecentUnhandledManagerMessages({
      roomId: groupRoom.id,
      reason: 'test-manager-timeout',
      lookbackMs: 60_000,
      timeoutMs: 1,
      replayThrottleMs: 60_000,
    })

    expect(recovered.failed).toBe(1)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, groupRoom.id))
    const failure = events.find((event) => event.metadata?.kind === 'manager.dispatch.timeout')
    expect(failure).toMatchObject({
      senderType: 'system',
      type: 'system',
    })
    expect(failure?.metadata).toMatchObject({
      sourceEventId: groupEvent!.id,
      targetMessageId: `room:${groupEvent!.id}`,
      retryable: true,
      retryAction: 'resend-message',
      hiddenFromChat: false,
    })
    expect(events.some((event) => event.metadata?.kind === 'manager.dispatch.startup-replay')).toBe(false)
  })

  test('Matrix runtime listener can run as a stoppable polling loop', async () => {
    let syncCount = 0
    const loopBatchIndex = (value: unknown) => {
      if (typeof value !== 'string') return 0
      const match = value.match(/^loop-batch-(\d+)$/)
      return match?.[1] ? Number(match[1]) : 0
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/sync')) {
        syncCount += 1
        return Response.json({
          next_batch: `loop-batch-${syncCount}`,
          rooms: { join: {} },
        })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    const [identity] = await db
      .insert(matrixIdentities)
      .values({
        ownerType: 'manager',
        ownerId: 'loop-manager',
        serverName: 'agenthub.local',
        localpart: 'manager-loop-manager',
        userId: '@manager-loop-manager:agenthub.local',
        accessToken: 'loop-token',
        password: 'loop-password',
        displayName: 'Loop Manager',
      })
      .returning()

    try {
      const listener = new MatrixRuntimeListener(
        new MatrixClient({
          homeserverUrl: 'http://matrix.test',
          serverName: 'agenthub.local',
          autoInviteParticipants: true,
          autoJoinParticipants: true,
        }),
      )
      const handle = listener.start({
        identityId: identity!.id,
        pollIntervalMs: 50,
        timeoutMs: 0,
        dispatch: false,
      })
      expect(listener.start({ identityId: identity!.id })).toBe(handle)
      await waitForCondition(
        async () => {
          const [latestIdentity] = await db
            .select()
            .from(matrixIdentities)
            .where(eq(matrixIdentities.id, identity!.id))
            .limit(1)
          return latestIdentity?.metadata?.matrixSync?.nextBatch ?? null
        },
        (nextBatch) => loopBatchIndex(nextBatch) >= 2,
        { description: 'matrix runtime loop persisted second sync batch' },
      )
      expect(listener.isRunning(identity!.id)).toBe(true)
      handle.stop()
      await handle.stopped
      expect(listener.isRunning(identity!.id)).toBe(false)
      const [updatedIdentity] = await db
        .select()
        .from(matrixIdentities)
        .where(eq(matrixIdentities.id, identity!.id))
        .limit(1)
      expect(loopBatchIndex(updatedIdentity?.metadata?.matrixSync?.nextBatch)).toBeGreaterThanOrEqual(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Matrix dispatcher routes human direct room messages to Worker runtime', async () => {
    const directCalls: any[] = []
    const dispatcher = new MatrixRoomEventDispatcher({})
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix Direct Workspace',
        goal: 'Direct room routing',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Direct Worker Target',
        role: 'Worker',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
      })
      .returning()
    const [session] = await db
      .insert(sessions)
      .values({
        title: 'Direct Agent Session',
        type: 'direct',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        metadata: { kind: 'agent-direct', savedAgentId: agent!.id },
      })
      .returning()
    const room = await roomService.ensureRoomForSession(session!.id, 'default-user')
    const [worker] = await db
      .insert(workerInstances)
      .values({
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        runtimeFamily: 'worker',
        runtimeBase: 'opencode',
        observedState: 'listening',
      })
      .returning()
    await roomService.addWorkerParticipant(room.id, agent!.id, worker!.id)
    const [event] = await db
      .insert(timelineEvents)
      .values({
        roomId: room.id,
        providerEventId: '$dispatcher-direct-human',
        senderType: 'human',
        type: 'human.message',
        body: '你好，直接回复我',
        metadata: {
          kind: 'matrix.sync.imported',
          matrix: {
            eventId: '$dispatcher-direct-human',
          },
        },
        sequence: 1,
      })
      .returning()

    const original = workerRuntimeService.runDirectRoom.bind(workerRuntimeService)
    ;(workerRuntimeService as any).runDirectRoom = async (input: any) => {
      directCalls.push(input)
      return { roomId: input.roomId, appendedEventIds: ['stub-event'] }
    }

    try {
      const result = await dispatcher.dispatchImportedEvents({ eventIds: [event!.id] })
      expect(result.dispatchedEventIds).toContain(event!.id)
      expect(directCalls).toHaveLength(1)
      expect(directCalls[0]?.roomId).toBe(room.id)
      expect(directCalls[0]?.workspaceAgentId).toBe(agent!.id)
    } finally {
      ;(workerRuntimeService as any).runDirectRoom = original
    }
  })

  test('Matrix runtime supervisor restores active Manager and Worker listeners on startup', async () => {
    let syncCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/sync')) {
        syncCount += 1
        return Response.json({
          next_batch: `supervisor-batch-${syncCount}`,
          rooms: { join: {} },
        })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    const [room] = await db
      .insert(rooms)
      .values({
        provider: 'matrix',
        providerRoomId: '!supervisor-room:agenthub.local',
        kind: 'task',
        ownerId: 'default-user',
        title: 'Supervisor Room',
      })
      .returning()
    const [managerIdentity] = await db
      .insert(matrixIdentities)
      .values({
        ownerType: 'manager',
        ownerId: 'supervisor-manager',
        serverName: 'agenthub.local',
        localpart: 'manager-supervisor-manager',
        userId: '@manager-supervisor-manager:agenthub.local',
        accessToken: 'supervisor-manager-token',
        password: 'manager-password',
        displayName: 'Manager',
      })
      .returning()
    const [workerIdentity] = await db
      .insert(matrixIdentities)
      .values({
        ownerType: 'worker',
        ownerId: 'supervisor-worker',
        serverName: 'agenthub.local',
        localpart: 'worker-supervisor-worker',
        userId: '@worker-supervisor-worker:agenthub.local',
        accessToken: 'supervisor-worker-token',
        password: 'worker-password',
        displayName: 'Worker',
      })
      .returning()
    await db.insert(roomParticipants).values([
      {
        roomId: room!.id,
        providerUserId: managerIdentity!.userId,
        participantType: 'manager',
        displayName: 'Manager',
        role: 'manager',
      },
      {
        roomId: room!.id,
        providerUserId: workerIdentity!.userId,
        participantType: 'worker',
        displayName: 'Worker',
        role: 'member',
      },
    ])

    try {
      const listener = new MatrixRuntimeListener(
        new MatrixClient({
          homeserverUrl: 'http://matrix.test',
          serverName: 'agenthub.local',
          autoInviteParticipants: true,
          autoJoinParticipants: true,
        }),
      )
      const supervisor = new MatrixRuntimeSupervisor(listener)
      const result = await supervisor.startActiveParticipantListeners({
        reason: 'test-startup',
        dispatch: false,
      })
      expect(result.startedCount).toBeGreaterThanOrEqual(2)
      while (syncCount < 2) await new Promise((resolve) => setTimeout(resolve, 25))
      expect(listener.isRunning(managerIdentity!.id)).toBe(true)
      expect(listener.isRunning(workerIdentity!.id)).toBe(true)
      listener.stop(managerIdentity!.id)
      listener.stop(workerIdentity!.id)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Matrix diagnostics reports homeserver config and listener health without leaking secrets', async () => {
    const diagnosticsApi = await import('../apps/server/src/services/rooms/matrix-diagnostics')
    const previousProvider = process.env.AGENTHUB_ROOM_PROVIDER
    const previousHomeserver = process.env.AGENTHUB_MATRIX_HOMESERVER_URL
    const previousToken = process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN
    delete process.env.AGENTHUB_MATRIX_HOMESERVER_URL
    process.env.AGENTHUB_ROOM_PROVIDER = 'matrix'
    process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN = 'super-secret-token'

    const [identity] = await db
      .insert(matrixIdentities)
      .values({
        ownerType: 'manager',
        ownerId: 'diagnostics-manager',
        serverName: 'agenthub.local',
        localpart: 'manager-diagnostics-manager',
        userId: '@manager-diagnostics-manager:agenthub.local',
        accessToken: 'diagnostics-token',
        password: 'diagnostics-password',
        displayName: 'Diagnostics Manager',
        metadata: {
          matrixSync: {
            lastSyncedAt: '2026-06-04T00:00:00.000Z',
            lastOkAt: '2026-06-04T00:00:00.000Z',
            consecutiveErrors: 0,
          },
        },
      })
      .returning()

    try {
      const diagnostics = await diagnosticsApi.describeMatrixDiagnostics()
      expect(diagnostics.configured).toBe(false)
      expect(diagnostics.homeserver.reachable).toBe(false)
      expect(diagnostics.registration.tokenConfigured).toBe(true)
      expect(JSON.stringify(diagnostics)).not.toContain('super-secret-token')
      expect(diagnostics.listeners.rows.some((row) => row.identityId === identity!.id)).toBe(true)
      expect(diagnostics.listeners.rows.find((row) => row.identityId === identity!.id)?.lastOkAt).toBe(
        '2026-06-04T00:00:00.000Z',
      )
    } finally {
      if (previousProvider === undefined) delete process.env.AGENTHUB_ROOM_PROVIDER
      else process.env.AGENTHUB_ROOM_PROVIDER = previousProvider
      if (previousHomeserver === undefined) delete process.env.AGENTHUB_MATRIX_HOMESERVER_URL
      else process.env.AGENTHUB_MATRIX_HOMESERVER_URL = previousHomeserver
      if (previousToken === undefined) delete process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN
      else process.env.AGENTHUB_MATRIX_REGISTRATION_TOKEN = previousToken
    }
  })

  test('Matrix dispatcher applies /stop as task room cancellation', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix Stop Workspace',
        goal: 'Cancel from Matrix room',
      })
      .returning()
    const [groupSession] = await db
      .insert(sessions)
      .values({
        title: 'Matrix Stop Group',
        type: 'group',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
      })
      .returning()
    const [taskSession] = await db
      .insert(sessions)
      .values({
        title: 'Matrix Stop Task',
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
        status: 'running',
      })
      .returning()
    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Stop Worker',
        role: 'Worker',
        modelId: 'test-model',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
      })
      .returning()
    const [worker] = await db
      .insert(workerInstances)
      .values({
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        runtimeFamily: 'worker',
        runtimeBase: 'opencode',
        modelId: 'test-model',
        observedState: 'busy',
      })
      .returning()
    const [task] = await db
      .insert(workspaceTasks)
      .values({
        workspaceId: workspace!.id,
        runId: run!.id,
        sessionId: taskSession!.id,
        agentId: agent!.id,
        title: 'Cancelable task',
        description: 'Cancel me',
        status: 'running',
      })
      .returning()
    const thread = await ensureTaskThread({
      workspaceId: workspace!.id,
      runId: run!.id,
      taskId: task!.id,
      groupSessionId: groupSession!.id,
      sessionId: taskSession!.id,
      ownerId: 'default-user',
      taskTitle: task!.title,
      workspaceAgentId: agent!.id,
      workerInstanceId: worker!.id,
      agentName: agent!.name,
    })
    const room = await roomController.ensureTaskThreadRoom(thread.id, 'default-user')
    const [lease] = await db
      .insert(runtimeLeases)
      .values({
        workspaceId: workspace!.id,
        runId: run!.id,
        taskId: task!.id,
        workerInstanceId: worker!.id,
        status: 'running',
      })
      .returning()
    const [event] = await db
      .insert(timelineEvents)
      .values({
        roomId: room.id,
        providerEventId: '$matrix-stop',
        senderType: 'human',
        type: 'human.message',
        body: '/stop 下班了，先停',
        metadata: { kind: 'matrix.sync.imported', matrix: { eventId: '$matrix-stop' } },
        sequence: 2,
      })
      .returning()

    const dispatcher = new MatrixRoomEventDispatcher({
      stepManagerRoom: async () => {},
      runWorkerTaskRoom: async () => {},
    })
    const result = await dispatcher.dispatchImportedEvents({ eventIds: [event!.id] })
    expect(result.dispatchedEventIds).toEqual([event!.id])

    const [updatedTask] = await db.select().from(workspaceTasks).where(eq(workspaceTasks.id, task!.id)).limit(1)
    const [updatedLease] = await db.select().from(runtimeLeases).where(eq(runtimeLeases.id, lease!.id)).limit(1)
    expect(updatedTask?.status).toBe('cancelled')
    expect(updatedLease?.status).toBe('released')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.some((row) => row.metadata?.kind === 'matrix.control.stop.applied')).toBe(true)
  })

  test('Matrix dispatcher applies /approve as an answer to a pending Worker clarification', async () => {
    const { room, clarificationId } = await createTaskRoomWithPendingClarification('Matrix Approve')
    const approveEvent = await roomService.importTimelineEvent({
      roomId: room.id,
      providerEventId: '$matrix-approve',
      senderType: 'human',
      type: 'human.message',
      body: '/approve 按这个方向继续',
      metadata: { kind: 'matrix.sync.imported', matrix: { eventId: '$matrix-approve' } },
    })

    const dispatcher = new MatrixRoomEventDispatcher({
      stepManagerRoom: async () => {},
      runWorkerTaskRoom: async () => {},
      resumeTaskRoomAfterApproval: (input: any) =>
        workerRuntimeService.resumeTaskRoomAfterHumanAnswer({
          roomId: input.roomId,
          ownerId: input.ownerId,
          sourceEventId: input.sourceEventId,
          answer: input.answer,
          runAfterResume: false,
        }),
    })
    const result = await dispatcher.dispatchImportedEvents({ eventIds: [approveEvent.id] })
    expect(result.dispatchedEventIds).toEqual([approveEvent.id])

    const [answered] = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, clarificationId))
      .limit(1)
    expect(answered?.status).toBe('answered')
    expect(answered?.answer).toBe('按这个方向继续')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const resumeEvent = events.find((row) => row.metadata?.kind === 'worker-runtime.resume-requested')
    expect(resumeEvent?.metadata?.sourceEventId).toBe(approveEvent.id)
    expect(resumeEvent?.metadata?.clarificationId).toBe(clarificationId)
    expect(resumeEvent?.metadata?.answer).toBe('按这个方向继续')
    expect(events.some((row) => row.metadata?.kind === 'matrix.control.approval')).toBe(false)
  })

  test('Matrix dispatcher treats plain task room replies as pending Worker clarification answers before mentions', async () => {
    const { room, agent, workerParticipant, clarificationId } =
      await createTaskRoomWithPendingClarification('Matrix Plain Reply')
    const workerCalls: any[] = []
    const replyEvent = await roomService.importTimelineEvent({
      roomId: room.id,
      providerEventId: '$matrix-plain-reply',
      senderType: 'human',
      type: 'human.message',
      body: `${workerParticipant.providerUserId} 可以，继续执行。`,
      metadata: {
        kind: 'matrix.sync.imported',
        matrix: {
          eventId: '$matrix-plain-reply',
          mentionedParticipantIds: [workerParticipant.id],
        },
      },
    })

    const dispatcher = new MatrixRoomEventDispatcher({
      stepManagerRoom: async () => {},
      runWorkerTaskRoom: async (input: any) => {
        workerCalls.push(input)
      },
      resumeTaskRoomAfterHumanAnswer: (input: any) =>
        workerRuntimeService.resumeTaskRoomAfterHumanAnswer({
          roomId: input.roomId,
          ownerId: input.ownerId,
          sourceEventId: input.sourceEventId,
          answer: input.answer,
          runAfterResume: false,
        }),
    })
    const result = await dispatcher.dispatchImportedEvents({ eventIds: [replyEvent.id] })
    expect(result.dispatchedEventIds).toEqual([replyEvent.id])
    expect(workerCalls).toHaveLength(0)

    const [answered] = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, clarificationId))
      .limit(1)
    expect(answered?.status).toBe('answered')
    expect(answered?.answer).toBe(`${workerParticipant.providerUserId} 可以，继续执行。`)
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const resumeEvent = events.find((row) => row.metadata?.kind === 'worker-runtime.resume-requested')
    expect(resumeEvent?.metadata?.sourceEventId).toBe(replyEvent.id)
    expect(resumeEvent?.metadata?.clarificationId).toBe(clarificationId)
    expect(resumeEvent?.metadata?.workspaceAgentId).toBeUndefined()
    expect(agent.name).toBe('Matrix Plain Reply Worker')
  })

  test('Matrix dispatcher binds /deny to a pending Worker clarification without resuming the Worker', async () => {
    const { room, clarificationId } = await createTaskRoomWithPendingClarification('Matrix Deny')
    const denyEvent = await roomService.importTimelineEvent({
      roomId: room.id,
      providerEventId: '$matrix-deny',
      senderType: 'human',
      type: 'human.message',
      body: '/deny 方向不对，先不要继续',
      metadata: { kind: 'matrix.sync.imported', matrix: { eventId: '$matrix-deny' } },
    })

    const workerCalls: any[] = []
    const dispatcher = new MatrixRoomEventDispatcher({
      stepManagerRoom: async () => {},
      runWorkerTaskRoom: async (input: any) => {
        workerCalls.push(input)
      },
    })
    const result = await dispatcher.dispatchImportedEvents({ eventIds: [denyEvent.id] })
    expect(result.dispatchedEventIds).toEqual([denyEvent.id])
    expect(workerCalls).toHaveLength(0)

    const [answered] = await db
      .select()
      .from(taskClarifications)
      .where(eq(taskClarifications.id, clarificationId))
      .limit(1)
    expect(answered?.status).toBe('answered')
    expect(answered?.answer).toBe('[DENIED] 方向不对，先不要继续')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    const deniedEvent = events.find((row) => row.metadata?.kind === 'worker-runtime.clarification-denied')
    expect(deniedEvent?.metadata?.sourceEventId).toBe(denyEvent.id)
    expect(deniedEvent?.metadata?.clarificationId).toBe(clarificationId)
    expect(deniedEvent?.metadata?.reason).toBe('方向不对，先不要继续')
    expect(events.some((row) => row.metadata?.kind === 'worker-runtime.resume-requested')).toBe(false)
    expect(events.some((row) => row.metadata?.kind === 'matrix.control.approval')).toBe(false)
  })

  test('Matrix dispatcher registers shared Matrix file refs as ArtifactStore records', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix File Workspace',
        goal: 'Register file refs',
      })
      .returning()
    const [groupSession] = await db
      .insert(sessions)
      .values({
        title: 'Matrix File Group',
        type: 'group',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
      })
      .returning()
    const [taskSession] = await db
      .insert(sessions)
      .values({
        title: 'Matrix File Task',
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
        status: 'running',
      })
      .returning()
    const [task] = await db
      .insert(workspaceTasks)
      .values({
        workspaceId: workspace!.id,
        runId: run!.id,
        sessionId: taskSession!.id,
        title: 'Read shared file',
        description: 'Use Matrix file',
        status: 'running',
      })
      .returning()
    const thread = await ensureTaskThread({
      workspaceId: workspace!.id,
      runId: run!.id,
      taskId: task!.id,
      groupSessionId: groupSession!.id,
      sessionId: taskSession!.id,
      ownerId: 'default-user',
      taskTitle: task!.title,
      agentName: null,
    })
    const room = await roomController.ensureTaskThreadRoom(thread.id, 'default-user')
    const [event] = await db
      .insert(timelineEvents)
      .values({
        roomId: room.id,
        providerEventId: '$matrix-file',
        senderType: 'human',
        type: 'file.shared',
        body: 'market-report.pdf',
        metadata: {
          kind: 'matrix.sync.imported',
          matrix: {
            eventId: '$matrix-file',
            file: {
              msgtype: 'm.file',
              name: 'market-report.pdf',
              url: 'mxc://agenthub.local/market-report',
              info: { mimetype: 'application/pdf', size: 1234 },
            },
          },
        },
        sequence: 2,
      })
      .returning()

    const dispatcher = new MatrixRoomEventDispatcher({
      stepManagerRoom: async () => {},
      runWorkerTaskRoom: async () => {},
    })
    const result = await dispatcher.dispatchImportedEvents({ eventIds: [event!.id] })
    expect(result.dispatchedEventIds).toEqual([event!.id])

    const artifactRows = await db.select().from(artifacts).where(eq(artifacts.taskId, task!.id))
    expect(artifactRows).toHaveLength(1)
    expect(artifactRows[0]?.title).toBe('market-report.pdf')
    expect(artifactRows[0]?.metadata?.matrixFile?.url).toBe('mxc://agenthub.local/market-report')
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
    expect(events.some((row) => row.metadata?.kind === 'matrix.file.artifact-registered')).toBe(true)
  })

  test('Matrix dispatcher downloads mxc media into ArtifactStore with the sender identity token', async () => {
    const previousHomeserver = process.env.AGENTHUB_MATRIX_HOMESERVER_URL
    const previousServerName = process.env.AGENTHUB_MATRIX_SERVER_NAME
    process.env.AGENTHUB_MATRIX_HOMESERVER_URL = 'http://matrix.test'
    process.env.AGENTHUB_MATRIX_SERVER_NAME = 'agenthub.local'
    Bun.env.AGENTHUB_MATRIX_HOMESERVER_URL = 'http://matrix.test'
    Bun.env.AGENTHUB_MATRIX_SERVER_NAME = 'agenthub.local'

    const mediaBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x61, 0x67, 0x65, 0x6e, 0x74])
    const calls: Array<{ path: string; auth: string | null }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      const auth = init?.headers
        ? ((init.headers as Record<string, string>).Authorization ?? null)
        : null
      calls.push({ path: parsed.pathname, auth })
      if (parsed.pathname.includes('/_matrix/client/v1/media/download/agenthub.local/market-report')) {
        return new Response(mediaBytes, {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="market-report.pdf"',
          },
        })
      }
      return Response.json({}, { status: 404 })
    }) as typeof fetch

    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Matrix Media Workspace',
        goal: 'Download media',
      })
      .returning()
    const [groupSession] = await db
      .insert(sessions)
      .values({
        title: 'Matrix Media Group',
        type: 'group',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
      })
      .returning()
    const [taskSession] = await db
      .insert(sessions)
      .values({
        title: 'Matrix Media Task',
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
        status: 'running',
      })
      .returning()
    const [task] = await db
      .insert(workspaceTasks)
      .values({
        workspaceId: workspace!.id,
        runId: run!.id,
        sessionId: taskSession!.id,
        title: 'Read downloaded Matrix file',
        description: 'Use Matrix media',
        status: 'running',
      })
      .returning()
    const thread = await ensureTaskThread({
      workspaceId: workspace!.id,
      runId: run!.id,
      taskId: task!.id,
      groupSessionId: groupSession!.id,
      sessionId: taskSession!.id,
      ownerId: 'default-user',
      taskTitle: task!.title,
      agentName: null,
    })
    const room = await roomController.ensureTaskThreadRoom(thread.id, 'default-user')
    const [human] = await db
      .insert(roomParticipants)
      .values({
        roomId: room.id,
        providerUserId: '@human-media-user:agenthub.local',
        participantType: 'human',
        userId: 'default-user',
        displayName: 'You',
        role: 'owner',
      })
      .returning()
    await db.insert(matrixIdentities).values({
      ownerType: 'human',
      ownerId: 'media-user',
      serverName: 'agenthub.local',
      localpart: 'human-media-user',
      userId: '@human-media-user:agenthub.local',
      accessToken: 'human-media-token',
      password: 'human-password',
      displayName: 'You',
    })
    const [event] = await db
      .insert(timelineEvents)
      .values({
        roomId: room.id,
        providerEventId: '$matrix-media-file',
        senderParticipantId: human!.id,
        senderType: 'human',
        type: 'file.shared',
        body: 'market-report.pdf',
        metadata: {
          kind: 'matrix.sync.imported',
          matrix: {
            eventId: '$matrix-media-file',
            senderUserId: '@human-media-user:agenthub.local',
            file: {
              msgtype: 'm.file',
              name: 'market-report.pdf',
              url: 'mxc://agenthub.local/market-report',
              info: { mimetype: 'application/pdf', size: mediaBytes.byteLength },
            },
          },
        },
        sequence: 2,
      })
      .returning()

    try {
      const dispatcher = new MatrixRoomEventDispatcher({
        stepManagerRoom: async () => {},
        runWorkerTaskRoom: async () => {},
      })
      const result = await dispatcher.dispatchImportedEvents({ eventIds: [event!.id] })
      expect(result.dispatchedEventIds).toEqual([event!.id])

      const artifactRows = await db.select().from(artifacts).where(eq(artifacts.taskId, task!.id))
      expect(artifactRows).toHaveLength(1)
      expect(artifactRows[0]?.status).toBe('registered')
      expect(artifactRows[0]?.size).toBe(mediaBytes.byteLength)
      expect(artifactRows[0]?.mimeType).toBe('application/pdf')
      expect(artifactRows[0]?.checksum).toBe(createHash('sha256').update(mediaBytes).digest('hex'))
      expect(readFileSync(artifactRows[0]!.storagePath!)).toEqual(Buffer.from(mediaBytes))
      expect(artifactRows[0]?.metadata?.matrixDownload?.downloaded).toBe(true)
      expect(artifactRows[0]?.metadata?.matrixDownload?.usedParticipantToken).toBe(true)
      expect(calls.some((call) => call.auth === 'Bearer human-media-token')).toBe(true)

      const events = await db.select().from(timelineEvents).where(eq(timelineEvents.roomId, room.id))
      const artifactEvent = events.find((row) => row.metadata?.kind === 'matrix.file.artifact-registered')
      expect(artifactEvent?.body).toContain('已从 Matrix 下载并登记共享文件')
    } finally {
      globalThis.fetch = originalFetch
      if (previousHomeserver === undefined) {
        delete process.env.AGENTHUB_MATRIX_HOMESERVER_URL
        delete Bun.env.AGENTHUB_MATRIX_HOMESERVER_URL
      } else {
        process.env.AGENTHUB_MATRIX_HOMESERVER_URL = previousHomeserver
        Bun.env.AGENTHUB_MATRIX_HOMESERVER_URL = previousHomeserver
      }
      if (previousServerName === undefined) {
        delete process.env.AGENTHUB_MATRIX_SERVER_NAME
        delete Bun.env.AGENTHUB_MATRIX_SERVER_NAME
      } else {
        process.env.AGENTHUB_MATRIX_SERVER_NAME = previousServerName
        Bun.env.AGENTHUB_MATRIX_SERVER_NAME = previousServerName
      }
    }
  })
})
