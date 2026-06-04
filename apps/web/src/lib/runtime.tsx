import { useMemo, type ReactNode } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { describeRuntimeActivity } from '../stores/chatStore'
import { selectRuntimeState, useChatStoreShallow } from '../stores/chatSelectors'
import type { AgentArtifact, ChatAttachment, Message } from './api'
import type { CodeAgentRunMetadata } from '@agenthub/shared'

type CodeAgentRunSummaryCounts = {
  artifacts: number
  commands: number
  files: number
  logs: number
  steps: number
  toolCalls: number
}

export type ThreadCodeAgentRunData = CodeAgentRunMetadata & {
  __agenthubFullRunId?: string
  __agenthubSummaryCounts?: CodeAgentRunSummaryCounts
  __agenthubSummaryOnly?: boolean
}

const fullCodeAgentRunCache = new Map<string, CodeAgentRunMetadata>()

export function getCachedCodeAgentRunMetadata(id?: string | null): CodeAgentRunMetadata | null {
  return id ? (fullCodeAgentRunCache.get(id) ?? null) : null
}

function toThreadMessage(message: Message): ThreadMessageLike {
  const role: ThreadMessageLike['role'] = message.senderType === 'user' ? 'user' : 'assistant'

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
  const fileCard =
    message.metadata && 'file_card' in (message.metadata as Record<string, unknown>)
      ? (message.metadata as Record<string, unknown>).file_card
      : null
  const memberProposal =
    message.metadata && 'memberProposals' in (message.metadata as Record<string, unknown>)
      ? { ...(message.metadata as Record<string, unknown>), messageId: message.id, content: message.content }
      : null
  const rawCodeAgentRun = isCodeAgentRunMetadata(message.metadata?.codeAgentRun)
    ? message.metadata.codeAgentRun
    : null
  const agentName =
    message.senderType === 'agent' &&
    message.metadata &&
    typeof message.metadata.agentName === 'string'
      ? message.metadata.agentName
      : null
  const senderLabel = agentName
  const rawDisplayContent =
    message.senderType === 'user' && typeof message.metadata?.displayContent === 'string'
      ? message.metadata.displayContent
      : message.content
  const finalCodeAgentContent =
    typeof rawCodeAgentRun?.finalMessage === 'string' ? rawCodeAgentRun.finalMessage.trim() : ''
  const displayContent = finalCodeAgentContent || rawDisplayContent
  const text = senderLabel
    ? displayContent.trim()
      ? `**${senderLabel}**\n\n${displayContent}`
      : `**${senderLabel}**`
    : displayContent
  const artifacts = readArtifacts(message.metadata?.artifacts, rawCodeAgentRun)
  const codeAgentRun = rawCodeAgentRun
    ? toThreadCodeAgentRunData(message.id, rawCodeAgentRun, artifacts)
    : null
  const artifactPart = artifacts.length
    ? [{ type: 'data' as const, name: 'agent_artifacts', data: { items: artifacts } }]
    : []
  const attachments = readChatAttachments(message.metadata?.attachments)
  const attachmentPart = attachments.length
    ? [{ type: 'data' as const, name: 'chat_attachments', data: { items: attachments } }]
    : []
  const avatarPart = readAgentAvatarPart(message.metadata, codeAgentRun)

  const deliveryReportPart = deliveryReport
    ? [{ type: 'data' as const, name: 'delivery_report', data: deliveryReport }]
    : []
  const fileCardPart = fileCard
    ? [{ type: 'data' as const, name: 'file_card', data: fileCard }]
    : []
  const memberProposalPart = memberProposal
    ? [{ type: 'data' as const, name: 'member_proposal_card', data: memberProposal }]
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
                { type: 'text', text },
                ...attachmentPart,
                ...memberProposalPart,
                { type: 'data', name: 'code_agent_run', data: codeAgentRun },
                ...fileCardPart,
                ...deliveryReportPart,
              ]
            : [
                ...avatarPart,
                { type: 'text', text },
                ...attachmentPart,
                ...memberProposalPart,
                ...artifactPart,
                ...fileCardPart,
                ...deliveryReportPart,
              ],
    createdAt: new Date(message.createdAt),
  }
}

