import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface SharedTaskDirectoryInput {
  projectPath?: string | null
  runId: string
  taskId: string
  taskTitle: string
  taskDescription: string
  goal: string
  assignee?: {
    id: string
    name: string
    role?: string | null
  } | null
  dependencies?: string[]
  acceptanceCriteria?: string[]
  requiredArtifacts?: string[]
}

export interface SharedTaskDirectory {
  rootPath: string
  relativeRoot: string
  specPath: string
  metaPath: string
  artifactsPath: string
}

export interface UpdateSharedTaskDirectoryStatusInput {
  projectPath?: string | null
  sharedTaskRelativeRoot?: string | null
  status:
    | 'prepared'
    | 'assigned'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'blocked'
  workerInstanceId?: string | null
  runtimeLeaseId?: string | null
  messageId?: string | null
  error?: string | null
  summary?: string | null
  artifacts?: Array<Record<string, unknown>>
  executionConfig?: Record<string, unknown> | null
  timestamps?: {
    assignedAt?: string
    startedAt?: string
    completedAt?: string
    failedAt?: string
    cancelledAt?: string
    updatedAt?: string
  }
}

export async function prepareSharedTaskDirectory(
  input: SharedTaskDirectoryInput,
): Promise<SharedTaskDirectory | null> {
  const projectPath = input.projectPath?.trim()
  if (!projectPath) return null

  const relativeRoot = ['.agenthub', 'shared', 'tasks', safePathSegment(input.taskId)].join('/')
  const rootPath = resolve(projectPath, relativeRoot)
  const basePath = join(rootPath, 'base')
  const artifactsPath = join(rootPath, 'artifacts')
  await mkdir(basePath, { recursive: true })
  await mkdir(artifactsPath, { recursive: true })

  const metaPath = join(rootPath, 'meta.json')
  const specPath = join(rootPath, 'spec.md')
  await writeFile(metaPath, JSON.stringify(buildTaskMeta(input, relativeRoot), null, 2), 'utf8')
  await writeFile(specPath, buildTaskSpec(input, relativeRoot), 'utf8')

  return {
    rootPath,
    relativeRoot,
    specPath,
    metaPath,
    artifactsPath,
  }
}

export async function updateSharedTaskDirectoryStatus(
  input: UpdateSharedTaskDirectoryStatusInput,
): Promise<void> {
  const projectPath = input.projectPath?.trim()
  const relativeRoot = input.sharedTaskRelativeRoot?.trim()
  if (!projectPath || !relativeRoot) return

  const rootPath = resolve(projectPath, relativeRoot)
  const metaPath = join(rootPath, 'meta.json')
  const resultPath = join(rootPath, 'result.md')
  await mkdir(rootPath, { recursive: true })

  const existingMeta = await readJsonObject(metaPath)
  const now = new Date().toISOString()
  const artifacts = input.artifacts?.map(normalizeArtifactRef) ?? undefined
  const nextMeta = {
    ...existingMeta,
    status: input.status,
    workerInstanceId: input.workerInstanceId ?? existingMeta.workerInstanceId ?? null,
    runtimeLeaseId: input.runtimeLeaseId ?? existingMeta.runtimeLeaseId ?? null,
    messageId: input.messageId ?? existingMeta.messageId ?? null,
    error: input.error ?? null,
    summary: input.summary ?? existingMeta.summary ?? null,
    artifacts: artifacts ?? existingMeta.artifacts ?? [],
    executionConfig: input.executionConfig ?? existingMeta.executionConfig ?? null,
    updatedAt: input.timestamps?.updatedAt ?? now,
    ...(input.timestamps?.assignedAt ? { assignedAt: input.timestamps.assignedAt } : {}),
    ...(input.timestamps?.startedAt ? { startedAt: input.timestamps.startedAt } : {}),
    ...(input.timestamps?.completedAt ? { completedAt: input.timestamps.completedAt } : {}),
    ...(input.timestamps?.failedAt ? { failedAt: input.timestamps.failedAt } : {}),
    ...(input.timestamps?.cancelledAt ? { cancelledAt: input.timestamps.cancelledAt } : {}),
  }

  await writeFile(metaPath, JSON.stringify(nextMeta, null, 2), 'utf8')

  if (input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled') {
    await writeFile(resultPath, buildResultMarkdown(input), 'utf8')
  }
}

