import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentHubUserDataRoot } from '../system-paths'
import { logger } from '../../lib/logger'

export interface WorkerOpenClawConfigInput {
  workerInstanceId: string
  workerName: string
  matrixUrl: string
  matrixDomain: string
  matrixUserId: string
  matrixAccessToken: string
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  gatewayPort: number
  dmAllowFrom: string[]
  groupAllowFrom: string[]
  timeoutSeconds: number
  maxConcurrent: number
}

export function getWorkerWorkspaceDir(workerInstanceId: string): string {
  return join(agentHubUserDataRoot(), 'workers', workerInstanceId)
}

export function generateWorkerOpenClawJson(input: WorkerOpenClawConfigInput): object {
  return {
    gateway: {
      mode: 'local',
      port: input.gatewayPort,
      bind: 'lan',
      auth: { token: `agenthub-worker-token-${input.workerInstanceId.slice(0, 8)}` },
      remote: { token: `agenthub-worker-token-${input.workerInstanceId.slice(0, 8)}` },
      controlUi: {
        dangerouslyDisableDeviceAuth: true,
        allowInsecureAuth: true,
        allowedOrigins: ['*'],
      },
    },
    channels: {
      matrix: {
        enabled: true,
        homeserver: input.matrixUrl,
        userId: input.matrixUserId,
        accessToken: input.matrixAccessToken,
        encryption: false,
        network: { dangerouslyAllowPrivateNetwork: true },
        autoJoin: 'always',
        dm: { policy: 'allowlist', allowFrom: input.dmAllowFrom },
        groupPolicy: 'allowlist',
        groupAllowFrom: input.groupAllowFrom,
        streaming: 'off',
        blockStreaming: false,
      },
    },
    models: {
      mode: 'merge',
      providers: {
        'agenthub-llm': {
          baseUrl: input.llmBaseUrl,
          apiKey: input.llmApiKey,
          api: 'openai-completions',
          models: [{ id: input.llmModel, reasoning: false, contextWindow: 128000, maxTokens: 8192, input: ['text'] }],
        },
      },
    },
    agents: {
      defaults: {
        timeoutSeconds: input.timeoutSeconds,
        workspace: '~',
        model: { primary: `agenthub-llm/${input.llmModel}` },
        maxConcurrent: input.maxConcurrent,
        subagents: { maxConcurrent: input.maxConcurrent * 2 },
        elevatedDefault: 'full',
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
    plugins: { load: { paths: [] }, entries: { matrix: { enabled: true } } },
    commands: { restart: true },
  }
}

export function deployWorkerConfig(input: WorkerOpenClawConfigInput): string {
  const workspaceDir = getWorkerWorkspaceDir(input.workerInstanceId)
  mkdirSync(workspaceDir, { recursive: true })

  // 1. Write openclaw.json (always overwrite — this is Manager-managed config)
  const configJson = generateWorkerOpenClawJson(input)
  const configPath = join(workspaceDir, 'openclaw.json')
  writeFileSync(configPath, JSON.stringify(configJson, null, 2), 'utf8')
  logger.info({ configPath, workerId: input.workerInstanceId, gatewayPort: input.gatewayPort }, 'Generated Worker openclaw.json')

  // 2. Copy agent files from infra/worker-agent/ (seed-only: skip if exists)
  const templateDir = join(process.cwd(), 'infra', 'worker-agent')
  if (existsSync(templateDir)) {
    copyAgentTemplate(workspaceDir, templateDir, input)
  }

  return configPath
}

function copyAgentTemplate(
  workspaceDir: string,
  templateDir: string,
  input: WorkerOpenClawConfigInput,
): void {
  // SOUL.md — seed-only (Worker owns it after first boot)
  const soulSrc = join(templateDir, 'SOUL.md')
  const soulDst = join(workspaceDir, 'SOUL.md')
  if (existsSync(soulSrc) && !existsSync(soulDst)) {
    const content = renderTemplate(readFileSync(soulSrc, 'utf8'), input)
    writeFileSync(soulDst, content, 'utf8')
    logger.info({ path: soulDst }, 'Seeded Worker SOUL.md')
  }

  // AGENTS.md — seed-only (Worker owns it after first boot)
  const agentsSrc = join(templateDir, 'AGENTS.md')
  const agentsDst = join(workspaceDir, 'AGENTS.md')
  if (existsSync(agentsSrc) && !existsSync(agentsDst)) {
    const content = renderTemplate(readFileSync(agentsSrc, 'utf8'), input)
    writeFileSync(agentsDst, content, 'utf8')
    logger.info({ path: agentsDst }, 'Seeded Worker AGENTS.md')
  }

  // skills/ — always sync (Coordinator-controlled builtin skills)
  const skillsSrc = join(templateDir, 'skills')
  const skillsDst = join(workspaceDir, 'skills')
  if (existsSync(skillsSrc)) {
    mkdirSync(skillsDst, { recursive: true })
    copyDirSync(skillsSrc, skillsDst)
  }

  // state.json — initialize if missing
  const statePath = join(workspaceDir, 'state.json')
  if (!existsSync(statePath)) {
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, status: 'ready', activeTasks: [] }, null, 2), 'utf8')
  }

  // memory/ — initialize if missing
  const memoryDir = join(workspaceDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
}

function renderTemplate(content: string, input: WorkerOpenClawConfigInput): string {
  // Replace AgentHub-specific placeholders
  return content
    .replace(/\{WORKER_NAME\}/g, input.workerName)
    .replace(/\{MATRIX_DOMAIN\}/g, input.matrixDomain)
    .replace(/\{COORDINATOR_ID\}/g, `@manager:${input.matrixDomain}`)
    .replace(/\{ADMIN_ID\}/g, `@admin:${input.matrixDomain}`)
}

function copyDirSync(src: string, dst: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(d, { recursive: true })
      copyDirSync(s, d)
    } else {
      copyFileSync(s, d)
    }
  }
}
