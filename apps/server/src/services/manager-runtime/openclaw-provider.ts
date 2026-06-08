import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { and, desc, db, eq, matrixIdentities, roomParticipants, rooms, timelineEvents, workspaceAgents } from '@agenthub/db'
import { agentHubUserDataRoot } from '../system-paths'
import { logger } from '../../lib/logger'
import { getRuntimeServerPort } from '../../lib/runtime-server'
import { resolveLlmRuntimeConfig, resolveModelConfig } from '../llm-client'
import { createMatrixClientFromEnv, matrixLocalpart } from '../rooms/matrix-client'
import { MatrixIdentityService } from '../rooms/matrix-identity-service'
import { resolveManagerAgentContractWorkspace } from '../agent-contract'
import { ensureManagerAgentContractFromController } from '../agent-contract'
import {
  containerControllerUrl,
  containerLlmBaseUrl,
  containerMatrixUrl,
  ensureOpenClawRuntimeImage,
  managerContainerName,
  managerContainersEnabled,
  OPENCLAW_RUNTIME_IMAGE,
} from '../container-runtime/agent-runtime-containers'
import { dockerRuntime } from '../container-runtime/docker-runtime'
import { RemoteManagerRuntimeAdapter, resolveHealthEndpoint, resolveStepEndpoint } from './remote-manager-runtime-adapter'
import { ResidentManagerRuntime } from './resident-manager-runtime'
import type { ManagerRuntime } from './types'

// ─── Manager Runtime Types ────────────────────────────────────────────

export type ManagerRuntimeType = 'openclaw' | 'qwenpaw'

export interface ManagerRuntimeStatus {
  runtimeType: ManagerRuntimeType
  available: boolean
  connectionMode: 'external-endpoint' | 'managed-process' | 'managed-docker' | 'unavailable'
  syncReady?: boolean
  running: boolean
  pid: number | null
  workspace: string
  configPath: string | null
  binaryPath: string | null
  endpoint: string | null
  stepEndpoint?: string | null
  healthEndpoint?: string | null
  error: string | null
  diagnostics?: Record<string, unknown>
  startedAt: string | null
  uptime: number | null
}

export interface ManagerRuntimeProvider {
  readonly runtimeType: ManagerRuntimeType
  status(): Promise<ManagerRuntimeStatus>
  ensureStarted?(): Promise<ManagerRuntimeStatus>
  stop?(): Promise<ManagerRuntimeStatus>
  healthCheck?(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }>
  getEndpointOrCommand(): { endpoint?: string; command?: string } | null
  createRuntime(): ManagerRuntime
}

// ─── OpenClaw Provider ────────────────────────────────────────────────

export class OpenClawManagerRuntimeProvider implements ManagerRuntimeProvider {
  readonly runtimeType = 'openclaw' as const

  private process: ChildProcess | null = null
  private startedAt: string | null = null
  private managerWorkspace: string
  private managerAccessToken: string | null = null
  private containerStartedAt: string | null = null
  private managerGatewayPort = preferredManagerGatewayPort()

  constructor(private config: {
    openclawPath?: string
    endpoint?: string
    matrixUrl?: string
    matrixDomain?: string
    matrixUserId?: string
    matrixAccessToken?: string
    llmBaseUrl?: string
    llmApiKey?: string
    llmModel?: string
    autoStart?: boolean
  } = {}) {
    this.managerWorkspace = join(agentHubUserDataRoot(), 'manager', 'global')
  }