function buildTaskMeta(input: SharedTaskDirectoryInput, relativeRoot: string) {
  const now = new Date().toISOString()
  return {
    schema: 'agenthub.shared-task.v1',
    taskId: input.taskId,
    runId: input.runId,
    title: input.taskTitle,
    status: 'prepared',
    assignedTo: input.assignee
      ? {
          id: input.assignee.id,
          name: input.assignee.name,
          role: input.assignee.role ?? '',
        }
      : null,
    dependencies: input.dependencies ?? [],
    paths: {
      root: relativeRoot,
      spec: `${relativeRoot}/spec.md`,
      base: `${relativeRoot}/base`,
      artifacts: `${relativeRoot}/artifacts`,
      plan: `${relativeRoot}/plan.md`,
      result: `${relativeRoot}/result.md`,
    },
    createdAt: now,
    updatedAt: now,
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function normalizeArtifactRef(artifact: Record<string, unknown>) {
  return {
    id: stringValue(artifact.id) ?? null,
    title: stringValue(artifact.title) ?? stringValue(artifact.filePath) ?? stringValue(artifact.path) ?? 'artifact',
    kind: stringValue(artifact.kind) ?? stringValue(artifact.type) ?? 'file',
    handoffPath: stringValue(artifact.handoffPath) ?? null,
    handoffRelativePath: stringValue(artifact.handoffRelativePath) ?? null,
    relativePath:
      stringValue(artifact.relativePath) ??
      stringValue(artifact.filePath) ??
      stringValue(artifact.path) ??
      null,
    sourcePath: stringValue(artifact.sourcePath) ?? null,
    status: stringValue(artifact.status) ?? null,
  }
}

function buildResultMarkdown(input: UpdateSharedTaskDirectoryStatusInput) {
  const lines = [
    `# Task Result`,
    '',
    `Status: ${input.status}`,
    `Updated At: ${input.timestamps?.updatedAt ?? new Date().toISOString()}`,
  ]
  if (input.summary) {
    lines.push('', '## Summary', input.summary)
  }
  if (input.error) {
    lines.push('', '## Error', input.error)
  }
  if (input.artifacts?.length) {
    lines.push('', '## Artifacts')
    for (const artifact of input.artifacts) {
      const ref = normalizeArtifactRef(artifact)
      const path = ref.handoffPath ?? ref.handoffRelativePath ?? ref.relativePath ?? ref.sourcePath ?? ''
      lines.push(`- ${ref.title}${path ? `: ${path}` : ''}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function buildTaskSpec(input: SharedTaskDirectoryInput, relativeRoot: string) {
  const lines = [
    `# ${input.taskTitle}`,
    '',
    '## 总目标',
    input.goal.trim() || '未提供总目标。',
    '',
    '## 当前任务',
    input.taskDescription.trim() || input.taskTitle,
    '',
    '## 负责人',
    input.assignee ? `${input.assignee.name} (${input.assignee.role || input.assignee.id})` : '待分配',
    '',
    '## 任务目录协议',
    `- 请先阅读本文件：\`${relativeRoot}/spec.md\`。`,
    `- 如需写执行计划，请写入：\`${relativeRoot}/plan.md\`。`,
    `- 最终结果摘要请写入：\`${relativeRoot}/result.md\`。`,
    `- 文件、报告、网页、日志等产物请放入：\`${relativeRoot}/artifacts/\`。`,
    '- 不要覆盖 `base/` 中的输入材料。',
  ]

  if (input.dependencies?.length) {
    lines.push('', '## 上游任务', ...input.dependencies.map((id) => `- ${id}`))
  }

  if (input.acceptanceCriteria?.length) {
    lines.push('', '## 验收标准', ...input.acceptanceCriteria.map((item) => `- ${item}`))
  }

  if (input.requiredArtifacts?.length) {
    lines.push('', '## 期望产物', ...input.requiredArtifacts.map((item) => `- ${item}`))
  }

  return `${lines.join('\n')}\n`
}

function safePathSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'task'
}
