import type { ModelCatalogItem, WorkspaceAgent } from './api'

type CodeAgentType = NonNullable<WorkspaceAgent['codeAgentType']>

export function isClaudeCodeCompatibleModel(model?: ModelCatalogItem | null, rawModelId?: string | null) {
  const modelId = model?.modelId?.trim() || rawModelId?.trim() || ''
  if (!isClaudeCodeModelId(modelId)) return false

  const provider = model?.provider?.trim().toLowerCase() ?? ''
  const endpoint = (model?.anthropicEndpoint?.trim() || model?.apiEndpoint?.trim() || '').toLowerCase()
  if (!model) return true
  return provider.includes('anthropic') || provider.includes('claude') || endpoint.includes('anthropic.com')
}

export function filterModelsForCodeAgent(
  models: ModelCatalogItem[],
  codeAgentType?: CodeAgentType | null,
  currentModelId?: string | null,
) {
  if (codeAgentType !== 'claude-code') return models

  const current = currentModelId
    ? models.find((model) => model.id === currentModelId || model.modelId === currentModelId)
    : null

  if (current) {
    return [current, ...models.filter((model) => model.id !== current.id)]
  }

  return models
}

export function isModelIncompatibleWithCodeAgent(
  model: ModelCatalogItem,
  codeAgentType?: CodeAgentType | null,
) {
  return codeAgentType === 'claude-code' && !isClaudeCodeCompatibleModel(model)
}

function isClaudeCodeModelId(modelId?: string | null) {
  return /\b(claude|sonnet|opus|haiku)\b/i.test(modelId?.trim() ?? '')
}
