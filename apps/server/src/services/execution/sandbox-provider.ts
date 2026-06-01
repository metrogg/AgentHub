import { mkdirSync, rmSync } from 'node:fs'
import { platform } from 'node:os'
import { resolve } from 'node:path'
import { env } from '../../env'
import type { AgentWorkdir } from './agent-workdir'
import { prepareAgentWorkdir } from './agent-workdir'
import { agentHubUserCacheRoot, safePathSegment } from '../system-paths'

export type SandboxProviderKind = 'local-workdir' | 'docker-sandbox' | 'cloud'
export type ExecutionIsolation = 'workdir' | 'microvm' | 'cloud'
export type NetworkPolicy = 'default' | 'restricted' | 'disabled'
export type AgentSandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface SandboxSpec {
  provider?: SandboxProviderKind | null
  runId: string
  taskId: string
  agentId: string
  agentName: string
  projectPath?: string | null
  codeAgentType?: string | null
  sandboxPolicy: AgentSandboxPolicy
  networkPolicy?: NetworkPolicy
  existingWorkdir?: AgentWorkdir | null
}

export interface SandboxLease {
  provider: SandboxProviderKind
  isolation: ExecutionIsolation
  sandboxPolicy: AgentSandboxPolicy
  cwd: string | null
  workdir: AgentWorkdir | null
  rootDir: string
  homeDir: string
  cacheDir: string
  configDir: string
  dataDir: string
  tempDir: string
  networkPolicy: NetworkPolicy
  cleanupMode: 'keep' | 'delete'
  env: Record<string, string>
  container?: SandboxContainerSpec
  metadata: Record<string, unknown>
  cleanup: () => Promise<void>
}

export interface SandboxProvider {
  kind: SandboxProviderKind
  acquire(spec: SandboxSpec): Promise<SandboxLease>
}

export interface SandboxContainerSpec {
  runtime: 'docker-sandbox'
  containerName: string
  workdir: string
  env: Record<string, string>
  networkMode: NetworkPolicy
  sandboxName?: string
  sandboxAgent?: string
}

export class SandboxProviderUnavailableError extends Error {
  constructor(kind: SandboxProviderKind) {
    super(`Sandbox provider "${kind}" is not implemented yet. Supported providers are "docker-sandbox" and "local-workdir".`)
    this.name = 'SandboxProviderUnavailableError'
  }
}

class LocalWorkdirSandboxProvider implements SandboxProvider {
  kind: SandboxProviderKind = 'local-workdir'

  async acquire(spec: SandboxSpec): Promise<SandboxLease> {
    const networkPolicy = spec.networkPolicy ?? 'default'
    const sandboxRoot = resolve(
      agentHubUserCacheRoot(),
      'sandboxes',
      safePathSegment(spec.runId),
      `${safePathSegment(spec.agentName)}-${safePathSegment(spec.agentId)}`,
      safePathSegment(spec.taskId),
    )
    const homeDir = resolve(sandboxRoot, 'home')
    const cacheDir = resolve(sandboxRoot, 'cache')
    const configDir = resolve(sandboxRoot, 'config')
    const dataDir = resolve(sandboxRoot, 'data')
    const tempDir = resolve(sandboxRoot, 'tmp')
    for (const dir of [sandboxRoot, homeDir, cacheDir, configDir, dataDir, tempDir]) {
      mkdirSync(dir, { recursive: true })
    }

    const workdir =
      spec.existingWorkdir ??
      prepareAgentWorkdir({
        projectPath: spec.projectPath,
        runId: spec.runId,
        taskId: spec.taskId,
        agentId: spec.agentId,
        agentName: spec.agentName,
        sandboxPolicy: spec.sandboxPolicy,
      })
    const cleanupMode = normalizeCleanupMode()
    const isolateHome = envFlag('AGENTHUB_SANDBOX_ISOLATE_HOME', false)

    return {
      provider: this.kind,
      isolation: 'workdir',
      sandboxPolicy: spec.sandboxPolicy,
      cwd: workdir?.executionPath ?? spec.projectPath ?? null,
      workdir,
      rootDir: sandboxRoot,
      homeDir,
      cacheDir,
      configDir,
      dataDir,
      tempDir,
      networkPolicy,
      cleanupMode,
      env: buildLocalSandboxEnv({
        rootDir: sandboxRoot,
        homeDir,
        cacheDir,
        configDir,
        dataDir,
        tempDir,
        isolateHome,
      }),
      metadata: {
        note:
          'Local workdir sandbox hardens cwd, temp/cache/config env and process lifecycle. It is not an OS/container sandbox.',
        networkPolicy,
        networkEnforced: false,
        rootDir: sandboxRoot,
        homeDir,
        cacheDir,
        configDir,
        dataDir,
        tempDir,
        homeIsolation: isolateHome ? 'enabled' : 'compatibility-mode',
        cleanupMode,
      },
      cleanup: async () => {
        if (cleanupMode !== 'delete') return
        rmSync(sandboxRoot, { recursive: true, force: true })
      },
    }
  }
}

