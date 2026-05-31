import { mkdirSync, rmSync } from 'node:fs'
import { platform } from 'node:os'
import { resolve } from 'node:path'
import type { AgentWorkdir } from './agent-workdir'
import { prepareAgentWorkdir } from './agent-workdir'
import { agentHubUserCacheRoot, safePathSegment } from '../system-paths'

export type SandboxProviderKind = 'local-workdir' | 'docker' | 'cloud'
export type ExecutionIsolation = 'workdir' | 'container' | 'cloud'
export type NetworkPolicy = 'default' | 'restricted' | 'disabled'
export type AgentSandboxPolicy = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface SandboxSpec {
  provider?: SandboxProviderKind | null
  runId: string
  taskId: string
  agentId: string
  agentName: string
  projectPath?: string | null
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

export interface SandboxMount {
  hostPath: string
  containerPath: string
  readOnly?: boolean
}

export interface SandboxContainerSpec {
  runtime: 'docker'
  image: string
  workdir: string
  env: Record<string, string>
  mounts: SandboxMount[]
  networkMode: string
  readOnlyRootfs?: boolean
  user?: string
  extraArgs?: string[]
}

export class SandboxProviderUnavailableError extends Error {
  constructor(kind: SandboxProviderKind) {
    super(`Sandbox provider "${kind}" is not implemented yet. Current stable provider is "local-workdir".`)
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

class DockerSandboxProvider implements SandboxProvider {
  kind: SandboxProviderKind = 'docker'

  async acquire(spec: SandboxSpec): Promise<SandboxLease> {
    const image = readEnv('AGENTHUB_DOCKER_SANDBOX_IMAGE')
    if (!image) {
      throw new Error(
        'Docker sandbox requires AGENTHUB_DOCKER_SANDBOX_IMAGE. The image must contain the configured Code Agent CLIs.',
      )
    }
    await assertDockerAvailable()

    const networkPolicy = spec.networkPolicy ?? normalizeDockerNetworkPolicy()
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
    const cleanupMode = normalizeCleanupMode()
    const containerEnv = buildDockerContainerEnv()
    const mounts: SandboxMount[] = [
      {
        hostPath: executionPath,
        containerPath: '/workspace',
        readOnly: spec.sandboxPolicy === 'read-only',
      },
      { hostPath: homeDir, containerPath: '/home/agenthub' },
      { hostPath: tempDir, containerPath: '/tmp/agenthub' },
      { hostPath: cacheDir, containerPath: '/home/agenthub/.cache' },
      { hostPath: configDir, containerPath: '/home/agenthub/.config' },
      { hostPath: dataDir, containerPath: '/home/agenthub/.local/share' },
    ]

    return {
      provider: this.kind,
      isolation: 'container',
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
        ...containerEnv,
        AGENTHUB_SANDBOX_PROVIDER: 'docker',
        AGENTHUB_SANDBOX_ISOLATION: 'container',
        AGENTHUB_SANDBOX_ROOT: sandboxRoot,
        AGENTHUB_SANDBOX_HOME: homeDir,
        AGENTHUB_SANDBOX_CACHE: cacheDir,
        AGENTHUB_SANDBOX_CONFIG: configDir,
        AGENTHUB_SANDBOX_DATA: dataDir,
        AGENTHUB_SANDBOX_TMP: tempDir,
      },
      container: {
        runtime: 'docker',
        image,
        workdir: '/workspace',
        env: containerEnv,
        mounts,
        networkMode: dockerNetworkMode(networkPolicy),
        readOnlyRootfs: envFlag('AGENTHUB_DOCKER_READONLY_ROOTFS', false),
        user: readEnv('AGENTHUB_DOCKER_USER') || undefined,
        extraArgs: splitShellWords(readEnv('AGENTHUB_DOCKER_EXTRA_ARGS')),
      },
      metadata: {
        note: 'Docker sandbox executes the Code Agent CLI inside a container. The selected image must provide the CLI binary.',
        networkPolicy,
        networkEnforced: true,
        image,
        rootDir: sandboxRoot,
        executionPath,
        containerWorkdir: '/workspace',
        cleanupMode,
      },
      cleanup: async () => {
        if (cleanupMode !== 'delete') return
        rmSync(sandboxRoot, { recursive: true, force: true })
      },
    }
  }
}

const dockerProvider = new DockerSandboxProvider()

export function normalizeSandboxProviderKind(value?: string | null): SandboxProviderKind {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'docker') return 'docker'
  if (normalized === 'cloud') return 'cloud'
  return 'local-workdir'
}

export function configuredSandboxProviderKind(): SandboxProviderKind {
  return normalizeSandboxProviderKind(
    Bun.env.AGENTHUB_SANDBOX_PROVIDER || process.env.AGENTHUB_SANDBOX_PROVIDER,
  )
}

export async function acquireExecutionSandbox(spec: SandboxSpec): Promise<SandboxLease> {
  const kind = spec.provider ?? configuredSandboxProviderKind()
  if (kind === 'local-workdir') return localWorkdirProvider.acquire(spec)
  if (kind === 'docker') return dockerProvider.acquire(spec)
  throw new SandboxProviderUnavailableError(kind)
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

function normalizeCleanupMode(): 'keep' | 'delete' {
  const value = readEnv('AGENTHUB_SANDBOX_CLEANUP').toLowerCase()
  return value === 'delete' || value === 'cleanup' ? 'delete' : 'keep'
}

function envFlag(key: string, fallback: boolean) {
  const value = readEnv(key).toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value)
}

function readEnv(key: string) {
  return Bun.env[key]?.trim() || process.env[key]?.trim() || ''
}

function buildDockerContainerEnv(): Record<string, string> {
  return {
    AGENTHUB_SANDBOX_PROVIDER: 'docker',
    AGENTHUB_SANDBOX_ISOLATION: 'container',
    HOME: '/home/agenthub',
    USERPROFILE: '/home/agenthub',
    APPDATA: '/home/agenthub/.config',
    LOCALAPPDATA: '/home/agenthub/.cache',
    TMP: '/tmp/agenthub',
    TEMP: '/tmp/agenthub',
    TMPDIR: '/tmp/agenthub',
    XDG_CACHE_HOME: '/home/agenthub/.cache',
    XDG_CONFIG_HOME: '/home/agenthub/.config',
    XDG_DATA_HOME: '/home/agenthub/.local/share',
    NPM_CONFIG_CACHE: '/home/agenthub/.cache/npm',
    BUN_INSTALL_CACHE_DIR: '/home/agenthub/.cache/bun',
  }
}

function normalizeDockerNetworkPolicy(): NetworkPolicy {
  const value = readEnv('AGENTHUB_DOCKER_NETWORK_POLICY').toLowerCase()
  if (value === 'disabled' || value === 'none') return 'disabled'
  if (value === 'restricted') return 'restricted'
  return 'default'
}

function dockerNetworkMode(policy: NetworkPolicy) {
  if (policy === 'disabled') return 'none'
  return readEnv('AGENTHUB_DOCKER_NETWORK') || 'bridge'
}

async function assertDockerAvailable() {
  try {
    const proc = Bun.spawn(['docker', 'version', '--format', '{{.Server.Version}}'], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: process.env,
    })
    const code = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(124), 3000)),
    ])
    if (code === 0) return
  } catch {
    // Fall through to a clear error below.
  }
  throw new Error('Docker sandbox is enabled, but Docker CLI/daemon is not available.')
}

function splitShellWords(value: string) {
  if (!value) return []
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map((item) => item.replace(/^['"]|['"]$/g, '')).filter(Boolean)
}