export const __runtimeTestHooks = {
  toThreadMessage,
}

function toThreadCodeAgentRunData(
  messageId: string,
  metadata: CodeAgentRunMetadata,
  artifacts: AgentArtifact[],
): ThreadCodeAgentRunData {
  const fullMetadata: CodeAgentRunMetadata = { ...metadata, artifacts }
  fullCodeAgentRunCache.set(messageId, fullMetadata)

  if (metadata.status !== 'completed') return fullMetadata

  return {
    type: metadata.type,
    status: metadata.status,
    runtime: metadata.runtime,
    command: metadata.command,
    cwd: metadata.cwd,
    durationMs: metadata.durationMs,
    exitCode: metadata.exitCode,
    commands: [],
    files: [],
    finalMessage: metadata.finalMessage,
    partialSuccess: metadata.partialSuccess,
    reviewRequired: metadata.reviewRequired,
    warning: metadata.warning,
    __agenthubFullRunId: messageId,
    __agenthubSummaryOnly: true,
    __agenthubSummaryCounts: {
      artifacts: artifacts.length,
      commands: metadata.commands.length,
      files: metadata.files.length,
      logs: metadata.logs?.length ?? 0,
      steps: metadata.steps?.length ?? 0,
      toolCalls: metadata.toolCalls?.length ?? 0,
    },
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
      (attachment.type === 'image' || attachment.type === 'file') &&
      typeof attachment.name === 'string' &&
      typeof attachment.mimeType === 'string' &&
      typeof attachment.size === 'number' &&
      typeof attachment.dataUrl === 'string' &&
      attachment.dataUrl.startsWith('data:')
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

export function AgentHubRuntimeProvider({ children }: { children: ReactNode }) {
  const {
    messages,
    streamingMessage,
    streamingCodeAgentRun,
    agentTyping,
    agentActivity,
    currentSessionId,
    sendMessage,
    safetyMode,
    cancelRun,
  } = useChatStoreShallow(selectRuntimeState)

  const threadMessages = useMemo<ThreadMessageLike[]>(() => {
    const list = messages.map(toThreadMessage)

    if (streamingMessage) {
      const streamingAvatarPart = streamingCodeAgentRun
        ? [
            {
              type: 'data' as const,
              name: 'agent_avatar',
              data: { runtime: streamingCodeAgentRun.runtime },
            },
          ]
        : []
      const streamingSenderLabel = streamingMessage.agentName ?? null
      const streamingText =
        streamingSenderLabel && streamingMessage.content.trim()
          ? `**${streamingSenderLabel}**\n\n${streamingMessage.content}`
          : streamingCodeAgentRun
            ? ''
            : streamingSenderLabel
              ? `**${streamingSenderLabel}**`
              : streamingMessage.content
      list.push({
        id: streamingMessage.id,
        role: 'assistant',
        content: streamingCodeAgentRun
          ? [
              ...streamingAvatarPart,
              ...(streamingText.trim() ? [{ type: 'text' as const, text: streamingText }] : []),
              { type: 'data', name: 'code_agent_run', data: streamingCodeAgentRun },
            ]
          : [{ type: 'text', text: streamingMessage.content }],
        status: { type: 'running' },
      })
    } else if (agentTyping) {
      const activity = describeRuntimeActivity(agentActivity)
      const actor = activity?.agentName ?? 'Agent'
      const activityLabel = activity?.label ?? '正在处理'
      list.push({
        id: 'agenthub-thinking',
        role: 'assistant',
        content: [{ type: 'text', text: `**${actor}**\n\n${activityLabel}...` }],
        status: { type: 'running' },
      })
    }

    return list
  }, [agentActivity, agentTyping, messages, streamingCodeAgentRun, streamingMessage])

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

      await sendMessage(part.text, { safetyMode })
    },
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
