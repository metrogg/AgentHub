import { and, db, eq, runtimeLeases, sql, workerInstances } from '@agenthub/db'
import type { CodeAgentType, RuntimeType, SandboxPolicy } from '@agenthub/shared'
import type { ExecutionConfigSummary } from '../execution/execution-config-summary'

export interface WorkerRuntimeAgentConfig {
  id: string
  runtimeType: RuntimeType
  codeAgentType?: CodeAgentType | null
  modelId?: string | null
  skillIds?: string[] | null
  sandboxPolicy?: SandboxPolicy | null
}

export interface EnsureWorkerInstanceInput {
  workspaceId: string
  agent: WorkerRuntimeAgentConfig
}

export async function ensureWorkerInstance(input: EnsureWorkerInstanceInput) {
  const runtimeBinding = resolveRuntimeBinding(input.agent)
  const existing = await findWorkerInstance(input.workspaceId, input.agent.id)
  if (existing) {
    const [updated] = await db
      .update(workerInstances)
      .set({
        runtimeFamily: runtimeBinding.runtimeFamily,
        runtimeBase: runtimeBinding.runtimeBase,
        modelId: input.agent.modelId ?? null,
        skillIds: input.agent.skillIds ?? [],
        sandboxPolicy: input.agent.sandboxPolicy ?? 'workspace-write',
        updatedAt: new Date(),
      })
      .where(eq(workerInstances.id, existing.id))
      .returning()
    return updated ?? existing
  }

  const [created] = await db
    .insert(workerInstances)
    .values({
      workspaceId: input.workspaceId,
      workspaceAgentId: input.agent.id,
      runtimeFamily: runtimeBinding.runtimeFamily,
      runtimeBase: runtimeBinding.runtimeBase,
      modelId: input.agent.modelId ?? null,
      skillIds: input.agent.skillIds ?? [],
      sandboxPolicy: input.agent.sandboxPolicy ?? 'workspace-write',
      desiredState: 'running',
      observedState: 'provisioning',
    })
    .returning()
  return created ?? null
}

