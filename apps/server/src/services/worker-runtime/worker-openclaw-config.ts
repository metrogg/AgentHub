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
  managerMatrixUserId: string
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  gatewayPort: number
  dmAllowFrom: string[]
  groupAllowFrom: string[]
  rooms?: WorkerOpenClawRoomBinding[]
  timeoutSeconds: number
  maxConcurrent: number
}

export interface WorkerOpenClawRoomBinding {
  roomId: string
  providerRoomId: string
  kind: string
  participantId?: string | null
  title?: string | null
  allowFrom?: string[]
}

export function getWorkerWorkspaceDir(workerInstanceId: string): string {
  return join(agentHubUserDataRoot(), 'workers', workerInstanceId)
}

export function generateWorkerOpenClawJson(input: WorkerOpenClawConfigInput): object {
  const workerAgentId = openClawWorkerAgentId(input.workerInstanceId)
  const workerAgentDir = join(getWorkerWorkspaceDir(input.workerInstanceId), '.openclaw', 'agents', workerAgentId, 'agent')
  const mentionPatterns = Array.from(
    new Set([
      `@${input.workerName}`,
      input.workerName,
      input.matrixUserId.split(':')[0],
      input.matrixUserId,
    ].filter(Boolean)),
  )
  const roomBindings = buildMatrixRoomBindings(input)

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
        groupAllowFrom: roomBindings.groupAllowFrom,
        groups: roomBindings.groups,
        streaming: 'partial',
        blockStreaming: true,
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
        skipBootstrap: true,
      },
      list: [
        {
          id: workerAgentId,
          name: input.workerName,
          default: true,
          workspace: '~',
          agentDir: workerAgentDir,
          identity: {
            name: input.workerName,
          },
          model: { primary: `agenthub-llm/${input.llmModel}` },
          groupChat: {
            mentionPatterns,
          },
        },
      ],
    },
    bindings: [
      {
        agentId: workerAgentId,
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
    plugins: { load: { paths: ['~/skills'] }, entries: { matrix: { enabled: true } } },
    commands: { restart: true },
  }
}

function buildMatrixRoomBindings(input: WorkerOpenClawConfigInput): {
  groupAllowFrom: string[]
  groups: Record<string, {
    enabled: true
    requireMention: true
    autoReply: true
    skills: string[]
    systemPrompt: string
  }>
} {
  const baseAllowFrom = new Set(input.groupAllowFrom.filter(Boolean))
  const groups: Record<string, {
    enabled: true
    requireMention: true
    autoReply: true
    skills: string[]
    systemPrompt: string
  }> = {}
  const defaultGroup = workerGroupConfig(input.workerName, null)
  groups['*'] = defaultGroup
  for (const room of input.rooms ?? []) {
    if (!room.providerRoomId) continue
    for (const userId of room.allowFrom ?? []) {
      if (userId) baseAllowFrom.add(userId)
    }
    groups[room.providerRoomId] = workerGroupConfig(input.workerName, room)
  }
  return {
    groupAllowFrom: Array.from(baseAllowFrom),
    groups,
  }
}

function workerGroupConfig(workerName: string, room: WorkerOpenClawRoomBinding | null) {
  const roomLabel = room ? `${room.title || room.roomId} (${room.kind})` : 'any AgentHub room'
  return {
    enabled: true as const,
    requireMention: true as const,
    autoReply: true as const,
    skills: ['task-progress', 'file-sync'],
    systemPrompt:
      `You are ${workerName}, an AgentHub resident Worker in ${roomLabel}. ` +
      'Only act when explicitly @mentioned. Read SOUL.md and AGENTS.md first, use shared task contracts, report blockers, progress, artifacts, and completion back to the same Matrix room.',
  }
}

export function openClawWorkerAgentId(workerInstanceId: string): string {
  const normalized = workerInstanceId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `worker-${(normalized || 'agent').slice(0, 32)}`
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
    .replace(/\{COORDINATOR_ID\}/g, input.managerMatrixUserId)
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
