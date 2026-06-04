import { describe, expect, test } from 'bun:test'
import type { Message, Session } from '../apps/web/src/lib/api'
import { SessionType } from '../apps/web/src/lib/api'
import { filterSessionTree, buildSessionTree } from '../apps/web/src/lib/sessionTree'
import {
  makeSelectMessageById,
  selectHeaderAgentStatus,
  selectRuntimeState,
  selectSessionListState,
  selectThreadShellState,
} from '../apps/web/src/stores/chatSelectors'
import { __runtimeTestHooks } from '../apps/web/src/lib/runtime'
import { MessageType, SenderType } from '../packages/shared/src/index'

const sessionCount = 50
const taskChildCount = 20
const messageCount = 1000
const switchSampleCount = 60
const medianBudgetMs = Number(process.env.AGENTHUB_CHAT_SWITCH_MEDIAN_BUDGET_MS ?? 25)
const p95BudgetMs = Number(process.env.AGENTHUB_CHAT_SWITCH_P95_BUDGET_MS ?? 80)

function session(partial: Partial<Session> & Pick<Session, 'id' | 'title' | 'type'>): Session {
  return {
    ownerId: 'user-1',
    workspaceId: null,
    workspaceAgentId: null,
    metadata: null,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    lastMessage: null,
    ...partial,
  }
}

function message(partial: Partial<Message> & Pick<Message, 'id' | 'sessionId' | 'content'>): Message {
  return {
    senderId: 'user-1',
    senderType: SenderType.User,
    type: MessageType.Text,
    metadata: null,
    createdAt: '2026-06-04T00:00:00.000Z',
    ...partial,
  }
}

function makeSessions() {
  const group = session({
    id: 'group-main',
    title: 'Performance group',
    type: SessionType.Group,
    workspaceId: 'workspace-1',
    updatedAt: '2026-06-04T00:10:00.000Z',
  })
  const taskChildren = Array.from({ length: taskChildCount }, (_, index) =>
    session({
      id: `task-child-${index + 1}`,
      title: `Performance group / Task ${index + 1}`,
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: `agent-${index + 1}`,
      metadata: {
        kind: 'orchestrator-task',
        groupSessionId: group.id,
        orchestratorRunId: 'run-performance',
        orchestratorTaskId: `task-${index + 1}`,
        taskThreadId: `thread-${index + 1}`,
        taskThreadStatus: index % 3 === 0 ? 'active' : 'completed',
      },
      updatedAt: `2026-06-04T00:09:${String(59 - index).padStart(2, '0')}.000Z`,
    }),
  )
  const agentDirects = Array.from({ length: sessionCount - taskChildCount - 1 }, (_, index) =>
    session({
      id: `agent-direct-${index + 1}`,
      title: `Agent direct ${index + 1}`,
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: `direct-agent-${index + 1}`,
      metadata: {
        kind: 'agent-direct',
        savedAgentId: `saved-agent-${index + 1}`,
      },
      updatedAt: `2026-06-04T00:08:${String(59 - index).padStart(2, '0')}.000Z`,
    }),
  )
  return [group, ...taskChildren, ...agentDirects]
}

function makeTaskBoard() {
  return {
    runId: 'run-performance',
    title: 'Performance plan',
    goal: 'Measure switching under a long chat and many task child conversations',
    collaborationMode: 'pipeline',
    sessionId: 'group-main',
    status: 'running',
    phases: [
      {
        id: 'implementation',
        title: 'Implementation',
        purpose: 'Run the tasks',
        taskIds: Array.from({ length: taskChildCount }, (_, index) => `task-${index + 1}`),
        status: 'active',
      },
    ],
    tasks: Array.from({ length: taskChildCount }, (_, index) => ({
      id: `task-${index + 1}`,
      phaseId: 'implementation',
      title: `Task ${index + 1}`,
      description: `Task ${index + 1} description`,
      agentId: `agent-${index + 1}`,
      agentName: `Agent ${index + 1}`,
      status: index % 3 === 0 ? 'running' : 'done',
      progress: index % 3 === 0 ? 50 : 100,
      progressStatus: index % 3 === 0 ? 'Working' : 'Completed',
      dependencies: index === 0 ? [] : [`task-${index}`],
      childSessionId: `task-child-${index + 1}`,
      taskThreadId: `thread-${index + 1}`,
      taskThreadStatus: index % 3 === 0 ? 'active' : 'completed',
      workerInstanceId: `worker-${index + 1}`,
      artifactCount: index % 2 === 0 ? 1 : 0,
      artifacts:
        index % 2 === 0
          ? [
              {
                artifactId: `artifact-${index + 1}`,
                title: `artifact-${index + 1}.html`,
                filePath: `dist/task-${index + 1}/index.html`,
                artifactKind: 'file',
              },
            ]
          : [],
    })),
  }
}

