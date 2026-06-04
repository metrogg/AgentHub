import { streamReply } from '../llm'
import { readManagerPromptConfig } from '../coordinator-runtime/manager-config'
import { buildToolsPrompt } from './skill-loader'
import { executeToolCall } from './tool-registry'
import type {
  ManagerAction,
  ManagerRuntime,
  ManagerRuntimeEvent,
  ManagerStepInput,
  ManagerStepResult,
  ManagerTool,
  ManagerToolCall,
  ManagerToolResult,
} from './types'

// ─── Local Manager Runtime ───────────────────────────────────────────
// Aligned with HiClaw's Manager execution pattern:
// 1. LLM reads SOUL.md + AGENTS.md + tools catalog
// 2. LLM decides which tool(s) to call
// 3. Tools execute against Controller APIs
// 4. Results go back to LLM
// 5. LLM decides next step or produces final actions
// 6. Repeat until LLM produces final actions or max iterations reached

const DEFAULT_MAX_ITERATIONS = 5
const MAX_OUTPUT_LENGTH = 8000

export class LocalManagerRuntime implements ManagerRuntime {
  readonly runtimeType = 'local-skill-runtime' as const

  async *step(
    input: ManagerStepInput,
    signal?: AbortSignal,
  ): AsyncGenerator<ManagerRuntimeEvent, ManagerStepResult> {
    const config = readManagerPromptConfig(input.context.workspaceId)
    const toolsPrompt = buildToolsPrompt(input.context.workspaceId)
    const tools = input.tools ?? []
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS

    const toolCalls: ManagerToolCall[] = []
    const toolResults: ManagerToolResult[] = []
    let iterations = 0
    let rawOutput = ''
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

    // Build initial prompt
    const systemPrompt = buildSystemPrompt(config.soul, config.agents, toolsPrompt)
    const userPrompt = buildStepPrompt(input)
    messages.push({ role: 'user', content: userPrompt })

    while (iterations < maxIterations) {
      iterations++
      signal?.throwIfAborted()

      yield { type: 'thinking', content: `Iteration ${iterations}...` }

      // Call LLM
      let output = ''
      for await (const chunk of streamReply(messages, systemPrompt, undefined, signal)) {
        output += chunk
        if (output.length > MAX_OUTPUT_LENGTH) break
      }
      rawOutput = output

      // Try to parse as tool calls
      const parsedToolCalls = parseToolCalls(output, tools)

      if (parsedToolCalls.length === 0) {
        // No tool calls - try to parse as final actions
        const actions = parseFinalActions(output)
        if (actions.length > 0) {
          yield { type: 'completed', actions }
          return {
            runtimeType: this.runtimeType,
            actions,
            toolCalls,
            toolResults,
            iterations,
            rawOutput: output,
          }
        }
        // LLM produced neither tool calls nor actions - treat as reply
        const replyAction: ManagerAction = { type: 'reply', message: extractTextOutput(output) }
        yield { type: 'completed', actions: [replyAction] }
        return {
          runtimeType: this.runtimeType,
          actions: [replyAction],
          toolCalls,
          toolResults,
          iterations,
          rawOutput: output,
        }
      }

      // Execute tool calls
      const context = {
        roomId: input.context.roomId,
        workspaceId: input.context.workspaceId,
        ownerId: 'default-user', // TODO: get from auth context
        runId: input.context.runId,
      }

      const assistantMessage = output
      messages.push({ role: 'assistant', content: assistantMessage })

      for (const call of parsedToolCalls) {
        toolCalls.push(call)
        yield { type: 'tool_call', call }

        const result = await executeToolCall(call, context)
        toolResults.push(result)
        yield { type: 'tool_result', result }
      }

      // Add tool results as user message for next iteration
      const toolResultsText = parsedToolCalls
        .map((call, i) => {
          const result = toolResults[toolResults.length - parsedToolCalls.length + i]!
          return `Tool ${call.name}(${JSON.stringify(call.arguments)}) => ${result.success ? 'SUCCESS' : 'FAILED'}: ${result.output}`
        })
        .join('\n\n')

      messages.push({
        role: 'user',
        content: `Tool execution results:\n${toolResultsText}\n\nContinue your reasoning. If you have enough information, output final actions as JSON.`,
      })
    }

    // Max iterations reached - produce a wait action
    const waitAction: ManagerAction = {
      type: 'wait',
      message: '达到最大迭代次数，需要继续观察。',
      reason: `Completed ${iterations} iterations without final decision.`,
    }
    yield { type: 'completed', actions: [waitAction] }
    return {
      runtimeType: this.runtimeType,
      actions: [waitAction],
      toolCalls,
      toolResults,
      iterations,
      rawOutput,
    }
  }
}

