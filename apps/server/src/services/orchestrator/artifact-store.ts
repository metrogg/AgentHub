import { artifacts, db, eq } from '@agenthub/db'

export type TaskArtifactRecord = typeof artifacts.$inferSelect

export interface RegisterTaskArtifactInput {
  workspaceId: string
  runId: string
  taskId: string
  taskThreadId?: string | null
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  artifact: Record<string, unknown>
  status?: 'discovered' | 'registered' | 'verified' | 'partial' | 'failed'
}

export async function registerTaskArtifact(input: RegisterTaskArtifactInput) {
  const normalized = normalizeArtifact(input.artifact)
  const existing = await findExistingArtifact(input.taskId, normalized.relativePath, normalized.checksum)
  if (existing) {
    const [updated] = await db
      .update(artifacts)
      .set({
        workspaceId: input.workspaceId,
        runId: input.runId,
        taskId: input.taskId,
        taskThreadId: input.taskThreadId ?? null,
        workspaceAgentId: input.workspaceAgentId ?? null,
        workerInstanceId: input.workerInstanceId ?? null,
        kind: normalized.kind,
        title: normalized.title,
        description: normalized.description,
        sourcePath: normalized.sourcePath,
        handoffPath: normalized.handoffPath,
        relativePath: normalized.relativePath,
        mimeType: normalized.mimeType,
        size: normalized.size,
        checksum: normalized.checksum,
        status: input.status ?? normalized.status,
        visibility: normalized.visibility,
        metadata: normalized.metadata,
        updatedAt: new Date(),
      })
      .where(eq(artifacts.id, existing.id))
      .returning()
    return updated ?? existing
  }

  const [created] = await db
    .insert(artifacts)
    .values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      taskId: input.taskId,
      taskThreadId: input.taskThreadId ?? null,
      workspaceAgentId: input.workspaceAgentId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      kind: normalized.kind,
      title: normalized.title,
      description: normalized.description,
      sourcePath: normalized.sourcePath,
      handoffPath: normalized.handoffPath,
      relativePath: normalized.relativePath,
      mimeType: normalized.mimeType,
      size: normalized.size,
      checksum: normalized.checksum,
      status: input.status ?? normalized.status,
      visibility: normalized.visibility,
      metadata: normalized.metadata,
    })
    .returning()
  return created
}

export function toCanonicalArtifactRecord(artifact: TaskArtifactRecord): Record<string, unknown> {
  return {
    artifactId: artifact.id,
    id: artifact.id,
    kind: artifact.kind,
    type: artifact.kind,
    artifactKind: artifact.kind,
    title: artifact.title,
    description: artifact.description ?? undefined,
    filePath: artifact.relativePath ?? artifact.handoffPath ?? artifact.sourcePath ?? undefined,
    path: artifact.relativePath ?? undefined,
    sourcePath: artifact.sourcePath ?? undefined,
    handoffPath: artifact.handoffPath ?? undefined,
    handoffRelativePath: artifact.relativePath ?? undefined,
    mimeType: artifact.mimeType ?? undefined,
    size: artifact.size ?? undefined,
    checksum: artifact.checksum ?? undefined,
    status: artifact.status,
    visibility: artifact.visibility,
    source: 'artifact-store',
    taskId: artifact.taskId ?? undefined,
    taskThreadId: artifact.taskThreadId ?? undefined,
    workspaceAgentId: artifact.workspaceAgentId ?? undefined,
    workerInstanceId: artifact.workerInstanceId ?? undefined,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }
}

async function findExistingArtifact(taskId: string, relativePath: string | null, checksum: string | null) {
  if (!relativePath && !checksum) return null
  const rows = await db.select().from(artifacts).where(eq(artifacts.taskId, taskId)).limit(100)
  return (
    rows.find((row) => {
      if (relativePath && checksum) return row.relativePath === relativePath && row.checksum === checksum
      if (relativePath) return row.relativePath === relativePath
      return row.checksum === checksum
    }) ?? null
  )
}

function normalizeArtifact(artifact: Record<string, unknown>) {
  const rawKind = stringValue(artifact.kind) ?? stringValue(artifact.type) ?? 'file'
  const relativePath =
    stringValue(artifact.handoffRelativePath) ??
    stringValue(artifact.relativePath) ??
    stringValue(artifact.filePath) ??
    stringValue(artifact.path) ??
    null
  const title =
    stringValue(artifact.title) ??
    (relativePath ? relativePath.split('/').filter(Boolean).at(-1) : null) ??
    stringValue(artifact.id) ??
    '未命名产物'
  const metadata = {
    ...artifact,
    originalArtifactId: stringValue(artifact.id) ?? null,
  }
  return {
    kind: normalizeArtifactKind(rawKind),
    title,
    description: stringValue(artifact.description) ?? stringValue(artifact.summary) ?? null,
    sourcePath: stringValue(artifact.sourcePath) ?? null,
    handoffPath: stringValue(artifact.handoffPath) ?? null,
    relativePath,
    mimeType: stringValue(artifact.mimeType) ?? null,
    size: numberValue(artifact.size) ?? null,
    checksum: stringValue(artifact.checksum) ?? null,
    status: normalizeArtifactStatus(stringValue(artifact.status)) ?? 'registered',
    visibility: 'team' as const,
    metadata,
  }
}

function normalizeArtifactKind(value: string): 'file' | 'directory' | 'preview' | 'report' | 'log' | 'diff' | 'url' {
  if (value === 'diff') return 'diff'
  if (value === 'preview' || value === 'deploy') return 'preview'
  if (value === 'log') return 'log'
  if (value === 'url') return 'url'
  if (value === 'directory') return 'directory'
  if (value === 'report' || value === 'workflow') return 'report'
  return 'file'
}

function normalizeArtifactStatus(value?: string | null): 'discovered' | 'registered' | 'verified' | 'partial' | 'failed' | null {
  if (value === 'discovered' || value === 'registered' || value === 'verified' || value === 'partial' || value === 'failed') {
    return value
  }
  return null
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
