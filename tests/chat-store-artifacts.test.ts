import { describe, expect, test } from 'bun:test'
import type { OrchestratorRunListItem, Session } from '../apps/web/src/lib/api'
import { SessionType } from '../apps/web/src/lib/api'
import { OrchestratorRunStatus } from '../packages/shared/src/index'
import { __chatStoreTestHooks } from '../apps/web/src/stores/chatStore'

function run(partial: Partial<OrchestratorRunListItem>): OrchestratorRunListItem {
  return {
    id: 'run-1',
    workspaceId: 'workspace-1',
    groupSessionId: 'group-1',
    planMessageId: null,
    status: OrchestratorRunStatus.Completed,
    plan: { title: 'Demo', goal: 'Goal', tasks: [], phases: [], agents: [] },
    summaryMessageId: 'summary-1',
    conflictReport: null,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    workspaceName: 'Workspace',
    sessionTitle: 'Group',
    ...partial,
  }
}

function session(partial: Partial<Session> & Pick<Session, 'id' | 'title' | 'type'>): Session {
  return {
    ownerId: 'user-1',
    workspaceId: null,
    workspaceAgentId: null,
    metadata: null,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    lastMessage: null,
    ...partial,
  }
}

describe('chat store artifact snapshot projection', () => {
  test('group manager startup activity exposes concrete thinking details', () => {
    expect(__chatStoreTestHooks.runtimeActivityLabel('thinking')).toBe('正在读取群聊上下文')
    expect(__chatStoreTestHooks.runtimeActivityDetail('thinking')).toBe(
      '读取上下文 / 检查成员 / 准备下一步',
    )

    const header = __chatStoreTestHooks.buildHeaderAgentStatusProjection({
      sessionId: 'group-1',
      taskBoard: null,
      agentTabs: [],
      agentTyping: true,
      agentActivity: {
        sessionId: 'group-1',
        agentName: 'Manager',
        phase: 'thinking',
        startedAt: '2026-06-03T00:00:00.000Z',
      },
      streamingMessage: null,
      streamingCodeAgentRun: null,
    })

    expect(header).toMatchObject({
      label: '理解中',
      detail: '读取上下文 / 检查成员 / 准备下一步',
      tone: 'thinking',
      live: true,
    })
  })

  test('resource snapshot carries task artifacts into task board directly', () => {
    const taskBoard = __chatStoreTestHooks.taskBoardFromRun(
      run({
        status: OrchestratorRunStatus.Running,
        taskBoardSnapshot: {
          runId: 'run-1',
          title: 'Snapshot plan',
          goal: 'Snapshot goal',
          collaborationMode: 'pipeline',
          sessionId: 'group-1',
          status: 'running',
          phases: [
            {
              id: 'implementation',
              title: '实现',
              purpose: '以服务端快照为准',
              taskIds: ['task-1'],
              status: 'active',
            },
          ],
          tasks: [
            {
              id: 'task-1',
              phaseId: 'implementation',
              title: 'Snapshot task',
              description: 'From server snapshot',
              agentId: 'agent-1',
              agentName: 'Snapshot Builder',
              status: 'running',
              progress: 55,
              dependencies: [],
              childSessionId: 'child-1',
              artifactCount: 1,
              artifacts: [
                {
                  artifactId: 'artifact-1',
                  id: 'artifact-1',
                  title: 'report.html',
                  filePath: 'deliverables/report.html',
                  size: 2048,
                  status: 'registered',
                  taskId: 'task-1',
                },
              ],
              validationStatus: 'passed',
            },
          ],
        },
      }),
    )

    expect(taskBoard).toBeTruthy()
    expect(taskBoard?.tasks[0]?.artifactCount).toBe(1)
    expect(taskBoard?.tasks[0]?.artifacts?.[0]?.title).toBe('report.html')
    expect(taskBoard?.tasks[0]?.artifacts?.[0]?.filePath).toBe('deliverables/report.html')
  })

  test('resource snapshot recomputes phase status from task thread state', () => {
    const taskBoard = {
      runId: 'run-1',
      title: 'Demo',
      goal: 'Goal',
      collaborationMode: 'pipeline',
      sessionId: 'group-1',
      status: 'running',
      phases: [
        {
          id: 'implementation',
          title: '实现',
          purpose: '完成实现',
          taskIds: ['task-1'],
          status: 'active',
        },
      ],
      tasks: [
        {
          id: 'task-1',
          phaseId: 'implementation',
          title: 'Build page',
          description: 'Implement the page',
          agentId: 'agent-1',
          agentName: 'Builder',
          status: 'running',
          dependencies: [],
          taskThreadId: 'thread-1',
          childSessionId: 'child-1',
          artifacts: [],
        },
      ],
    } as any

    const next = __chatStoreTestHooks.applyResourceSnapshotToTaskBoard(taskBoard, {
      run: { status: 'completed' },
      taskThreads: [
        {
          id: 'thread-1',
          taskId: 'task-1',
          sessionId: 'child-1',
          status: 'completed',
        },
      ],
      artifacts: [],
      runtimeLeases: [],
    })

    expect(next.status).toBe('completed')
    expect(next.tasks[0]?.status).toBe('done')
    expect(next.phases[0]?.status).toBe('completed')
  })

  test('task board derived from run snapshot normalizes phase status from task ledger', () => {
    const taskBoard = __chatStoreTestHooks.taskBoardFromRun(
      run({
        status: OrchestratorRunStatus.Running,
        plan: {
          title: 'Demo',
          goal: 'Goal',
          agents: [{ id: 'agent-1', name: 'Builder' }],
          phases: [
            {
              id: 'implementation',
              title: '实现',
              purpose: '完成实现',
              taskIds: ['task-1'],
            },
          ],
          tasks: [
            {
              id: 'task-1',
              phaseId: 'implementation',
              title: 'Build page',
              description: 'Implement the page',
              agentId: 'agent-1',
              dependencies: [],
            },
          ],
          taskLedger: {
            tasks: [
              {
                id: 'task-1',
                phaseId: 'implementation',
                title: 'Build page',
                description: 'Implement the page',
                agentId: 'agent-1',
                status: 'done',
                dependencies: [],
              },
            ],
            phases: [
              {
                id: 'implementation',
                title: '实现',
                purpose: '完成实现',
                taskIds: ['task-1'],
              },
            ],
          },
          progressLedger: {
            status: 'running',
          },
        } as any,
      }),
    )

    expect(taskBoard).toBeTruthy()
    expect(taskBoard?.tasks[0]?.status).toBe('done')
    expect(taskBoard?.phases[0]?.status).toBe('completed')
  })

  test('task board prefers server taskBoardSnapshot over rebuilding from run resources', () => {
    const taskBoard = __chatStoreTestHooks.taskBoardFromRun(
      run({
        status: OrchestratorRunStatus.Running,
        plan: {
          title: 'Legacy plan',
          goal: 'Legacy goal',
          agents: [{ id: 'agent-legacy', name: 'Legacy Builder' }],
          phases: [
            {
              id: 'legacy-phase',
              title: '旧阶段',
              purpose: '旧逻辑',
              taskIds: ['legacy-task'],
            },
          ],
          tasks: [
            {
              id: 'legacy-task',
              phaseId: 'legacy-phase',
              title: 'Legacy task',
              description: 'Should be ignored when snapshot exists',
              agentId: 'agent-legacy',
              dependencies: [],
            },
          ],
        } as any,
        taskBoardSnapshot: {
          runId: 'run-1',
          title: 'Snapshot plan',
          goal: 'Snapshot goal',
          collaborationMode: 'pipeline',
          sessionId: 'group-1',
          status: 'running',
          phases: [
            {
              id: 'implementation',
              title: '实现',
              purpose: '以服务端快照为准',
              taskIds: ['task-1'],
              status: 'active',
            },
          ],
          tasks: [
            {
              id: 'task-1',
              phaseId: 'implementation',
              title: 'Snapshot task',
              description: 'From server snapshot',
              agentId: 'agent-1',
              agentName: 'Snapshot Builder',
              status: 'running',
              progress: 55,
              dependencies: [],
              childSessionId: 'child-1',
              artifactCount: 1,
              validationStatus: 'passed',
            },
          ],
        },
      }),
    )

    expect(taskBoard).toBeTruthy()
    expect(taskBoard?.title).toBe('Snapshot plan')
    expect(taskBoard?.goal).toBe('Snapshot goal')
    expect(taskBoard?.tasks).toHaveLength(1)
    expect(taskBoard?.tasks[0]).toMatchObject({
      id: 'task-1',
      title: 'Snapshot task',
      agentName: 'Snapshot Builder',
      status: 'running',
      progress: 55,
      artifactCount: 1,
      validationStatus: 'passed',
    })
    expect(taskBoard?.phases[0]).toMatchObject({
      id: 'implementation',
      title: '实现',
      status: 'active',
    })
  })

  test('runtime activity projection tracks manager, task execution, and synthesis states', () => {
    let projection = {
      agentTyping: false,
      agentActivity: null,
    } as any

    projection = __chatStoreTestHooks.reduceRuntimeActivityProjection(
      projection,
      {
        type: 'CUSTOM',
        name: 'agenthub.manager.status',
        value: {
          status: 'thinking',
          action: 'planning',
          actorAgentId: 'orch-1',
          actorName: 'Orchestrator',
        },
      },
      'group-1',
    )
    expect(projection.agentTyping).toBe(true)
    expect(projection.agentActivity).toMatchObject({
      sessionId: 'group-1',
      agentId: 'orch-1',
      agentName: 'Orchestrator',
      phase: 'planning',
    })

    projection = __chatStoreTestHooks.reduceRuntimeActivityProjection(
      projection,
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        value: {
          taskId: 'task-1',
          status: 'running',
          agentId: 'agent-1',
          agentName: 'Builder',
        },
      },
      'group-1',
    )
    expect(projection.agentTyping).toBe(true)
    expect(projection.agentActivity).toMatchObject({
      sessionId: 'group-1',
      agentId: 'agent-1',
      agentName: 'Builder',
      phase: 'executing',
    })

    projection = __chatStoreTestHooks.reduceRuntimeActivityProjection(
      projection,
      {
        type: 'CUSTOM',
        name: 'agenthub.run.status',
        value: {
          status: 'synthesizing',
        },
      },
      'group-1',
    )
    expect(projection.agentTyping).toBe(true)
    expect(projection.agentActivity).toMatchObject({
      sessionId: 'group-1',
      phase: 'synthesizing',
    })

    projection = __chatStoreTestHooks.reduceRuntimeActivityProjection(
      projection,
      {
        type: 'RUN_FINISHED',
        result: {
          status: 'completed',
        },
      },
      'group-1',
    )
    expect(projection.agentTyping).toBe(false)
    expect(projection.agentActivity).toBeNull()
  })

  test('snapshot-derived runtime activity falls back to the running task when replay is unavailable', () => {
    const taskBoard = {
      runId: 'run-1',
      title: 'Demo',
      goal: 'Goal',
      collaborationMode: 'pipeline',
      sessionId: 'group-1',
      status: 'running',
      phases: [
        {
          id: 'implementation',
          title: '实现',
          purpose: '完成实现',
          taskIds: ['task-1'],
          status: 'active',
        },
      ],
      tasks: [
        {
          id: 'task-1',
          phaseId: 'implementation',
          title: 'Build page',
          description: 'Implement the page',
          agentId: 'agent-1',
          agentName: 'Builder',
          status: 'running',
          dependencies: [],
          childSessionId: 'child-1',
          artifacts: [],
        },
      ],
    } as any

    const projection = __chatStoreTestHooks.runtimeActivityFromSnapshot({
      taskBoard,
      agUiEvents: [],
    })

    expect(projection.agentTyping).toBe(true)
    expect(projection.agentActivity).toMatchObject({
      sessionId: 'group-1',
      agentId: 'agent-1',
      agentName: 'Builder',
      phase: 'executing',
    })
  })

  test('snapshot-derived runtime activity falls back to orchestrator planning and synthesizing states', () => {
    const planningBoard = {
      runId: 'run-1',
      title: 'Demo',
      goal: 'Goal',
      collaborationMode: 'pipeline',
      sessionId: 'group-1',
      status: 'planning',
      phases: [],
      tasks: [],
    } as any
    const synthesizingBoard = {
      ...planningBoard,
      status: 'synthesizing',
    } as any

    const planning = __chatStoreTestHooks.runtimeActivityFromSnapshot({
      taskBoard: planningBoard,
      agUiEvents: [],
    })
    const synthesizing = __chatStoreTestHooks.runtimeActivityFromSnapshot({
      taskBoard: synthesizingBoard,
      agUiEvents: [],
    })

    expect(planning.agentTyping).toBe(true)
    expect(planning.agentActivity).toMatchObject({
      sessionId: 'group-1',
      agentName: 'Manager',
      phase: 'planning',
    })

    expect(synthesizing.agentTyping).toBe(true)
    expect(synthesizing.agentActivity).toMatchObject({
      sessionId: 'group-1',
      agentName: 'Manager',
      phase: 'synthesizing',
    })
  })

  test('snapshot-derived runtime activity prefers the server control-plane snapshot', () => {
    const taskBoard = {
      runId: 'run-1',
      title: 'Demo',
      goal: 'Goal',
      collaborationMode: 'pipeline',
      sessionId: 'group-1',
      status: 'running',
      phases: [],
      tasks: [
        {
          id: 'task-1',
          phaseId: 'implementation',
          title: 'Build page',
          description: 'Implement the page',
          agentId: 'agent-1',
          agentName: 'Builder',
          status: 'running',
          dependencies: [],
        },
      ],
    } as any

    const projection = __chatStoreTestHooks.runtimeActivityFromSnapshot({
      taskBoard,
      agUiEvents: [
        {
          type: 'CUSTOM',
          name: 'agenthub.manager.status',
          value: {
            status: 'thinking',
            action: 'planning',
            actorAgentId: 'orch-1',
            actorName: 'Orchestrator',
          },
        },
      ],
      serverRuntimeActivity: {
        agentTyping: true,
        agentActivity: {
          sessionId: 'group-1',
          agentId: 'agent-1',
          agentName: 'Builder',
          phase: 'executing',
          startedAt: null,
        },
        source: 'task-board',
      },
    })

    expect(projection.agentTyping).toBe(true)
    expect(projection.agentActivity).toMatchObject({
      sessionId: 'group-1',
      agentId: 'agent-1',
      agentName: 'Builder',
      phase: 'executing',
    })
  })

  test('session refresh preserves orchestrator task threads projected from the current task board', () => {
    const sessions = [
      session({
        id: 'group-1',
        title: 'Research group',
        type: SessionType.Group,
        workspaceId: 'workspace-1',
      }),
    ]

    const nextSessions = __chatStoreTestHooks.mergeSessionsWithRuntimeProjection(
      sessions,
      sessions[0] ?? null,
      {
        runId: 'run-1',
        title: 'Demo',
        goal: 'Goal',
        collaborationMode: 'pipeline',
        sessionId: 'group-1',
        status: 'running',
        phases: [],
        tasks: [
          {
            id: 'task-1',
            phaseId: 'implementation',
            title: 'Research AI tools',
            description: 'Investigate current tools',
            agentId: 'agent-1',
            agentName: 'Researcher',
            status: 'running',
            taskThreadStatus: 'active',
            dependencies: [],
            childSessionId: 'child-1',
            taskThreadId: 'thread-1',
            workerInstanceId: 'worker-1',
            artifacts: [],
          },
        ],
      } as any,
    )

    expect(nextSessions.map((item) => item.id)).toContain('child-1')
    const child = nextSessions.find((item) => item.id === 'child-1')
    expect(child?.metadata).toMatchObject({
      kind: 'orchestrator-task',
      groupSessionId: 'group-1',
      orchestratorRunId: 'run-1',
      orchestratorTaskId: 'task-1',
      taskThreadId: 'thread-1',
      workerInstanceId: 'worker-1',
      taskThreadStatus: 'active',
    })
    expect(child?.workspaceAgentId).toBe('agent-1')
    expect(child?.title).toContain('Researcher')
  })

  test('session refresh preserves prepared task threads without forcing an assigned workspace agent', () => {
    const sessions = [
      session({
        id: 'group-1',
        title: 'Research group',
        type: SessionType.Group,
        workspaceId: 'workspace-1',
      }),
    ]

    const nextSessions = __chatStoreTestHooks.mergeSessionsWithRuntimeProjection(
      sessions,
      sessions[0] ?? null,
      {
        runId: 'run-1',
        title: 'Demo',
        goal: 'Goal',
        collaborationMode: 'pipeline',
        sessionId: 'group-1',
        status: 'planning',
        phases: [],
        tasks: [
          {
            id: 'task-1',
            phaseId: 'analysis',
            title: 'Clarify scope',
            description: 'Wait for manager dispatch',
            agentId: 'agent-1',
            agentName: 'Researcher',
            status: 'pending',
            taskThreadStatus: 'prepared',
            dependencies: [],
            childSessionId: 'child-prepared-1',
            taskThreadId: 'thread-prepared-1',
            artifacts: [],
          },
        ],
      } as any,
    )

    const child = nextSessions.find((item) => item.id === 'child-prepared-1')
    expect(child?.workspaceAgentId).toBeNull()
    expect(child?.title).toContain('准备中')
    expect(child?.metadata).toMatchObject({
      kind: 'orchestrator-task',
      taskThreadId: 'thread-prepared-1',
      taskThreadStatus: 'prepared',
    })
  })

  test('task board snapshot preserves task thread status for prepared tasks', () => {
    const run = {
      id: 'run-1',
      workspaceId: 'workspace-1',
      groupSessionId: 'group-1',
      planMessageId: null,
      status: 'planning',
      plan: null,
      summaryMessageId: null,
      conflictReport: [],
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      workspaceName: 'Workspace',
      sessionTitle: 'Group',
      taskBoardSnapshot: {
        runId: 'run-1',
        title: 'Demo',
        goal: 'Goal',
        collaborationMode: 'pipeline',
        sessionId: 'group-1',
        status: 'planning',
        phases: [],
        tasks: [
          {
            id: 'task-1',
            phaseId: 'analysis',
            title: 'Clarify scope',
            description: 'Wait for dispatch',
            agentId: 'agent-1',
            agentName: 'Researcher',
            status: 'pending',
            taskThreadStatus: 'prepared',
            dependencies: [],
            childSessionId: 'child-1',
            taskThreadId: 'thread-1',
          },
        ],
      },
    } as any

    const taskBoard = __chatStoreTestHooks.taskBoardFromRun(run)
    expect(taskBoard?.tasks[0]).toMatchObject({
      id: 'task-1',
      status: 'pending',
      taskThreadStatus: 'prepared',
      childSessionId: 'child-1',
      taskThreadId: 'thread-1',
    })
  })

  test('resource snapshot task threads can be projected into agent tabs without relying on taskBoard child session fields', () => {
    const runWithResources = run({
      resourceSnapshot: {
        tasks: [
          {
            id: 'task-1',
            agentId: 'agent-1',
            title: 'Research AI tools',
          },
        ],
        taskThreads: [
          {
            id: 'thread-1',
            taskId: 'task-1',
            sessionId: 'child-1',
            workerInstanceId: 'worker-1',
            status: 'assigned',
          },
        ],
      },
    })

    const entries = __chatStoreTestHooks.buildRunResourceTaskEntries(runWithResources, {
      runId: 'run-1',
      title: 'Demo',
      goal: 'Goal',
      collaborationMode: 'pipeline',
      sessionId: 'group-1',
      status: 'running',
      phases: [],
      tasks: [
        {
          id: 'task-1',
          phaseId: 'implementation',
          title: 'Research AI tools',
          description: 'Investigate current tools',
          agentId: 'agent-1',
          agentName: 'Researcher',
          status: 'pending',
          dependencies: [],
          childSessionId: null,
          artifacts: [],
        },
      ],
    } as any)

    expect(entries).toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        childSessionId: 'child-1',
        taskThreadId: 'thread-1',
        taskThreadStatus: 'assigned',
        workerInstanceId: 'worker-1',
        agentId: 'agent-1',
        agentName: 'Researcher',
        taskTitle: 'Research AI tools',
        status: 'assigned',
      }),
    ])
  })

  test('run projection can restore prepared child sessions from resource task threads', () => {
    const sessions = [
      session({
        id: 'group-1',
        title: 'Research group',
        type: SessionType.Group,
        workspaceId: 'workspace-1',
      }),
    ]

    const projected = __chatStoreTestHooks.mergeSessionsWithRunProjection(
      sessions,
      sessions[0] ?? null,
      run({
        resourceSnapshot: {
          tasks: [
            {
              id: 'task-1',
              agentId: 'agent-1',
              title: 'Clarify scope',
            },
          ],
          taskThreads: [
            {
              id: 'thread-prepared-1',
              taskId: 'task-1',
              sessionId: 'child-prepared-1',
              workerInstanceId: null,
              status: 'prepared',
            },
          ],
        },
      }),
      {
        runId: 'run-1',
        title: 'Demo',
        goal: 'Goal',
        collaborationMode: 'pipeline',
        sessionId: 'group-1',
        status: 'planning',
        phases: [],
        tasks: [
          {
            id: 'task-1',
            phaseId: 'analysis',
            title: 'Clarify scope',
            description: 'Wait for dispatch',
            agentId: 'agent-1',
            agentName: 'Researcher',
            status: 'pending',
            dependencies: [],
            childSessionId: null,
            artifacts: [],
          },
        ],
      } as any,
    )

    const child = projected.find((item) => item.id === 'child-prepared-1')
    expect(child?.workspaceAgentId).toBeNull()
    expect(child?.metadata).toMatchObject({
      kind: 'orchestrator-task',
      groupSessionId: 'group-1',
      orchestratorRunId: 'run-1',
      orchestratorTaskId: 'task-1',
      taskThreadId: 'thread-prepared-1',
      taskThreadStatus: 'prepared',
    })
  })

  test('observe_resources manager event reprojects sessions and tabs from resource task threads', () => {
    const initialState = {
      sessions: [
        session({
          id: 'group-1',
          title: 'Research group',
          type: SessionType.Group,
          workspaceId: 'workspace-1',
        }),
      ],
      currentSession: session({
        id: 'group-1',
        title: 'Research group',
        type: SessionType.Group,
        workspaceId: 'workspace-1',
      }),
      currentWorkspace: null,
      currentWorkspaceAgents: [],
      currentSessionId: 'group-1',
      messages: [],
      streamingMessage: null,
      streamingCodeAgentRun: null,
      pendingAttachments: [],
      safetyMode: 'ask',
      loadingSessions: false,
      loadingMessages: false,
      agentTyping: false,
      agentActivity: null,
      replyingToMessageId: null,
      replyingToMessage: null,
      sessionsBootstrapped: true,
      taskBoard: {
        runId: 'run-1',
        title: 'Demo',
        goal: 'Goal',
        collaborationMode: 'pipeline',
        sessionId: 'group-1',
        status: 'planning',
        phases: [],
        tasks: [
          {
            id: 'task-1',
            phaseId: 'analysis',
            title: 'Clarify scope',
            description: 'Wait for dispatch',
            agentId: 'agent-1',
            agentName: 'Researcher',
            status: 'pending',
            dependencies: [],
            childSessionId: null,
            artifacts: [],
          },
        ],
      },
      previewUrl: null,
      previewFileName: null,
      selectedAgentTab: null,
      agentTabs: [],
    } as any

    const nextState = __chatStoreTestHooks.applyAgUiEventToState(
      initialState,
      {
        type: 'CUSTOM',
        name: 'agenthub.manager.status',
        runId: 'run-1',
        threadId: 'group-1',
        value: {
          action: 'observe_resources',
          status: 'thinking',
          actorAgentId: 'orch-1',
          actorName: 'Orchestrator',
          resourceSnapshot: {
            run: { status: 'planning' },
            tasks: [
              {
                id: 'task-1',
                agentId: 'agent-1',
                title: 'Clarify scope',
              },
            ],
            taskThreads: [
              {
                id: 'thread-prepared-1',
                taskId: 'task-1',
                sessionId: 'child-prepared-1',
                workerInstanceId: null,
                status: 'prepared',
              },
            ],
            artifacts: [],
            runtimeLeases: [],
          },
        },
      },
      'group-1',
    )

    expect(nextState.taskBoard?.tasks[0]).toMatchObject({
      id: 'task-1',
      childSessionId: 'child-prepared-1',
      taskThreadId: 'thread-prepared-1',
      taskThreadStatus: 'prepared',
    })
    expect(nextState.agentTabs[0]).toMatchObject({
      taskId: 'task-1',
      childSessionId: 'child-prepared-1',
      taskThreadStatus: 'prepared',
      status: 'pending',
    })
    const child = nextState.sessions.find((item: Session) => item.id === 'child-prepared-1')
    expect(child?.workspaceAgentId).toBeNull()
    expect(child?.metadata).toMatchObject({
      kind: 'orchestrator-task',
      groupSessionId: 'group-1',
      orchestratorRunId: 'run-1',
      orchestratorTaskId: 'task-1',
      taskThreadId: 'thread-prepared-1',
      taskThreadStatus: 'prepared',
    })
  })

  test('task room code-agent progress restores the live run preview card', () => {
    const projection = __chatStoreTestHooks.applyRoomRuntimeProjection(
      {
        agentTyping: false,
        agentActivity: null,
        streamingMessage: null,
        streamingCodeAgentRun: null,
      },
      {
        room: {
          id: 'task-room-1',
          provider: 'matrix',
          providerRoomId: '!task-room-1:test',
          kind: 'task',
          ownerId: 'user-1',
          workspaceId: 'workspace-1',
          sessionId: 'child-session-1',
          runId: 'run-1',
          taskId: 'task-1',
          taskThreadId: 'thread-1',
          title: '任务：实现页面',
          topic: null,
          status: 'active',
          metadata: {},
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
        event: {
          id: 'event-progress-1',
          roomId: 'task-room-1',
          providerEventId: '$event-progress-1',
          senderParticipantId: 'participant-worker-1',
          senderType: 'worker',
          type: 'task.progress',
          body: '运行命令：bun test',
          metadata: {
            kind: 'worker-runtime.progress',
            type: 'code-agent-run',
            status: 'running',
            runtime: 'claude-code',
            command: 'claude run',
            durationMs: 1200,
            exitCode: 0,
            workspaceAgentId: 'agent-1',
            steps: [
              {
                id: 'step-1',
                kind: 'command',
                status: 'running',
                title: '运行命令',
                command: 'bun test',
              },
            ],
          },
          sequence: 8,
          createdAt: '2026-06-03T00:00:00.000Z',
        },
        participantsById: new Map([
          [
            'participant-worker-1',
            {
              id: 'participant-worker-1',
              roomId: 'task-room-1',
              providerUserId: '@worker:agenthub.local',
              participantType: 'worker',
              userId: null,
              workspaceAgentId: 'agent-1',
              workerInstanceId: 'worker-instance-1',
              displayName: '全栈工程师',
              role: 'member',
              status: 'joined',
              metadata: {},
              joinedAt: '2026-06-03T00:00:00.000Z',
              updatedAt: '2026-06-03T00:00:00.000Z',
            },
          ],
        ]),
      },
    )

    expect(projection.streamingMessage).toMatchObject({
      id: 'room-runtime:event-progress-1',
      agentId: 'agent-1',
      agentName: '全栈工程师',
    })
    expect(projection.streamingCodeAgentRun).toMatchObject({
      type: 'code-agent-run',
      status: 'running',
      runtime: 'claude-code',
      command: 'claude run',
    })
  })

  test('group room timeline events update streamingCodeAgentRun but do not create a floating streamingMessage', () => {
    const projection = __chatStoreTestHooks.applyRoomRuntimeProjection(
      {
        agentTyping: false,
        agentActivity: null,
        streamingMessage: null,
        streamingCodeAgentRun: null,
      },
      {
        room: {
          id: 'group-room-1',
          provider: 'matrix',
          providerRoomId: '!group-room-1:test',
          kind: 'group',
          ownerId: 'user-1',
          workspaceId: 'workspace-1',
          sessionId: 'group-session-1',
          runId: 'run-1',
          taskId: null,
          taskThreadId: null,
          title: 'Project 群聊',
          topic: null,
          status: 'active',
          metadata: {},
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:00:00.000Z',
        },
        event: {
          id: 'event-progress-2',
          roomId: 'group-room-1',
          providerEventId: '$event-progress-2',
          senderParticipantId: 'participant-worker-1',
          senderType: 'worker',
          type: 'task.progress',
          body: '运行命令：bun test',
          metadata: {
            kind: 'worker-runtime.progress',
            type: 'code-agent-run',
            status: 'running',
            runtime: 'claude-code',
            command: 'claude run',
          },
          sequence: 9,
          createdAt: '2026-06-03T00:00:00.000Z',
        },
        participantsById: new Map(),
      },
    )

    // group chat text streams via room timeline messages — no floating streamingMessage bubble
    expect(projection.streamingMessage).toBeNull()
    // but the execution process card should update live
    expect(projection.streamingCodeAgentRun).not.toBeNull()
    expect(projection.streamingCodeAgentRun?.status).toBe('running')
    expect(projection.streamingCodeAgentRun?.runtime).toBe('claude-code')
  })

  test('task status event reprojects sessions and tabs from task thread semantics without resource snapshot', () => {
    const initialState = {
      sessions: [
        session({
          id: 'group-1',
          title: 'Build group',
          type: SessionType.Group,
          workspaceId: 'workspace-1',
        }),
      ],
      currentSession: session({
        id: 'group-1',
        title: 'Build group',
        type: SessionType.Group,
        workspaceId: 'workspace-1',
      }),
      currentWorkspace: null,
      currentWorkspaceAgents: [],
      currentSessionId: 'group-1',
      messages: [],
      streamingMessage: null,
      streamingCodeAgentRun: null,
      pendingAttachments: [],
      safetyMode: 'ask',
      loadingSessions: false,
      loadingMessages: false,
      agentTyping: false,
      agentActivity: null,
      replyingToMessageId: null,
      replyingToMessage: null,
      sessionsBootstrapped: true,
      taskBoard: {
        runId: 'run-1',
        title: 'Demo',
        goal: 'Goal',
        collaborationMode: 'pipeline',
        sessionId: 'group-1',
        status: 'running',
        phases: [],
        tasks: [
          {
            id: 'task-1',
            phaseId: 'implementation',
            title: 'Build page',
            description: 'Implement page',
            agentId: 'agent-1',
            agentName: 'Builder',
            status: 'pending',
            dependencies: [],
            childSessionId: null,
            artifacts: [],
          },
        ],
      },
      previewUrl: null,
      previewFileName: null,
      selectedAgentTab: null,
      agentTabs: [],
    } as any

    const nextState = __chatStoreTestHooks.applyAgUiEventToState(
      initialState,
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId: 'run-1',
        threadId: 'group-1',
        value: {
          taskId: 'task-1',
          status: 'running',
          taskThreadStatus: 'active',
          taskThreadId: 'thread-1',
          childSessionId: 'child-1',
          workerInstanceId: 'worker-1',
          agentId: 'agent-1',
          agentName: 'Builder',
          taskTitle: 'Build page',
        },
      },
      'group-1',
    )

    expect(nextState.taskBoard?.tasks[0]).toMatchObject({
      id: 'task-1',
      status: 'running',
      taskThreadStatus: 'active',
      taskThreadId: 'thread-1',
      childSessionId: 'child-1',
      workerInstanceId: 'worker-1',
    })
    expect(nextState.agentTabs[0]).toMatchObject({
      taskId: 'task-1',
      status: 'running',
      taskThreadStatus: 'active',
      childSessionId: 'child-1',
      workerInstanceId: 'worker-1',
    })
    const child = nextState.sessions.find((item: Session) => item.id === 'child-1')
    expect(child?.workspaceAgentId).toBe('agent-1')
    expect(child?.metadata).toMatchObject({
      kind: 'orchestrator-task',
      taskThreadId: 'thread-1',
      taskThreadStatus: 'active',
      workerInstanceId: 'worker-1',
      orchestratorTaskId: 'task-1',
    })
  })

  test('room timeline task event creates a minimal task board and child session without an existing snapshot', () => {
    const group = session({
      id: 'group-room-1',
      title: 'Room-first group',
      type: SessionType.Group,
      workspaceId: 'workspace-room-1',
    })
    const initialState = {
      sessions: [group],
      currentSession: group,
      currentWorkspace: null,
      currentWorkspaceAgents: [],
      currentSessionId: group.id,
      messages: [],
      streamingMessage: null,
      streamingCodeAgentRun: null,
      pendingAttachments: [],
      safetyMode: 'ask',
      loadingSessions: false,
      loadingMessages: false,
      agentTyping: false,
      agentActivity: null,
      replyingToMessageId: null,
      replyingToMessage: null,
      replyingToKind: 'reply',
      sessionsBootstrapped: true,
      taskBoard: null,
      previewUrl: null,
      previewFileName: null,
      selectedAgentTab: null,
      agentTabs: [],
    } as any

    const nextState = __chatStoreTestHooks.applyAgUiEventToState(
      initialState,
      {
        type: 'CUSTOM',
        name: 'agenthub.task.status',
        runId: 'run-room-1',
        threadId: 'child-room-1',
        value: {
          taskId: 'task-room-1',
          status: 'assigned',
          taskThreadStatus: 'assigned',
          taskThreadId: 'thread-room-1',
          childSessionId: 'child-room-1',
          workerInstanceId: 'worker-room-1',
          agentId: 'agent-room-1',
          agentName: 'Builder',
          taskTitle: 'Build report',
          taskDescription: 'Generate the first report.',
          roomId: 'room-task-1',
        },
      },
      group.id,
    )

    expect(nextState.taskBoard).toMatchObject({
      runId: 'run-room-1',
      sessionId: group.id,
      status: 'running',
      collaborationMode: 'room-timeline',
    })
    expect(nextState.taskBoard?.tasks[0]).toMatchObject({
      id: 'task-room-1',
      title: 'Build report',
      status: 'assigned',
      taskThreadStatus: 'assigned',
      taskThreadId: 'thread-room-1',
      childSessionId: 'child-room-1',
      workerInstanceId: 'worker-room-1',
      agentId: 'agent-room-1',
      agentName: 'Builder',
    })
    expect(nextState.agentTabs[0]).toMatchObject({
      taskId: 'task-room-1',
      status: 'assigned',
      childSessionId: 'child-room-1',
      taskThreadStatus: 'assigned',
    })
    const child = nextState.sessions.find((item: Session) => item.id === 'child-room-1')
    expect(child).toMatchObject({
      type: SessionType.Direct,
      workspaceId: 'workspace-room-1',
      workspaceAgentId: 'agent-room-1',
    })
    expect(child?.metadata).toMatchObject({
      kind: 'orchestrator-task',
      groupSessionId: group.id,
      orchestratorRunId: 'run-room-1',
      orchestratorTaskId: 'task-room-1',
      taskThreadId: 'thread-room-1',
      workerInstanceId: 'worker-room-1',
      taskThreadStatus: 'assigned',
    })
  })

  test('control panel projection reflects executing agent activity on top of task board tabs', () => {
    const projection = __chatStoreTestHooks.buildControlPanelProjection({
      taskBoard: {
        runId: 'run-1',
        title: 'Demo',
        goal: 'Goal',
        collaborationMode: 'pipeline',
        sessionId: 'group-1',
        status: 'running',
        phases: [],
        tasks: [
          {
            id: 'task-1',
            phaseId: 'implementation',
            title: 'Research AI tools',
            description: 'Investigate current tools',
            agentId: 'agent-1',
            agentName: 'Researcher',
            status: 'assigned',
            dependencies: [],
            childSessionId: 'child-1',
            artifacts: [],
          },
        ],
      } as any,
      agentTabs: [
        {
          taskId: 'task-1',
          agentId: 'agent-1',
          agentName: 'Researcher',
          taskTitle: 'Research AI tools',
          status: 'assigned',
          childSessionId: 'child-1',
        },
      ],
      agentTyping: true,
      agentActivity: {
        sessionId: 'group-1',
        agentId: 'agent-1',
        agentName: 'Researcher',
        phase: 'executing',
        startedAt: '2026-06-03T00:00:00.000Z',
      },
    })

    expect(projection).toBeTruthy()
    expect(projection?.activeAgentCount).toBe(1)
    expect(projection?.tabs[0]?.status).toBe('running')
    expect(projection?.currentActivity).toEqual({
      agentName: 'Researcher',
      detail: 'Worker 正在执行任务',
      label: '正在执行任务',
      phase: 'executing',
    })
  })

  test('task board panel projection derives phase counters and task result badges from task board state', () => {
    const projection = __chatStoreTestHooks.buildTaskBoardPanelProjection({
      runId: 'run-1',
      title: 'Demo',
      goal: 'Goal',
      collaborationMode: 'pipeline',
      sessionId: 'group-1',
      status: 'running',
      phases: [
        {
          id: 'implementation',
          title: '实现',
          purpose: '完成实现',
          taskIds: ['task-1', 'task-2'],
          status: 'active',
        },
      ],
      tasks: [
        {
          id: 'task-1',
          phaseId: 'implementation',
          title: 'Build page',
          description: 'Implement the page',
          agentId: 'agent-1',
          agentName: 'Builder',
          status: 'running',
          progress: 82,
          dependencies: [],
          childSessionId: 'child-1',
          taskThreadId: 'thread-1',
          workerInstanceId: 'worker-1',
          runtimeLeaseId: 'lease-1',
          artifactCount: 2,
          artifacts: [
            { artifactId: 'artifact-1', title: 'report.html', filePath: 'deliverables/report.html' },
          ],
          outputSummary: 'Generated deliverables.',
          validationStatus: 'passed',
          executionConfig: {
            adapterName: 'OpenCode',
            modelLabel: 'kimi-k2',
          },
        },
        {
          id: 'task-2',
          phaseId: 'implementation',
          title: 'Verify build',
          description: 'Verify the page',
          agentId: 'agent-2',
          agentName: 'QA',
          status: 'done',
          dependencies: ['task-1'],
          resultError: undefined,
          artifacts: [],
        },
      ],
    } as any)

    expect(projection).toBeTruthy()
    expect(projection?.taskCount).toBe(2)
    expect(projection?.phaseCount).toBe(1)
    expect(projection?.hasFailedTasks).toBe(false)
    expect(projection?.emptyStateLabel).toBe('暂无阶段信息')
    expect(projection?.phases[0]?.completedTaskCount).toBe(1)
    expect(projection?.phases[0]?.totalTaskCount).toBe(2)
    expect(projection?.phases[0]?.tasks[0]).toMatchObject({
      artifactCountResolved: 2,
      hasResultLine: true,
      progressTone: 'green',
      statusTone: 'running',
      validationStatus: 'passed',
    })
    expect(projection?.phases[0]?.tasks[1]).toMatchObject({
      artifactCountResolved: 0,
      hasResultLine: false,
      statusTone: 'default',
    })
  })

  test('blocked task threads keep stable worker child-session titles', () => {
    const sessions = [
      session({
        id: 'group-1',
        title: 'AI team',
        type: SessionType.Group,
        workspaceId: 'workspace-1',
      }),
    ]

    const nextSessions = __chatStoreTestHooks.buildOptimisticOrchestratorTaskSessions(
      {
        sessions,
        currentSession: sessions[0] ?? null,
      },
      {
        runId: 'run-1',
        title: 'Demo',
        goal: 'Goal',
        collaborationMode: 'pipeline',
        sessionId: 'group-1',
        status: 'running',
        phases: [
          {
            id: 'analysis',
            title: '分析',
            purpose: '澄清问题',
            taskIds: ['task-1'],
            status: 'active',
          },
        ],
        tasks: [
          {
            id: 'task-1',
            phaseId: 'analysis',
            title: 'Research market',
            description: 'Investigate and ask for clarification',
            agentId: 'agent-1',
            agentName: 'Researcher',
            status: 'blocked',
            dependencies: [],
            childSessionId: 'child-1',
            taskThreadId: 'thread-1',
            taskThreadStatus: 'active',
            artifacts: [],
          },
        ],
      } as any,
    )

    const child = nextSessions.find((item) => item.id === 'child-1')
    expect(child?.title).toBe('Researcher · Research market')
    expect(child?.workspaceAgentId).toBe('agent-1')
    expect((child?.metadata as Record<string, unknown>)?.taskThreadStatus).toBe('active')
  })
})
