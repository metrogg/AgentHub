import { Agent } from '@mastra/core/agent'
import { env } from '../env'

type MastraModelId = `${string}/${string}`

export const DEFAULT_AGENT_INSTRUCTIONS =
  'You are AgentHub Assistant, a helpful AI collaborator inside a multi-agent collaboration platform. Reply clearly, keep context from the conversation, and surface practical next steps when useful.'

function resolveAnthropicModel(): MastraModelId {
  return env.ANTHROPIC_MODEL.includes('/')
    ? (env.ANTHROPIC_MODEL as MastraModelId)
    : `anthropic/${env.ANTHROPIC_MODEL}`
}

export function createAssistantAgent(apiKey: string, instructions = DEFAULT_AGENT_INSTRUCTIONS) {
  return new Agent({
    id: 'agenthub-assistant',
    name: 'AgentHub Assistant',
    description: 'Default chat agent powered by Mastra.',
    instructions,
    model: {
      id: resolveAnthropicModel(),
      apiKey,
    },
  })
}
