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
  if (message.senderType === 'system') {
    return {
      id: message.id,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: message.content }],
      createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    }
  }

  const role: ThreadMessageLike['role'] = message.senderType === 'agent' ? 'assistant' : 'user'

  const taskBoard =
    message.type === 'task_board' &&
    message.metadata &&
    'plan' in (message.metadata as Record<string, unknown>)
      ? {
          ...((message.metadata as Record<string, unknown>).plan as Record<string, unknown>),
          runId: (message.metadata as Record<string, unknown>).runId as string,
          messageId: message.id,
        }
      : null
  const clarification =
    message.metadata && 'clarificationTaskId' in (message.metadata as Record<string, unknown>)
      ? { ...(message.metadata as Record<string, unknown>), messageId: message.id }
      : null
  const deliveryReport =
    message.metadata && 'delivery_report' in (message.metadata as Record<string, unknown>)
      ? (message.metadata as Record<string, unknown>).delivery_report
      : null
  const agentName =
    message.senderType === 'agent' &&
    message.metadata &&
    typeof message.metadata.agentName === 'string'
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
  const codeAgentRun = isCodeAgentRunMetadata(message.metadata?.codeAgentRun)
    ? message.metadata.codeAgentRun
    : null
  const artifacts = readArtifacts(message.metadata?.artifacts, codeAgentRun)
  const artifactPart = artifacts.length
    ? [{ type: 'data' as const, name: 'agent_artifacts', data: { items: artifacts } }]
    : []
  const reasoningText = readReasoningText(message.metadata)
  const reasoningPart = reasoningText
    ? [{ type: 'data' as const, name: 'agent_reasoning', data: { text: reasoningText, running: false } }]
    : []
  const attachments = readChatAttachments(message.metadata?.attachments)
  const attachmentPart = attachments.length
    ? [{ type: 'data' as const, name: 'chat_attachments', data: { items: attachments } }]
    : []
  const avatarPart = readAgentAvatarPart(message.metadata, codeAgentRun)

  const deliveryReportPart = deliveryReport
    ? [{ type: 'data' as const, name: 'delivery_report', data: deliveryReport }]
    : []

  return {
    id: message.id,
    role,
    content: clarification
      ? [{ type: 'data', name: 'clarification_card', data: clarification }]
      : taskBoard
        ? [{ type: 'data', name: 'task_board', data: taskBoard }]
        : codeAgentRun
            ? [
                ...avatarPart,
                ...reasoningPart,
                { type: 'text', text },
                ...attachmentPart,
                { type: 'data', name: 'code_agent_run', data: codeAgentRun },
                ...artifactPart,
                ...deliveryReportPart,
              ]
            : [
                ...avatarPart,
                ...reasoningPart,
                { type: 'text', text },
                ...attachmentPart,
                ...artifactPart,
                ...deliveryReportPart,
              ],
    createdAt: new Date(message.createdAt),
  }
}

function isCodeAgentRunMetadata(value: unknown): value is CodeAgentRunMetadata {
  return Boolean(
    value && typeof value === 'object' && (value as { type?: unknown }).type === 'code-agent-run',
  )
}