  async status(): Promise<ManagerRuntimeStatus> {
    const binaryPath = this.findBinary()
    const endpoint = this.config.endpoint || process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT || null
    const containerMode = managerContainersEnabled()
    const container = containerMode ? await dockerRuntime.inspect(managerContainerName(this.runtimeType)) : null
    const connectionMode: ManagerRuntimeStatus['connectionMode'] = endpoint
      ? 'external-endpoint'
      : containerMode
        ? 'managed-docker'
        : binaryPath
          ? 'managed-process'
          : 'unavailable'
    const localManagedProcessRunning = this.process !== null && !this.process.killed
    const localGatewayProbe =
      !endpoint && !containerMode && !localManagedProcessRunning
        ? await probeGatewayHealth(this.managerGatewayPort, 500)
        : null
    const running = endpoint
      ? true
      : containerMode
        ? Boolean(container?.running)
        : localManagedProcessRunning || Boolean(localGatewayProbe?.ok)
    const residentSyncReady = endpoint ? true : running
    const matrixDomain = this.config.matrixDomain || process.env.AGENTHUB_MATRIX_SERVER_NAME || 'agenthub.local'
    const configInspection = inspectOpenClawManagerConfig(this.getConfigPath(), matrixDomain)
    const runtimeContractInspection = inspectManagerRuntimeContract(
      resolveManagerAgentContractWorkspace('global').runtimePath,
    )
    const matrixPluginInspection = inspectOpenClawMatrixPlugin(this.managerWorkspace)
    const desiredControllerUrl = this.desiredControllerUrl()
    const managerDiagnostics = await describeOpenClawManagerDiagnostics({
      workspace: this.managerWorkspace,
      configPath: this.getConfigPath(),
      configInspection,
      endpoint,
      gatewayPort: this.managerGatewayPort,
    })
    let configError: string | null = null
    if (!endpoint && running && !runtimeContractInspection.exists) {
      configError = 'OpenClaw Manager runtime contract is missing; restart/regenerate Manager runtime config.'
    } else if (!endpoint && running && runtimeContractInspection.controllerUrl !== desiredControllerUrl) {
      configError = `OpenClaw Manager runtime contract points to ${runtimeContractInspection.controllerUrl || 'no Controller API'}, expected ${desiredControllerUrl}; restart/regenerate Manager runtime config.`
    } else if (!endpoint && configInspection.matrixPluginEnabled && !matrixPluginInspection.installed) {
      configError = 'OpenClaw Matrix plugin is not installed; run `openclaw plugins install @openclaw/matrix` in the Manager workspace and restart Manager.'
    } else if (!endpoint && configInspection.exists && !configInspection.matrixPluginEnabled) {
      configError = 'OpenClaw Manager config has channels.matrix enabled but plugins.entries.matrix is not enabled; restart/regenerate Manager runtime config.'
    } else if (!endpoint && configInspection.exists && !configInspection.humanAllowed) {
      configError = `OpenClaw Manager config does not allow the AgentHub human Matrix user (${configInspection.expectedHumanUserId}); restart/regenerate Manager runtime config.`
    } else if (!endpoint && configInspection.exists && !configInspection.wildcardGroupEnabled) {
      configError = 'OpenClaw Manager config does not include channels.matrix.groups["*"]; restart/regenerate Manager runtime config so newly created rooms are observed.'
    }

    return {
      runtimeType: this.runtimeType,
      available: containerMode || binaryPath !== null || endpoint !== null,
      connectionMode,
      syncReady: residentSyncReady,
      running,
      pid: endpoint || containerMode ? null : localManagedProcessRunning ? this.process!.pid ?? null : null,
      workspace: this.managerWorkspace,
      configPath: this.getConfigPath(),
      binaryPath: containerMode ? null : binaryPath,
      endpoint,
      stepEndpoint: endpoint ? resolveStepEndpoint(endpoint) : null,
      healthEndpoint: endpoint ? resolveHealthEndpoint(endpoint) : null,
      error: configError || (!containerMode && !binaryPath && !endpoint ? 'OpenClaw binary not found and no endpoint configured' : null),
      diagnostics: {
        backend: containerMode ? 'docker' : 'local-process',
        containerName: containerMode ? managerContainerName(this.runtimeType) : null,
        containerStatus: container,
        image: containerMode ? OPENCLAW_RUNTIME_IMAGE : null,
        binaryInstalled: binaryPath !== null,
        endpointConfigured: endpoint !== null,
        synchronousStepReady: residentSyncReady,
        configInspection,
        runtimeContractInspection: {
          ...runtimeContractInspection,
          expectedControllerUrl: desiredControllerUrl,
        },
        matrixPluginInspection,
        localGatewayProbe,
        ...managerDiagnostics,
        note: endpoint
          ? 'OpenClaw Manager endpoint is configured; AgentHub can call POST /step.'
          : containerMode
            ? 'OpenClaw Manager is managed as a resident Docker container and coordinates through Matrix.'
            : 'OpenClaw resident process is running and coordinates through Matrix /sync.',
      },
      startedAt: containerMode ? this.containerStartedAt : this.startedAt,
      uptime: (containerMode ? this.containerStartedAt : this.startedAt)
        ? Date.now() - new Date((containerMode ? this.containerStartedAt : this.startedAt)!).getTime()
        : null,
    }
  }

  async ensureStarted(): Promise<ManagerRuntimeStatus> {
    const st = await this.status()
    if (st.running && !st.error) return st
    if (st.running && st.error) {
      await this.stop?.()
    }
    if (st.endpoint) return st // external endpoint, no need to start

    if (!managerContainersEnabled() && !st.binaryPath) {
      return { ...st, error: 'OpenClaw binary not found. Run: bash infra/setup-openclaw.sh' }
    }

    this.managerGatewayPort = preferredManagerGatewayPort()
    if (!managerContainersEnabled()) {
      await this.stopLastManagedProcess()
    }

    // Ensure Manager Matrix identity exists
    try {
      const client = createMatrixClientFromEnv()
      const identityService = new MatrixIdentityService(client)
      const identity = await identityService.ensureIdentity({
        ownerType: 'manager',
        ownerId: 'manager',
        displayName: 'Manager',
      })
      this.config.matrixAccessToken = identity.accessToken ?? undefined
      this.config.matrixUserId = identity.userId ?? undefined
      this.config.matrixUrl = client.homeserverUrl
      this.config.matrixDomain = client.serverName
      this.managerAccessToken = identity.accessToken ?? null
      logger.info({ userId: identity.userId }, 'Manager Matrix identity ensured')
    } catch (err) {
      logger.error({ err }, 'Failed to ensure Manager Matrix identity')
      return { ...st, error: `Matrix identity failed: ${err}` }
    }

    // If an orchestrator agent has a modelId bound, use it as the Manager LLM model.
    if (!this.config.llmModel && !process.env.AGENTHUB_MANAGER_LLM_MODEL) {
      const [orchestratorAgent] = await db
        .select({ modelId: workspaceAgents.modelId })
        .from(workspaceAgents)
        .where(eq(workspaceAgents.roleType, 'orchestrator'))
        .limit(1)
      if (orchestratorAgent?.modelId) {
        this.config.llmModel = orchestratorAgent.modelId
        logger.info({ modelId: orchestratorAgent.modelId }, 'Using orchestrator agent modelId for Manager LLM')
      }
    }

    // Generate config with Matrix credentials and a real model catalog target.
    await this.generateConfig()

    // Copy agent files and refresh Controller-backed registries.
    await this.copyAgentFiles()

    // Launch
    if (managerContainersEnabled()) {
      await this.launchContainer()
    } else {
      this.launch(st.binaryPath!)
    }
    return this.status()
  }

