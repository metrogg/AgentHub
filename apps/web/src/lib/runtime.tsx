import { useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { useChatStore } from '../stores/chatStore'
import type { AgentArtifact, ChatAttachment, Message } from './api'
import type { CodeAgentRunMetadata } from '@agenthub/shared'

function toThreadMessage(message: Message): ThreadMessageLike {
  const role: ThreadMessageLike['role'] =
    message.senderType === 'agent'
      ? 'assistant'
      : message.senderType === 'system'
        ? 'system'
        : 'user'

  const plan =
    message.type === 'task_card' && message.metadata && 'plan' in message.metadata
      ? {
          ...(message.metadata.plan as Record<string, unknown>),
          messageId: message.id,
          dispatchResult: (message.metadata as { dispatchResult?: unknown }).dispatchResult,
        }
      : null
  const agentName =
    message.senderType === 'agent' && message.metadata && typeof message.metadata.agentName === 'string'
      ? message.metadata.agentName
      : null
  const runtimeLabel =
    message.senderType === 'agent' && message.metadata?.runtimeType === 'code-agent'
      ? `代码 Agent / ${String(message.metadata.codeAgentType ?? 'cli')}`
      : message.senderType === 'agent' &&
          typeof message.metadata?.runtimeType === 'string' &&
          message.metadata.runtimeType !== 'llm'
        ? String(message.metadata.runtimeType).toUpperCase()
        : null
  const senderLabel = [agentName, runtimeLabel].filter(Boolean).join(' · ')
  const displayContent =
    message.senderType === 'user' && typeof message.metadata?.displayContent === 'string'
      ? message.metadata.displayContent
      : message.content
  const text = senderLabel ? `**${senderLabel}**\n\n${displayContent}` : displayContent
  const codeAgentRun = isCodeAgentRunMetadata(message.metadata?.codeAgentRun) ? message.metadata.codeAgentRun : null
  const artifacts = readArtifacts(message.metadata?.artifacts, codeAgentRun)
  const artifactPart = artifacts.length ? [{ type: 'data' as const, name: 'agent_artifacts', data: { items: artifacts } }] : []
  const attachments = readChatAttachments(message.metadata?.attachments)
  const attachmentPart = attachments.length ? [{ type: 'data' as const, name: 'chat_attachments', data: { items: attachments } }] : []
  const avatarPart = readAgentAvatarPart(message.metadata, codeAgentRun)

  return {
    id: message.id,
    role,
    content: plan
      ? [{ type: 'data', name: 'orchestrator_plan', data: plan }]
      : codeAgentRun
        ? [
            ...avatarPart,
            { type: 'text', text },
            ...attachmentPart,
            { type: 'data', name: 'code_agent_run', data: codeAgentRun },
            ...artifactPart,
          ]
        : [...avatarPart, { type: 'text', text }, ...attachmentPart, ...artifactPart],
    createdAt: new Date(message.createdAt),
  }
}

function isCodeAgentRunMetadata(value: unknown): value is CodeAgentRunMetadata {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'code-agent-run')
}

function readArtifacts(value: unknown, codeAgentRun: CodeAgentRunMetadata | null): AgentArtifact[] {
  const direct = Array.isArray(value) ? value : []
  const fromRun = Array.isArray(codeAgentRun?.artifacts) ? codeAgentRun.artifacts : []
  const seen = new Set<string>()
  return [...direct, ...fromRun].filter((item): item is AgentArtifact => {
    if (!item || typeof item !== 'object') return false
    const artifact = item as { id?: unknown; type?: unknown }
    if (typeof artifact.id !== 'string' || typeof artifact.type !== 'string' || seen.has(artifact.id)) return false
    seen.add(artifact.id)
    return ['diff', 'preview', 'file', 'deploy', 'workflow'].includes(artifact.type)
  })
}

function readChatAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ChatAttachment => {
    if (!item || typeof item !== 'object') return false
    const attachment = item as Partial<ChatAttachment>
    return (
      typeof attachment.id === 'string' &&
      attachment.type === 'image' &&
      typeof attachment.name === 'string' &&
      typeof attachment.mimeType === 'string' &&
      typeof attachment.size === 'number' &&
      typeof attachment.dataUrl === 'string' &&
      attachment.dataUrl.startsWith('data:image/')
    )
  })
}

function readAgentAvatarPart(metadata: Message['metadata'], codeAgentRun: CodeAgentRunMetadata | null) {
  const runtime = codeAgentRun?.runtime ?? metadata?.codeAgentType
  if (metadata?.runtimeType !== 'code-agent' && !codeAgentRun) return []
  if (runtime !== 'codex' && runtime !== 'claude-code' && runtime !== 'opencode' && runtime !== 'gemini') return []
  return [{ type: 'data' as const, name: 'agent_avatar', data: { runtime } }]
}

export function AgentHubRuntimeProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const messages = useChatStore((state) => state.messages)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const streamingCodeAgentRun = useChatStore((state) => state.streamingCodeAgentRun)
  const agentTyping = useChatStore((state) => state.agentTyping)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const cancelRun = useChatStore((state) => state.cancelRun)

  const threadMessages = useMemo<ThreadMessageLike[]>(() => {
    const list = messages.map(toThreadMessage)

    if (streamingMessage) {
      const streamingAvatarPart = streamingCodeAgentRun
        ? [{ type: 'data' as const, name: 'agent_avatar', data: { runtime: streamingCodeAgentRun.runtime } }]
        : []
      list.push({
        id: streamingMessage.id,
        role: 'assistant',
        content: streamingCodeAgentRun
          ? [
              ...streamingAvatarPart,
              ...(streamingMessage.content.trim() ? [{ type: 'text' as const, text: streamingMessage.content }] : []),
              { type: 'data', name: 'code_agent_run', data: streamingCodeAgentRun },
              ...(streamingCodeAgentRun.artifacts?.length
                ? [{ type: 'data' as const, name: 'agent_artifacts', data: { items: streamingCodeAgentRun.artifacts } }]
                : []),
            ]
          : [{ type: 'text', text: streamingMessage.content }],
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
  }, [agentTyping, messages, streamingCodeAgentRun, streamingMessage])

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

      const result = await sendMessage(part.text)
      if (result?.groupSessionId && result.groupSessionId !== currentSessionId) {
        navigate(`/chat/${result.groupSessionId}`)
      }
    },
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
