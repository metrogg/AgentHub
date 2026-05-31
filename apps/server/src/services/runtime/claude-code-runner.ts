import type {
  TimelineEvent,
  TimelineEventKind,
  TimelineEventStatus,
  TimelineRuntime,
} from '@agenthub/shared'
import type { AgentProfile, ExecutionContext } from './agent-runtime'
import {
  streamCodeAgentReply,
  isCodeAgentProfile,
} from '../code-agent-adapter'

export type RunnerOutput =
  | { type: 'timeline_event'; event: TimelineEvent }
  | { type: 'text_delta'; text: string; blockId: string }
  | { type: 'reasoning_delta'; text: string; blockId: string }

type ToolUseState = {
  name: string
  input: Record<string, unknown>
}

/**
 * Claude tool → TimelineEvent kind 映射
 */
function mapClaudeToolToKind(toolName: string): TimelineEventKind {
  switch (toolName) {
    case 'Bash':
      return 'command'
    case 'Read':
      return 'file_read'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'file_change'
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
      return 'search'
    case 'WebFetch':
      return 'tool'
    case 'TodoWrite':
      return 'todo_list'
    case 'Task':
      return 'subagent'
    case 'ExitPlanMode':
      return 'plan'
    default:
      return 'tool'
  }
}

function mapToolKindToRuntime(kind: TimelineEventKind): TimelineRuntime {
  if (
    kind === 'message' ||
    kind === 'reasoning' ||
    kind === 'turn' ||
    kind === 'error' ||
    kind === 'plan' ||
    kind === 'approval'
  ) {
    return 'claude-code'
  }
  return 'claude-code'
}

function buildToolPayload(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = { toolName, ...input }
  switch (toolName) {
    case 'Bash':
      return { ...base, kind: 'command' }
    case 'Read':
      return { ...base, kind: 'file_read' }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { ...base, kind: 'file_change' }
    case 'Glob':
    case 'Grep':
    case 'WebSearch':
      return { ...base, kind: 'search' }
    default:
      return base
  }
}

function now(): number {
  return Date.now()
}

/**
 * ClaudeCodeRunner 将原始 streamCodeAgentReply 输出翻译为统一的 TimelineEvent 流。
 */
export class ClaudeCodeRunner {
  private sessionId = ''
  private blockSeq = 0
  private turnSeq = 0
  private intraTurnOrder = 0
  private currentTurnId = ''
  private activeToolUse: Map<number, ToolUseState> = new Map()
  private textBuffer = ''
  private currentTextBlockId: string | null = null
  private currentReasoningBlockId: string | null = null

  async *runTimeline(
    profile: AgentProfile,
    ctx: ExecutionContext,
  ): AsyncGenerator<RunnerOutput> {
    this.sessionId = ctx.sessionId
    this.blockSeq = 0
    this.turnSeq = 0
    this.intraTurnOrder = 0
    this.currentTurnId = `${this.sessionId}:turn:0`
    this.activeToolUse = new Map()
    this.textBuffer = ''
    this.currentTextBlockId = null
    this.currentReasoningBlockId = null

    if (!isCodeAgentProfile(profile)) {
      return
    }

    // 发起第一个 turn
    yield* this.emitTurnStart()

    try {
      for await (const chunk of streamCodeAgentReply(
        profile,
        {
          id: crypto.randomUUID(),
          sessionId: ctx.sessionId,
          senderId: 'user',
          senderType: 'user',
          type: 'text',
          content: ctx.prompt,
          metadata: null,
          createdAt: new Date(),
        },
        ctx.history,
        ctx.signal,
        ctx.envelope,
        ctx.continueSession,
        ctx.resumeSessionId,
      )) {
        if (ctx.signal?.aborted) break

        if (typeof chunk === 'string') {
          this.textBuffer += chunk
          if (this.currentTextBlockId) {
            yield {
              type: 'text_delta',
              text: chunk,
              blockId: this.currentTextBlockId,
            }
          }
          continue
        }

        switch (chunk.kind) {
          case 'code-agent-block-start':
            yield* this.handleBlockStart(chunk.block)
            break
          case 'code-agent-block-stop':
            yield* this.handleBlockStop(chunk.index)
            break
          case 'code-agent-thinking':
            yield* this.handleThinkingText(chunk.text)
            break
          case 'code-agent-tool-input':
            this.handleToolInputDelta(chunk.partialJson)
            break
          case 'code-agent-plan':
            yield* this.handlePlanEvent(chunk.input)
            break
          case 'code-agent-metadata':
            // 向后兼容：metadata 快照转换为 tool/step 事件
            yield* this.handleMetadataSnapshot(chunk.metadata)
            break
        }
      }
    } finally {
      // sweep 未完成的 tool_use 和 block
      yield* this.sweepPending()
      yield* this.emitTurnEnd()
    }
  }