const localWorkdirProvider = new LocalWorkdirSandboxProvider()

class DockerSbxSandboxProvider implements SandboxProvider {
  kind: SandboxProviderKind = 'docker-sandbox'

  async acquire(spec: SandboxSpec): Promise<SandboxLease> {
    await assertSbxAvailable()
    const networkPolicy = spec.networkPolicy ?? 'default'
    const sandboxRoot = resolve(
      agentHubUserCacheRoot(),
      'sandboxes',
      safePathSegment(spec.runId),
      `${safePathSegment(spec.agentName)}-${safePathSegment(spec.agentId)}`,
      safePathSegment(spec.taskId),
    )
    const workspaceDir = resolve(sandboxRoot, 'workspace')
    const homeDir = resolve(sandboxRoot, 'home')
    const cacheDir = resolve(sandboxRoot, 'cache')
    const configDir = resolve(sandboxRoot, 'config')
    const dataDir = resolve(sandboxRoot, 'data')
    const tempDir = resolve(sandboxRoot, 'tmp')
    for (const dir of [sandboxRoot, workspaceDir, homeDir, cacheDir, configDir, dataDir, tempDir]) {
      mkdirSync(dir, { recursive: true })
    }

    const workdir =
      spec.existingWorkdir ??
      prepareAgentWorkdir({
        projectPath: spec.projectPath,
        runId: spec.runId,
        taskId: spec.taskId,
        agentId: spec.agentId,
        agentName: spec.agentName,
        sandboxPolicy: spec.sandboxPolicy,
      })
    const executionPath = workdir?.executionPath ?? spec.projectPath ?? workspaceDir
    const cleanupMode = normalizeCleanupMode('delete')
    const sandboxName = buildSandboxContainerName(spec)
    const sandboxAgent = resolveDockerSandboxAgent(spec)
    const sandboxEnv = buildDockerSandboxEnv({
      homeDir,
      cacheDir,
      configDir,
      dataDir,
      tempDir,
    })
    await createDockerSandbox({
      sandboxName,
      sandboxAgent,
      executionPath,
      extraWorkspaces: [homeDir, cacheDir, configDir, dataDir, tempDir],
      readOnlyWorkspace: spec.sandboxPolicy === 'read-only',
    })

    return {
      provider: this.kind,
      isolation: 'microvm',
      sandboxPolicy: spec.sandboxPolicy,
      cwd: executionPath,
      workdir:
        workdir ??
        (spec.projectPath
          ? null
          : {
              projectPath: workspaceDir,
              executionPath: workspaceDir,
              relativePath: '.',
            }),
      rootDir: sandboxRoot,
      homeDir,
      cacheDir,
      configDir,
      dataDir,
      tempDir,
      networkPolicy,
      cleanupMode,
      env: {
        ...sandboxEnv,
        AGENTHUB_SANDBOX_PROVIDER: 'docker-sandbox',
        AGENTHUB_SANDBOX_ISOLATION: 'microvm',
        AGENTHUB_SANDBOX_ROOT: sandboxRoot,
        AGENTHUB_SANDBOX_HOME: homeDir,
        AGENTHUB_SANDBOX_CACHE: cacheDir,
        AGENTHUB_SANDBOX_CONFIG: configDir,
        AGENTHUB_SANDBOX_DATA: dataDir,
        AGENTHUB_SANDBOX_TMP: tempDir,
      },
      container: {
        runtime: 'docker-sandbox',
        containerName: sandboxName,
        sandboxName,
        sandboxAgent,
        workdir: executionPath,
        env: sandboxEnv,
        networkMode: networkPolicy,
      },
      metadata: {
        note: 'Docker Sandboxes executes the Code Agent CLI inside a Docker-managed sandbox environment.',
        networkPolicy,
        networkEnforced: true,
        sandboxName,
        sandboxAgent,
        rootDir: sandboxRoot,
        executionPath,
        cleanupMode,
      },
      cleanup: async () => {
        if (cleanupMode !== 'delete') return
        await removeDockerSandbox(sandboxName)
        rmSync(sandboxRoot, { recursive: true, force: true })
      },
    }
  }
}