function makeMessages(sessionId: string): Message[] {
  return Array.from({ length: messageCount }, (_, index) => {
    const isAgent = index % 2 === 1
    const hasArtifact = isAgent && index % 25 === 1
    const hasRun = isAgent && index % 50 === 1
    return message({
      id: `${sessionId}-message-${index + 1}`,
      sessionId,
      senderId: isAgent ? 'agent-1' : 'user-1',
      senderType: isAgent ? SenderType.Agent : SenderType.User,
      content: `${isAgent ? 'Agent' : 'User'} message ${index + 1} with enough markdown text to exercise projection.`,
      metadata: {
        ...(isAgent ? { agentName: 'Performance Agent' } : {}),
        ...(hasArtifact
          ? {
              artifacts: [
                {
                  id: `${sessionId}-artifact-${index + 1}`,
                  type: 'file',
                  title: `report-${index + 1}.docx`,
                  path: `reports/report-${index + 1}.docx`,
                  status: 'created',
                  mimeType:
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                },
              ],
              file_card: {
                files: [
                  {
                    fileName: `report-${index + 1}.docx`,
                    filePath: `reports/report-${index + 1}.docx`,
                    fileSize: 2048,
                    runId: 'run-performance',
                    workspaceId: 'workspace-1',
                  },
                ],
              },
            }
          : {}),
        ...(hasRun
          ? {
              codeAgentRun: {
                type: 'code-agent-run',
                status: 'completed',
                runtime: 'claude-code',
                command: 'claude',
                cwd: 'F:/Learning/AgentHub/workspaces/performance',
                durationMs: 1200,
                exitCode: 0,
                commands: [],
                files: [],
                logs: [],
                steps: [],
                toolCalls: [],
                artifacts: [],
                finalMessage: `Completed message ${index + 1}`,
              },
            }
          : {}),
      },
      createdAt: `2026-06-04T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    })
  })
}

function percentile(sorted: number[], value: number) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * value) - 1))
  return sorted[index] ?? 0
}

function projectSwitch(state: any, targetSession: Session, messages: Message[]) {
  const selectedTaskId =
    targetSession.metadata?.kind === 'orchestrator-task'
      ? (targetSession.metadata.orchestratorTaskId as string)
      : null
  const nextState = {
    ...state,
    currentSessionId: targetSession.id,
    currentSession: targetSession,
    messages,
    selectedAgentTab: selectedTaskId,
  }

  const sessionTree = filterSessionTree(buildSessionTree(nextState.sessions), '', false, new Set())
  const runtimeState = selectRuntimeState(nextState)
  const threadMessages = runtimeState.messages.map(__runtimeTestHooks.toThreadMessage)
  const shellState = selectThreadShellState(nextState)
  const listState = selectSessionListState(nextState)
  const headerStatus = selectHeaderAgentStatus(nextState)
  const visibleMessageIds = [
    messages[0]?.id,
    messages[10]?.id,
    messages[100]?.id,
    messages[500]?.id,
    messages[999]?.id,
  ].filter((id): id is string => Boolean(id))
  const visibleMessages = visibleMessageIds.map((id) => makeSelectMessageById(id)(nextState))

  return {
    agentTabs: shellState.agentTabs.length,
    headerStatus: headerStatus.label,
    messages: threadMessages.length,
    selectedSession: listState.currentSessionId,
    sessionGroups: sessionTree.length,
    visibleMessages: visibleMessages.length,
  }
}

describe('chat switching performance baseline', () => {
  test('keeps switch projection responsive with 1000 messages, 50 sessions and 20 task child conversations', () => {
    const sessions = makeSessions()
    const taskBoard = makeTaskBoard()
    const messagesBySession = new Map(sessions.map((item) => [item.id, makeMessages(item.id)]))
    const baseState = {
      sessions,
      currentSession: sessions[0],
      currentWorkspace: null,
      currentWorkspaceAgents: [],
      currentSessionId: sessions[0]?.id,
      messages: messagesBySession.get(sessions[0]?.id ?? '') ?? [],
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
      taskBoard,
      previewUrl: null,
      previewFileName: null,
      selectedAgentTab: null,
      agentTabs: taskBoard.tasks.map((task) => ({
        taskId: task.id,
        agentId: task.agentId,
        agentName: task.agentName,
        taskTitle: task.title,
        status: task.status === 'running' ? 'running' : 'done',
        childSessionId: task.childSessionId,
        taskThreadStatus: task.taskThreadStatus,
        workerInstanceId: task.workerInstanceId,
      })),
    }
    const targets = [
      sessions[0],
      ...sessions.filter((item) => item.metadata?.kind === 'orchestrator-task'),
      ...sessions.filter((item) => item.metadata?.kind === 'agent-direct').slice(0, 9),
    ].filter((item): item is Session => Boolean(item))

    for (const target of targets.slice(0, 5)) {
      projectSwitch(baseState, target, messagesBySession.get(target.id) ?? [])
    }

    const samples: number[] = []
    let lastProjection: ReturnType<typeof projectSwitch> | null = null
    for (let index = 0; index < switchSampleCount; index += 1) {
      const target = targets[index % targets.length]!
      const messages = messagesBySession.get(target.id) ?? []
      const start = performance.now()
      lastProjection = projectSwitch(baseState, target, messages)
      samples.push(performance.now() - start)
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const median = percentile(sorted, 0.5)
    const p95 = percentile(sorted, 0.95)
    const max = sorted[sorted.length - 1] ?? 0
    console.info(
      [
        'chat-switch-baseline',
        `messages=${messageCount}`,
        `sessions=${sessionCount}`,
        `taskChildren=${taskChildCount}`,
        `samples=${switchSampleCount}`,
        `median=${median.toFixed(2)}ms`,
        `p95=${p95.toFixed(2)}ms`,
        `max=${max.toFixed(2)}ms`,
      ].join(' '),
    )

    expect(sessions).toHaveLength(sessionCount)
    expect(sessions.filter((item) => item.metadata?.kind === 'orchestrator-task')).toHaveLength(
      taskChildCount,
    )
    expect(lastProjection).toMatchObject({
      agentTabs: taskChildCount,
      messages: messageCount,
      selectedSession: expect.any(String),
    })
    expect(lastProjection?.sessionGroups).toBe(sessionCount - taskChildCount)
    expect(median).toBeLessThanOrEqual(medianBudgetMs)
    expect(p95).toBeLessThanOrEqual(p95BudgetMs)
  })
})
