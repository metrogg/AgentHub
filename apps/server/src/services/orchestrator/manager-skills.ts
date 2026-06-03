/**
 * ManagerSkills — AgentHub's built-in Manager capabilities, modeled on HiClaw's
 * 16 skill system. Each skill is a TypeScript function (not a shell script),
 * callable from ManagerLoop.step(), the patrol, or user-initiated actions.
 *
 * HiClaw pattern: SKILL.md (what + gotchas) + scripts/ (how) + references/ (details)
 * AgentHub pattern: function (what + how) + JSDoc gotchas + RunEvent feedback
 */

import { db, eq, and, workspaceAgents, settings, workerInstances } from '@agenthub/db'
import { emitRunEvent } from './run-events'
import { workerController } from './worker-controller'
import { markWorkerInstanceState } from './worker-runtime-resources'

// ─── Skill: Worker Management ────────────────────────────────────────────────

export interface CreateWorkerInput {
  workspaceId: string
  name: string
  role: string
  roleType: string
  codeAgentType: string
  modelId?: string | null
  skillIds?: string[]
}

export interface WorkerManagementResult {
  action: string
  workerId?: string | null
  error?: string
}

/**
 * worker-management — find or create a Worker agent in the workspace.
 *
 * Gotchas:
 * - Idempotent: if a worker with the same name+workspace exists, returns it
 * - Role description feeds into the system prompt; keep it specific
 * - Created workers get workspace-write sandbox by default
 */
export async function ensureWorker(params: CreateWorkerInput): Promise<WorkerManagementResult> {
  const existing = await db
    .select()
    .from(workspaceAgents)
    .where(
      and(
        eq(workspaceAgents.workspaceId, params.workspaceId),
        eq(workspaceAgents.name, params.name),
      ),
    )
    .limit(1)

  if (existing.length > 0) {
    const worker = existing[0]!
    return { action: 'found', workerId: worker.id }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const values: any = {
    workspaceId: params.workspaceId,
    name: params.name,
    role: params.role,
    roleType: params.roleType,
    runtimeType: 'code-agent',
    codeAgentType: params.codeAgentType,
    modelId: params.modelId ?? null,
    skillIds: params.skillIds ?? [],
    sandboxPolicy: 'workspace-write',
  }
  const [created] = await db.insert(workspaceAgents).values(values).returning()

  if (!created) return { action: 'create', error: 'Failed to create worker agent' }
  return { action: 'created', workerId: created.id }
}

export async function listWorkspaceWorkers(workspaceId: string) {
  return db
    .select()
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))
}

// ─── Skill: Model Switch ─────────────────────────────────────────────────────

export interface ModelSwitchResult {
  success: boolean
  modelId: string
  previousModelId?: string | null
}

/**
 * model-switch — switch the active LLM model.
 *
 * Gotchas:
 * - Always verify connectivity before switching
 * - If the new model is not in the catalog, it's added first
 */
export async function switchActiveModel(modelId: string): Promise<ModelSwitchResult> {
  const [current] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'ACTIVE_MODEL_ID'))
    .limit(1)

  const previousModelId = current?.value ?? null

  if (current) {
    await db
      .update(settings)
      .set({ value: modelId, updatedAt: new Date() })
      .where(eq(settings.key, 'ACTIVE_MODEL_ID'))
  } else {
    await db.insert(settings).values({ key: 'ACTIVE_MODEL_ID', value: modelId })
  }

  return { success: true, modelId, previousModelId }
}

// ─── Skill: Worker Model Switch ──────────────────────────────────────────────

/**
 * worker-model-switch — switch a Worker's LLM model.
 *
 * Gotchas:
 * - The worker's active lease will be released; next task picks up the new model
 * - Does NOT recreate a container (unlike HiClaw); model binding is per-lease
 */
export async function switchWorkerModel(
  workerInstanceId: string,
  modelId: string,
): Promise<ModelSwitchResult> {
  const [worker] = await db
    .select()
    .from(workerInstances)
    .where(eq(workerInstances.id, workerInstanceId))
    .limit(1)

  const previousModelId = worker?.modelId ?? null

  await db
    .update(workerInstances)
    .set({ modelId, updatedAt: new Date() })
    .where(eq(workerInstances.id, workerInstanceId))

  await markWorkerInstanceState(workerInstanceId, 'idle', {
    message: `Model switched to ${modelId}. Worker is idle, next task will use new model.`,
  })

  return { success: true, modelId, previousModelId }
}

// ─── Skill: Git Delegation ───────────────────────────────────────────────────

export interface GitOperation {
  taskId: string
  workspace: string
  operations: string[]
}

/**
 * git-delegation-management — execute git operations on behalf of Workers.
 *
 * Gotchas:
 * - Operations run in the task's workdir, not the project root
 * - Manager validates the workspace path before executing
 * - Worker must have workspace-write sandbox for this to work
 */
