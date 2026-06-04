import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { agentHubUserDataRoot } from '../system-paths'
import { logger } from '../../lib/logger'
import { getRuntimeServerPort } from '../../lib/runtime-server'
import { createMatrixClientFromEnv } from '../rooms/matrix-client'
import { MatrixIdentityService } from '../rooms/matrix-identity-service'
import { resolveHealthEndpoint, resolveStepEndpoint } from './remote-manager-runtime-adapter'
import { ResidentManagerRuntime } from './resident-manager-runtime'
import type { ManagerRuntime } from './types'

// ─── Manager Runtime Types ────────────────────────────────────────────

export type ManagerRuntimeType = 'openclaw' | 'qwenpaw'

export interface ManagerRuntimeStatus {
  runtimeType: ManagerRuntimeType
  available: boolean
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
    const running = this.process !== null && !this.process.killed

    return {
      runtimeType: this.runtimeType,
      available: binaryPath !== null || endpoint !== null,
      syncReady: endpoint !== null,
      running,
      pid: running ? this.process!.pid ?? null : null,
      workspace: this.managerWorkspace,
      configPath: this.getConfigPath(),
      binaryPath,
      endpoint,
      stepEndpoint: endpoint ? resolveStepEndpoint(endpoint) : null,
      healthEndpoint: endpoint ? resolveHealthEndpoint(endpoint) : null,
      error: !binaryPath && !endpoint ? 'OpenClaw binary not found and no endpoint configured' : null,
      diagnostics: {
        binaryInstalled: binaryPath !== null,
        endpointConfigured: endpoint !== null,
        synchronousStepReady: endpoint !== null,
        note: endpoint
          ? 'OpenClaw Manager endpoint is configured; AgentHub can call POST /step.'
          : 'OpenClaw binary availability only means lifecycle can be managed. Configure AGENTHUB_OPENCLAW_MANAGER_ENDPOINT for synchronous Manager steps.',
      },
      startedAt: this.startedAt,
      uptime: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : null,
    }
  }

  async ensureStarted(): Promise<ManagerRuntimeStatus> {
    const st = await this.status()
    if (st.running) return st
    if (st.endpoint) return st // external endpoint, no need to start

    if (!st.binaryPath) {
      return { ...st, error: 'OpenClaw binary not found. Run: bash infra/setup-openclaw.sh' }
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

    // Generate config with Matrix credentials
    this.generateConfig()

    // Copy agent files
    this.copyAgentFiles()

    // Launch
    this.launch(st.binaryPath)
    return this.status()
  }

  async stop(): Promise<ManagerRuntimeStatus> {
    if (this.process) {
      logger.info('Stopping OpenClaw Manager...')
      this.process.kill('SIGTERM')
      this.process = null
      this.startedAt = null
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

    // Managed process: check if still running
    if (st.running) {
      return { healthy: true }
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
    // OpenClaw is a resident process; AgentHub does not invoke its step directly.
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

  private generateConfig(): string {
    const matrixUrl = this.config.matrixUrl || process.env.AGENTHUB_MATRIX_HOMESERVER_URL || 'http://localhost:6167'
    const matrixDomain = this.config.matrixDomain || process.env.AGENTHUB_MATRIX_SERVER_NAME || 'local.agenthub'
    const matrixUserId = this.config.matrixUserId || `@manager:${matrixDomain}`
    const llmBaseUrl = this.config.llmBaseUrl || process.env.AGENTHUB_MANAGER_LLM_BASE_URL || process.env.LLM_BASE_URL || 'http://localhost:8000/v1'
    const llmApiKey = this.config.llmApiKey || process.env.AGENTHUB_MANAGER_LLM_API_KEY || process.env.LLM_API_KEY || 'agenthub-internal'
    const llmModel = this.config.llmModel || process.env.AGENTHUB_MANAGER_LLM_MODEL || process.env.LLM_MODEL || 'default'
    const llmContextWindow = Number(process.env.AGENTHUB_MANAGER_LLM_CONTEXT_WINDOW || '128000')
    const llmMaxTokens = Number(process.env.AGENTHUB_MANAGER_LLM_MAX_TOKENS || '8192')

    const config = {
      gateway: {
        mode: 'local',
        port: 18799,
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
          dm: { policy: 'allowlist', allowFrom: [`@admin:${matrixDomain}`] },
          groupPolicy: 'open',
          groupAllowFrom: [`@admin:${matrixDomain}`],
          streaming: 'partial',
          blockStreaming: true,
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
        load: { paths: [join(this.managerWorkspace, 'skills')] },
        entries: {},
      },
      commands: { restart: true },
    }

    mkdirSync(this.managerWorkspace, { recursive: true })
    const configPath = this.getConfigPath()
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    logger.info({ configPath }, 'Generated OpenClaw Manager config')
    return configPath
  }

  private copyAgentFiles(): void {
    const sourceDir = join(process.cwd(), 'infra', 'manager-agent')
    if (!existsSync(sourceDir)) return
    mkdirSync(this.managerWorkspace, { recursive: true })
    for (const file of ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md']) {
      const src = join(sourceDir, file)
      const dst = join(this.managerWorkspace, file)
      if (existsSync(src) && !existsSync(dst)) {
        writeFileSync(dst, readFileSync(src, 'utf8'), 'utf8')
      }
    }
    const skillsSource = join(sourceDir, 'skills')
    const skillsTarget = join(this.managerWorkspace, 'skills')
    if (existsSync(skillsSource)) {
      mkdirSync(skillsTarget, { recursive: true })
      this.copyDirSync(skillsSource, skillsTarget)
    }
    // Ensure state files exist
    const statePath = join(this.managerWorkspace, 'state.json')
    if (!existsSync(statePath)) {
      writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, status: 'ready', activeTasks: [] }, null, 2), 'utf8')
    }
    const registryPath = join(this.managerWorkspace, 'workers-registry.json')
    if (!existsSync(registryPath)) {
      writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, workers: [] }, null, 2), 'utf8')
    }
  }

  private launch(binaryPath: string): void {
    const serverPort = getRuntimeServerPort() ?? Number(process.env.PORT || 3000)
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: this.getConfigPath(),
      OPENCLAW_NO_RESPAWN: '1',
      HOME: this.managerWorkspace,
      AGENTHUB_CONTROLLER_URL: `http://localhost:${serverPort}`,
      AGENTHUB_MANAGER_TOKEN: this.managerAccessToken ?? '',
    }

    logger.info({ binaryPath, configPath: this.getConfigPath() }, 'Launching OpenClaw Manager...')

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
      for (const line of data.toString().trim().split('\n')) {
        if (line.trim()) logger.info({ source: 'openclaw-manager' }, line.trim())
      }
    })
    this.process.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().trim().split('\n')) {
        if (line.trim()) logger.warn({ source: 'openclaw-manager' }, line.trim())
      }
    })
    this.process.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'OpenClaw Manager exited')
      this.process = null
      this.startedAt = null
    })
    this.process.on('error', (err) => {
      logger.error({ err }, 'OpenClaw Manager process error')
      this.process = null
      this.startedAt = null
    })

    this.startedAt = new Date().toISOString()
  }

  private copyDirSync(src: string, dst: string): void {
    const { readdirSync, statSync, copyFileSync } = require('node:fs')
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const s = join(src, entry.name)
      const d = join(dst, entry.name)
      if (entry.isDirectory()) {
        mkdirSync(d, { recursive: true })
        this.copyDirSync(s, d)
      } else {
        copyFileSync(s, d)
      }
    }
  }
}

// ─── QwenPaw Provider ────────────────────────────────────────────────

export class QwenPawManagerRuntimeProvider implements ManagerRuntimeProvider {
  readonly runtimeType = 'qwenpaw' as const

  async status(): Promise<ManagerRuntimeStatus> {
    return {
      runtimeType: this.runtimeType,
      available: false,
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