export async function markWorkerInstanceState(
  workerInstanceId: string | null | undefined,
  state:
    | 'provisioning'
    | 'ready'
    | 'listening'
    | 'assigned'
    | 'busy'
    | 'waiting_for_human'
    | 'resuming'
    | 'idle'
    | 'sleeping'
    | 'stopped'
    | 'failed',
  input: {
    message?: string | null
    health?: Record<string, unknown>
    runtimeHome?: string | null
    runtimeConfigPath?: string | null
  } = {},
) {
  if (!workerInstanceId) return null
  const [updated] = await db
    .update(workerInstances)
    .set({
      observedState: state,
      health: input.health ?? undefined,
      runtimeHome: input.runtimeHome ?? undefined,
      runtimeConfigPath: input.runtimeConfigPath ?? undefined,
      lastHeartbeatAt: new Date(),
      message: input.message ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(workerInstances.id, workerInstanceId))
    .returning()
  return updated ?? null
}

export async function createRuntimeLease(input: {
  workspaceId: string
  runId?: string | null
  taskId?: string | null
  workerInstanceId?: string | null
  provider?: 'local-workdir' | 'docker-sandbox' | 'remote-container' | 'cloud'
  cwd?: string | null
  homeDir?: string | null
  configDir?: string | null
  cacheDir?: string | null
  tmpDir?: string | null
  dataDir?: string | null
  metadata?: Record<string, unknown>
}) {
  const [created] = await db
    .insert(runtimeLeases)
    .values({
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      workerInstanceId: input.workerInstanceId ?? null,
      provider: normalizeLeaseProvider(input.provider) ?? 'local-workdir',
      status: 'creating',
      cwd: input.cwd ?? null,
      homeDir: input.homeDir ?? null,
      configDir: input.configDir ?? null,
      cacheDir: input.cacheDir ?? null,
      tmpDir: input.tmpDir ?? null,
      dataDir: input.dataDir ?? null,
      metadata: input.metadata ?? {},
    })
    .returning()
  return created ?? null
}

export async function markRuntimeLeaseReady(
  runtimeLeaseId: string | null | undefined,
  input: RuntimeLeaseRuntimeUpdate = {},
) {
  return updateRuntimeLease(runtimeLeaseId, {
    ...runtimeUpdate(input),
    status: 'ready',
  })
}

export async function markRuntimeLeaseRunning(
  runtimeLeaseId: string | null | undefined,
  input: RuntimeLeaseRuntimeUpdate = {},
) {
  return updateRuntimeLease(runtimeLeaseId, {
    ...runtimeUpdate(input),
    status: 'running',
    startedAt: input.startedAt ?? new Date(),
  })
}

export async function markRuntimeLeaseWaitingForHuman(
  runtimeLeaseId: string | null | undefined,
  input: {
    metadata?: Record<string, unknown>
    workerInstanceId?: string | null
    message?: string | null
  } = {},
) {
  const waiting = await updateRuntimeLease(runtimeLeaseId, {
    status: 'waiting_for_human',
    metadata: input.metadata,
  })
  await markWorkerInstanceState(input.workerInstanceId, 'waiting_for_human', {
    message: input.message ?? 'Worker is waiting for human clarification.',
    health: {
      waitingForHuman: true,
      waitingSince: new Date().toISOString(),
      ...(input.metadata ?? {}),
    },
  })
  return waiting
}

export async function releaseRuntimeLease(
  runtimeLeaseId: string | null | undefined,
  input: { metadata?: Record<string, unknown>; workerInstanceId?: string | null } = {},
) {
  const released = await updateRuntimeLease(runtimeLeaseId, {
    status: 'released',
    releasedAt: new Date(),
    metadata: input.metadata,
  })
  await markWorkerInstanceState(input.workerInstanceId, 'idle', {
    message: 'Runtime lease released.',
  })
  return released
}

export async function failRuntimeLease(
  runtimeLeaseId: string | null | undefined,
  input: {
    error?: string | null
    metadata?: Record<string, unknown>
    workerInstanceId?: string | null
  } = {},
) {
  const failed = await updateRuntimeLease(runtimeLeaseId, {
    status: 'failed',
    releasedAt: new Date(),
    error: input.error ?? null,
    metadata: input.metadata,
  })
  await markWorkerInstanceState(input.workerInstanceId, 'failed', {
    message: input.error ?? 'Runtime lease failed.',
  })
  return failed
}

export async function markRuntimeLeaseStale(
  runtimeLeaseId: string | null | undefined,
  input: { error?: string | null; metadata?: Record<string, unknown> } = {},
) {
  return updateRuntimeLease(runtimeLeaseId, {
    status: 'stale',
    releasedAt: new Date(),
    error: input.error ?? 'Runtime lease became stale.',
    metadata: input.metadata,
  })
}

export async function markInterruptedRuntimeLeasesStale(input: {
  reason: string
  limit?: number
}): Promise<{ staleLeaseCount: number; affectedWorkerInstanceIds: string[] }> {
  const rows = await db.select().from(runtimeLeases).where(
    sql`${runtimeLeases.status} in ('creating', 'ready', 'running', 'cleaning')`,
  ).limit(input.limit ?? 500)
  if (rows.length === 0) {
    return { staleLeaseCount: 0, affectedWorkerInstanceIds: [] }
  }

  const now = new Date()
  const affectedWorkerInstanceIds = [
    ...new Set(
      rows
        .map((row) => row.workerInstanceId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]

  await Promise.all(
    rows.map((row) =>
      updateRuntimeLease(row.id, {
        status: 'stale',
        releasedAt: now,
        error: input.reason,
        metadata: {
          ...(row.metadata ?? {}),
          staleReason: input.reason,
          staleAt: now.toISOString(),
          previousStatus: row.status,
        },
      }),
    ),
  )

  await Promise.all(
    affectedWorkerInstanceIds.map((workerInstanceId) =>
      markWorkerInstanceState(workerInstanceId, 'failed', {
        message: `Runtime lease interrupted: ${input.reason}`,
        health: {
          staleRuntimeLease: true,
          staleReason: input.reason,
          staleAt: now.toISOString(),
        },
      }),
    ),
  )

  return { staleLeaseCount: rows.length, affectedWorkerInstanceIds }
}

export interface RuntimeLeaseRuntimeUpdate {
  provider?: 'local-workdir' | 'docker-sandbox' | 'remote-container' | 'cloud'
  cwd?: string | null
  homeDir?: string | null
  configDir?: string | null
  cacheDir?: string | null
  tmpDir?: string | null
  dataDir?: string | null
  containerId?: string | null
  sandboxId?: string | null
  pid?: number | null
  startedAt?: Date
  metadata?: Record<string, unknown>
  executionConfig?: ExecutionConfigSummary
}

async function updateRuntimeLease(
  runtimeLeaseId: string | null | undefined,
  values: Partial<typeof runtimeLeases.$inferInsert>,
) {
  if (!runtimeLeaseId) return null
  const [updated] = await db
    .update(runtimeLeases)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(eq(runtimeLeases.id, runtimeLeaseId))
    .returning()
  return updated ?? null
}

function runtimeUpdate(input: RuntimeLeaseRuntimeUpdate): Partial<typeof runtimeLeases.$inferInsert> {
  const provider = normalizeLeaseProvider(input.provider)
  return {
    provider: provider ?? undefined,
    cwd: input.cwd ?? input.executionConfig?.executionPath ?? undefined,
    homeDir: input.homeDir ?? input.executionConfig?.sandboxHomeDir ?? undefined,
    configDir: input.configDir ?? input.executionConfig?.sandboxConfigDir ?? undefined,
    cacheDir: input.cacheDir ?? input.executionConfig?.sandboxCacheDir ?? undefined,
    tmpDir: input.tmpDir ?? input.executionConfig?.sandboxTempDir ?? undefined,
    dataDir: input.dataDir ?? input.executionConfig?.sandboxDataDir ?? undefined,
    containerId: input.containerId ?? input.executionConfig?.sandboxContainerName ?? undefined,
    sandboxId: input.sandboxId ?? input.executionConfig?.sandboxId ?? undefined,
    pid: input.pid ?? undefined,
    metadata: mergeRuntimeMetadata(input.metadata, input.executionConfig),
  }
}

function normalizeLeaseProvider(
  provider: RuntimeLeaseRuntimeUpdate['provider'],
): 'local-workdir' | 'docker-sandbox' | 'remote-container' | undefined {
  if (!provider) return undefined
  if (provider === 'local-workdir' || provider === 'docker-sandbox' || provider === 'remote-container') {
    return provider
  }
  return 'remote-container'
}

function mergeRuntimeMetadata(
  metadata?: Record<string, unknown>,
  executionConfig?: ExecutionConfigSummary,
) {
  if (!metadata && !executionConfig) return undefined
  return {
    ...(metadata ?? {}),
    ...(executionConfig ? { executionConfig } : {}),
  }
}

async function findWorkerInstance(workspaceId: string, workspaceAgentId: string) {
  const [instance] = await db
    .select()
    .from(workerInstances)
    .where(and(eq(workerInstances.workspaceId, workspaceId), eq(workerInstances.workspaceAgentId, workspaceAgentId)))
    .limit(1)
  return instance ?? null
}

function resolveRuntimeBinding(agent: WorkerRuntimeAgentConfig): {
  runtimeFamily: 'coordinator' | 'worker'
  runtimeBase: 'codex' | 'claude-code' | 'opencode' | 'gemini'
} {
  if (agent.codeAgentType === 'claude-code') {
    return { runtimeFamily: 'worker', runtimeBase: 'claude-code' }
  }
  if (agent.codeAgentType === 'opencode') {
    return { runtimeFamily: 'worker', runtimeBase: 'opencode' }
  }
  if (agent.codeAgentType === 'gemini') {
    return { runtimeFamily: 'worker', runtimeBase: 'gemini' }
  }
  if (agent.codeAgentType === 'openclaw') {
    return { runtimeFamily: 'worker', runtimeBase: 'openclaw' }
  }
  return { runtimeFamily: 'worker', runtimeBase: 'codex' }
}
