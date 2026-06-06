import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { api, type Message, type Session } from '../apps/web/src/lib/api'
import { useChatStore } from '../apps/web/src/stores/chatStore'
import { MessageType, SenderType, SessionType, WsEvent } from '../packages/shared/src/index'

const originalSendMessageWithModel = api.sendMessageWithModel
const originalListSessions = api.listSessions

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

function message(partial: Partial<Message> & Pick<Message, 'id' | 'sessionId' | 'content'>): Message {
  return {
    id: partial.id,
    sessionId: partial.sessionId,
    senderId: 'user-1',
    senderType: SenderType.User,
    type: MessageType.Text,
    metadata: null,
    createdAt: '2026-06-04T00:00:00.000Z',
    ...partial,
  }
}

function resetChatStore(activeSession: Session) {
  useChatStore.setState({
    sessions: [activeSession],
    currentSession: activeSession,
    currentSessionId: activeSession.id,
    currentWorkspace: null,
    currentWorkspaceAgents: [],
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
  })
}

beforeEach(() => {
  api.sendMessageWithModel = originalSendMessageWithModel
  api.listSessions = originalListSessions
})

afterEach(() => {
  api.sendMessageWithModel = originalSendMessageWithModel
  api.listSessions = originalListSessions
})

describe('chat store send message', () => {
  test('forwards mentioned agent ids to the message API', async () => {
    const activeSession = session({
      id: 'group-session-1',
      type: SessionType.Group,
      workspaceId: 'workspace-1',
    })
    resetChatStore(activeSession)

    let captured:
      | Parameters<typeof api.sendMessageWithModel>
      | null = null
    api.sendMessageWithModel = (async (...args: Parameters<typeof api.sendMessageWithModel>) => {
      captured = args
      return message({
        id: 'server-message-1',
        sessionId: args[0],
        content: args[1].content,
      })
    }) as typeof api.sendMessageWithModel
    api.listSessions = (async () => ({ items: [activeSession] })) as typeof api.listSessions

    await useChatStore
      .getState()
      .sendMessageToSession(activeSession.id, '@Builder please run', {
        mentions: ['agent-builder'],
      })

    expect(captured?.[0]).toBe(activeSession.id)
    expect(captured?.[1].mentions).toEqual(['agent-builder'])
  })

  test('keeps current runtime status when websocket events arrive before the send request settles', async () => {
    const activeSession = session({
      id: 'direct-session-1',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
    })
    resetChatStore(activeSession)

    api.sendMessageWithModel = (async (...args: Parameters<typeof api.sendMessageWithModel>) => {
      useChatStore.setState({
        agentTyping: true,
        agentActivity: {
          sessionId: args[0],
          agentId: 'agent-1',
          agentName: 'Builder',
          phase: 'replying',
          startedAt: '2026-06-04T00:00:00.000Z',
        },
      })
      return message({
        id: 'server-message-2',
        sessionId: args[0],
        content: args[1].content,
      })
    }) as typeof api.sendMessageWithModel
    api.listSessions = (async () => ({ items: [activeSession] })) as typeof api.listSessions

    await useChatStore.getState().sendMessageToSession(activeSession.id, 'hello')

    expect(useChatStore.getState().agentTyping).toBe(true)
    expect(useChatStore.getState().agentActivity?.phase).toBe('replying')
    expect(useChatStore.getState().agentActivity?.agentName).toBe('Builder')
  })

  test('does not clear live agent output when a user message completion event arrives', () => {
    const activeSession = session({
      id: 'direct-session-2',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
    })
    resetChatStore(activeSession)
    useChatStore.setState({
      agentTyping: false,
      agentActivity: null,
      streamingMessage: {
        id: 'agent-stream-1',
        content: 'partial output',
        agentId: 'agent-1',
        agentName: 'Builder',
      },
    })

    useChatStore.getState().handleWSEvent({
      type: 'message:completed',
      payload: {
        sessionId: activeSession.id,
        message: message({
          id: 'user-message-1',
          sessionId: activeSession.id,
          senderType: SenderType.User,
          content: 'hello',
        }),
      },
    })

    expect(useChatStore.getState().streamingMessage?.id).toBe('agent-stream-1')
    expect(useChatStore.getState().streamingMessage?.content).toBe('partial output')
  })

  test('dedupes optimistic user bubble when room timeline arrives before send resolves', async () => {
    const activeSession = session({
      id: 'direct-session-3',
      type: SessionType.Direct,
      workspaceId: 'workspace-1',
      workspaceAgentId: 'agent-1',
    })
    resetChatStore(activeSession)

    const roomMessage = message({
      id: 'room:timeline-event-1',
      sessionId: activeSession.id,
      senderType: SenderType.User,
      content: 'hello',
      createdAt: new Date().toISOString(),
      metadata: {
        kind: 'chat.message',
        roomTimeline: {
          roomId: 'room-1',
          roomKind: 'direct',
          eventId: 'timeline-event-1',
          eventType: 'human.message',
        },
      },
    })

    let resolveSend!: (message: Message) => void
    api.sendMessageWithModel = (async () => {
      useChatStore.getState().handleWSEvent({
        type: WsEvent.RoomTimelineEvent,
        payload: {
          sessionId: activeSession.id,
          room: {
            id: 'room-1',
            provider: 'matrix',
            providerRoomId: '!room:agenthub.local',
            kind: 'direct',
            ownerId: 'user-1',
            workspaceId: 'workspace-1',
            sessionId: activeSession.id,
            runId: null,
            taskId: null,
            taskThreadId: null,
            title: 'Direct',
            topic: null,
            metadata: { kind: 'agent-direct' },
            createdAt: '2026-06-04T00:00:00.000Z',
            updatedAt: '2026-06-04T00:00:00.000Z',
          },
          participants: [],
          event: {
            id: 'timeline-event-1',
            roomId: 'room-1',
            providerEventId: '$event-1',
            senderParticipantId: null,
            senderType: 'human',
            type: 'human.message',
            body: 'hello',
            metadata: {
              kind: 'chat.message',
              messageType: 'text',
            },
            sequence: 1,
            createdAt: roomMessage.createdAt,
          },
        },
      })
      return new Promise<Message>((resolve) => {
        resolveSend = resolve
      })
    }) as typeof api.sendMessageWithModel
    api.listSessions = (async () => ({ items: [activeSession] })) as typeof api.listSessions

    const sending = useChatStore.getState().sendMessageToSession(activeSession.id, 'hello')
    await Promise.resolve()
    expect(useChatStore.getState().messages.filter((item) => item.senderType === SenderType.User)).toHaveLength(1)

    resolveSend(roomMessage)
    await sending

    const userMessages = useChatStore
      .getState()
      .messages.filter((item) => item.senderType === SenderType.User)
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]?.id).toBe('room:timeline-event-1')
    expect(userMessages[0]?.content).toBe('hello')
  })
})
