/**
 * ManagerSkills — Manager/Orchestrator 可调用的内建能力草案。
 *
 * 注意：这里只有已经满足 AgentHub 当前分层约束的能力可以继续演进为主路径能力。
 * 凡是会绕过模型管理、Code Agent、Sandbox、RuntimeLease 或平台权限边界的操作，
 * 只能显式报错，不能假装自己已经是可用实现。
 */

import { db, eq, and, workspaceAgents, settings, workerInstances } from '@agenthub/db'
import { emitRunEvent } from './run-events'
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
 * model-switch — 历史草案入口，当前禁止直接切换全局活动模型。
 *
 * Gotchas:
 * - AgentHub 当前只允许“模型管理 / 内部 LLM 默认模型”链路管理内部模型配置
 * - Manager 不能在运行时直接篡改 ACTIVE_MODEL_ID
 */
export async function switchActiveModel(modelId: string): Promise<ModelSwitchResult> {
  throw new Error(
    `Manager 不能直接切换全局活动模型（请求模型：${modelId}）。请通过模型管理或“内部 LLM 默认模型”设置修改内部模型链路。`,
  )
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
 * git-delegation-management — 历史草案入口，当前禁止 Manager 直接执行 shell git。
 *
 * Gotchas:
 * - Git / shell 操作必须通过 Worker Runtime、Code Agent 与 SandboxProvider 执行
 * - Manager 直接 spawn shell 会绕过 RuntimeLease / 权限 / 隔离边界
 */
export async function delegateGitOperation(op: GitOperation): Promise<{
  success: boolean
  output: string
}> {
  throw new Error(
    `Manager 不能直接执行 git 命令（taskId=${op.taskId}）。请把 git 操作下发给具备对应权限的 Worker，并通过 RuntimeLease / Sandbox 执行。`,
  )
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
