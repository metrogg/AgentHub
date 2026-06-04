import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentHubUserDataRoot } from '../system-paths'
import { logger } from '../../lib/logger'

// ─── OpenClaw Launcher ───────────────────────────────────────────────
// Launches OpenClaw as a child process that connects to our Tuwunel
// Matrix homeserver and acts as the Manager agent.
//
// Aligned with HiClaw's start-manager-agent.sh but adapted for AgentHub:
// - No MinIO (uses local filesystem)
// - No Higress (uses AgentHub's LLM gateway directly)
// - No hiclaw CLI (uses curl to AgentHub Controller API)

export interface OpenClawLauncherConfig {
  /** Path to OpenClaw binary (default: auto-detect) */
  openclawPath?: string
  /** Path to openclaw.json config */
  configPath?: string
  /** Matrix homeserver URL */
  matrixUrl?: string
  /** Matrix domain (server name) */
  matrixDomain?: string
  /** Manager Matrix user ID */
  matrixUserId?: string
  /** Manager Matrix access token */
  matrixAccessToken?: string
  /** LLM provider base URL */
  llmBaseUrl?: string
  /** LLM API key */
  llmApiKey?: string
  /** LLM model ID */
  llmModel?: string
  /** AgentHub Controller API URL */
  controllerUrl?: string
  /** Whether to enable E2EE */
  e2ee?: boolean
}

export class OpenClawLauncher {
  private process: ChildProcess | null = null
  private config: OpenClawLauncherConfig
  private managerWorkspace: string

  constructor(config: OpenClawLauncherConfig = {}) {
    this.config = config
    this.managerWorkspace = join(agentHubUserDataRoot(), 'manager', 'global')
  }

  /**
   * Check if OpenClaw is installed and available.
   */
  isAvailable(): boolean {
    const openclawPath = this.config.openclawPath || this.findOpenClawBinary()
    return openclawPath !== null && existsSync(openclawPath)
  }

