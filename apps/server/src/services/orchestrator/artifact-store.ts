import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { artifacts, db, eq } from '@agenthub/db'
import { agentHubUserDataRoot, safePathSegment } from '../system-paths'

export type TaskArtifactRecord = typeof artifacts.$inferSelect

export interface RegisterTaskArtifactInput {
  workspaceId: string
  runId: string
  taskId: string
  roomId?: string | null
  taskThreadId?: string | null
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  artifact: Record<string, unknown>
  status?: 'discovered' | 'registered' | 'verified' | 'partial' | 'failed'
}

export async function registerTaskArtifact(input: RegisterTaskArtifactInput) {
  const normalized = normalizeArtifact(input.artifact)
  const storageObject = materializeLocalArtifactObject({
    workspaceId: input.workspaceId,
    runId: input.runId,
    taskId: input.taskId,
    roomId: input.roomId ?? null,
    taskThreadId: input.taskThreadId ?? null,
    workspaceAgentId: input.workspaceAgentId ?? null,
    workerInstanceId: input.workerInstanceId ?? null,
    artifact: input.artifact,
    normalized,
  })
  const existing = await findExistingArtifact(
    input.taskId,
    normalized.relativePath,
    storageObject.checksum ?? normalized.checksum,
  )
  if (existing) {
    const [updated] = await db
      .update(artifacts)
      .set({
        workspaceId: input.workspaceId,
        runId: input.runId,
        taskId: input.taskId,
        roomId: input.roomId ?? null,
        taskThreadId: input.taskThreadId ?? null,
        workspaceAgentId: input.workspaceAgentId ?? null,
        workerInstanceId: input.workerInstanceId ?? null,
        kind: normalized.kind,
        title: normalized.title,
        description: normalized.description,
        sourcePath: normalized.sourcePath,
        handoffPath: normalized.handoffPath,
        relativePath: normalized.relativePath,
        storageProvider: storageObject.storageProvider,
        bucket: storageObject.bucket,
        objectKey: storageObject.objectKey,
        storagePath: storageObject.storagePath,
        mimeType: normalized.mimeType,
        size: storageObject.size ?? normalized.size,
        checksum: storageObject.checksum ?? normalized.checksum,
        status: input.status ?? normalized.status,
        visibility: normalized.visibility,
        metadata: {
          ...normalized.metadata,
          storage: storageObject.metadata,
        },
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
      roomId: input.roomId ?? null,
      taskThreadId: input.taskThreadId ?? null,
      workspaceAgentId: input.workspaceAgentId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      kind: normalized.kind,
      title: normalized.title,
      description: normalized.description,
      sourcePath: normalized.sourcePath,
      handoffPath: normalized.handoffPath,
      relativePath: normalized.relativePath,
      storageProvider: storageObject.storageProvider,
      bucket: storageObject.bucket,
      objectKey: storageObject.objectKey,
      storagePath: storageObject.storagePath,
      mimeType: normalized.mimeType,
      size: storageObject.size ?? normalized.size,
      checksum: storageObject.checksum ?? normalized.checksum,
      status: input.status ?? normalized.status,
      visibility: normalized.visibility,
      metadata: {
        ...normalized.metadata,
        storage: storageObject.metadata,
      },
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
    storageProvider: artifact.storageProvider,
    bucket: artifact.bucket,
    objectKey: artifact.objectKey ?? undefined,
    storagePath: artifact.storagePath ?? undefined,
    mimeType: artifact.mimeType ?? undefined,
    size: artifact.size ?? undefined,
    checksum: artifact.checksum ?? undefined,
    status: artifact.status,
    visibility: artifact.visibility,
    source: 'artifact-store',
    taskId: artifact.taskId ?? undefined,
    roomId: artifact.roomId ?? undefined,
    taskThreadId: artifact.taskThreadId ?? undefined,
    workspaceAgentId: artifact.workspaceAgentId ?? undefined,
    workerInstanceId: artifact.workerInstanceId ?? undefined,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }
}

interface NormalizedArtifact {
  kind: 'file' | 'directory' | 'preview' | 'report' | 'log' | 'diff' | 'url'
  title: string
  description: string | null
  sourcePath: string | null
  handoffPath: string | null
  relativePath: string | null
  mimeType: string | null
  size: number | null
  checksum: string | null
  status: 'discovered' | 'registered' | 'verified' | 'partial' | 'failed'
  visibility: 'team'
  metadata: Record<string, unknown>
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

function normalizeArtifact(artifact: Record<string, unknown>): NormalizedArtifact {
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

function materializeLocalArtifactObject(input: {
  workspaceId: string
  runId: string
  taskId: string
  roomId?: string | null
  taskThreadId?: string | null
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  artifact: Record<string, unknown>
  normalized: NormalizedArtifact
}) {
  const bucket = 'agenthub-artifacts'
  const objectKey =
    stringValue(input.artifact.objectKey) ??
    buildArtifactObjectKey({
      workspaceId: input.workspaceId,
      runId: input.runId,
      taskId: input.taskId,
      relativePath: input.normalized.relativePath,
      title: input.normalized.title,
      kind: input.normalized.kind,
    })
  const storagePath = resolveArtifactStoragePath(bucket, objectKey)
  const sourcePath = resolveArtifactReadableSourcePath(input.artifact, input.normalized)
  let size: number | null = input.normalized.size
  let checksum: string | null = input.normalized.checksum
  let materialized = false
  let materializationMode: 'copy' | 'content' | 'descriptor' = 'descriptor'

  try {
    mkdirSync(dirname(storagePath), { recursive: true })
    if (sourcePath && existsSync(sourcePath)) {
      const stat = statSync(sourcePath)
      if (stat.isFile()) {
        copyFileSync(sourcePath, storagePath)
        size = stat.size
        checksum = checksum ?? checksumFile(sourcePath)
        materialized = true
        materializationMode = 'copy'
      }
    }
    if (!materialized) {
      const content = stringValue(input.artifact.content) ?? stringValue(input.artifact.text)
      if (content !== null) {
        writeFileSync(storagePath, content, 'utf8')
        size = Buffer.byteLength(content, 'utf8')
        checksum = checksum ?? checksumText(content)
        materialized = true
        materializationMode = 'content'
      }
    }
    if (!materialized) {
      const descriptor = `${JSON.stringify(input.artifact, null, 2)}\n`
      writeFileSync(storagePath, descriptor, 'utf8')
      size = Buffer.byteLength(descriptor, 'utf8')
      checksum = checksum ?? checksumText(descriptor)
      materialized = true
      materializationMode = 'descriptor'
    }
  } catch {
    materialized = false
  }

  return {
    storageProvider: 'local-filesystem' as const,
    bucket,
    objectKey,
    storagePath,
    size,
    checksum,
    metadata: {
      provider: 'local-filesystem',
      bucket,
      objectKey,
      storagePath,
      materialized,
      materializationMode,
      taskThreadId: input.taskThreadId ?? null,
      roomId: input.roomId ?? null,
      workspaceAgentId: input.workspaceAgentId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
    },
  }
}

function buildArtifactObjectKey(input: {
  workspaceId: string
  runId: string
  taskId: string
  relativePath: string | null
  title: string
  kind: string
}) {
  const extension = extname(input.relativePath ?? input.title)
  const leaf = safePathSegment(input.relativePath ?? input.title)
  const suffix = leaf.includes('.') || !extension ? leaf : `${leaf}${extension}`
  return [
    'workspaces',
    safePathSegment(input.workspaceId),
    'runs',
    safePathSegment(input.runId),
    'tasks',
    safePathSegment(input.taskId),
    safePathSegment(input.kind),
    suffix || 'artifact',
  ].join('/')
}

function resolveArtifactStoragePath(bucket: string, objectKey: string) {
  const parts = objectKey
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((part) => safePathSegment(part))
  return join(agentHubUserDataRoot(), 'storage', 'objects', safePathSegment(bucket), ...parts)
}

function resolveArtifactReadableSourcePath(
  artifact: Record<string, unknown>,
  normalized: NormalizedArtifact,
) {
  const candidates = [
    normalized.handoffPath,
    normalized.sourcePath,
    stringValue(artifact.storagePath),
    stringValue(artifact.absolutePath),
  ].filter(Boolean) as string[]
  return candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate)) ?? null
}

function checksumFile(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function checksumText(value: string) {
  return createHash('sha256').update(value).digest('hex')
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
