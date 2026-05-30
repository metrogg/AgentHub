import type { AgentRelation, AgentSelection, ExecutionAgent, ExecutionTask } from './types'

interface SelectAgentInput {
  task: Pick<
    ExecutionTask,
    'id' | 'title' | 'description' | 'agentId' | 'taskType' | 'dependencies' | 'maxRetries'
  >
  agents: ExecutionAgent[]
  relations?: AgentRelation[]
}

const TASK_ROLE_MATCH: Record<NonNullable<ExecutionTask['taskType']>, string[]> = {
  read: ['researcher', 'architect'],
  research: ['researcher'],
  design: ['architect', 'clarifier'],
  code: ['coder'],
  test: ['verifier', 'reviewer', 'coder'],
  verify: ['verifier'],
  review: ['reviewer'],
  synthesize: ['integrator', 'orchestrator', 'architect'],
}

const TASK_TAG_MATCH: Record<NonNullable<ExecutionTask['taskType']>, string[]> = {
  read: ['read', 'research', 'analysis'],
  research: ['research', 'sources', 'analysis'],
  design: ['planning', 'architecture', 'design', 'requirements'],
  code: ['code', 'implementation', 'workspace-write'],
  test: ['test', 'quality', 'validation', 'verify', 'build', 'typecheck'],
  verify: ['verify', 'test', 'build', 'typecheck'],
  review: ['review', 'quality', 'test'],
  synthesize: ['synthesize', 'summary', 'delivery'],
}

export function selectAgentForTask(input: SelectAgentInput): AgentSelection {
  const { task, agents, relations = [] } = input
  const candidates = agents.length ? agents : []
  if (!candidates.length) {
    return { selectedAgentKey: '', score: 0, rationale: ['No available agents'] }
  }

  const taskType = task.taskType ?? inferTaskType(`${task.title} ${task.description}`)
  const workerCandidates =
    taskType === 'synthesize'
      ? candidates
      : candidates.filter((agent) => agent.roleType !== 'orchestrator')
  const candidatePool = workerCandidates.length ? workerCandidates : candidates

  const scored = candidatePool
    .filter((agent) => isEligible(agent, taskType))
    .map((agent) => scoreAgent(agent, task, relations))
    .sort((a, b) => b.score - a.score)

  const selected = scored[0] ?? scoreAgent(candidatePool[0]!, task, relations)
  const reviewer =
    findRelatedAgent(selected.agent, 'reviewed_by', agents, relations) ??
    agents.find((agent) => agent.roleType === 'reviewer')
  const fallback = findRelatedAgent(selected.agent, 'fallback_to', agents, relations)

  return {
    selectedAgentKey: selected.agent.key,
    score: Math.round(selected.score),
    rationale: selected.rationale,
    reviewerAgentKey: reviewer?.key,
    fallbackAgentKey: fallback?.key,
  }
}

function isEligible(agent: ExecutionAgent, taskType?: ExecutionTask['taskType']) {
  if (taskType === 'code') {
    return (
      agent.runtimeType === 'code-agent' ||
      agent.roleType === 'coder' ||
      agent.capabilityTags.some((tag) => tag.toLowerCase().includes('code'))
    )
  }
  if (taskType === 'test' || taskType === 'verify') {
    return (
      agent.roleType === 'verifier' ||
      agent.capabilityTags.some((tag) =>
        ['verify', 'test', 'build', 'typecheck'].includes(tag.toLowerCase()),
      )
    )
  }
  if (taskType === 'review') {
    return (
      agent.roleType === 'reviewer' ||
      agent.capabilityTags.some((tag) => tag.toLowerCase().includes('review'))
    )
  }
  return true
}

function scoreAgent(
  agent: ExecutionAgent,
  task: SelectAgentInput['task'],
  relations: AgentRelation[],
) {
  const taskType = task.taskType ?? inferTaskType(`${task.title} ${task.description}`)
  const roleMatches = TASK_ROLE_MATCH[taskType] ?? []
  const tagMatches = TASK_TAG_MATCH[taskType] ?? []
  const tags = agent.capabilityTags.map((tag) => tag.toLowerCase())
  const text = [
    agent.name,
    agent.role,
    agent.description,
    agent.runtimeType,
    agent.codeAgentType,
    ...tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  let score = 0
  const rationale: string[] = []

  if (agent.roleType && roleMatches.includes(agent.roleType)) {
    score += 30
    rationale.push(`roleType=${agent.roleType} matches ${taskType}`)
  }
  const matchedTags = tagMatches.filter((tag) => text.includes(tag))
  if (matchedTags.length) {
    score += Math.min(25, matchedTags.length * 8)
    rationale.push(`capabilityTags match: ${matchedTags.slice(0, 3).join(', ')}`)
  }
  if (taskType === 'code' && agent.runtimeType === 'code-agent') {
    score += 20
    rationale.push('runtimeType=code-agent fits code task')
  } else if (taskType !== 'code' && agent.runtimeType === 'llm') {
    score += 10
    rationale.push('runtimeType=llm fits reasoning task')
  }
  if (taskType === 'code' && agent.sandboxPolicy === 'workspace-write') {
    score += 10
    rationale.push('sandboxPolicy=workspace-write allows edits')
  } else if (taskType !== 'code' && agent.sandboxPolicy === 'read-only') {
    score += 8
    rationale.push('sandboxPolicy=read-only is safe for non-code task')
  }
  if (
    relations.some(
      (relation) => relation.sourceAgentId === agent.id || relation.targetAgentId === agent.id,
    )
  ) {
    score += 10
    rationale.push('has collaboration relations')
  }
  if (agent.toolPermissions.includes('workspace:write') && taskType === 'code') {
    score += 5
    rationale.push('toolPermissions include workspace:write')
  }

  return {
    agent,
    score,
    rationale: rationale.length ? rationale : ['Selected as best available agent'],
  }
}

function findRelatedAgent(
  source: ExecutionAgent,
  relationType: AgentRelation['relationType'],
  agents: ExecutionAgent[],
  relations: AgentRelation[],
) {
  const relation = relations.find(
    (item) => item.sourceAgentId === source.id && item.relationType === relationType,
  )
  if (!relation) return undefined
  return agents.find((agent) => agent.id === relation.targetAgentId)
}

function inferTaskType(text: string): NonNullable<ExecutionTask['taskType']> {
  const lowered = text.toLowerCase()
  if (/梳理|分析|范围|边界|目标|交付|需求|方案|设计|plan|scope|requirement/.test(lowered))
    return 'design'
  if (lowered.includes('review') || lowered.includes('审查')) return 'review'
  if (lowered.includes('code') || lowered.includes('implement') || lowered.includes('实现'))
    return 'code'
  if (lowered.includes('research') || lowered.includes('资料') || lowered.includes('调研'))
    return 'research'
  if (lowered.includes('verify') || lowered.includes('verification')) return 'verify'
  if (lowered.includes('test') || lowered.includes('验证')) return 'test'
  if (lowered.includes('summary') || lowered.includes('汇总')) return 'synthesize'
  return 'design'
}
