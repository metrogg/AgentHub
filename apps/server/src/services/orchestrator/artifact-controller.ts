import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { artifacts, db, eq, workspaceTasks } from '@agenthub/db'
import { emitRunEvent } from './run-events'
import { registerTaskArtifact, toCanonicalArtifactRecord, type TaskArtifactRecord } from './artifact-store'

export interface ArtifactBatchInput {
  workspaceId: string
  runId: string
  taskId: string
  roomId?: string | null
  taskThreadId?: string | null
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  groupSessionId?: string | null
  artifacts: Array<Record<string, unknown>>
}

export interface ArtifactBatchResult {
  registered: Array<{ artifactId: string; kind: string; title: string; handoffPath?: string }>
  skipped: number
  failed: number
  artifactIds: string[]
}

/**
 * ArtifactController is the single convergence point for artifact registration.
 *
 * In HiClaw, artifacts go through MinIO with a clear protocol:
 * 1. Manager creates task directory, pushes spec + base files
 * 2. Worker writes plan.md, result.md, artifacts/ into the directory
 * 3. Worker pushes back to shared storage
 * 4. Manager pulls and registers artifacts
 *
 * AgentHub's ArtifactController implements the same pattern:
 * - registerBatch() is the single entry point after task execution
 * - Each artifact gets an artifact.created RunEvent
 * - workspace_tasks.artifacts JSON becomes a cache/projection, not the source of truth
 */
export async function registerArtifactBatch(input: ArtifactBatchInput): Promise<ArtifactBatchResult> {
  const registered: ArtifactBatchResult['registered'] = []
  const artifactIds: string[] = []
  let skipped = 0
  let failed = 0

  for (const raw of input.artifacts) {
    try {
      const record = await registerTaskArtifact({
        workspaceId: input.workspaceId,
        runId: input.runId,
        taskId: input.taskId,
        roomId: input.roomId ?? null,
        taskThreadId: input.taskThreadId ?? null,
        workspaceAgentId: input.workspaceAgentId ?? null,
        workerInstanceId: input.workerInstanceId ?? null,
        artifact: raw,
        status: (raw.status as 'discovered' | 'registered' | 'verified' | 'partial' | 'failed') ?? 'registered',
      })

      if (!record) {
        failed++
        continue
      }

      artifactIds.push(record.id)
      const canonical = toCanonicalArtifactRecord(record as TaskArtifactRecord)
      registered.push({
        artifactId: record.id,
        kind: canonical.kind as string,
        title: canonical.title as string,
        handoffPath: canonical.handoffPath as string | undefined,
      })

      // Emit artifact.created RunEvent for new registrations
      if (input.groupSessionId) {
        await emitRunEvent({
          runId: input.runId,
          workspaceId: input.workspaceId,
          groupSessionId: input.groupSessionId,
          taskId: input.taskId,
          threadId: input.taskThreadId ?? null,
          workerInstanceId: input.workerInstanceId ?? null,
          agentId: input.workspaceAgentId ?? null,
          type: 'artifact.created',
          payload: {
            artifactId: record.id,
            taskId: input.taskId,
            roomId: input.roomId ?? null,
            kind: record.kind,
            title: record.title,
            handoffPath: record.handoffPath ?? null,
            relativePath: record.relativePath ?? null,
            objectKey: record.objectKey ?? null,
            storageProvider: record.storageProvider,
            storagePath: record.storagePath ?? null,
            mimeType: record.mimeType ?? null,
            size: record.size ?? null,
            status: record.status,
            visibility: record.visibility,
          },
        })
      }
    } catch {
      failed++
    }
  }

  return { registered, skipped, failed, artifactIds }
}

/**
 * Query all registered artifacts for a run, ordered by creation time.
 * This is the authoritative query — the artifacts table is the source of truth.
 */
export async function getRunArtifacts(runId: string): Promise<TaskArtifactRecord[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.runId, runId))
    .orderBy(artifacts.createdAt)
  return rows as TaskArtifactRecord[]
}

/**
 * Query all registered artifacts for a task.
 */
export async function getTaskArtifacts(taskId: string): Promise<TaskArtifactRecord[]> {
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(artifacts.createdAt)
  return rows as TaskArtifactRecord[]
}

/**
 * Discover and register all files in a task's shared directory.
 *
 * After a Worker finishes, this walks:
 *   {projectPath}/{sharedTaskRelativeRoot}/artifacts/**
 * and registers every file as an artifact. This is the "Worker dropped files
 * into the project, now Manager sees them" path — without it, code Workers
 * that just write files into the workspace would never appear in the UI.
 */