  private *emitTurnStart(): Generator<RunnerOutput> {
    yield this.emit({
      id: this.currentTurnId,
      kind: 'turn',
      status: 'started',
      title: `第 ${this.turnSeq + 1} 轮`,
    })
  }

  private *emitTurnEnd(): Generator<RunnerOutput> {
    yield this.emit({
      id: `${this.sessionId}:turn:${this.turnSeq}:end`,
      kind: 'turn',
      status: 'success',
      title: `第 ${this.turnSeq + 1} 轮完成`,
    })
  }

  private *handleBlockStart(block: any): Generator<RunnerOutput> {
    const blockType = block?.type as string | undefined

    if (blockType === 'text') {
      this.blockSeq++
      this.currentTextBlockId = `${this.sessionId}:text:${this.blockSeq}`
      this.textBuffer = ''

      // 空 running message 占住位置
      yield this.emit({
        id: this.currentTextBlockId,
        kind: 'message',
        status: 'running',
        title: '回复中…',
      })
    } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      this.blockSeq++
      this.currentReasoningBlockId = `${this.sessionId}:reasoning:${this.blockSeq}`

      yield this.emit({
        id: this.currentReasoningBlockId,
        kind: 'reasoning',
        status: 'running',
        title: '思考中…',
      })
    } else if (blockType === 'tool_use') {
      const toolName = String(block?.name ?? '')
      const input = block?.input ?? {}
      this.blockSeq++

      this.activeToolUse.set(block?.index ?? 0, {
        name: toolName,
        input: input as Record<string, unknown>,
      })

      const kind = mapClaudeToolToKind(toolName)
      yield this.emit({
        id: `${this.sessionId}:tool:${this.blockSeq}`,
        kind,
        status: 'running',
        title: `调用工具：${toolName}`,
        payload: buildToolPayload(toolName, input as Record<string, unknown>),
      })
    }
  }

  private *handleBlockStop(index: number): Generator<RunnerOutput> {
    const toolState = this.activeToolUse.get(index)

    if (this.currentTextBlockId && this.textBuffer) {
      yield this.emit({
        id: this.currentTextBlockId!,
        kind: 'message',
        status: 'success',
        title: '回复完成',
        payload: { content: this.textBuffer, role: 'assistant' },
      })
      this.currentTextBlockId = null
      this.textBuffer = ''
    }

    if (this.currentReasoningBlockId) {
      yield this.emit({
        id: this.currentReasoningBlockId,
        kind: 'reasoning',
        status: 'success',
        title: '推理完成',
        payload: { content: this.textBuffer || '' },
      })
      this.currentReasoningBlockId = null
      this.textBuffer = ''
    }

    if (toolState) {
      const kind = mapClaudeToolToKind(toolState.name)
      yield this.emit({
        id: `${this.sessionId}:tool:${this.blockSeq}`,
        kind,
        status: 'success',
        title: `工具完成：${toolState.name}`,
        payload: buildToolPayload(toolState.name, toolState.input),
      })
      this.activeToolUse.delete(index)
    }
  }

  private *handleThinkingText(text: string): Generator<RunnerOutput> {
    if (this.currentReasoningBlockId) {
      this.textBuffer += text
      yield {
        type: 'reasoning_delta',
        text,
        blockId: this.currentReasoningBlockId,
      }
    }
  }

  private handleToolInputDelta(partialJson: string): void {
    // 工具输入的流式 JSON 累积；当前不做额外处理，由 block_stop 时产出完整事件
    // 未来可用于展示 "工具参数填写中…" 状态
    void partialJson
  }

  private *handlePlanEvent(input: Record<string, unknown>): Generator<RunnerOutput> {
    this.blockSeq++
    yield this.emit({
      id: `${this.sessionId}:plan:${this.blockSeq}`,
      kind: 'plan',
      status: 'requires_action',
      title: '计划确认',
      summary: typeof input.plan === 'string' ? String(input.plan).slice(0, 300) : undefined,
      payload: { ...input, source: 'ExitPlanMode' },
    })
  }

  private *handleMetadataSnapshot(
    metadata: Record<string, unknown>,
  ): Generator<RunnerOutput> {
    const type = metadata.type as string | undefined
    if (type !== 'code-agent-run') return

    const commands = (metadata.commands as any[]) ?? []
    for (const cmd of commands) {
      yield this.emit({
        id: `${this.sessionId}:cmd:${cmd.id ?? crypto.randomUUID()}`,
        kind: 'command',
        status: 'success',
        title: `运行命令：${String(cmd.command ?? '').slice(0, 100)}`,
        payload: { command: cmd.command, cwd: cmd.cwd },
      })
    }

    const files = (metadata.files as any[]) ?? []
    for (const file of files) {
      yield this.emit({
        id: `${this.sessionId}:file:${file.path ?? crypto.randomUUID()}`,
        kind: 'file_change',
        status: 'success',
        title: `${file.status === 'created' ? '创建' : file.status === 'modified' ? '修改' : file.status === 'deleted' ? '删除' : '操作'}：${String(file.path ?? '').slice(0, 100)}`,
        payload: { path: file.path, fileStatus: file.status },
      })
    }
  }

  private *sweepPending(): Generator<RunnerOutput> {
    // 未完成的 text block
    if (this.currentTextBlockId) {
      yield this.emit({
        id: this.currentTextBlockId,
        kind: 'message',
        status: this.textBuffer ? 'success' : 'cancelled',
        title: this.textBuffer ? '回复完成' : '回复中断',
        payload: { content: this.textBuffer, role: 'assistant' },
      })
      this.currentTextBlockId = null
    }

    // 未完成的 reasoning block
    if (this.currentReasoningBlockId) {
      yield this.emit({
        id: this.currentReasoningBlockId,
        kind: 'reasoning',
        status: 'cancelled',
        title: '推理中断',
      })
      this.currentReasoningBlockId = null
    }

    // 未完成的 tool use
    for (const [index, state] of this.activeToolUse) {
      const kind = mapClaudeToolToKind(state.name)
      yield this.emit({
        id: `${this.sessionId}:tool:sweep:${index}`,
        kind,
        status: 'error',
        title: `工具未完成：${state.name}`,
        payload: buildToolPayload(state.name, state.input),
      })
    }
    this.activeToolUse.clear()
  }

  private emit(fields: {
    id: string
    kind: TimelineEventKind
    status: TimelineEventStatus
    title: string
    summary?: string
    payload?: Record<string, unknown>
  }): RunnerOutput {
    return { type: 'timeline_event', event: this.createEvent(fields) }
  }

  private createEvent(fields: {
    id: string
    kind: TimelineEventKind
    status: TimelineEventStatus
    title: string
    summary?: string
    payload?: Record<string, unknown>
  }): TimelineEvent {
    const order = this.intraTurnOrder++
    return {
      id: fields.id,
      sessionId: this.sessionId,
      messageId: undefined,
      turnId: this.currentTurnId,
      runtime: mapToolKindToRuntime(fields.kind),
      kind: fields.kind,
      status: fields.status,
      title: fields.title,
      summary: fields.summary,
      payload: fields.payload ?? {},
      turnSeq: this.turnSeq,
      intraTurnOrder: order,
      createdAt: now(),
      updatedAt: now(),
    }
  }
}
