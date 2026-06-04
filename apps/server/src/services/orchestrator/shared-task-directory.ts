import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { putSharedObject, sharedTaskObjectKey, type SharedObjectRef } from './shared-storage'

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
  rootPath: string | null
  relativeRoot: string
  specPath: string | null
  metaPath: string | null
  planPath: string | null
  resultPath: string | null
  artifactsPath: string | null
  objects: {
    meta: SharedObjectRef
    spec: SharedObjectRef
    plan: SharedObjectRef
  }
}

export type SharedTaskResultStatus =
  | 'SUCCESS'
  | 'SUCCESS_WITH_NOTES'
  | 'REVISION_NEEDED'
  | 'BLOCKED'
  | 'INTERRUPTED'

export interface SharedTaskResult {
  status: SharedTaskResultStatus
  summary: string
  deliverables: string[]
  notes: string[]
}

export interface SharedTaskResultArtifact {
  id: string
  title: string
  kind: 'file'
  type: 'file'
  path: string
  relativePath: string
  handoffRelativePath: string
  sharedTaskRelativeRoot: string
  source: 'shared-task-result'
}

export interface SharedTaskResultRead {
  result: SharedTaskResult
  resultPath: string
  rawText: string
}

export interface UpdateSharedTaskDirectoryStatusInput {
  projectPath?: string | null
  sharedTaskRelativeRoot?: string | null
  taskId?: string | null
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

export interface UpdateSharedTaskDirectoryStatusResult {
  meta?: SharedObjectRef
  result?: SharedObjectRef
}

export async function prepareSharedTaskDirectory(
  input: SharedTaskDirectoryInput,
): Promise<SharedTaskDirectory | null> {
  const projectPath = input.projectPath?.trim()

  const relativeRoot = ['.agenthub', 'shared', 'tasks', safePathSegment(input.taskId)].join('/')
  const metaText = JSON.stringify(buildTaskMeta(input, relativeRoot), null, 2)
  const specText = buildTaskSpec(input, relativeRoot)
  const planText = buildInitialPlan(input, relativeRoot)
  const objects = {
    meta: await putSharedObject({
      objectKey: sharedTaskObjectKey(input.taskId, 'meta.json'),
      content: metaText,
      mimeType: 'application/json; charset=utf-8',
    }),
    spec: await putSharedObject({
      objectKey: sharedTaskObjectKey(input.taskId, 'spec.md'),
      content: specText,
      mimeType: 'text/markdown; charset=utf-8',
    }),
    plan: await putSharedObject({
      objectKey: sharedTaskObjectKey(input.taskId, 'plan.md'),
      content: planText,
      mimeType: 'text/markdown; charset=utf-8',
    }),
  }

  let rootPath: string | null = null
  let metaPath: string | null = null
  let specPath: string | null = null
  let planPath: string | null = null
  let resultPath: string | null = null
  let artifactsPath: string | null = null

  if (projectPath) {
    rootPath = resolve(projectPath, relativeRoot)
    const basePath = join(rootPath, 'base')
    artifactsPath = join(rootPath, 'artifacts')
    await mkdir(basePath, { recursive: true })
    await mkdir(artifactsPath, { recursive: true })

    metaPath = join(rootPath, 'meta.json')
    specPath = join(rootPath, 'spec.md')
    planPath = join(rootPath, 'plan.md')
    resultPath = join(rootPath, 'result.md')
    await writeFile(metaPath, metaText, 'utf8')
    await writeFile(specPath, specText, 'utf8')
    await writeFile(planPath, planText, 'utf8')
  }

  return {
    rootPath,
    relativeRoot,
    specPath,
    metaPath,
    planPath,
    resultPath,
    artifactsPath,
    objects,
  }
}

export async function updateSharedTaskDirectoryStatus(
  input: UpdateSharedTaskDirectoryStatusInput,
): Promise<UpdateSharedTaskDirectoryStatusResult> {
  const projectPath = input.projectPath?.trim()
  const relativeRoot = input.sharedTaskRelativeRoot?.trim()
  const taskId = input.taskId?.trim() || (relativeRoot ? taskIdFromRelativeRoot(relativeRoot) : null)
  if (!relativeRoot || !taskId) return {}

  const rootPath = projectPath ? resolve(projectPath, relativeRoot) : null
  const metaPath = rootPath ? join(rootPath, 'meta.json') : null
  const resultPath = rootPath ? join(rootPath, 'result.md') : null
  if (rootPath) await mkdir(rootPath, { recursive: true })

  const existingMeta = metaPath ? await readJsonObject(metaPath) : {}
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

  const metaText = JSON.stringify(nextMeta, null, 2)
  if (metaPath) await writeFile(metaPath, metaText, 'utf8')
  const result: UpdateSharedTaskDirectoryStatusResult = {
    meta: await putSharedObject({
      objectKey: sharedTaskObjectKey(taskId, 'meta.json'),
      content: metaText,
      mimeType: 'application/json; charset=utf-8',
    }),
  }

  if (
    input.status === 'completed' ||
    input.status === 'failed' ||
    input.status === 'cancelled' ||
    input.status === 'blocked'
  ) {
    const resultText = renderSharedTaskResult(buildSharedTaskResult(input, relativeRoot))
    if (resultPath) await writeFile(resultPath, resultText, 'utf8')
    result.result = await putSharedObject({
      objectKey: sharedTaskObjectKey(taskId, 'result.md'),
      content: resultText,
      mimeType: 'text/markdown; charset=utf-8',
    })
  }
  return result
}

export async function readSharedTaskResult(input: {
  projectPath?: string | null
  sharedTaskRelativeRoot?: string | null
}): Promise<SharedTaskResultRead | null> {
  const projectPath = input.projectPath?.trim()
  const relativeRoot = input.sharedTaskRelativeRoot?.trim()
  if (!projectPath || !relativeRoot) return null

  const resultPath = resolve(projectPath, relativeRoot, 'result.md')
  let rawText = ''
  try {
    rawText = await readFile(resultPath, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }

  const result = parseSharedTaskResult(rawText)
  validateSharedTaskResult(result, relativeRoot)
  return { result, resultPath, rawText }
}

export function parseSharedTaskResult(text: string): SharedTaskResult {
  let status = ''
  let summary = ''
  const deliverables: string[] = []
  const notes: string[] = []
  let section: 'deliverables' | 'notes' | '' = ''

  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('STATUS:')) {
      status = line.slice('STATUS:'.length).trim()
      section = ''
      continue
    }
    if (line.startsWith('SUMMARY:')) {
      summary = line.slice('SUMMARY:'.length).trim()
      section = ''
      continue
    }
    if (line === 'DELIVERABLES:') {
      section = 'deliverables'
      continue
    }
    if (line === 'NOTES:') {
      section = 'notes'
      continue
    }
    if (line.startsWith('- ')) {
      const item = line.slice(2).trim()
      if (!item) continue
      if (section === 'deliverables') deliverables.push(item)
      if (section === 'notes') notes.push(item)
    }
  }

