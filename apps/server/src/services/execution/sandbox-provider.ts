import type { AgentWorkdir } from './agent-workdir'
import { prepareAgentWorkdir } from './agent-workdir'

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
  env: Record<string, string>
  metadata: Record<string, unknown>
  cleanup: () => Promise<void>
}

export interface SandboxProvider {
  kind: SandboxProviderKind
  acquire(spec: SandboxSpec): Promise<SandboxLease>
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

    return {
      provider: this.kind,
      isolation: 'workdir',
      sandboxPolicy: spec.sandboxPolicy,
      cwd: workdir?.executionPath ?? spec.projectPath ?? null,
      workdir,
      env: {},
      metadata: {
        note: 'Local workdir isolation only. This is not an OS/container sandbox.',
        networkPolicy: spec.networkPolicy ?? 'default',
      },
      cleanup: async () => {
        // Keep workdirs by default because they are the user's visible task artifacts.
      },
    }
  }
}

const localWorkdirProvider = new LocalWorkdirSandboxProvider()

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
  throw new SandboxProviderUnavailableError(kind)
}