function readArtifacts(value: unknown, codeAgentRun: CodeAgentRunMetadata | null): AgentArtifact[] {
  const direct = Array.isArray(value) ? value : []
  const fromRun = Array.isArray(codeAgentRun?.artifacts) ? codeAgentRun.artifacts : []
  const seen = new Set<string>()
  return [...direct, ...fromRun].filter((item): item is AgentArtifact => {
    if (!item || typeof item !== 'object') return false
    const artifact = item as { id?: unknown; type?: unknown }
    if (
      typeof artifact.id !== 'string' ||
      typeof artifact.type !== 'string' ||
      seen.has(artifact.id)
    )
      return false
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

function readAgentAvatarPart(
  metadata: Message['metadata'],
  codeAgentRun: CodeAgentRunMetadata | null,
) {
  const runtime = codeAgentRun?.runtime ?? metadata?.codeAgentType
  if (metadata?.runtimeType !== 'code-agent' && !codeAgentRun) return []
  if (
    runtime !== 'codex' &&
    runtime !== 'claude-code' &&
    runtime !== 'opencode' &&
    runtime !== 'gemini'
  )
    return []
  return [{ type: 'data' as const, name: 'agent_avatar', data: { runtime } }]
}

function readReasoningText(metadata: Message['metadata']) {
  if (!metadata || typeof metadata !== 'object') return ''
  if (typeof metadata.reasoning === 'string') return metadata.reasoning
  const parts = metadata.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part): part is { text: string; type: string } => {
      return (
        Boolean(part) &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'reasoning' &&
        typeof (part as { text?: unknown }).text === 'string'
      )
    })
    .map((part) => part.text)
    .join('')
}

export function AgentHubRuntimeProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const messages = useChatStore((state) => state.messages)
  const streamingMessage = useChatStore((state) => state.streamingMessage)
  const streamingParts = useChatStore((state) => state.streamingParts)
  const streamingCodeAgentRun = useChatStore((state) => state.streamingCodeAgentRun)
  const agentTyping = useChatStore((state) => state.agentTyping)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sendMessage = useChatStore((state) => state.sendMessage)
  const cancelRun = useChatStore((state) => state.cancelRun)

  const threadMessages = useMemo<ThreadMessageLike[]>(() => {
    const list = messages.map(toThreadMessage)

    if (streamingMessage) {
      const liveParts = streamingParts.filter((part) => part.messageId === streamingMessage.id)
      const liveTextParts = liveParts.filter((part) => part.type === 'text')
      const liveText = liveTextParts.length
        ? liveTextParts.map((part) => part.text || part.deltaText).join('')
        : streamingMessage.content
      const liveReasoning = liveParts
        .filter((part) => part.type === 'reasoning')
        .map((part) => part.text || part.deltaText)
        .join('')
      const streamingAvatarPart = streamingCodeAgentRun
        ? [
            {
              type: 'data' as const,
              name: 'agent_avatar',
              data: { runtime: streamingCodeAgentRun.runtime },
            },
          ]
        : []
      const streamingRuntimeLabel = streamingCodeAgentRun
        ? `代码 Agent / ${String(streamingCodeAgentRun.runtime ?? 'cli')}`
        : null
      const streamingSenderLabel = [streamingMessage.agentName, streamingRuntimeLabel]
        .filter(Boolean)
        .join(' · ')
      const streamingText =
        streamingSenderLabel && liveText.trim()
          ? `**${streamingSenderLabel}**\n\n${liveText}`
          : streamingSenderLabel
            ? `**${streamingSenderLabel}**`
            : liveText
      const streamingReasoningPart = liveReasoning.trim()
        ? [
            {
              type: 'data' as const,
              name: 'agent_reasoning',
              data: { text: liveReasoning, running: true },
            },
          ]
        : []
      list.push({
        id: streamingMessage.id,
        role: 'assistant',
        content: streamingCodeAgentRun
          ? [
              ...streamingAvatarPart,
              ...streamingReasoningPart,
              ...(streamingText.trim() ? [{ type: 'text' as const, text: streamingText }] : []),
              { type: 'data', name: 'code_agent_run', data: streamingCodeAgentRun },
              ...(streamingCodeAgentRun.artifacts?.length
                ? [
                    {
                      type: 'data' as const,
                      name: 'agent_artifacts',
                      data: { items: streamingCodeAgentRun.artifacts },
                    },
                  ]
                : []),
            ]
          : [
              ...streamingReasoningPart,
              ...(streamingText.trim() ? [{ type: 'text' as const, text: streamingText }] : []),
            ],
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
  }, [agentTyping, messages, streamingCodeAgentRun, streamingMessage, streamingParts])

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
