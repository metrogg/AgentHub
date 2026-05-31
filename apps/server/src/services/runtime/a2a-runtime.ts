import type { Message, MessageSendParams, Task } from '@a2a-js/sdk'
import type { AgentArtifact } from '@agenthub/db'
import type { AgentOutputChunk, AgentRuntime, ExecutionContext } from './agent-runtime'
import { buildA2AArtifact, buildA2AMessage } from '../protocols/a2a-adapter'

export class A2ARuntime implements AgentRuntime {
  readonly runtimeType = 'a2a'
  readonly displayName = 'A2A Agent'

  async *execute(ctx: ExecutionContext): AsyncGenerator<AgentOutputChunk> {
    const endpoint = ctx.profile.a2aEndpoint?.trim()
    if (!endpoint) {
      yield {
        kind: 'text',
        text:
          '[错误：A2A Agent 未配置 endpoint。请在 Agent roleProfile.a2aEndpoint，或 modelId 中配置 A2A JSON-RPC URL。]',
      }
      return
    }

    const requestId = crypto.randomUUID()
    const params = ctx.envelope?.a2a?.params ?? buildMessageSendParams(ctx)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: requestId,
        jsonrpc: '2.0',
        method: 'message/send',
        params,
      }),
      signal: ctx.signal,
    })

    if (!response.ok) {
      yield {
        kind: 'text',
        text: `[错误：A2A Agent HTTP ${response.status}：${await response.text()}]`,
      }
      return
    }

    const payload = await response.json() as {
      result?: Task | Message
      error?: { message?: string; code?: number; data?: unknown }
    }
    if (payload.error) {
      yield {
        kind: 'text',
        text: `[错误：A2A Agent 返回错误 ${payload.error.code ?? ''}：${payload.error.message ?? 'Unknown error'}]`,
      }
      return
    }
    if (!payload.result) {
      yield { kind: 'text', text: '[错误：A2A Agent 没有返回 result。]' }
      return
    }

    const text = extractResultText(payload.result)
    if (text) yield { kind: 'text', text }

    if (isTask(payload.result)) {
      for (const artifact of payload.result.artifacts ?? []) {
        yield { kind: 'artifact', artifact: toAgentArtifact(artifact) }
      }
    }

    yield {
      kind: 'metadata',
      metadata: {
        type: 'a2a-remote-run',
        endpoint,
        request: params,
        result: payload.result,
      },
    }
  }
}

function buildMessageSendParams(ctx: ExecutionContext): MessageSendParams {
  return {
    configuration: {
      acceptedOutputModes: ['text/plain', 'application/json', 'text/markdown'],
      blocking: true,
      historyLength: 20,
    },
    message: buildA2AMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: ctx.prompt,
      contextId: ctx.sessionId,
    }),
  }
}

function extractResultText(result: Task | Message) {
  if (isTask(result)) {
    return result.status.message
      ? extractMessageText(result.status.message)
      : (result.history ?? []).map(extractMessageText).filter(Boolean).join('\n\n')
  }
  return extractMessageText(result)
}

function extractMessageText(message: Message) {
  return message.parts
    .map((part) => {
      if (part.kind === 'text') return part.text
      if (part.kind === 'data') return JSON.stringify(part.data, null, 2)
      if (part.kind === 'file') return 'uri' in part.file ? part.file.uri : (part.file.name ?? '')
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function isTask(value: Task | Message): value is Task {
  return value.kind === 'task'
}

function toAgentArtifact(artifact: ReturnType<typeof buildA2AArtifact>): AgentArtifact {
  const path = typeof artifact.metadata?.path === 'string' ? artifact.metadata.path : undefined
  return {
    id: artifact.artifactId,
    kind: 'file',
    title: artifact.name ?? artifact.artifactId,
    description: artifact.description,
    path,
    mimeType: firstMimeType(artifact),
    source: 'a2a',
    createdAt: new Date().toISOString(),
  }
}

function firstMimeType(artifact: ReturnType<typeof buildA2AArtifact>) {
  for (const part of artifact.parts) {
    if (part.kind === 'file') return part.file.mimeType
    if (part.kind === 'data' && typeof part.metadata?.mimeType === 'string') {
      return part.metadata.mimeType
    }
  }
  return undefined
}