const dockerSbxProvider = new DockerSbxSandboxProvider()

export function normalizeSandboxProviderKind(value?: string | null): SandboxProviderKind {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'docker-sandbox' || normalized === 'sbx') return 'docker-sandbox'
  if (normalized === 'cloud') return 'cloud'
  return 'local-workdir'
}

export function configuredSandboxProviderKind(): SandboxProviderKind {
  return normalizeSandboxProviderKind(readEnv('AGENTHUB_SANDBOX_PROVIDER') || 'docker-sandbox')
}

export async function acquireExecutionSandbox(spec: SandboxSpec): Promise<SandboxLease> {
  const kind = spec.provider ?? configuredSandboxProviderKind()
  if (kind === 'local-workdir') return localWorkdirProvider.acquire(spec)
  if (kind === 'docker-sandbox') return dockerSbxProvider.acquire(spec)
  throw new SandboxProviderUnavailableError(kind)
}

export async function describeSandboxRuntimeStatus() {
  const [sbxAvailable, sbxProbe] = await probeSbxAvailability()
  const sandboxProvider = configuredSandboxProviderKind()
  return {
    defaultProvider: 'docker-sandbox',
    configuredProvider: sandboxProvider,
    dockerSandbox: {
      agent: readEnv('AGENTHUB_DOCKER_SANDBOX_AGENT') || 'auto',
      available: sbxAvailable,
      probe: sbxProbe,
    },
    cleanupMode: normalizeCleanupMode('delete'),
    sandboxRoot: agentHubUserCacheRoot(),
  }
}

function buildLocalSandboxEnv(input: {
  rootDir: string
  homeDir: string
  cacheDir: string
  configDir: string
  dataDir: string
  tempDir: string
  isolateHome: boolean
}): Record<string, string> {
  const env: Record<string, string> = {
    AGENTHUB_SANDBOX_PROVIDER: 'local-workdir',
    AGENTHUB_SANDBOX_ISOLATION: 'workdir',
    AGENTHUB_SANDBOX_ROOT: input.rootDir,
    AGENTHUB_SANDBOX_HOME: input.homeDir,
    AGENTHUB_SANDBOX_CACHE: input.cacheDir,
    AGENTHUB_SANDBOX_CONFIG: input.configDir,
    AGENTHUB_SANDBOX_DATA: input.dataDir,
    AGENTHUB_SANDBOX_TMP: input.tempDir,
    TMP: input.tempDir,
    TEMP: input.tempDir,
    TMPDIR: input.tempDir,
    XDG_CACHE_HOME: input.cacheDir,
    XDG_CONFIG_HOME: input.configDir,
    XDG_DATA_HOME: input.dataDir,
    NPM_CONFIG_CACHE: resolve(input.cacheDir, 'npm'),
    BUN_INSTALL_CACHE_DIR: resolve(input.cacheDir, 'bun'),
  }

  if (platform() === 'win32') {
    env.APPDATA = input.configDir
    env.LOCALAPPDATA = input.cacheDir
  }

  if (input.isolateHome) {
    env.HOME = input.homeDir
    env.USERPROFILE = input.homeDir
  }

  return env
}

function normalizeCleanupMode(defaultMode: 'keep' | 'delete' = 'keep'): 'keep' | 'delete' {
  const value = readEnv('AGENTHUB_SANDBOX_CLEANUP').toLowerCase()
  if (!value) return defaultMode
  return value === 'delete' || value === 'cleanup' ? 'delete' : 'keep'
}

function envFlag(key: string, fallback: boolean) {
  const value = readEnv(key).toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value)
}

