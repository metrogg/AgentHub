import type { AgentRelation, AgentSelection, ExecutionAgent, ExecutionTask } from './types'

interface SelectAgentInput {
  task: Pick<
    ExecutionTask,
    'id' | 'title' | 'description' | 'agentId' | 'taskType' | 'dependencies' | 'maxRetries'
  >
  agents: ExecutionAgent[]
  relations?: AgentRelation[]
}

/**
 * 保留为显式指派校验器，不再根据关键词/标签替 Orchestrator 重新改派。
 */
export function selectAgentForTask(input: SelectAgentInput): AgentSelection {
  const { task, agents, relations = [] } = input
  const selected = agents.find((agent) => agent.id === task.agentId || agent.key === task.agentId)
  if (!selected) {
    return {
      selectedAgentKey: '',
      score: 0,
      rationale: ['Task assignment agent not found'],
    }
  }

  const reviewer = findRelatedAgent(selected, 'reviewed_by', agents, relations)
  const fallback = findRelatedAgent(selected, 'fallback_to', agents, relations)

  return {
    selectedAgentKey: selected.key,
    score: 100,
    rationale: ['Using Orchestrator-provided assignment'],
    reviewerAgentKey: reviewer?.key,
    fallbackAgentKey: fallback?.key,
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
