import type { ExecutionTask } from './types'

export interface TaskContractViolation {
  type: 'missing_artifact' | 'path_not_allowed' | 'missing_blackboard_write'
  message: string
  expected?: string
  actual?: string
}

export interface TaskContractResult {
  status: 'passed' | 'failed'
  violations: TaskContractViolation[]
}

export function validateTaskOutputContract(params: {
  task: Pick<ExecutionTask, 'id' | 'outputContract'>
  artifacts: Array<Record<string, unknown>>
  writtenBlackboardKeys?: string[]
}): TaskContractResult {
  const contract = params.task.outputContract
  if (!contract) return { status: 'passed', violations: [] }

  const violations: TaskContractViolation[] = []
  const artifactKinds = new Set(params.artifacts.map((artifact) => artifactKind(artifact)).filter(Boolean))
  for (const required of contract.requiredArtifacts ?? []) {
    if (!artifactKinds.has(required)) {
      violations.push({
        type: 'missing_artifact',
        message: `Required artifact "${required}" was not produced.`,
        expected: required,
      })
    }
  }

  const writtenKeys = new Set(params.writtenBlackboardKeys ?? [])
  for (const required of contract.requiredBlackboardWrites ?? []) {
    if (required.key && !writtenKeys.has(required.key)) {
      violations.push({
        type: 'missing_blackboard_write',
        message: `Required blackboard write "${required.key}" was not produced.`,
        expected: required.key,
      })
    }
  }

  const allowedPaths = (contract.allowedPaths ?? []).map(normalizePathPattern).filter(Boolean)
  if (allowedPaths.length > 0) {
    for (const artifact of params.artifacts) {
      const filePath = artifactPath(artifact)
      if (!filePath) continue
      const normalized = normalizePath(filePath)
      if (!allowedPaths.some((pattern) => matchPathPattern(normalized, pattern))) {
        violations.push({
          type: 'path_not_allowed',
          message: `Artifact path "${filePath}" is outside allowed paths.`,
          expected: allowedPaths.join(', '),
          actual: filePath,
        })
      }
    }
  }

  return { status: violations.length > 0 ? 'failed' : 'passed', violations }
}

function artifactKind(artifact: Record<string, unknown>): string {
  const value = artifact.kind ?? artifact.type
  return typeof value === 'string' ? value : ''
}

function artifactPath(artifact: Record<string, unknown>): string {
  const value = artifact.filePath ?? artifact.path
  return typeof value === 'string' ? value : ''
}

function normalizePathPattern(pattern: string): string {
  return normalizePath(pattern).replace(/\/+$/, '')
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
}

function matchPathPattern(filePath: string, pattern: string): boolean {
  if (!pattern) return false
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3).replace(/\/+$/, '')
    return filePath === prefix || filePath.startsWith(`${prefix}/`)
  }
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2).replace(/\/+$/, '')
    if (!filePath.startsWith(`${prefix}/`)) return false
    return !filePath.slice(prefix.length + 1).includes('/')
  }
  return filePath === pattern || filePath.startsWith(`${pattern}/`)
}