function readEnv(key: string) {
  const configured = (env as Record<string, unknown>)[key]
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  return Bun.env[key]?.trim() || process.env[key]?.trim() || ''
}

function buildDockerSandboxEnv(input: {
  homeDir: string
  cacheDir: string
  configDir: string
  dataDir: string
  tempDir: string
}): Record<string, string> {
  return {
    AGENTHUB_SANDBOX_PROVIDER: 'docker-sandbox',
    AGENTHUB_SANDBOX_ISOLATION: 'microvm',
    HOME: input.homeDir,
    USERPROFILE: input.homeDir,
    APPDATA: input.configDir,
    LOCALAPPDATA: input.cacheDir,
    TMP: input.tempDir,
    TEMP: input.tempDir,
    TMPDIR: input.tempDir,
    XDG_CACHE_HOME: input.cacheDir,
    XDG_CONFIG_HOME: input.configDir,
    XDG_DATA_HOME: input.dataDir,
    NPM_CONFIG_CACHE: resolve(input.cacheDir, 'npm'),
    BUN_INSTALL_CACHE_DIR: resolve(input.cacheDir, 'bun'),
  }
}

async function assertSbxAvailable() {
  const [available] = await probeSbxAvailability()
  if (!available) {
    throw new Error('Docker Sandboxes is enabled, but the sbx CLI is not available. Install Docker Sandboxes or set AGENTHUB_SANDBOX_PROVIDER=local-workdir for compatibility mode.')
  }
}

async function probeSbxAvailability(): Promise<[boolean, { version?: string; exitCode: number }]> {
  for (const args of [['--version'], ['version']]) {
    try {
      const proc = Bun.spawn(['sbx', ...args], {
        stdout: 'pipe',
        stderr: 'ignore',
        env: process.env,
      })
      const code = await Promise.race([
        proc.exited,
        new Promise<number>((resolve) => setTimeout(() => resolve(124), 3000)),
      ])
      if (code === 0) {
        const version = (await new Response(proc.stdout).text()).trim()
        return [true, { version: version || undefined, exitCode: code }]
      }
      if (code !== 124) continue
      return [false, { exitCode: code }]
    } catch {
      // Try the next common version shape before reporting unavailable.
    }
  }
  return [false, { exitCode: -1 }]
}

async function createDockerSandbox(input: {
  sandboxName: string
  sandboxAgent: string
  executionPath: string
  extraWorkspaces: string[]
  readOnlyWorkspace: boolean
}) {
  const workspaceArg = input.readOnlyWorkspace ? `${input.executionPath}:ro` : input.executionPath
  const args = [
    'create',
    '--name',
    input.sandboxName,
    input.sandboxAgent,
    workspaceArg,
    ...input.extraWorkspaces,
  ]
  const proc = Bun.spawn(['sbx', ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
    env: process.env,
  })
  const code = await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(124), 30_000)),
  ])
  if (code === 0) return
  if (code === 124) {
    try {
      proc.kill()
    } catch {
      // Process may have exited.
    }
  }
  const stderr = (await new Response(proc.stderr).text()).trim()
  throw new Error(`Docker Sandboxes failed to create sandbox "${input.sandboxName}": ${stderr || `exit code ${code}`}`)
}

async function removeDockerSandbox(sandboxName: string) {
  try {
    const proc = Bun.spawn(['sbx', 'rm', '-f', sandboxName], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: process.env,
    })
    await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 3000))])
  } catch {
    // Best-effort cleanup.
  }
}

function buildSandboxContainerName(spec: SandboxSpec) {
  const parts = [
    'agenthub',
    safePathSegment(spec.runId),
    safePathSegment(spec.agentName),
    safePathSegment(spec.agentId),
    safePathSegment(spec.taskId),
  ]
  return parts.join('-').slice(0, 120)
}

function resolveDockerSandboxAgent(spec: SandboxSpec) {
  const configured = readEnv('AGENTHUB_DOCKER_SANDBOX_AGENT')
  if (configured) return configured
  const codeAgentType = spec.codeAgentType?.trim().toLowerCase()
  if (codeAgentType === 'claude-code' || codeAgentType === 'claude') return 'claude'
  if (codeAgentType === 'opencode') return 'opencode'
  if (codeAgentType === 'gemini') return 'gemini'
  return 'codex'
}
