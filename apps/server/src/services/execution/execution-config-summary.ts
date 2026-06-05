import { relative } from 'node:path'
import type { AgentRunProfile } from '../agent-runner'
import { inspectCodeAgentRuntime } from '../code-agent-adapter'
import type { AgentWorkdir } from './agent-workdir'
import type { SandboxLease } from './sandbox-provider'

export interface ExecutionConfigSummary {
  runtimeType: AgentRunProfile['runtimeType']
  codeAgentType?: AgentRunProfile['codeAgentType']
  adapterName?: string
  command?: string
  modelId?: string | null
  modelProvider?: string | null
  modelLabel?: string
  modelSource?: string | null
  baseUrl?: string | null
  baseUrlHost?: string | null
  installed?: boolean
  configured?: boolean
  executionEnabled?: boolean
  cwdValid?: boolean
  canExecute?: boolean
  readinessStatus: 'ready' | 'blocked' | 'unknown'
  blockers?: string[]
  commandPreview?: string
  requestedSandboxPolicy?: AgentRunProfile['sandboxPolicy']
  sandboxPolicy: AgentRunProfile['sandboxPolicy']
  sandboxProvider?: SandboxLease['provider']
  isolation?: SandboxLease['isolation']
  networkPolicy?: SandboxLease['networkPolicy']
  projectPath?: string | null
  originalProjectPath?: string | null
  executionPath?: string | null
  workdirRelativePath?: string | null
  sandboxRoot?: string | null
  sandboxHomeDir?: string | null
  sandboxCacheDir?: string | null
  sandboxConfigDir?: string | null
  sandboxDataDir?: string | null
  sandboxTempDir?: string | null
  sandboxContainerName?: string | null
  sandboxId?: string | null
  skillCount: number
  toolPermissions: string[]
  approvalRequired: boolean
  updatedAt: string
}

export async function buildExecutionConfigSummary(input: {
  profile: AgentRunProfile
  projectPath?: string | null
  executionPath?: string | null
  workdir?: AgentWorkdir | null
  sandboxLease?: SandboxLease | null
  requestedSandboxPolicy?: AgentRunProfile['sandboxPolicy']
}): Promise<ExecutionConfigSummary> {
  const executionPath =
    input.executionPath ??
    input.sandboxLease?.cwd ??
    input.workdir?.executionPath ??
    input.profile.projectPath ??
    input.projectPath ??
    null
  const inspection =
    input.profile.runtimeType === 'code-agent'
      ? await inspectCodeAgentRuntime(input.profile, executionPath)
      : null
  const readinessStatus = inspection?.canExecute
    ? 'ready'
    : inspection
      ? 'blocked'
      : 'unknown'

  return {
    runtimeType: input.profile.runtimeType,
    codeAgentType: input.profile.codeAgentType,
    adapterName: inspection?.adapterName,
    command: inspection?.command,
    modelId: inspection?.modelId ?? input.profile.modelId ?? null,
    modelProvider: inspection?.modelProvider ?? null,
    modelLabel: inspection?.modelLabel ?? input.profile.modelId ?? undefined,
    modelSource: inspection?.modelSource ?? null,
    baseUrl: inspection?.baseUrl ?? null,
    baseUrlHost: inspection?.baseUrlHost ?? null,
    installed: inspection?.installed,
    configured: inspection?.configured,
    executionEnabled: inspection?.executionEnabled,
    cwdValid: inspection?.cwdValid,
    canExecute: inspection?.canExecute,
    readinessStatus,
    blockers: inspection?.blockers,
    commandPreview: inspection?.commandPreview,
    requestedSandboxPolicy: input.requestedSandboxPolicy,
    sandboxPolicy: input.profile.sandboxPolicy,
    sandboxProvider: input.sandboxLease?.provider,
    isolation: input.sandboxLease?.isolation,
    networkPolicy: input.sandboxLease?.networkPolicy,
    projectPath: input.projectPath ?? input.profile.originalProjectPath ?? input.profile.projectPath ?? null,
    originalProjectPath: input.profile.originalProjectPath ?? null,
    executionPath,
    workdirRelativePath:
      input.workdir?.relativePath ??
      relativeWorkdir(input.projectPath ?? input.profile.originalProjectPath, executionPath),
    sandboxRoot: input.sandboxLease?.rootDir ?? null,
    sandboxHomeDir: input.sandboxLease?.homeDir ?? null,
    sandboxCacheDir: input.sandboxLease?.cacheDir ?? null,
    sandboxConfigDir: input.sandboxLease?.configDir ?? null,
    sandboxDataDir: input.sandboxLease?.dataDir ?? null,
    sandboxTempDir: input.sandboxLease?.tempDir ?? null,
    sandboxContainerName: input.sandboxLease?.container?.containerName ?? null,
    sandboxId: input.sandboxLease?.container?.sandboxName ?? null,
    skillCount: input.profile.skillIds?.length ?? 0,
    toolPermissions: input.profile.toolPermissions ?? [],
    approvalRequired: input.profile.approvalRequired,
    updatedAt: new Date().toISOString(),
  }
}

function relativeWorkdir(projectPath?: string | null, executionPath?: string | null) {
  if (!projectPath || !executionPath) return null
  try {
    const rel = relative(projectPath, executionPath).replace(/\\/g, '/')
    return rel && !rel.startsWith('..') ? rel || '.' : null
  } catch {
    return null
  }
}