  const result = {
    status: normalizeSharedTaskResultStatus(status),
    summary,
    deliverables,
    notes,
  }
  validateSharedTaskResult(result)
  return result
}

export function renderSharedTaskResult(result: SharedTaskResult): string {
  validateSharedTaskResult(result)
  const lines = [
    `STATUS: ${result.status}`,
    `SUMMARY: ${singleLine(result.summary)}`,
    '',
    'DELIVERABLES:',
    ...result.deliverables.map((item) => `- ${item}`),
  ]
  if (result.notes.length > 0) {
    lines.push('', 'NOTES:', ...result.notes.map((item) => `- ${item}`))
  }
  return `${lines.join('\n').replace(/\s+$/g, '')}\n`
}

export function mapSharedTaskResultStatus(
  status: SharedTaskResultStatus,
): 'done' | 'failed' | 'cancelled' | 'blocked' {
  if (status === 'SUCCESS' || status === 'SUCCESS_WITH_NOTES') return 'done'
  if (status === 'BLOCKED') return 'blocked'
  if (status === 'INTERRUPTED') return 'cancelled'
  return 'failed'
}

export function sharedTaskResultDeliverablesToArtifacts(input: {
  taskId: string
  deliverables: string[]
  sharedTaskRelativeRoot: string
}): SharedTaskResultArtifact[] {
  return input.deliverables.map((path, index) => ({
    id: `shared-task-${input.taskId}-${index}`,
    title: path.split(/[\\/]/).filter(Boolean).pop() ?? 'artifact',
    kind: 'file',
    type: 'file',
    path,
    relativePath: path,
    handoffRelativePath: path,
    sharedTaskRelativeRoot: input.sharedTaskRelativeRoot,
    source: 'shared-task-result',
  }))
}

