import { describe, expect, test } from 'bun:test'
import { MessageType, SenderType } from '../packages/shared/src/index'
import type { Message } from '../apps/web/src/lib/api'
import { __runtimeTestHooks } from '../apps/web/src/lib/runtime'

function message(partial: Partial<Message> & Pick<Message, 'id' | 'content'>): Message {
  return {
    id: partial.id,
    sessionId: 'session-1',
    senderId: 'system',
    senderType: SenderType.System,
    type: MessageType.Text,
    content: partial.content,
    metadata: null,
    createdAt: '2026-06-04T04:38:00.000Z',
    ...partial,
  }
}

describe('assistant runtime message projection', () => {
  test('keeps planning failure artifact cards on system messages', () => {
    const threadMessage = __runtimeTestHooks.toThreadMessage(
      message({
        id: 'message-1',
        content: 'Orchestrator planning failed but generated a document.',
        metadata: {
          systemEvent: 'orchestrator_plan_failed',
          artifacts: [
            {
              id: 'artifact-1',
              type: 'file',
              title: 'agent-notes.docx',
              path: 'deliverables/agent-notes.docx',
              status: 'created',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              size: 1024,
            },
          ],
          file_card: {
            files: [
              {
                fileName: 'agent-notes.docx',
                filePath: 'deliverables/agent-notes.docx',
                fileSize: 1024,
                runId: 'run-1',
                workspaceId: 'workspace-1',
              },
            ],
          },
          delivery_report: {
            status: 'partial',
            runId: 'run-1',
            files: [{ name: 'agent-notes.docx', size: 1024, type: 'docx' }],
            checklist: [{ item: 'Recovered generated file from planning output', done: true }],
          },
        },
      }),
    )

    const dataParts = (threadMessage.content as any[]).filter((part) => part.type === 'data')
    expect(threadMessage.role).toBe('assistant')
    expect(dataParts.map((part) => part.name)).toEqual([
      'agent_artifacts',
      'file_card',
      'delivery_report',
    ])
    expect(dataParts.find((part) => part.name === 'file_card')?.data.files[0]).toMatchObject({
      fileName: 'agent-notes.docx',
      workspaceId: 'workspace-1',
    })
  })
})