  async stop(): Promise<ManagerRuntimeStatus> {
    if (this.process) {
      logger.info('Stopping OpenClaw Manager...')
      await killChildProcessTree(this.process)
      this.process = null
      this.startedAt = null
    }
    await this.stopLastManagedProcess()
    if (managerContainersEnabled()) {
      await dockerRuntime.stop(managerContainerName(this.runtimeType))
      this.containerStartedAt = null
    }
    return this.status()
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
    const st = await this.status()

    // External endpoint: try HTTP health check
    if (st.endpoint) {
      try {
        const start = Date.now()
        const resp = await fetch(resolveHealthEndpoint(st.endpoint), { signal: AbortSignal.timeout(5000) })
        return { healthy: resp.ok, latencyMs: Date.now() - start }
      } catch (e) {
        return { healthy: false, error: `Endpoint unreachable: ${e}` }
      }
    }

    // Managed process/container: the process can exist briefly while OpenClaw is
    // still validating config, so probe the gateway health endpoint.
    if (st.running) {
      try {
        const start = Date.now()
        const resp = await fetch(`http://127.0.0.1:${this.managerGatewayPort}/health`, {
          signal: AbortSignal.timeout(5000),
        })
        return { healthy: resp.ok, latencyMs: Date.now() - start }
      } catch (e) {
        return {
          healthy: false,
          error: `Gateway health unreachable: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
    }

    return { healthy: false, error: st.error || 'OpenClaw not running' }
  }

  getEndpointOrCommand(): { endpoint?: string; command?: string } | null {
    if (this.config.endpoint) return { endpoint: this.config.endpoint }
    if (process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT) {
      return { endpoint: process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT }
    }
    return null
  }

  createRuntime(): ManagerRuntime {
    const endpoint = this.config.endpoint || process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT || null
    if (endpoint) {
      return new RemoteManagerRuntimeAdapter('openclaw', { endpoint })
    }
    // OpenClaw without an HTTP endpoint is a resident process; AgentHub does not invoke its step directly.
    return new ResidentManagerRuntime('openclaw')
  }

  // ─── Internal ────────────────────────────────────────────────────

  private findBinary(): string | null {
    if (this.config.openclawPath && existsSync(this.config.openclawPath)) {
      return this.config.openclawPath
    }
    if (process.env.AGENTHUB_OPENCLAW_PATH && existsSync(process.env.AGENTHUB_OPENCLAW_PATH)) {
      return process.env.AGENTHUB_OPENCLAW_PATH
    }
    const candidates = [
      join(process.cwd(), '.openclaw-runtime', 'openclaw.mjs'),
      '/usr/local/bin/openclaw',
      join(process.env.HOME || '', '.local', 'bin', 'openclaw'),
      // npm global install paths
      join(process.env.APPDATA || '', 'npm', 'openclaw.cmd'),
      join(process.env.HOME || '', '.npm', 'bin', 'openclaw'),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    try {
      const { execSync } = require('node:child_process')
      const result = execSync('which openclaw 2>/dev/null || where openclaw 2>nul', {
        encoding: 'utf8',
        timeout: 5000,
      }).trim()
      if (result && existsSync(result)) return result
    } catch {}
    return null
  }

  private getConfigPath(): string {
    return join(this.managerWorkspace, 'openclaw.json')
  }

  private getPidPath(): string {
    return join(this.managerWorkspace, 'openclaw-manager.pid')
  }

  private desiredControllerUrl(): string {
    return managerContainersEnabled() ? containerControllerUrl() : localControllerUrl()
  }

  private async generateConfig(): Promise<string> {
    const matrixUrl = this.config.matrixUrl || (managerContainersEnabled() ? containerMatrixUrl() : process.env.AGENTHUB_MATRIX_HOMESERVER_URL) || 'http://localhost:6167'
    const matrixDomain = this.config.matrixDomain || process.env.AGENTHUB_MATRIX_SERVER_NAME || 'agenthub.local'
    const matrixUserId = this.config.matrixUserId || `@manager:${matrixDomain}`
    const runtimeWorkspace = managerContainersEnabled() ? '/workspace' : this.managerWorkspace
    const managerAgentDir = join(runtimeWorkspace, '.openclaw', 'agents', 'manager', 'agent')
    const defaultHumanUserId = `@human-${matrixLocalpart('default-user')}:${matrixDomain}`
    const adminUserId = `@admin:${matrixDomain}`
    const managerAllowFrom = Array.from(new Set([adminUserId, defaultHumanUserId]))
    const requestedLlmModel = this.config.llmModel || process.env.AGENTHUB_MANAGER_LLM_MODEL || process.env.LLM_MODEL || undefined
    const resolvedLlm = await resolveLlmRuntimeConfig(requestedLlmModel)
    const resolvedCatalogModel = requestedLlmModel ? await resolveModelConfig(requestedLlmModel) : null
    const llmBaseUrl = this.config.llmBaseUrl || process.env.AGENTHUB_MANAGER_LLM_BASE_URL || (managerContainersEnabled() ? containerLlmBaseUrl() : resolvedLlm.baseUrl)
    const llmApiKey = this.config.llmApiKey || process.env.AGENTHUB_MANAGER_LLM_API_KEY || resolvedLlm.apiKey || process.env.LLM_API_KEY || 'agenthub-internal'
    const llmModel = resolvedCatalogModel?.modelId || this.config.llmModel || process.env.AGENTHUB_MANAGER_LLM_MODEL || resolvedLlm.model
    const llmContextWindow = Number(process.env.AGENTHUB_MANAGER_LLM_CONTEXT_WINDOW || '128000')
    const llmMaxTokens = Number(process.env.AGENTHUB_MANAGER_LLM_MAX_TOKENS || '8192')
    const matrixGroups = await loadOpenClawMatrixGroups()

    const config = {
      gateway: {
        mode: 'local',
        port: this.managerGatewayPort,
        bind: 'lan',
        auth: { token: 'agenthub-manager-token' },
        remote: { token: 'agenthub-manager-token' },
        controlUi: { dangerouslyDisableDeviceAuth: true, allowInsecureAuth: true, allowedOrigins: ['*'] },
      },
      channels: {
        matrix: {
          enabled: true,
          homeserver: matrixUrl,
          userId: matrixUserId,
          accessToken: this.config.matrixAccessToken || '',
          encryption: false,
          network: { dangerouslyAllowPrivateNetwork: true },
          autoJoin: 'always',
          dm: { policy: 'allowlist', allowFrom: managerAllowFrom },
          groupPolicy: 'allowlist',
          groupAllowFrom: managerAllowFrom,
          groups: matrixGroups,
          streaming: 'off',
          blockStreaming: false,
        },
      },
      models: {
        mode: 'merge',
        providers: {
          'agenthub-llm': {
            baseUrl: llmBaseUrl,
            apiKey: llmApiKey,
            api: 'openai-completions',
            models: [{ id: llmModel, name: llmModel, reasoning: true, contextWindow: llmContextWindow, maxTokens: llmMaxTokens, input: ['text'] }],
          },
        },
      },
      agents: {
        defaults: {
          timeoutSeconds: 1800,
          workspace: '~',
          model: { primary: `agenthub-llm/${llmModel}` },
          maxConcurrent: 8,
          subagents: { maxConcurrent: 16 },
          elevatedDefault: 'full',
          heartbeat: { every: '1h', prompt: 'Read ~/HEARTBEAT.md and follow the checklist.' },
          skipBootstrap: true,
        },
        list: [
          {
            id: 'manager',
            name: 'AgentHub Manager',
            default: true,
            workspace: runtimeWorkspace,
            agentDir: managerAgentDir,
            identity: {
              name: 'AgentHub Manager',
              emoji: '🧭',
            },
            model: { primary: `agenthub-llm/${llmModel}` },
            skills: ['agenthub-controller'],
            groupChat: {
              mentionPatterns: ['@Orchestrator', '@Manager', 'Orchestrator', 'Manager', '管理者'],
            },
          },
        ],
      },
      bindings: [
        {
          agentId: 'manager',
          match: {
            channel: 'matrix',
            accountId: '*',
          },
        },
      ],
      messages: {
        groupChat: {
          visibleReplies: 'automatic',
          historyLimit: 50,
        },
      },
      tools: {
        exec: { host: 'gateway', security: 'full', ask: 'off' },
        elevated: { enabled: true, allowFrom: { matrix: ['*'] } },
      },
      session: {
        dmScope: 'per-channel-peer',
        resetByType: { dm: { mode: 'daily', atHour: 4 }, group: { mode: 'daily', atHour: 4 } },
      },
      plugins: {
        load: { paths: [join(runtimeWorkspace, 'skills')] },
        entries: {
          matrix: { enabled: true },
        },
      },
      commands: { restart: true },
    }

    mkdirSync(this.managerWorkspace, { recursive: true })
    const configPath = this.getConfigPath()
    const configJson = JSON.stringify(config, null, 2)
    // Only write if content actually changed — avoids triggering OpenClaw's config watcher SIGUSR1 restart loop
    try {
      const existing = readFileSync(configPath, 'utf8')
      if (existing === configJson) {
        logger.info({ configPath, gatewayPort: this.managerGatewayPort }, 'OpenClaw Manager config unchanged, skipped write')
        return configPath
      }
    } catch { /* file doesn't exist yet */ }
    writeFileSync(configPath, configJson, 'utf8')
    logger.info({ configPath, gatewayPort: this.managerGatewayPort }, 'Generated OpenClaw Manager config')
    return configPath
  }

  private async copyAgentFiles(): Promise<void> {
    await ensureManagerAgentContractFromController({
      managerId: 'global',
      runtimeType: this.runtimeType,
      matrixUserId: this.config.matrixUserId ?? null,
      controllerUrl: this.desiredControllerUrl(),
      sharedStorageRoot: process.env.AGENTHUB_SHARED_STORAGE_ROOT || null,
      matrixHomeserverUrl: this.config.matrixUrl ?? null,
      matrixServerName: this.config.matrixDomain ?? null,
      runtimeConfigPath: this.getConfigPath(),
    })
  }

  private launch(binaryPath: string): void {
    const pathSeparator = process.platform === 'win32' ? ';' : ':'
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: this.getConfigPath(),
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_WATCH_CONFIG: '0',
      HOME: this.managerWorkspace,
      PATH: `${this.managerWorkspace}${pathSeparator}${process.env.PATH || ''}`,
      AGENTHUB_CONTROLLER_URL: this.desiredControllerUrl(),
      AGENTHUB_MANAGER_TOKEN: this.managerAccessToken ?? '',
    }

    logger.info({ binaryPath, configPath: this.getConfigPath(), gatewayPort: this.managerGatewayPort }, 'Launching OpenClaw Manager...')

    const isCmd = binaryPath.toLowerCase().endsWith('.cmd')
    const shell = process.platform === 'win32' || isCmd
    this.process = spawn(binaryPath, ['gateway', 'run', '--verbose', '--force'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.managerWorkspace,
      shell,
      windowsHide: true,
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      for (const line of decodeOpenClawLogChunk(data).trim().split('\n')) {
        if (line.trim()) logger.info({ source: 'openclaw-manager' }, line.trim())
      }
    })
    this.process.stderr?.on('data', (data: Buffer) => {
      for (const line of decodeOpenClawLogChunk(data).trim().split('\n')) {
        if (line.trim()) logger.warn({ source: 'openclaw-manager' }, line.trim())
      }
    })
    this.process.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'OpenClaw Manager exited')
      this.process = null
      this.startedAt = null
      rmPidFile(this.getPidPath())
    })
    this.process.on('error', (err) => {
      logger.error({ err }, 'OpenClaw Manager process error')
      this.process = null
      this.startedAt = null
      rmPidFile(this.getPidPath())
    })

    this.startedAt = new Date().toISOString()
    if (this.process.pid) {
      writeFileSync(this.getPidPath(), String(this.process.pid), 'utf8')
    }
  }

  private async stopLastManagedProcess(): Promise<void> {
    const pidPath = this.getPidPath()
    if (!existsSync(pidPath)) return
    const pid = Number(readFileSync(pidPath, 'utf8').trim())
    if (Number.isFinite(pid) && pid > 0) {
      await killPidTree(Math.trunc(pid))
    }
    rmPidFile(pidPath)
  }

  private async launchContainer(): Promise<void> {
    const image = await ensureOpenClawRuntimeImage()
    if (!image.present) {
      throw new Error(`OpenClaw runtime image unavailable: ${image.error || OPENCLAW_RUNTIME_IMAGE}`)
    }
    await dockerRuntime.run({
      name: managerContainerName(this.runtimeType),
      image: OPENCLAW_RUNTIME_IMAGE,
      volumes: [{ host: this.managerWorkspace, container: '/workspace' }],
      env: {
        OPENCLAW_CONFIG_PATH: '/workspace/openclaw.json',
        OPENCLAW_NO_RESPAWN: '1',
        HOME: '/workspace',
        AGENTHUB_CONTROLLER_URL: containerControllerUrl(),
        AGENTHUB_MANAGER_TOKEN: this.managerAccessToken ?? '',
      },
      ports: [{ host: this.managerGatewayPort, container: this.managerGatewayPort }],
      labels: {
        'dev.agenthub.kind': 'manager',
        'dev.agenthub.runtime': this.runtimeType,
      },
      restart: 'unless-stopped',
    })
    this.containerStartedAt = new Date().toISOString()
  }

}

// ─── QwenPaw Provider ────────────────────────────────────────────────

export class QwenPawManagerRuntimeProvider implements ManagerRuntimeProvider {
  readonly runtimeType = 'qwenpaw' as const

  async status(): Promise<ManagerRuntimeStatus> {
    return {
      runtimeType: this.runtimeType,
      available: false,
      connectionMode: 'unavailable',
      syncReady: false,
      running: false,
      pid: null,
      workspace: join(agentHubUserDataRoot(), 'manager', 'global'),
      configPath: null,
      binaryPath: null,
      endpoint: null,
      stepEndpoint: null,
      healthEndpoint: null,
      error: 'QwenPaw Manager runtime not yet implemented',
      diagnostics: {
        implemented: false,
        note: 'QwenPaw provider is reserved but not wired yet.',
      },
      startedAt: null,
      uptime: null,
    }
  }

  async healthCheck() {
    return { healthy: false, error: 'QwenPaw not implemented' }
  }

  getEndpointOrCommand() {
    return null
  }

  createRuntime(): ManagerRuntime {
    return new ResidentManagerRuntime('qwenpaw')
  }
}

function preferredManagerGatewayPort() {
  const raw = Number(process.env.AGENTHUB_OPENCLAW_MANAGER_PORT || '18799')
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 18799
}

function localControllerUrl() {
  return `http://localhost:${getRuntimeServerPort() ?? Number(process.env.PORT || 3000)}`
}

function inspectManagerRuntimeContract(runtimePath: string) {
  if (!existsSync(runtimePath)) {
    return {
      exists: false,
      controllerUrl: null,
      error: null,
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(runtimePath, 'utf8')) as Record<string, unknown>
    return {
      exists: true,
      controllerUrl: typeof parsed.controllerUrl === 'string' ? parsed.controllerUrl : null,
      error: null,
    }
  } catch (error) {
    return {
      exists: true,
      controllerUrl: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function inspectOpenClawMatrixPlugin(managerWorkspace: string) {
  const projectsRoot = join(managerWorkspace, 'npm', 'projects')
  const candidates: string[] = []
  if (existsSync(projectsRoot)) {
    try {
      for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        candidates.push(join(projectsRoot, entry.name, 'node_modules', '@openclaw', 'matrix'))
      }
    } catch {
      // ignore
    }
  }
  const installedPath = candidates.find((candidate) => existsSync(join(candidate, 'openclaw.plugin.json'))) ?? null
  return {
    installed: installedPath !== null,
    installPath: installedPath,
    checkedPaths: candidates,
    installCommand: 'openclaw plugins install @openclaw/matrix',
  }
}

async function killChildProcessTree(proc: ChildProcess, timeoutMs = 5000) {
  if (!proc.pid) return
  await killPidTree(proc.pid, timeoutMs)
}

async function killPidTree(pid: number, timeoutMs = 5000) {
  if (!isPidRunning(pid)) return

  try {
    if (process.platform === 'win32') {
      await waitForProcess(spawn('taskkill', ['/pid', String(pid), '/t'], {
        stdio: 'ignore',
        windowsHide: true,
      }))
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch {
    // best effort; force kill below if needed
  }

  const started = Date.now()
  while (isPidRunning(pid) && Date.now() - started < timeoutMs) {
    await sleep(100)
  }

  if (!isPidRunning(pid)) return

  try {
    if (process.platform === 'win32') {
      await waitForProcess(spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      }))
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // ignore
  }
}

function isPidRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForProcess(proc: ChildProcess) {
  return new Promise<void>((resolve) => {
    proc.once('exit', () => resolve())
    proc.once('error', () => resolve())
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rmPidFile(pidPath: string) {
  try {
    rmSync(pidPath, { force: true })
  } catch {
    // ignore
  }
}

async function loadOpenClawMatrixGroups() {
  const rows = await db
    .select({ providerRoomId: rooms.providerRoomId })
    .from(rooms)
    .where(eq(rooms.status, 'active'))

  const groups: Record<string, {
    enabled: true
    requireMention: false
    autoReply: true
    skills: string[]
    systemPrompt: string
  }> = {}
  const agenthubManagerRoomConfig: {
    enabled: true
    requireMention: false
    autoReply: true
    skills: string[]
    systemPrompt: string
  } = {
    enabled: true,
    requireMention: false,
    autoReply: true,
    skills: ['agenthub-controller'],
    systemPrompt:
      'You are the AgentHub Manager. Coordinate through this Matrix room, use the agenthub-controller skill for workers, tasks, rooms, and status, and keep actions transparent to the human.',
  }
  groups['*'] = agenthubManagerRoomConfig
  for (const row of rows) {
    if (!row.providerRoomId) continue
    groups[row.providerRoomId] = agenthubManagerRoomConfig
  }
  return groups
}

async function describeOpenClawManagerDiagnostics(input: {
  workspace: string
  configPath: string
  configInspection: ReturnType<typeof inspectOpenClawManagerConfig>
  endpoint: string | null
  gatewayPort: number
}) {
  const roomRows = await db
    .select({
      roomId: rooms.id,
      title: rooms.title,
      kind: rooms.kind,
      providerRoomId: rooms.providerRoomId,
      participantId: roomParticipants.id,
      participantStatus: roomParticipants.status,
      participantUserId: roomParticipants.providerUserId,
    })
    .from(rooms)
    .leftJoin(
      roomParticipants,
      and(eq(roomParticipants.roomId, rooms.id), eq(roomParticipants.participantType, 'manager')),
    )
    .where(eq(rooms.status, 'active'))

  const [managerIdentity] = await db
    .select()
    .from(matrixIdentities)
    .where(and(eq(matrixIdentities.ownerType, 'manager'), eq(matrixIdentities.ownerId, 'manager')))
    .limit(1)

  const [latestReply] = await db
    .select({
      id: timelineEvents.id,
      roomId: timelineEvents.roomId,
      body: timelineEvents.body,
      metadata: timelineEvents.metadata,
      createdAt: timelineEvents.createdAt,
    })
    .from(timelineEvents)
    .where(and(eq(timelineEvents.senderType, 'manager'), eq(timelineEvents.type, 'manager.message')))
    .orderBy(desc(timelineEvents.createdAt))
    .limit(1)

  const agenthubSkillPath = join(input.workspace, 'skills', 'agenthub-controller', 'SKILL.md')
  const soulPath = join(input.workspace, 'SOUL.md')
  const agentsPath = join(input.workspace, 'AGENTS.md')
  const toolsPath = join(input.workspace, 'TOOLS.md')
  const contract = resolveManagerAgentContractWorkspace('global')
  const contractFiles = {
    runtime: existsSync(contract.runtimePath),
    runtimeManifest: existsSync(contract.runtimeManifestPath),
    runtimeSpecificConfig: existsSync(input.configPath),
    soul: existsSync(contract.soulPath),
    agents: existsSync(contract.agentsPath),
    tools: existsSync(contract.toolsPath),
    heartbeat: existsSync(contract.heartbeatPath),
    skillsDir: existsSync(contract.skillsDir),
    memoryDir: existsSync(contract.memoryDir),
    workerRegistry: existsSync(contract.workerRegistryPath),
    teamRegistry: existsSync(contract.teamRegistryPath),
    humanRegistry: existsSync(contract.humanRegistryPath),
    state: existsSync(contract.statePath),
    rooms: existsSync(contract.roomsPath),
    logsDir: existsSync(contract.logsDir),
  }
  const controllerUrl = `http://localhost:${getRuntimeServerPort() ?? Number(process.env.PORT || 3000)}`
  const controllerReachable = await probeControllerHealth(controllerUrl)

  const configuredRoomIds = new Set(input.configInspection.groupKeys)
  const managerUserId = managerIdentity?.userId ?? null
  const roomBindings = roomRows
    .filter((room) => room.providerRoomId)
    .map((room) => ({
      roomId: room.roomId,
      title: room.title,
      kind: room.kind,
      providerRoomId: room.providerRoomId,
      configured: configuredRoomIds.has(room.providerRoomId!) || input.configInspection.wildcardGroupEnabled,
      sessionKey: `agent:manager:matrix:channel:${room.providerRoomId}`,
      managerParticipantId: room.participantId ?? null,
      managerParticipantStatus: room.participantStatus ?? null,
      managerParticipantUserId: room.participantUserId ?? null,
      boundToResidentManager: Boolean(managerUserId && room.participantUserId === managerUserId),
    }))

  return {
    managerIdentity: {
      userId: managerUserId,
      hasAccessToken: Boolean(managerIdentity?.accessToken),
      lastSync: managerIdentity?.metadata?.matrixSync ?? null,
    },
    agenthubSkillLoaded: existsSync(agenthubSkillPath),
    managerPersonaReady: existsSync(soulPath) && existsSync(agentsPath) && existsSync(toolsPath),
    controllerReachable,
    matrixJoinedRooms: roomBindings.filter((room) => room.managerParticipantStatus === 'joined').length,
    roomBindings,
    contract: {
      root: contract.root,
      runtimePath: contract.runtimePath,
      runtimeManifestPath: contract.runtimeManifestPath,
      runtimeSpecificConfigPath: input.configPath,
      soulPath: contract.soulPath,
      agentsPath: contract.agentsPath,
      toolsPath: contract.toolsPath,
      heartbeatPath: contract.heartbeatPath,
      skillsDir: contract.skillsDir,
      memoryDir: contract.memoryDir,
      workerRegistryPath: contract.workerRegistryPath,
      teamRegistryPath: contract.teamRegistryPath,
      humanRegistryPath: contract.humanRegistryPath,
      statePath: contract.statePath,
      roomsPath: contract.roomsPath,
      logsDir: contract.logsDir,
      agentDir: contract.agentDir,
      ready: Object.values(contractFiles).every(Boolean),
      files: contractFiles,
    },
    configuredMatrixRooms: input.configInspection.groupKeys,
    lastManagerReplyAt: latestReply ? new Date(latestReply.createdAt).toISOString() : null,
    lastManagerReplyPreview: latestReply?.body?.slice(0, 160) ?? null,
    lastManagerStatusKind:
      latestReply?.metadata && typeof latestReply.metadata.kind === 'string'
        ? latestReply.metadata.kind
        : null,
    lastQueueDepth: null,
    expectedResidentSessionKeyPrefix: 'agent:manager:matrix:channel:',
    endpoint: input.endpoint,
    gatewayPort: input.gatewayPort,
  }
}

async function probeControllerHealth(controllerUrl: string) {
  if (process.env.NODE_ENV === 'test') {
    return { ok: true, url: controllerUrl, status: 200 }
  }
  try {
    const response = await fetch(`${controllerUrl}/health`, { signal: AbortSignal.timeout(1000) })
    return { ok: response.ok, url: controllerUrl, status: response.status }
  } catch (error) {
    return { ok: false, url: controllerUrl, error: error instanceof Error ? error.message : String(error) }
  }
}

async function probeGatewayHealth(port: number, timeoutMs = 1000) {
  if (process.env.NODE_ENV === 'test') {
    return { ok: false, url: `http://127.0.0.1:${port}`, status: null }
  }
  try {
    const url = `http://127.0.0.1:${port}`
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: response.ok, url, status: response.status }
  } catch (error) {
    return { ok: false, url: `http://127.0.0.1:${port}`, error: error instanceof Error ? error.message : String(error) }
  }
}

function inspectOpenClawManagerConfig(configPath: string, matrixDomain: string) {
  const expectedHumanUserId = `@human-${matrixLocalpart('default-user')}:${matrixDomain}`
  const result = {
    exists: existsSync(configPath),
    expectedHumanUserId,
    allowFrom: [] as string[],
    groupAllowFrom: [] as string[],
    groupPolicy: null as string | null,
    requireMention: null as boolean | null,
    matrixChannelEnabled: false,
    matrixPluginEnabled: false,
    matrixGroupCount: 0,
    groupKeys: [] as string[],
    wildcardGroupEnabled: false,
    wildcardAgentHubSkillEnabled: false,
    bindingsCount: 0,
    managerBindingConfigured: false,
    managerIdentityName: null as string | null,
    managerAgentDir: null as string | null,
    humanAllowed: false,
    error: null as string | null,
  }
  if (!result.exists) return result
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const agents =
      isPlainRecord(parsed.agents) && Array.isArray(parsed.agents.list)
        ? (parsed.agents.list as Array<Record<string, unknown>>)
        : []
    const matrix = ((parsed.channels as any)?.matrix ?? {}) as Record<string, unknown>
    const matrixPlugin = ((parsed.plugins as any)?.entries?.matrix ?? {}) as Record<string, unknown>
    const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : []
    const dm = (matrix.dm ?? {}) as Record<string, unknown>
    result.allowFrom = arrayOfStrings(dm.allowFrom)
    result.groupAllowFrom = arrayOfStrings(matrix.groupAllowFrom)
    result.groupPolicy = typeof matrix.groupPolicy === 'string' ? matrix.groupPolicy : null
    const groups = isPlainRecord(matrix.groups) ? matrix.groups : {}
    const wildcardGroup = ((groups as any)?.['*'] ?? {}) as Record<string, unknown>
    result.requireMention = typeof wildcardGroup.requireMention === 'boolean' ? wildcardGroup.requireMention : null
    result.matrixChannelEnabled = matrix.enabled === true
    result.matrixPluginEnabled = matrixPlugin.enabled === true
    result.groupKeys = Object.keys(groups)
    result.matrixGroupCount = result.groupKeys.length
    result.wildcardGroupEnabled = wildcardGroup.enabled === true
    result.wildcardAgentHubSkillEnabled = arrayOfStrings(wildcardGroup.skills).includes('agenthub-controller')
    result.bindingsCount = bindings.length
    result.managerBindingConfigured = bindings.some((binding) => {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false
      const rec = binding as Record<string, unknown>
      if (rec.agentId !== 'manager') return false
      const match = isPlainRecord(rec.match) ? (rec.match as Record<string, unknown>) : null
      if (!match) return false
      return match.channel === 'matrix' && (match.accountId === '*' || typeof match.accountId === 'string')
    })
    const managerAgent = agents.find((agent) => agent?.id === 'manager') ?? null
    result.managerIdentityName =
      managerAgent?.identity && isPlainRecord(managerAgent.identity) && typeof managerAgent.identity.name === 'string'
        ? managerAgent.identity.name
        : null
    result.managerAgentDir =
      typeof managerAgent?.agentDir === 'string' ? managerAgent.agentDir : null
    const allowed = new Set([...result.allowFrom, ...result.groupAllowFrom])
    result.humanAllowed = allowed.has(expectedHumanUserId) || allowed.has('*')
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }
  return result
}

function decodeOpenClawLogChunk(data: Buffer) {
  const utf8 = data.toString('utf8')
  if (!utf8.includes('�')) return utf8

  try {
    const Decoder = TextDecoder as unknown as new (label?: string) => TextDecoder
    const gb18030 = new Decoder('gb18030').decode(data)
    return scoreLogText(gb18030) >= scoreLogText(utf8) ? gb18030 : utf8
  } catch {
    return utf8
  }
}

function scoreLogText(text: string) {
  const replacement = (text.match(/\uFFFD/g) ?? []).length
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const printable = (text.match(/[A-Za-z0-9]/g) ?? []).length
  return cjk * 3 + printable - replacement * 10
}

function arrayOfStrings(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
