import { describe, expect, test } from 'bun:test'

import { MatrixClient } from '../apps/server/src/services/rooms/matrix-client'

const maxMatrixClientPayloadBytes = 48_000
const encoder = new TextEncoder()

describe('MatrixClient message payload sizing', () => {
  test('truncates oversized text and metadata before sending to Matrix', async () => {
    const requestBody = await captureMatrixSendBody((client) =>
      client.sendTextMessage(
        '!room:agenthub.local',
        'content '.repeat(40_000),
        {
          kind: 'worker-runtime.completed',
          workspaceId: 'workspace-1',
          workspaceAgentId: 'agent-1',
          workerInstanceId: 'worker-1',
          traceId: 'trace-1',
          result: 'result '.repeat(40_000),
          artifacts: Array.from({ length: 500 }, (_, index) => ({
            path: `artifact-${index}.md`,
            summary: 'artifact summary '.repeat(50),
          })),
        },
      ),
    )

    expect(byteLength(requestBody)).toBeLessThanOrEqual(maxMatrixClientPayloadBytes)
    const parsed = JSON.parse(requestBody) as Record<string, unknown>
    expect(parsed.body).toContain('Matrix event was truncated')
    expect(parsed['org.agenthub.metadata']).toMatchObject({
      kind: 'worker-runtime.completed',
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
      workerInstanceId: 'worker-1',
      traceId: 'trace-1',
    })
    expect(String(requestBody)).not.toContain('artifact-499.md')
  })

  test('keeps mention messages below the Matrix PDU safety budget', async () => {
    const requestBody = await captureMatrixSendBody((client) =>
      client.sendMentionMessage(
        '!room:agenthub.local',
        {
          body: 'Please handle this task. '.repeat(30_000),
          mentionUserId: '@worker-1:agenthub.local',
          mentionDisplayName: 'Worker',
          metadata: {
            kind: 'manager.assign.dispatched',
            mentionParticipantId: 'participant-1',
            workspaceAgentId: 'agent-1',
            workerInstanceId: 'worker-1',
            taskId: 'task-1',
            taskDescription: 'task description '.repeat(30_000),
          },
        },
      ),
    )

    expect(byteLength(requestBody)).toBeLessThanOrEqual(maxMatrixClientPayloadBytes)
    const parsed = JSON.parse(requestBody) as Record<string, unknown>
    expect(parsed.body).toContain('@Worker')
    expect(parsed.body).toContain('Matrix event was truncated')
    expect(parsed.formatted_body).toContain('matrix.to/#/@worker-1:agenthub.local')
    expect(parsed['org.agenthub.metadata']).toMatchObject({
      kind: 'manager.assign.dispatched',
      mentionParticipantId: 'participant-1',
      workspaceAgentId: 'agent-1',
      workerInstanceId: 'worker-1',
      taskId: 'task-1',
    })
  })
})

async function captureMatrixSendBody(send: (client: MatrixClient) => Promise<unknown>) {
  const originalFetch = globalThis.fetch
  let requestBody = ''
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = typeof init?.body === 'string' ? init.body : ''
    return new Response(JSON.stringify({ event_id: '$event' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const client = new MatrixClient({
      homeserverUrl: 'http://matrix.local',
      serverName: 'agenthub.local',
      adminAccessToken: 'token',
      autoInviteParticipants: true,
      autoJoinParticipants: true,
    })
    await send(client)
    return requestBody
  } finally {
    globalThis.fetch = originalFetch
  }
}

function byteLength(value: string) {
  return encoder.encode(value).length
}
