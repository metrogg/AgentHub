import { Agent } from '@mastra/core/agent'
import { env } from '../env'

type MastraModelId = `${string}/${string}`

export const DEFAULT_AGENT_INSTRUCTIONS =
  'You are AgentHub Assistant, a helpful AI collaborator inside a multi-agent collaboration platform. Reply clearly, keep context from the conversation, and surface practical next steps when useful.'

function resolveAnthropicModel(model = env.ANTHROPIC_MODEL): MastraModelId {
  return model.includes('/') ? (model as MastraModelId) : `anthropic/${model}`
}

export function createAssistantAgent(
  apiKey: string,
  instructions = DEFAULT_AGENT_INSTRUCTIONS,
  model = env.ANTHROPIC_MODEL
) {
  return new Agent({
    id: 'agenthub-assistant',
    name: 'AgentHub Assistant',
    description: 'Default chat agent powered by Mastra.',
    instructions,
    model: {
      id: resolveAnthropicModel(model),
      apiKey,
    },
  })
}
