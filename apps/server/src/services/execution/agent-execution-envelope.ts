import { mkdirSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { resolve } from 'node:path'

/**
 * AgentExecutionEnvelope — 每次 Agent 执行的强制上下文信封。
 *
 * 要求：
 * 1. runId + taskId + agentId 必须提供，用于全链路追踪。
 * 2. projectPath 是用户原始工作区路径。
 * 3. worktreePath 是实际执行目录（Git worktree）。
 *    - read-only: worktreePath 可为 null，直接在 projectPath 读取。
 *    - workspace-write / danger-full-access: worktreePath 必须非空。
 * 4. sandboxPolicy 决定文件系统边界。
 * 5. envAllowlist 决定子进程能看到的 env 键白名单。
 */

export interface AgentExecutionEnvelope {
  /** Run 标识（Orchestrator runId 或 sessionId） */
  runId: string
  /** Task 标识 */
  taskId: string
  /** Agent 标识 */
  agentId: string
  /** Agent 名称（用于日志/artifact） */
  agentName: string
  /** 用户原始项目路径 */
  projectPath: string | null
  /** Git worktree 路径（实际执行目录）。非 read-only 时必须非空 */
  worktreePath: string | null
  /** 沙箱策略 */
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 子进程 env 白名单 */
  envAllowlist: string[]
  /** 模型目标配置（注入到子进程 env） */
  modelTarget?: {
    apiKey?: string
    provider?: string
    modelId?: string
    openaiBaseUrl?: string
    anthropicBaseUrl?: string
  }
}

/** 默认 env 白名单：只传模型 key、必要 PATH、HOME 等明确字段 */
export const DEFAULT_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'ComSpec',
  'SystemRoot',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'DEEPSEEK_API_KEY',
  'AGENTHUB_MODEL_API_KEY',
  'CODEX_HOME',
  'OPENCODE_CONFIG',
  'NODE_ENV',
]

export function validateEnvelope(envelope: AgentExecutionEnvelope): void {
  if (!envelope.runId) throw new Error('AgentExecutionEnvelope.runId is required')
  if (!envelope.taskId) throw new Error('AgentExecutionEnvelope.taskId is required')
  if (!envelope.agentId) throw new Error('AgentExecutionEnvelope.agentId is required')
  if (envelope.sandboxPolicy !== 'read-only' && envelope.projectPath && !envelope.worktreePath) {
    throw new Error(
      `AgentExecutionEnvelope.worktreePath is required for sandboxPolicy=${envelope.sandboxPolicy}. ` +
        `Git worktree must be prepared before execution. Fallback to original projectPath is prohibited.`
    )
  }
  // projectPath 为 null 时（无项目工作区），允许 worktreePath 为 null，
  // buildExecutionCwd 会按需创建 no-project 执行目录。
}

export function buildExecutionCwd(envelope: AgentExecutionEnvelope): {
  cwd: string | undefined
  label: string
  valid: boolean
} {
  if (envelope.sandboxPolicy === 'read-only') {
    const path = envelope.projectPath ?? ensureNoProjectExecutionDir(envelope) ?? undefined
    return { cwd: path, label: path ?? '(只读模式，无项目目录)', valid: true }
  }

  const wt = envelope.worktreePath ?? ensureNoProjectExecutionDir(envelope)
  if (!wt) {
    return {
      cwd: undefined,
      label: envelope.projectPath ?? '(未指定)',
      valid: false,
    }
  }

  return { cwd: wt, label: wt, valid: true }
}

export function ensureNoProjectExecutionDir(
  envelope: Pick<AgentExecutionEnvelope, 'runId' | 'taskId' | 'agentId' | 'agentName' | 'projectPath'>,
) {
  if (envelope.projectPath) return null
  const dir = resolve(
    noProjectExecutionRoot(),
    'workspaces',
    'no-project',
    safePathSegment(envelope.runId),
    safePathSegment(envelope.taskId),
    `${safePathSegment(envelope.agentName)}-${safePathSegment(envelope.agentId)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

function noProjectExecutionRoot() {
  const configured =
    Bun.env.AGENTHUB_AGENT_CACHE_DIR?.trim() ||
    Bun.env.AGENTHUB_USER_CACHE_DIR?.trim() ||
    process.env.AGENTHUB_AGENT_CACHE_DIR?.trim() ||
    process.env.AGENTHUB_USER_CACHE_DIR?.trim()
  if (configured) return resolve(configured, '.AgentHub')
  return agentHubUserCacheRoot()
}

export function agentHubUserCacheRoot() {
  const configured =
    Bun.env.AGENTHUB_AGENT_CACHE_DIR?.trim() ||
    Bun.env.AGENTHUB_USER_CACHE_DIR?.trim() ||
    process.env.AGENTHUB_AGENT_CACHE_DIR?.trim() ||
    process.env.AGENTHUB_USER_CACHE_DIR?.trim()
  if (configured) {
    const root = resolve(configured, '.AgentHub')
    if (ensureWritableDir(root)) return root
  }

  const bases =
    platform() === 'win32'
      ? [
          Bun.env.LOCALAPPDATA?.trim(),
          process.env.LOCALAPPDATA?.trim(),
          Bun.env.APPDATA?.trim(),
          process.env.APPDATA?.trim(),
          tmpdir(),
        ]
      : platform() === 'darwin'
        ? [resolve(homedir(), 'Library', 'Caches'), tmpdir()]
        : [
            Bun.env.XDG_CACHE_HOME?.trim(),
            process.env.XDG_CACHE_HOME?.trim(),
            resolve(homedir(), '.cache'),
            tmpdir(),
          ]

  for (const base of bases.filter(Boolean) as string[]) {
    const root = resolve(base, '.AgentHub')
    if (ensureWritableDir(root)) return root
  }

  const root = resolve(tmpdir(), '.AgentHub')
  mkdirSync(root, { recursive: true })
  return root
}

function safePathSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown'
}

function ensureWritableDir(path: string) {
  try {
    mkdirSync(path, { recursive: true })
    return true
  } catch {
    return false
  }
}