// ─── Prompt Building ─────────────────────────────────────────────────

function buildSystemPrompt(soul: string, agents: string, toolsPrompt: string): string {
  return [
    soul,
    agents,
    '',
    'You are the Manager agent running inside AgentHub.',
    'You coordinate Worker agents through Matrix rooms to accomplish user goals.',
    '',
    '## How You Work',
    '1. Observe the room timeline to understand what is happening.',
    '2. Decide if you need to take action (use a tool) or just reply.',
    '3. If you need to act, call one or more tools.',
    '4. Review tool results and decide if more actions are needed.',
    '5. When done, output final actions as JSON.',
    '',
    '## Tool Calling Format',
    'To call a tool, output a JSON block:',
    '```json',
    '{"tool_calls":[{"name":"tool.name","arguments":{"param":"value"}}]}',
    '```',
    '',
    '## Final Actions Format',
    'When you have completed your reasoning, output final actions:',
    '```json',
    '{"actions":[{"type":"reply","message":"your message to the room"}]}',
    '```',
    '',
    'Action types: reply, clarify, propose_members, assign, wait, create_worker, cancel_task, request_approval',
    '',
    toolsPrompt,
    '',
    '## Important Rules',
    '- Do not force ordinary conversation into task planning.',
    '- Manager coordinates; Workers execute.',
    '- All visible text should be concise Chinese unless the room context clearly asks otherwise.',
    '- When assigning tasks, include clear taskTitle and taskDescription.',
    '- Use taskKey and dependsOn for task dependencies.',
    '- Be transparent about your reasoning.',
  ].join('\n')
}

function buildStepPrompt(input: ManagerStepInput): string {
  const workers = input.context.workers ?? []
  const events = input.timeline.slice(-40)
  const lines: string[] = [
    `roomId: ${input.context.roomId}`,
    input.context.workspaceId ? `workspaceId: ${input.context.workspaceId}` : '',
    input.context.runId ? `runId: ${input.context.runId}` : '',
    input.context.goal ? `roomGoal: ${input.context.goal}` : '',
    input.context.managerName ? `managerName: ${input.context.managerName}` : '',
    '',
    'Available workers:',
  ]
  if (workers.length) {
    for (const w of workers) {
      lines.push(
        `- id=${w.workspaceAgentId}; name=${w.name}; role=${w.role}; runtime=${w.runtimeType}${w.codeAgentType ? `; codeAgent=${w.codeAgentType}` : ''}${w.status ? `; status=${w.status}` : ''}${w.capabilityTags.length ? `; capabilities=${w.capabilityTags.join(',')}` : ''}`,
      )
    }
  } else {
    lines.push('- none')
  }
  lines.push('', 'Room timeline (recent events):')
  if (events.length) {
    for (const event of events) {
      const body = event.body.trim().replace(/\s+/g, ' ').slice(0, 500)
      lines.push(`[${event.sequence}] ${event.senderType} ${event.type}: ${body}`)
    }
  } else {
    lines.push('- empty')
  }
  lines.push('', 'What should you do next? Call tools or output final actions.')
  return lines.filter(Boolean).join('\n')
}

// ─── Parsing ─────────────────────────────────────────────────────────