export async function discoverAndRegisterSharedTaskArtifacts(input: {
  workspaceId: string
  runId: string
  taskId: string
  roomId?: string | null
  taskThreadId?: string | null
  workspaceAgentId?: string | null
  workerInstanceId?: string | null
  groupSessionId?: string | null
  projectPath?: string | null
  sharedTaskRelativeRoot?: string | null
}): Promise<ArtifactBatchResult> {
  const result: ArtifactBatchResult = { registered: [], skipped: 0, failed: 0, artifactIds: [] }
  const projectPath = input.projectPath?.trim()
  const sharedRoot = input.sharedTaskRelativeRoot?.trim()
  if (!projectPath || !sharedRoot) return result

  const artifactsDir = join(projectPath, sharedRoot, 'artifacts')
  if (!safeExists(artifactsDir) || !safeStatIsDir(artifactsDir)) return result

  const files = listFilesRecursive(artifactsDir)
  if (files.length === 0) return result

  const batchArtifacts = files.map((file) => {
    const rel = file.slice(artifactsDir.length + 1).replace(/\\/g, '/')
    return {
      title: rel,
      kind: inferArtifactKindFromPath(rel),
      relativePath: rel,
      sourcePath: file,
      status: 'discovered' as const,
      visibility: 'team' as const,
    }
  })

  return registerArtifactBatch({
    workspaceId: input.workspaceId,
    runId: input.runId,
    taskId: input.taskId,
    roomId: input.roomId ?? null,
    taskThreadId: input.taskThreadId ?? null,
    workspaceAgentId: input.workspaceAgentId ?? null,
    workerInstanceId: input.workerInstanceId ?? null,
    groupSessionId: input.groupSessionId ?? null,
    artifacts: batchArtifacts,
  })
}

/**
 * Synchronize the workspace_tasks.artifacts JSON field from the artifacts table.
 * This turns the JSON column into a cache that can always be rebuilt from the
 * authoritative artifact records.
 */
export async function syncTaskArtifactsCache(taskId: string): Promise<void> {
  const rows = await getTaskArtifacts(taskId)
  const cache = rows.map((row) => toCanonicalArtifactRecord(row))
  await db
    .update(workspaceTasks)
    .set({
      artifacts: cache as unknown as typeof workspaceTasks.$inferInsert['artifacts'],
      updatedAt: new Date(),
    })
    .where(eq(workspaceTasks.id, taskId))
}

/**
 * Aggregate all child task artifacts into one run-level "primary deliverable"
 * so the user can click one button in the chat to see the final report /
 * landing page / app bundle. Without this, the UI shows 5 separate file chips
 * for a 5-part tutorial run; with this, the user gets one index.
 *
 * Returns the registered primary artifact id (or null if no markdown files found).
 */
export async function synthesizeRunPrimaryArtifact(input: {
  workspaceId: string
  runId: string
  title: string
  summary?: string
  includeMarkdown: boolean
  includeHtmlPreview: boolean
  groupSessionId?: string | null
  roomId?: string | null
}): Promise<string | null> {
  const all = await getRunArtifacts(input.runId)
  if (all.length === 0) return null

  const lines: string[] = [`# ${input.title}`, '']
  if (input.summary) {
    lines.push(input.summary, '')
  }
  lines.push('## Deliverables', '')

  for (const row of all) {
    const canonical = toCanonicalArtifactRecord(row)
    const title = (canonical.title as string) || row.title
    const rel = (canonical.relativePath as string) || row.relativePath || row.handoffPath
    const kind = row.kind
    if (input.includeMarkdown && row.mimeType?.startsWith('text/markdown')) {
      // Inline the markdown content for the report
      try {
        const fs = await import('node:fs/promises')
        if (row.storagePath) {
          const content = await fs.readFile(row.storagePath, 'utf8')
          lines.push(`### ${title}`, '', content, '', '---', '')
        } else {
          lines.push(`- [${title}](${rel ?? '#'}) _(${row.kind} - 路径为空)_`, '')
        }
      } catch {
        lines.push(`- [${title}](${rel ?? '#'}) _(${row.kind} - 读取失败)_`, '')
      }
    } else if (input.includeHtmlPreview && row.mimeType === 'text/html') {
      lines.push(`- [${title}](${row.storagePath}) _(preview: ${kind})_`, '')
    } else {
      lines.push(`- [${title}](${row.storagePath}) _(${kind})_`, '')
    }
  }

  const content = lines.join('\n')
  const result = await registerArtifactBatch({
    workspaceId: input.workspaceId,
    runId: input.runId,
    taskId: '__synthesis__', // synthesis is not bound to a specific task
    roomId: input.roomId ?? null,
    groupSessionId: input.groupSessionId ?? null,
    artifacts: [
      {
        title: `${input.title} - 总览`,
        kind: 'report',
        content,
        mimeType: 'text/markdown; charset=utf-8',
        status: 'registered',
        visibility: 'team',
      },
    ],
  })
  return result.artifactIds[0] ?? null
}

function safeExists(p: string): boolean {
  try {
    return statSync(p) !== undefined
  } catch {
    return false
  }
}

function safeStatIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: { name: string; isFile(): boolean; isDirectory(): boolean }[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as typeof entries
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out
}

function inferArtifactKindFromPath(relPath: string): 'file' | 'directory' | 'preview' | 'report' | 'log' | 'diff' | 'url' {
  const lower = relPath.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'preview'
  if (lower.endsWith('.md') || lower.endsWith('report.md') || lower.includes('/reports/')) return 'report'
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'log'
  if (lower.endsWith('.diff') || lower.endsWith('.patch')) return 'diff'
  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif') || lower.endsWith('.svg')) return 'file'
  return 'file'
}
