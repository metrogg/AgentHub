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