export async function delegateGitOperation(op: GitOperation): Promise<{
  success: boolean
  output: string
}> {
  const lines: string[] = []
  for (const cmd of op.operations) {
    const trimmed = cmd.trim()
    if (!trimmed.startsWith('git ')) {
      lines.push(`SKIPPED (not a git command): ${trimmed}`)
      continue
    }
    try {
      const proc = Bun.spawn(['bash', '-c', trimmed], {
        cwd: op.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      if (exitCode === 0) {
        lines.push(`OK: ${trimmed}\n${stdout.trim()}`)
      } else {
        lines.push(`FAILED (exit ${exitCode}): ${trimmed}\n${stderr.trim() || stdout.trim()}`)
      }
    } catch (err: any) {
      lines.push(`ERROR: ${trimmed}\n${err?.message || String(err)}`)
    }
  }
  return { success: lines.every((l) => !l.startsWith('FAILED') && !l.startsWith('ERROR')), output: lines.join('\n\n') }
}

// ─── Skill: MCP Server Management ────────────────────────────────────────────

export interface McpServerConfig {
  name: string
  transport: 'sse' | 'streamable-http' | 'stdio'
  endpoint?: string | null
  command?: string | null
  args?: string[]
  env?: Record<string, string>
}

/**
 * mcp-server-management — register or update an MCP server configuration.
 *
 * Gotchas:
 * - Store credentials in settings, not in code
 * - Always verify connectivity before notifying Workers
 * - Server name must be unique
 */
export async function registerMcpServer(config: McpServerConfig): Promise<{
  success: boolean
  serverId: string
}> {
  const key = `MCP_SERVER_${config.name.toUpperCase()}`
  const [existing] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1)

  const value = JSON.stringify(config)

  if (existing) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key))
  } else {
    await db.insert(settings).values({ key, value })
  }

  return { success: true, serverId: key }
}

// ─── Skill: File Sync ────────────────────────────────────────────────────────

/**
 * file-sync-management — coordinate file access between Manager and Workers.
 *
 * Gotchas:
 * - Manager must pull before reading Worker output
 * - After writing, push + notify Worker via @mention in TaskThread
 * - Local FS is not real-time synced (unlike MinIO mc mirror)
 */
export async function notifyWorkerFileSync(
  workspaceId: string,
  groupSessionId: string,
  runId: string,
  taskId: string,
  threadId: string | null,
  message: string,
): Promise<void> {
  if (!threadId) return

  await emitRunEvent({
    runId,
    workspaceId,
    groupSessionId,
    taskId,
    threadId,
    type: 'manager.next_action',
    payload: {
      action: 'file_sync_request',
      reason: message,
      taskId,
      threadId,
    },
  })
}

// ─── Skill: Worker Discovery ──────────────────────────────────────────────────

/**
 * hiclaw-find-worker — search for suitable Workers by role or capability.
 *
 * Gotchas:
 * - Only searches the current workspace
 * - Does not import from external markets (no Nacos equivalent yet)
 */
export async function findWorkerByRole(
  workspaceId: string,
  roleType: string,
): Promise<Array<{ id: string; name: string; roleType: string }>> {
  const all = await db
    .select({
      id: workspaceAgents.id,
      name: workspaceAgents.name,
      roleType: workspaceAgents.roleType,
    })
    .from(workspaceAgents)
    .where(eq(workspaceAgents.workspaceId, workspaceId))

  return all
    .filter((w) => w.roleType === roleType)
    .map((w) => ({ id: w.id, name: w.name, roleType: (w.roleType ?? 'custom') as string }))
}

// ─── Skill: Human Management ─────────────────────────────────────────────────

export interface HumanAccessInput {
  userId: string
  workspaceId: string
  /** HiClaw L1=admin, L2=team, L3=worker-specific */
  permissionLevel: 1 | 2 | 3
  accessibleAgentIds?: string[]
}

/**
 * human-management — grant or revoke human access to workspace agents.
 *
 * Gotchas:
 * - L1 = full admin access (all agents + orchestration)
 * - L2 = access to specified teams/agents
 * - L3 = access to specified workers only
 * - Higher levels include all lower-level permissions
 */
export async function grantHumanAccess(input: HumanAccessInput): Promise<{ success: boolean }> {
  // For now, single-user mode: the current user is always L1 admin.
  // When multi-user support arrives, this stores permission in a settings record.
  const key = `HUMAN_ACCESS_${input.workspaceId}_${input.userId}`
  const value = JSON.stringify(input)

  const [existing] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1)

  if (existing) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key))
  } else {
    await db.insert(settings).values({ key, value })
  }

  return { success: true }
}
