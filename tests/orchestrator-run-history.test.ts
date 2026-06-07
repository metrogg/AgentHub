import './setup'
import { describe, expect, test } from 'bun:test'

const { app } = await import('../apps/server/src/app')
const {
  db,
  roomParticipants,
  rooms,
  sessions,
  timelineEvents,
  workspaceAgents,
  workspaces,
} = await import('../packages/db/src/index')

describe('run history', () => {
  test('includes direct room worker runtime completions', async () => {
    const [workspace] = await db
      .insert(workspaces)
      .values({
        ownerId: 'default-user',
        name: 'Direct History Workspace',
        goal: 'Check direct history',
      })
      .returning()
    expect(workspace).toBeTruthy()

    const [agent] = await db
      .insert(workspaceAgents)
      .values({
        workspaceId: workspace!.id,
        name: 'Direct Builder',
        role: 'Builder',
        roleType: 'coder',
        codeAgentType: 'claude-code',
      })
      .returning()
    expect(agent).toBeTruthy()

    const [session] = await db
      .insert(sessions)
      .values({
        ownerId: 'default-user',
        title: 'Direct Builder',
        type: 'direct',
        workspaceId: workspace!.id,
        workspaceAgentId: agent!.id,
        metadata: { kind: 'agent-direct' },
      })
      .returning()
    expect(session).toBeTruthy()

    const [room] = await db
      .insert(rooms)
      .values({
        providerRoomId: `!direct-history-${crypto.randomUUID()}:agenthub.local`,
        kind: 'direct',
        ownerId: 'default-user',
        workspaceId: workspace!.id,
        sessionId: session!.id,
        title: 'Direct Builder',
      })
      .returning()
    expect(room).toBeTruthy()

    const [participant] = await db
      .insert(roomParticipants)
      .values({
        roomId: room!.id,
        participantType: 'worker',
        workspaceAgentId: agent!.id,
        displayName: agent!.name,
        role: 'member',
      })
      .returning()
    expect(participant).toBeTruthy()

    const [event] = await db
      .insert(timelineEvents)
      .values({
        roomId: room!.id,
        providerEventId: `$direct-history-${crypto.randomUUID()}`,
        senderParticipantId: participant!.id,
        senderType: 'worker',
        type: 'worker.message',
        body: '',
        sequence: 1,
        metadata: {
          kind: 'worker-runtime.completed',
          status: 'completed',
          workspaceAgentId: agent!.id,
          runtimeType: 'claude-code',
          codeAgentRun: {
            type: 'code-agent-run',
            status: 'completed',
            runtime: 'claude-code',
            command: 'claude --print',
            durationMs: 1200,
            exitCode: 0,
            finalMessage: 'Direct run complete.',
            commands: [],
            files: [{ path: 'index.html', status: 'modified' }],
            toolCalls: [],
            artifacts: [],
            steps: [{ id: 'step-1', kind: 'file', status: 'completed', title: 'index.html' }],
          },
        },
      })
      .returning()
    expect(event).toBeTruthy()

    const response = await app.request('/api/orchestrator-runs')
    expect(response.status).toBe(200)
    const body = await response.json() as {
      items: Array<{
        id: string
        source?: string
        workspaceName: string
        sessionTitle: string
        plan?: { tasks?: Array<{ title: string }> }
      }>
    }

    const directRun = body.items.find((item) => item.id === `direct-runtime:${event!.id}`)
    expect(directRun).toMatchObject({
      source: 'direct-runtime',
      workspaceName: 'Direct History Workspace',
      sessionTitle: 'Direct Builder',
    })
    expect(directRun?.plan?.tasks?.[0]?.title).toContain('Direct Builder')
  })
})