export function validateSharedTaskResult(result: SharedTaskResult, relativeRoot?: string | null) {
  normalizeSharedTaskResultStatus(result.status)
  if (!result.summary.trim()) {
    throw new Error('Shared task result summary is required.')
  }
  const expectedPrefix = relativeRoot?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  for (const deliverable of result.deliverables) {
    const normalized = deliverable.trim().replace(/\\/g, '/')
    if (!normalized) {
      throw new Error('Shared task result deliverable path must be non-empty.')
    }
    if (hasUnsafePathSegment(normalized)) {
      throw new Error(`Shared task result deliverable path is unsafe: ${deliverable}`)
    }
    if (expectedPrefix && !normalized.startsWith(`${expectedPrefix}/`)) {
      throw new Error(`Shared task result deliverable must be under ${expectedPrefix}: ${deliverable}`)
    }
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

function buildSharedTaskResult(
  input: UpdateSharedTaskDirectoryStatusInput,
  relativeRoot: string,
): SharedTaskResult {
  const artifacts = input.artifacts?.map(normalizeArtifactRef) ?? []
  const deliverables = artifacts
    .map((artifact) => artifact.handoffRelativePath ?? artifact.relativePath ?? null)
    .filter((path): path is string => Boolean(path))
    .map((path) => normalizeDeliverablePath(path, relativeRoot))
    .filter((path): path is string => Boolean(path))

  const notes = [
    input.error ? `Error: ${input.error}` : '',
    input.runtimeLeaseId ? `Runtime lease: ${input.runtimeLeaseId}` : '',
    input.workerInstanceId ? `Worker instance: ${input.workerInstanceId}` : '',
  ].filter(Boolean)

  return {
    status: sharedTaskStatusToResultStatus(input.status, Boolean(input.error)),
    summary: input.summary?.trim() || fallbackResultSummary(input),
    deliverables,
    notes,
  }
}

function sharedTaskStatusToResultStatus(
  status: UpdateSharedTaskDirectoryStatusInput['status'],
  hasError: boolean,
): SharedTaskResultStatus {
  if (status === 'completed') return hasError ? 'SUCCESS_WITH_NOTES' : 'SUCCESS'
  if (status === 'cancelled') return 'INTERRUPTED'
  if (status === 'blocked') return 'BLOCKED'
  return 'REVISION_NEEDED'
}

function fallbackResultSummary(input: UpdateSharedTaskDirectoryStatusInput) {
  if (input.status === 'completed') return 'Task completed.'
  if (input.status === 'cancelled') return 'Task was interrupted or cancelled before completion.'
  if (input.status === 'blocked') return 'Task is blocked and requires Manager or Human follow-up.'
  return input.error?.trim() || 'Task did not complete successfully.'
}

function normalizeDeliverablePath(path: string, relativeRoot: string): string | null {
  const normalizedPath = path.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!normalizedPath || hasUnsafePathSegment(normalizedPath)) return null
  const normalizedRoot = relativeRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath
  if (normalizedPath.startsWith('artifacts/')) return `${normalizedRoot}/${normalizedPath}`
  return `${normalizedRoot}/artifacts/${normalizedPath}`
}

function normalizeSharedTaskResultStatus(status: string): SharedTaskResultStatus {
  const normalized = status.trim().toUpperCase()
  if (
    normalized === 'SUCCESS' ||
    normalized === 'SUCCESS_WITH_NOTES' ||
    normalized === 'REVISION_NEEDED' ||
    normalized === 'BLOCKED' ||
    normalized === 'INTERRUPTED'
  ) {
    return normalized
  }
  throw new Error(`Invalid shared task result status: ${status || '<missing>'}`)
}

function singleLine(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function hasUnsafePathSegment(value: string) {
  if (/^[a-zA-Z]:\//.test(value) || value.startsWith('/') || value.startsWith('\\')) return true
  return value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
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
    `- 最终结果请写入：\`${relativeRoot}/result.md\`，必须使用下面“结果契约”中的机器可读格式。`,
    `- 文件、报告、网页、日志等产物请放入：\`${relativeRoot}/artifacts/\`。`,
    '- 不要覆盖 `base/` 中的输入材料。',
    '',
    '## 结果契约',
    '请让 `result.md` 保持以下格式，方便 Manager 稳定读取与验收：',
    '',
    '```text',
    'STATUS: SUCCESS | SUCCESS_WITH_NOTES | REVISION_NEEDED | BLOCKED | INTERRUPTED',
    'SUMMARY: 一句话总结任务结果',
    '',
    'DELIVERABLES:',
    `- ${relativeRoot}/artifacts/<产物文件名>`,
    '',
    'NOTES:',
    '- 可选补充说明、风险、未完成事项',
    '```',
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

function buildInitialPlan(input: SharedTaskDirectoryInput, relativeRoot: string) {
  const lines = [
    `# Plan: ${input.taskTitle}`,
    '',
    'STATUS: PREPARED',
    '',
    '## Contract refs',
    `- spec: ${relativeRoot}/spec.md`,
    `- result: ${relativeRoot}/result.md`,
    `- artifacts: ${relativeRoot}/artifacts/`,
    '',
    'Worker should replace this file with its execution plan before or during work.',
  ]
  if (input.dependencies?.length) {
    lines.push('', '## Dependencies', ...input.dependencies.map((id) => `- ${id}`))
  }
  return `${lines.join('\n')}\n`
}

function taskIdFromRelativeRoot(relativeRoot: string) {
  return relativeRoot.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? 'task'
}

function safePathSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'task'
}
