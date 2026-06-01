import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { logger } from '../../lib/logger'

export interface CollaborationContract {
  id: string
  name: string
  version?: string
  description?: string
  scope: {
    description?: string
    allowedPaths: string[]
    forbiddenPaths: string[]
  }
  outputs: {
    artifactChain: string[]
    requiredArtifacts: string[]
    requiredBlackboardWrites: string[]
  }
  quality: {
    acceptanceCriteria: string[]
    qualityGates: string[]
  }
  capabilities: {
    preferredSkills: string[]
    requiredTools: string[]
    requiredMcpServers: string[]
    rules: string[]
  }
}

export async function loadExplicitCollaborationContracts(
  workspacePath: string | null | undefined,
): Promise<CollaborationContract[]> {
  if (!workspacePath) return []
  const contractDirs = [resolve(workspacePath, '.agenthub', 'contracts')]
  const contracts: CollaborationContract[] = []
  for (const dir of contractDirs) {
    if (!existsSync(dir)) continue
    const files = await readdir(dir).catch(() => [])
    for (const file of files) {
      if (!isContractFile(file)) continue
      const path = resolve(dir, file)
      const content = await readFile(path, 'utf8').catch(() => '')
      if (!content.trim()) continue
      try {
        const contract = parseCollaborationContract(content, file)
        if (contract) contracts.push(contract)
      } catch (error: any) {
        logger.warn({ err: error?.message, path }, 'Failed to parse collaboration contract')
      }
    }
  }
  return dedupeContracts(contracts)
}

export function parseCollaborationContract(
  content: string,
  fallbackId = 'collaboration-contract',
): CollaborationContract | null {
  const raw = parseContractDocument(content)
  const root = asRecord(raw.spec) ?? asRecord(raw.contract) ?? raw
  if (root.enabled === false) return null

  const forbiddenKeys = ['triggers', 'phases', 'requiredAgents', 'synthesis']
  const presentForbiddenKeys = forbiddenKeys.filter((key) => key in root)
  if (presentForbiddenKeys.length) {
    throw new Error(
      `Spec contract cannot contain workflow/template keys: ${presentForbiddenKeys.join(', ')}`,
    )
  }

  const scope = asRecord(root.scope) ?? {}
  const outputs = asRecord(root.outputs) ?? {}
  const quality = asRecord(root.quality) ?? {}
  const capabilities = asRecord(root.capabilities) ?? {}

  const id = stringValue(root.id) ?? fallbackId.replace(/\.(contract\.)?(json|ya?ml)$/i, '')
  const contract: CollaborationContract = {
    id,
    name: stringValue(root.name) ?? id,
    version: stringValue(root.version) ?? undefined,
    description: stringValue(root.description) ?? undefined,
    scope: {
      description: stringValue(scope.description) ?? undefined,
      allowedPaths: normalizePathList(scope.allowedPaths),
      forbiddenPaths: normalizePathList(scope.forbiddenPaths),
    },
    outputs: {
      artifactChain: normalizeStringList(outputs.artifactChain),
      requiredArtifacts: normalizeArtifactList(outputs.requiredArtifacts),
      requiredBlackboardWrites: normalizeStringList(outputs.requiredBlackboardWrites),
    },
    quality: {
      acceptanceCriteria: normalizeStringList(quality.acceptanceCriteria),
      qualityGates: normalizeStringList(quality.qualityGates),
    },
    capabilities: {
      preferredSkills: normalizeStringList(capabilities.preferredSkills),
      requiredTools: normalizeStringList(capabilities.requiredTools),
      requiredMcpServers: normalizeStringList(capabilities.requiredMcpServers),
      rules: normalizeStringList(capabilities.rules),
    },
  }

  if (!hasContractContent(contract)) {
    throw new Error('Spec contract is empty; add scope, outputs, quality, or capabilities')
  }

  return contract
}

