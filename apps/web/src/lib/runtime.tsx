import { useMemo, type ReactNode } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { useChatStore } from '../stores/chatStore'
import type { AgentArtifact, AgentDraft, Message } from './api'

type ArtifactBundle = {
  artifacts: AgentArtifact[]
}

type AgentDraftBundle = {
  draft: AgentDraft
  status?: string
  messageId: string
}

function toThreadMessage(message: Message): ThreadMessageLike {
  const role: ThreadMessageLike['role'] =
    message.senderType === 'agent'
      ? 'assistant'
      : message.senderType === 'system'
        ? 'system'
        : 'user'

  const plan =
    message.type === 'task_card' && message.metadata && 'plan' in message.metadata
      ? { ...(message.metadata.plan as Record<string, unknown>), messageId: message.id }
      : null
  const agentName =
    message.senderType === 'agent' && message.metadata && typeof message.metadata.agentName === 'string'
      ? message.metadata.agentName
      : null
  const runtimeLabel =
    message.senderType === 'agent' && message.metadata?.runtimeType === 'code-agent'
      ? `Code Agent / ${String(message.metadata.codeAgentType ?? 'cli')}`
      : message.senderType === 'agent' &&
          typeof message.metadata?.runtimeType === 'string' &&
          message.metadata.runtimeType !== 'llm'
        ? String(message.metadata.runtimeType).toUpperCase()
        : null
  const senderLabel = [agentName, runtimeLabel].filter(Boolean).join(' · ')
  const text = senderLabel ? `**${senderLabel}**\n\n${message.content}` : message.content
  const artifacts = parseArtifacts(message.metadata)
  const agentDraft = parseAgentDraft(message)

  if (agentDraft) {
    return {
      id: message.id,
      role,
      content: [{ type: 'data', name: 'agent_draft', data: agentDraft }],
      createdAt: new Date(message.createdAt),
    }
  }

  if (artifacts.length) {
    return {
      id: message.id,
      role,
      content: [
        { type: 'text', text },
        { type: 'data', name: 'artifact_bundle', data: { artifacts } satisfies ArtifactBundle },
      ],
      createdAt: new Date(message.createdAt),
    }
  }

  return {
    id: message.id,
    role,
    content: plan
      ? [{ type: 'data', name: 'orchestrator_plan', data: plan }]
      : [{ type: 'text', text }],
    createdAt: new Date(message.createdAt),
  }
}

function parseAgentDraft(message: Message): AgentDraftBundle | null {
  const value = message.metadata?.agentDraft
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<AgentDraft>
  if (typeof candidate.name !== 'string' || typeof candidate.role !== 'string') return null
  return {
    draft: candidate as AgentDraft,
    status: typeof message.metadata?.agentDraftStatus === 'string' ? message.metadata.agentDraftStatus : 'draft',
    messageId: message.id,
  }
}

function parseArtifacts(metadata: Record<string, unknown> | null): AgentArtifact[] {
  const value = metadata?.artifacts
  if (!Array.isArray(value)) return []
  return value.filter((item): item is AgentArtifact => {
    if (!item || typeof item !== 'object') return false
    const kind = (item as { kind?: unknown }).kind
    const title = (item as { title?: unknown }).title
    return typeof kind === 'string' && typeof title === 'string'
  })
}

export function AgentHubRuntimeProvider({ children }: { children: ReactNode }) {
  const messages = useChatStore((state) => state.messages)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const agentTyping = useChatStore((state) => state.agentTyping)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const cancelRun = useChatStore((state) => state.cancelRun)

  const threadMessages = useMemo<ThreadMessageLike[]>(() => {
    const list = messages.map(toThreadMessage)

    if (streamingMessage) {
      list.push({
        id: streamingMessage.id,
        role: 'assistant',
        content: [{ type: 'text', text: streamingMessage.content }],
        status: { type: 'running' },
      })
    } else if (agentTyping) {
      list.push({
        id: 'agenthub-thinking',
        role: 'assistant',
        content: [],
        status: { type: 'running' },
      })
    }

    return list
  }, [agentTyping, messages, streamingMessage])

  const runtime = useExternalStoreRuntime({
    isRunning: agentTyping || streamingMessage !== null,
    messages: threadMessages,
    convertMessage: (message: ThreadMessageLike) => message,
    onCancel: cancelRun,
    onNew: async (message: AppendMessage) => {
      if (!currentSessionId) {
        throw new Error('请先选择或新建一个会话')
      }

      const part = message.content[0]
      if (!part || part.type !== 'text') {
        throw new Error('仅支持纯文本消息')
      }

      await sendMessage(part.text)
    },
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
