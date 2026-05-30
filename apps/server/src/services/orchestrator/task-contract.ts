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
  task: Pick<ExecutionTask, 'id' | 'outputContract' | 'taskType'>
  artifacts: Array<Record<string, unknown>>
  writtenBlackboardKeys?: string[]
}): TaskContractResult {
  const contract = params.task.outputContract
  if (!contract) return { status: 'passed', violations: [] }

  const violations: TaskContractViolation[] = []
  const artifactKinds = new Set(params.artifacts.map((artifact) => artifactKind(artifact)).filter(Boolean))
  for (const required of contract.requiredArtifacts ?? []) {
    // 1) 匹配 artifact kind / type（如 file、diff）
    if (artifactKinds.has(required)) continue
    // 2) 匹配 artifact 的文件路径（LLM 通常把文件名写在 requiredArtifacts 中）
    const matched = params.artifacts.some((artifact) => {
      const path = artifactPath(artifact)
      if (!path) return false
      return path === required || path.endsWith(`/${required}`) || path.endsWith(`\\${required}`)
    })
    if (!matched) {
      violations.push({
        type: 'missing_artifact',
        message: `Required artifact "${required}" was not produced.`,
        expected: required,
      })
    }
  }

  const writtenKeys = new Set(params.writtenBlackboardKeys ?? [])
  for (const required of contract.requiredBlackboardWrites ?? []) {
    if (required.schemaType === 'task_output') {
      const canonicalKey = `task_${params.task.id}_output`
      if (writtenKeys.has(canonicalKey)) continue
    } else if (required.key && writtenKeys.has(required.key)) {
      continue
    }
    if (required.key) {
      violations.push({
        type: 'missing_blackboard_write',
        message: `Required blackboard write "${required.key}" was not produced.`,
        expected: required.key,
      })
    } else {
      violations.push({
        type: 'missing_blackboard_write',
        message: 'Required blackboard write was not produced.',
      })
    }
  }

  const allowedPaths = (contract.allowedPaths ?? []).map(normalizePathPattern).filter(Boolean)
  if (allowedPaths.length > 0) {
    for (const artifact of params.artifacts) {
      const filePath = artifactPath(artifact)
      if (!filePath) continue
      const normalized = normalizePath(filePath)
      if (isSafeRelativeArtifactPath(filePath) && !shouldEnforceAllowedPath(params.task, artifact)) continue
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

function isSafeRelativeArtifactPath(value: string): boolean {
  const raw = value.trim()
  if (!raw) return false
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return false
  const segments = raw.replace(/\\/g, '/').split('/')
  return segments.every((segment) => segment && segment !== '.' && segment !== '..')
}

function shouldEnforceAllowedPath(
  task: Pick<ExecutionTask, 'taskType'>,
  artifact: Record<string, unknown>,
): boolean {
  const strictTaskTypes = new Set(['code', 'test', 'verify'])
  return artifactKind(artifact) === 'diff' || Boolean(task.taskType && strictTaskTypes.has(task.taskType))
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
