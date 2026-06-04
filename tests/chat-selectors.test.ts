import { describe, expect, test } from 'bun:test'
import type { Message, Session } from '../apps/web/src/lib/api'
import type { ChatState } from '../apps/web/src/stores/chatStore'
import {
  makeSelectMessageById,
  makeSelectMessageWithQuoteSource,
  makeSelectSessionExists,
} from '../apps/web/src/stores/chatSelectors'
import { MessageType, SenderType, SessionType } from '../packages/shared/src/index'

function message(partial: Partial<Message> & Pick<Message, 'id' | 'content'>): Message {
  return {
    id: partial.id,
    sessionId: 'session-1',
    senderId: 'user-1',
    senderType: SenderType.User,
    type: MessageType.Text,
    metadata: null,
    createdAt: '2026-06-04T00:00:00.000Z',
    ...partial,
  }
}

function session(partial: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    id: partial.id,
    ownerId: 'user-1',
    title: 'Session',
    type: SessionType.Direct,
    workspaceId: null,
    workspaceAgentId: null,
    metadata: null,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    lastMessage: null,
    ...partial,
  }
}

describe('chat store selectors', () => {
  test('selects a single message by id without changing the message reference', () => {
    const target = message({ id: 'message-2', content: 'target' })
    const state = {
      messages: [
        message({ id: 'message-1', content: 'before' }),
        target,
        message({ id: 'message-3', content: 'after' }),
      ],
    } as ChatState

    expect(makeSelectMessageById('message-2')(state)).toBe(target)
    expect(makeSelectMessageById('missing')(state)).toBeUndefined()
  })

  test('selects only the message and its quote source for quoted rendering', () => {
    const source = message({ id: 'source', content: 'quoted content' })
    const reply = message({
      id: 'reply',
      content: 'reply content',
      replyToMessageId: source.id,
    })
    const state = {
      messages: [source, reply],
    } as ChatState

    expect(makeSelectMessageWithQuoteSource(reply.id)(state)).toEqual({
      message: reply,
      quotedSourceMessage: source,
    })
  })

  test('selects route session existence as a boolean', () => {
    const state = {
      sessions: [session({ id: 'session-1' })],
    } as ChatState

    expect(makeSelectSessionExists('session-1')(state)).toBe(true)
    expect(makeSelectSessionExists('missing')(state)).toBe(false)
    expect(makeSelectSessionExists(null)(state)).toBe(false)
  })
})
