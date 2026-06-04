import { streamReply } from '../llm'
import { extractJsonObject, parseJsonObject } from '../orchestrator/planner'
import { readManagerPromptConfig } from './manager-config'
import type {
  CoordinatorAction,
  CoordinatorRuntime,
  CoordinatorStepInput,
  CoordinatorStepResult,
} from './types'

const ACTION_TYPES = new Set(['reply', 'clarify', 'propose_members', 'assign', 'wait'])

export class LocalCoordinatorRuntime implements CoordinatorRuntime {
  readonly runtimeType = 'local-llm' as const

  async step(input: CoordinatorStepInput, signal?: AbortSignal): Promise<CoordinatorStepResult> {
    const config = readManagerPromptConfig(input.context.workspaceId)
    const output = await collectCoordinatorOutput({
      system: buildSystemPrompt(config.soul, config.agents),
      prompt: buildStepPrompt(input),
      signal,
    })
    const jsonText = extractJsonObject(output)
    if (!jsonText) {
      throw new Error(`CoordinatorRuntime 没有返回可解析 JSON。原始输出片段：${preview(output)}`)
    }
    const parsed = parseJsonObject(jsonText) as { actions?: unknown }
    const actions = normalizeActions(parsed.actions)
    return {
      runtimeType: this.runtimeType,
      actions,
      rawOutput: output,
    }
  }
}

async function collectCoordinatorOutput(input: {
  system: string
  prompt: string
  signal?: AbortSignal
}) {
  let output = ''
  for await (const chunk of streamReply(
    [{ role: 'user', content: input.prompt }],
    input.system,
    undefined,
    input.signal,
  )) {
    output += chunk
    if (output.length > 6000) break
  }
  return output
}

function buildSystemPrompt(soul: string, agents: string) {
  return [
    soul,
    agents,
    'You are running inside AgentHub CoordinatorRuntime.',
    'Observe the room timeline and decide the next Manager action.',
    'Return JSON only. Do not use Markdown.',
    '',
    'Allowed action types:',
    '- reply: natural room reply, greetings, acknowledgements, lightweight coordination.',
    '- clarify: ask the human for missing required information.',
    '- propose_members: propose adding missing workers; do not create them silently.',
    '- assign: assign a concrete task to an existing worker.',
    '- wait: no action needed yet.',
    '',
    'Important:',
    '- Do not force ordinary conversation into planning.',
    '- Manager coordinates; Worker executes.',
    '- Assign only to existing worker ids provided in context.',
    '- All visible text must be concise Chinese unless the room context clearly asks otherwise.',
    '',
    'Output schema:',
    'For multiple assign actions in one goal, use stable taskKey values and dependsOn taskKey values when one worker needs another worker result first.',
    '{"actions":[{"type":"reply|clarify|propose_members|assign|wait","message":"visible text","reason":"why","targetWorkerId":"workspace agent id for assign","taskKey":"stable task key","dependsOn":["upstream taskKey"],"taskTitle":"short title","taskDescription":"task details","memberProposals":[{"name":"...","role":"...","reason":"...","expectedContribution":"..."}],"metadata":{}}]}',
  ].join('\n')
}

function buildStepPrompt(input: CoordinatorStepInput) {
  const workers = input.context.workers ?? []
  const events = input.timeline.slice(-40)
  return [
    `roomId: ${input.context.roomId}`,
    input.context.workspaceId ? `workspaceId: ${input.context.workspaceId}` : '',
    input.context.runId ? `runId: ${input.context.runId}` : '',
    input.context.goal ? `roomGoal: ${input.context.goal}` : '',
    input.context.managerName ? `managerName: ${input.context.managerName}` : '',
    '',
    'workers:',
    workers.length
      ? workers
          .map((worker) =>
            [
              `- id=${worker.workspaceAgentId}`,
              `name=${worker.name}`,
              `role=${worker.role}`,
              `runtime=${worker.runtimeType}`,
              worker.codeAgentType ? `codeAgent=${worker.codeAgentType}` : '',
              worker.status ? `status=${worker.status}` : '',
              worker.capabilityTags.length ? `capabilities=${worker.capabilityTags.join(',')}` : '',
            ]
              .filter(Boolean)
              .join('; '),
          )
          .join('\n')
      : '- none',
    '',
    'timeline:',
    events.length
      ? events
          .map((event) => {
            const body = event.body.trim().replace(/\s+/g, ' ').slice(0, 1000)
            return `[${event.sequence}] ${event.senderType} ${event.type}: ${body}`
          })
          .join('\n')
      : '- empty',
  ]
    .filter(Boolean)
    .join('\n')
}

function normalizeActions(value: unknown): CoordinatorAction[] {
  if (!Array.isArray(value)) {
    throw new Error('CoordinatorRuntime 输出缺少 actions 数组')
  }
  const actions = value.map(normalizeAction).filter(Boolean) as CoordinatorAction[]
  if (!actions.length) {
    throw new Error('CoordinatorRuntime 输出了空 actions')
  }
  return actions
}

function normalizeAction(value: unknown): CoordinatorAction | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (!ACTION_TYPES.has(type)) {
    throw new Error(`CoordinatorRuntime 输出了无效 action：${type || 'unknown'}`)
  }
  return {
    type: type as CoordinatorAction['type'],
    message: optionalText(record.message),
    reason: optionalText(record.reason),
    targetWorkerId: optionalText(record.targetWorkerId),
    taskKey: optionalText(record.taskKey),
    dependsOn: normalizeStringArray(record.dependsOn),
    taskTitle: optionalText(record.taskTitle),
    taskDescription: optionalText(record.taskDescription),
    memberProposals: normalizeMemberProposals(record.memberProposals),
    metadata:
      record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : undefined,
  }
}

function normalizeMemberProposals(value: unknown): CoordinatorAction['memberProposals'] {
  if (!Array.isArray(value)) return undefined
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const record = item as Record<string, unknown>
      const name = optionalText(record.name)
      const role = optionalText(record.role)
      const reason = optionalText(record.reason)
      if (!name || !role || !reason) return null
      return {
        name,
        role,
        reason,
        expectedContribution: optionalText(record.expectedContribution),
      }
    })
    .filter(Boolean) as NonNullable<CoordinatorAction['memberProposals']>
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const values = value
    .map((item) => optionalText(item))
    .filter(Boolean) as string[]
  return values.length ? values : undefined
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function preview(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500)
}