export function formatContractsForPlanner(contracts: CollaborationContract[]) {
  if (!contracts.length) return ''
  return [
    'Explicit collaboration contracts from the workspace:',
    ...contracts.map((contract, index) => {
      const lines = [
        `${index + 1}. ${contract.name} (${contract.id})`,
        contract.description ? `Description: ${contract.description}` : '',
        contract.scope.description ? `Scope: ${contract.scope.description}` : '',
        contract.scope.allowedPaths.length
          ? `Allowed paths: ${contract.scope.allowedPaths.join(', ')}`
          : '',
        contract.scope.forbiddenPaths.length
          ? `Forbidden paths: ${contract.scope.forbiddenPaths.join(', ')}`
          : '',
        contract.outputs.artifactChain.length
          ? `Artifact chain: ${contract.outputs.artifactChain.join(' -> ')}`
          : '',
        contract.outputs.requiredArtifacts.length
          ? `Required artifacts: ${contract.outputs.requiredArtifacts.join(', ')}`
          : '',
        contract.outputs.requiredBlackboardWrites.length
          ? `Required blackboard writes: ${contract.outputs.requiredBlackboardWrites.join(', ')}`
          : '',
        contract.quality.acceptanceCriteria.length
          ? `Acceptance criteria: ${contract.quality.acceptanceCriteria.join(' | ')}`
          : '',
        contract.quality.qualityGates.length
          ? `Quality gates: ${contract.quality.qualityGates.join(' | ')}`
          : '',
        contract.capabilities.preferredSkills.length
          ? `Preferred skills: ${contract.capabilities.preferredSkills.join(', ')}`
          : '',
        contract.capabilities.requiredTools.length
          ? `Required tools: ${contract.capabilities.requiredTools.join(', ')}`
          : '',
        contract.capabilities.requiredMcpServers.length
          ? `Required MCP servers: ${contract.capabilities.requiredMcpServers.join(', ')}`
          : '',
        contract.capabilities.rules.length
          ? `Rules: ${contract.capabilities.rules.join(', ')}`
          : '',
      ]
      return lines.filter(Boolean).join('\n')
    }),
  ].join('\n\n')
}

function isContractFile(file: string) {
  return /\.contract\.(json|ya?ml)$/i.test(file)
}

function parseContractDocument(content: string): Record<string, unknown> {
  const trimmed = content.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  return parseSimpleContractYaml(trimmed)
}

function parseSimpleContractYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ]
  let arrayTarget: { indent: number; parent: Record<string, unknown>; key: string } | null = null

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0
    const line = rawLine.trim()

    if (line.startsWith('- ') && arrayTarget && indent > arrayTarget.indent) {
      const current = Array.isArray(arrayTarget.parent[arrayTarget.key])
        ? arrayTarget.parent[arrayTarget.key] as unknown[]
        : []
      current.push(parseScalar(line.slice(2).trim()))
      arrayTarget.parent[arrayTarget.key] = current
      continue
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop()
    const parent = stack[stack.length - 1]!.value
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    const value = match[2]!
    if (!value) {
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, value: child })
      arrayTarget = { indent, parent, key }
      continue
    }
    parent[key] = parseScalar(value)
    arrayTarget = null
  }
  return root
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean)
  }
  return unquote(trimmed)
}

function unquote(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function normalizeArtifactList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      return stringValue(record.path) ?? stringValue(record.type) ?? stringValue(record.name) ?? ''
    })
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20)
}

function normalizePathList(value: unknown): string[] {
  return normalizeStringList(value)
    .map((item) => item.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, ''))
    .filter(Boolean)
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 40)
}

function hasContractContent(contract: CollaborationContract) {
  return Boolean(
    contract.scope.allowedPaths.length ||
      contract.scope.forbiddenPaths.length ||
      contract.outputs.artifactChain.length ||
      contract.outputs.requiredArtifacts.length ||
      contract.outputs.requiredBlackboardWrites.length ||
      contract.quality.acceptanceCriteria.length ||
      contract.quality.qualityGates.length ||
      contract.capabilities.preferredSkills.length ||
      contract.capabilities.requiredTools.length ||
      contract.capabilities.requiredMcpServers.length ||
      contract.capabilities.rules.length,
  )
}

function dedupeContracts(contracts: CollaborationContract[]) {
  const seen = new Set<string>()
  return contracts.filter((contract) => {
    if (seen.has(contract.id)) return false
    seen.add(contract.id)
    return true
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