  /**
   * Get the path to the OpenClaw binary.
   */
  findOpenClawBinary(): string | null {
    // Check common locations
    const candidates = [
      // Project-local install
      join(process.cwd(), '.openclaw-runtime', 'openclaw.mjs'),
      // Global symlink
      '/usr/local/bin/openclaw',
      // User local
      join(process.env.HOME || '', '.local', 'bin', 'openclaw'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    // Try which
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

  /**
   * Generate openclaw.json for the Manager.
   * Aligned with HiClaw's manager-openclaw.json.tmpl.
   */
  generateConfig(): string {
    const matrixUrl = this.config.matrixUrl || 'http://localhost:6167'
    const matrixDomain = this.config.matrixDomain || 'local.agenthub'
    const matrixUserId = this.config.matrixUserId || `@manager:${matrixDomain}`
    const llmBaseUrl = this.config.llmBaseUrl || 'http://localhost:8000/v1'
    const llmApiKey = this.config.llmApiKey || 'agenthub-internal'
    const llmModel = this.config.llmModel || 'default'

    const config = {
      gateway: {
        mode: 'local',
        port: 18799,
        bind: 'lan',
        auth: { token: 'agenthub-manager-token' },
        remote: { token: 'agenthub-manager-token' },
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
          allowInsecureAuth: true,
          allowedOrigins: ['*'],
        },
      },
      channels: {
        matrix: {
          enabled: true,
          homeserver: matrixUrl,
          userId: matrixUserId,
          accessToken: this.config.matrixAccessToken || '',
          encryption: this.config.e2ee ?? false,
          network: { dangerouslyAllowPrivateNetwork: true },
          autoJoin: 'always',
          dm: {
            policy: 'allowlist',
            allowFrom: [`@admin:${matrixDomain}`],
          },
          groupPolicy: 'allowlist',
          groupAllowFrom: [`@admin:${matrixDomain}`],
          groups: {
            '*': { allow: true, requireMention: true },
          },
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
            models: [
              {
                id: llmModel,
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 8192,
                input: ['text'],
              },
            ],
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
          heartbeat: {
            every: '1h',
            prompt: 'Read ~/HEARTBEAT.md and follow the checklist.',
          },
        },
      },
      tools: {
        exec: { host: 'gateway', security: 'full', ask: 'off' },
        elevated: { enabled: true, allowFrom: { matrix: ['*'] } },
      },
      session: {
        dmScope: 'per-channel-peer',
        resetByType: {
          dm: { mode: 'daily', atHour: 4 },
          group: { mode: 'daily', atHour: 4 },
        },
      },
      plugins: {
        load: { paths: [] },
        entries: {},
      },
      commands: { restart: true },
    }

    const configPath = join(this.managerWorkspace, 'openclaw.json')
    mkdirSync(this.managerWorkspace, { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    logger.info({ configPath }, 'Generated OpenClaw Manager config')
    return configPath
  }

  /**
   * Copy agent files (SOUL.md, AGENTS.md, skills, HEARTBEAT.md, TOOLS.md)
   * from the infra/manager-agent directory to the manager workspace.
   */
  copyAgentFiles(): void {
    const sourceDir = join(process.cwd(), 'infra', 'manager-agent')
    if (!existsSync(sourceDir)) {
      logger.warn({ sourceDir }, 'Agent files source directory not found, skipping')
      return
    }
    const targetDir = this.managerWorkspace
    mkdirSync(targetDir, { recursive: true })

    const files = ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'TOOLS.md']
    for (const file of files) {
      const src = join(sourceDir, file)
      const dst = join(targetDir, file)
      if (existsSync(src) && !existsSync(dst)) {
        writeFileSync(dst, readFileSync(src, 'utf8'), 'utf8')
        logger.info({ file }, 'Copied agent file to manager workspace')
      }
    }

    // Copy skills directory
    const skillsSource = join(sourceDir, 'skills')
    const skillsTarget = join(targetDir, 'skills')
    if (existsSync(skillsSource)) {
      mkdirSync(skillsTarget, { recursive: true })
      this.copyDirSync(skillsSource, skillsTarget)
    }
  }

  /**
   * Launch OpenClaw as a child process.
   * Returns the ChildProcess, or null if OpenClaw is not available.
   */
  launch(): ChildProcess | null {
    if (this.process) {
      logger.warn('OpenClaw Manager is already running')
      return this.process
    }

    const openclawPath = this.config.openclawPath || this.findOpenClawBinary()
    if (!openclawPath) {
      logger.error('OpenClaw binary not found. Run: bash infra/setup-openclaw.sh')
      return null
    }

    // Ensure config exists
    const configPath = this.config.configPath || join(this.managerWorkspace, 'openclaw.json')
    if (!existsSync(configPath)) {
      this.generateConfig()
    }

    // Copy agent files
    this.copyAgentFiles()

    // Set up environment
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: '1',
      HOME: this.managerWorkspace,
    }

    // Create .openclaw symlink
    const openclawDir = join(this.managerWorkspace, '.openclaw')
    mkdirSync(openclawDir, { recursive: true })

    logger.info({ openclawPath, configPath }, 'Launching OpenClaw Manager...')

    this.process = spawn(openclawPath, ['gateway', 'run', '--verbose', '--force'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.managerWorkspace,
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line.trim()) logger.info({ source: 'openclaw-manager' }, line.trim())
      }
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line.trim()) logger.warn({ source: 'openclaw-manager' }, line.trim())
      }
    })

    this.process.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'OpenClaw Manager exited')
      this.process = null
    })

    this.process.on('error', (err) => {
      logger.error({ err }, 'OpenClaw Manager process error')
      this.process = null
    })

    return this.process
  }

  /**
   * Stop the OpenClaw Manager process.
   */
  stop(): void {
    if (this.process) {
      logger.info('Stopping OpenClaw Manager...')
      this.process.kill('SIGTERM')
      this.process = null
    }
  }

  /**
   * Check if the OpenClaw Manager is currently running.
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed
  }

  // ─── Worker Management ──────────────────────────────────────────

  private workerProcesses = new Map<string, ChildProcess>()

  /**
   * Generate openclaw.json for a Worker.
   * Aligned with HiClaw's worker-openclaw.json.tmpl.
   */
  generateWorkerConfig(workerName: string, options: {
    matrixUserId?: string
    matrixAccessToken?: string
    llmModel?: string
  } = {}): string {
    const workerWorkspace = join(agentHubUserDataRoot(), 'workers', workerName)
    mkdirSync(workerWorkspace, { recursive: true })

    const matrixDomain = this.config.matrixDomain || 'local.agenthub'
    const matrixUserId = options.matrixUserId || `@worker-${workerName}:${matrixDomain}`
    const llmBaseUrl = this.config.llmBaseUrl || 'http://localhost:8000/v1'
    const llmApiKey = this.config.llmApiKey || 'agenthub-internal'
    const llmModel = options.llmModel || 'default'

    const config = {
      gateway: {
        mode: 'local',
        port: 0,
        bind: 'lan',
        auth: { token: `agenthub-worker-${workerName}` },
        remote: { token: `agenthub-worker-${workerName}` },
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
          allowInsecureAuth: true,
          allowedOrigins: ['*'],
        },
      },
      channels: {
        matrix: {
          enabled: true,
          homeserver: this.config.matrixUrl || 'http://localhost:6167',
          userId: matrixUserId,
          accessToken: options.matrixAccessToken || '',
          encryption: this.config.e2ee ?? false,
          network: { dangerouslyAllowPrivateNetwork: true },
          autoJoin: 'always',
          dm: {
            policy: 'allowlist',
            allowFrom: [`@admin:${matrixDomain}`, `@manager:${matrixDomain}`],
          },
          groupPolicy: 'allowlist',
          groupAllowFrom: [`@admin:${matrixDomain}`, `@manager:${matrixDomain}`],
          groups: {
            '*': { allow: true, requireMention: true },
          },
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
            models: [
              {
                id: llmModel,
                reasoning: false,
                contextWindow: 128000,
                maxTokens: 8192,
                input: ['text'],
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          timeoutSeconds: 600,
          workspace: workerWorkspace,
          model: { primary: `agenthub-llm/${llmModel}` },
          maxConcurrent: 4,
          subagents: { maxConcurrent: 8 },
          elevatedDefault: 'full',
        },
      },
      tools: {
        exec: { host: 'gateway', security: 'full', ask: 'off' },
        elevated: { enabled: true, allowFrom: { matrix: ['*'] } },
      },
      plugins: {
        load: { paths: [] },
        entries: {},
      },
    }

    const configPath = join(workerWorkspace, 'openclaw.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

    // Copy worker agent files
    const sourceDir = join(process.cwd(), 'infra', 'worker-agent')
    if (existsSync(sourceDir)) {
      for (const file of ['SOUL.md', 'AGENTS.md']) {
        const src = join(sourceDir, file)
        const dst = join(workerWorkspace, file)
        if (existsSync(src) && !existsSync(dst)) {
          writeFileSync(dst, readFileSync(src, 'utf8'), 'utf8')
        }
      }
    }

    logger.info({ workerName, configPath }, 'Generated OpenClaw Worker config')
    return configPath
  }

  /**
   * Launch an OpenClaw Worker as a child process.
   */
  launchWorker(workerName: string, options: {
    matrixUserId?: string
    matrixAccessToken?: string
    llmModel?: string
  } = {}): ChildProcess | null {
    if (this.workerProcesses.has(workerName)) {
      logger.warn({ workerName }, 'OpenClaw Worker is already running')
      return this.workerProcesses.get(workerName)!
    }

    const openclawPath = this.config.openclawPath || this.findOpenClawBinary()
    if (!openclawPath) {
      logger.error('OpenClaw binary not found. Run: bash infra/setup-openclaw.sh')
      return null
    }

    const configPath = this.generateWorkerConfig(workerName, options)
    const workerWorkspace = join(agentHubUserDataRoot(), 'workers', workerName)

    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: '1',
      HOME: workerWorkspace,
    }

    logger.info({ workerName, openclawPath, configPath }, 'Launching OpenClaw Worker...')

    const proc = spawn(openclawPath, ['gateway', 'run', '--verbose', '--force'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workerWorkspace,
    })

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line.trim()) logger.info({ source: `openclaw-worker-${workerName}` }, line.trim())
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      for (const line of lines) {
        if (line.trim()) logger.warn({ source: `openclaw-worker-${workerName}` }, line.trim())
      }
    })

    proc.on('exit', (code, signal) => {
      logger.info({ workerName, code, signal }, 'OpenClaw Worker exited')
      this.workerProcesses.delete(workerName)
    })

    proc.on('error', (err) => {
      logger.error({ workerName, err }, 'OpenClaw Worker process error')
      this.workerProcesses.delete(workerName)
    })

    this.workerProcesses.set(workerName, proc)
    return proc
  }

  /**
   * Stop a specific OpenClaw Worker.
   */
  stopWorker(workerName: string): void {
    const proc = this.workerProcesses.get(workerName)
    if (proc) {
      logger.info({ workerName }, 'Stopping OpenClaw Worker...')
      proc.kill('SIGTERM')
      this.workerProcesses.delete(workerName)
    }
  }

  /**
   * Stop all OpenClaw Workers.
   */
  stopAllWorkers(): void {
    for (const [name, proc] of this.workerProcesses) {
      logger.info({ workerName: name }, 'Stopping OpenClaw Worker...')
      proc.kill('SIGTERM')
    }
    this.workerProcesses.clear()
  }

  /**
   * List running OpenClaw Workers.
   */
  listRunningWorkers(): string[] {
    return Array.from(this.workerProcesses.keys())
  }

  // ─── User OpenClaw Integration ──────────────────────────────────

  /**
   * Configure AgentHub to use a user's existing OpenClaw installation.
   * Supports three modes:
   * 1. openclawPath: user provides path to OpenClaw binary → AgentHub manages lifecycle
   * 2. endpoint: user already has OpenClaw running → AgentHub connects via HTTP
   * 3. both: user provides binary path AND endpoint (for health checks)
   */
  configureFromUserOpenClaw(input: {
    openclawPath?: string
    endpoint?: string
    matrixUrl?: string
    matrixDomain?: string
    llmBaseUrl?: string
    llmApiKey?: string
    llmModel?: string
  }): { mode: 'managed' | 'external' | 'none'; details: string } {
    // Mode 1: User has OpenClaw binary, AgentHub manages it
    if (input.openclawPath) {
      if (!existsSync(input.openclawPath)) {
        return { mode: 'none', details: `OpenClaw binary not found at: ${input.openclawPath}` }
      }
      this.config.openclawPath = input.openclawPath
      if (input.matrixUrl) this.config.matrixUrl = input.matrixUrl
      if (input.matrixDomain) this.config.matrixDomain = input.matrixDomain
      if (input.llmBaseUrl) this.config.llmBaseUrl = input.llmBaseUrl
      if (input.llmApiKey) this.config.llmApiKey = input.llmApiKey
      if (input.llmModel) this.config.llmModel = input.llmModel

      // Generate config and copy agent files
      this.generateConfig()
      this.copyAgentFiles()

      return {
        mode: 'managed',
        details: `Using OpenClaw at ${input.openclawPath}. Config generated at ${join(this.managerWorkspace, 'openclaw.json')}. Launch with: openclaw gateway run`,
      }
    }

    // Mode 2: User already has OpenClaw running, just set endpoint
    if (input.endpoint) {
      process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT = input.endpoint
      return {
        mode: 'external',
        details: `Connecting to external OpenClaw at ${input.endpoint}. AgentHub will use it as ManagerRuntimeProvider endpoint.`,
      }
    }

    return { mode: 'none', details: 'No OpenClaw path or endpoint provided.' }
  }

  /**
   * Get current OpenClaw integration status.
   */
  getStatus(): {
    available: boolean
    mode: 'managed' | 'external' | 'none'
    binaryPath: string | null
    endpoint: string | null
    managerRunning: boolean
    workerCount: number
  } {
    const binaryPath = this.config.openclawPath || this.findOpenClawBinary()
    const endpoint = process.env.AGENTHUB_OPENCLAW_MANAGER_ENDPOINT || null

    let mode: 'managed' | 'external' | 'none' = 'none'
    if (this.isRunning()) mode = 'managed'
    else if (binaryPath) mode = 'managed'
    else if (endpoint) mode = 'external'

    return {
      available: mode !== 'none',
      mode,
      binaryPath,
      endpoint,
      managerRunning: this.isRunning(),
      workerCount: this.workerProcesses.size,
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────

  private copyDirSync(src: string, dst: string): void {
    const { readdirSync, statSync, copyFileSync } = require('node:fs')
    const entries = readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = join(src, entry.name)
      const dstPath = join(dst, entry.name)
      if (entry.isDirectory()) {
        mkdirSync(dstPath, { recursive: true })
        this.copyDirSync(srcPath, dstPath)
      } else {
        copyFileSync(srcPath, dstPath)
      }
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

export const openclawLauncher = new OpenClawLauncher()