function parseToolCalls(output: string, tools: ManagerTool[]): ManagerToolCall[] {
  const calls: ManagerToolCall[] = []
  // Look for tool_calls JSON block
  const toolCallMatch = output.match(/```json\s*(\{[\s\S]*?"tool_calls"[\s\S]*?\})\s*```/)
  if (toolCallMatch) {
    try {
      const parsed = JSON.parse(toolCallMatch[1]!) as { tool_calls?: unknown }
      if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc && typeof tc === 'object' && typeof (tc as any).name === 'string') {
            calls.push({
              id: `tc_${Date.now()}_${calls.length}`,
              name: (tc as any).name,
              arguments: (tc as any).arguments ?? {},
            })
          }
        }
      }
    } catch {
      // JSON parse failed
    }
  }
  // Also try inline JSON without code blocks
  if (!calls.length) {
    const inlineMatch = output.match(/\{"tool_calls":\s*\[[\s\S]*?\]\}/)
    if (inlineMatch) {
      try {
        const parsed = JSON.parse(inlineMatch[0]) as { tool_calls?: unknown }
        if (Array.isArray(parsed.tool_calls)) {
          for (const tc of parsed.tool_calls) {
            if (tc && typeof tc === 'object' && typeof (tc as any).name === 'string') {
              calls.push({
                id: `tc_${Date.now()}_${calls.length}`,
                name: (tc as any).name,
                arguments: (tc as any).arguments ?? {},
              })
            }
          }
        }
      } catch {
        // JSON parse failed
      }
    }
  }
  return calls
}

function parseFinalActions(output: string): ManagerAction[] {
  const actions: ManagerAction[] = []
  // Look for actions JSON block
  const actionMatch = output.match(/```json\s*(\{[\s\S]*?"actions"[\s\S]*?\})\s*```/)
  if (actionMatch) {
    try {
      const parsed = JSON.parse(actionMatch[1]!) as { actions?: unknown }
      if (Array.isArray(parsed.actions)) {
        for (const a of parsed.actions) {
          if (a && typeof a === 'object' && typeof (a as any).type === 'string') {
            actions.push(normalizeAction(a))
          }
        }
      }
    } catch {
      // JSON parse failed
    }
  }
  // Also try inline JSON without code blocks
  if (!actions.length) {
    const inlineMatch = output.match(/\{"actions":\s*\[[\s\S]*?\]\}/)
    if (inlineMatch) {
      try {
        const parsed = JSON.parse(inlineMatch[0]) as { actions?: unknown }
        if (Array.isArray(parsed.actions)) {
          for (const a of parsed.actions) {
            if (a && typeof a === 'object' && typeof (a as any).type === 'string') {
              actions.push(normalizeAction(a))
            }
          }
        }
      } catch {
        // JSON parse failed
      }
    }
  }
  return actions
}

function normalizeAction(raw: any): ManagerAction {
  const validTypes = [
    'reply',
    'clarify',
    'propose_members',
    'assign',
    'wait',
    'create_worker',
    'cancel_task',
    'request_approval',
  ]
  const type = validTypes.includes(raw.type) ? raw.type : 'reply'
  return {
    type: type as ManagerAction['type'],
    message: typeof raw.message === 'string' ? raw.message : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    targetWorkerId: typeof raw.targetWorkerId === 'string' ? raw.targetWorkerId : undefined,
    taskKey: typeof raw.taskKey === 'string' ? raw.taskKey : undefined,
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d: any) => typeof d === 'string') : undefined,
    taskTitle: typeof raw.taskTitle === 'string' ? raw.taskTitle : undefined,
    taskDescription: typeof raw.taskDescription === 'string' ? raw.taskDescription : undefined,
    memberProposals: Array.isArray(raw.memberProposals)
      ? raw.memberProposals
          .filter((p: any) => p && typeof p.name === 'string')
          .map((p: any) => ({
            name: p.name,
            role: p.role || 'worker',
            reason: p.reason || '',
            expectedContribution: p.expectedContribution,
          }))
      : undefined,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined,
  }
}

function extractTextOutput(output: string): string {
  // Strip JSON blocks and return remaining text
  return output
    .replace(/```json[\s\S]*?```/g, '')
    .replace(/\{[\s]*"(tool_calls|actions)"[\s\S]*?\}/g, '')
    .trim()
    .slice(0, 2000)
}
