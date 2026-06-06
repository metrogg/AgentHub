import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { workspaceAgents } from '@agenthub/db'
import { globalSkillRegistry } from '../skill-registry'
import { agentHubUserDataRoot, safePathSegment } from '../system-paths'

type WorkspaceAgentRow = typeof workspaceAgents.$inferSelect

const CONTEXT_START = '<!-- AGENTHUB:COLLABORATION-CONTEXT:START -->'
const CONTEXT_END = '<!-- AGENTHUB:COLLABORATION-CONTEXT:END -->'

const RUNTIME_PARITY_CAPABILITIES = [
  'matrix_identity',
  'room_timeline_io',
  'mention_dispatch',
  'SOUL.md',
  'AGENTS.md',
  'skills',
  'workspace_contract',
  'shared_task_contract',
  'artifact_refs',
  'heartbeat',
  'stop_or_cancel',
  'clarification_resume',
  'transparent_blockers',
]

export interface WorkerAgentContractWorkspace {
  root: string
  profilePath: string
  runtimePath: string
  soulPath: string
  agentsPath: string
  statePath: string
  roomsPath: string
  tasksPath: string
  skillsPath: string
}

export interface EnsureWorkerAgentContractInput {
  workerInstanceId: string
  agent: WorkspaceAgentRow
  matrixUserId?: string | null
  participantId?: string | null
  runtimeBase?: string | null
  runtimeConfigPath?: string | null
  controllerUrl?: string | null
  sharedStorageRoot?: string | null
  currentRooms?: Array<{
    roomId: string
    roomKind?: string | null
    providerRoomId?: string | null
    participantId?: string | null
    title?: string | null
  }>
}

export function resolveWorkerAgentContractRoot(): string {
  return join(agentHubUserDataRoot(), 'workers')
}

export function resolveWorkerAgentContractWorkspace(workerInstanceId: string): WorkerAgentContractWorkspace {
  const root = join(resolveWorkerAgentContractRoot(), workerInstanceId)
  return {
    root,
    profilePath: join(root, 'profile.json'),
    runtimePath: join(root, 'runtime.json'),
    soulPath: join(root, 'SOUL.md'),
    agentsPath: join(root, 'AGENTS.md'),
    statePath: join(root, 'state.json'),
    roomsPath: join(root, 'rooms.json'),
    tasksPath: join(root, 'tasks.json'),
    skillsPath: join(root, 'skills'),
  }
}

export async function ensureWorkerAgentContract(
  input: EnsureWorkerAgentContractInput,
): Promise<WorkerAgentContractWorkspace> {
  const ws = resolveWorkerAgentContractWorkspace(input.workerInstanceId)
  mkdirSync(ws.root, { recursive: true })
  mkdirSync(ws.skillsPath, { recursive: true })

  const runtimeBase = input.runtimeBase ?? readWorkerRuntimeBase(input.agent.roleProfile) ?? input.agent.codeAgentType ?? null
  writeJson(ws.profilePath, buildProfile(input, runtimeBase))
  writeJson(ws.runtimePath, buildRuntime(input, runtimeBase))
  writeIfMissing(ws.soulPath, buildWorkerSoul(input.agent, runtimeBase))
  upsertCollaborationContext(ws.agentsPath, buildWorkerAgents(input.agent), buildCollaborationContext(input, runtimeBase))
  writeJsonIfMissing(ws.statePath, {
    schemaVersion: 1,
    status: 'created',
    activeTasks: [],
    heartbeat: {
      lastHeartbeatAt: null,
      lastMatrixSyncAt: null,
      lastRuntimeReadyAt: null,
      lastTaskStartedAt: null,
      lastTaskCompletedAt: null,
      lastError: null,
      queueDepth: 0,
    },
  })
  writeJsonIfMissing(ws.roomsPath, {
    schemaVersion: 1,
    rooms: input.currentRooms ?? [],
  })
  writeJsonIfMissing(ws.tasksPath, { schemaVersion: 1, tasks: [] })
  await syncWorkerSkills(ws.skillsPath, input.agent.skillIds ?? [])

  return ws
}

function buildProfile(input: EnsureWorkerAgentContractInput, runtimeBase: string | null) {
  const agent = input.agent
  return {
    schemaVersion: 1,
    workerInstanceId: input.workerInstanceId,
    workspaceAgentId: agent.id,
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType,
    description: agent.description,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    workerRuntimeBase: runtimeBase,
    capabilityTags: agent.capabilityTags ?? [],
    skillIds: agent.skillIds ?? [],
    toolPermissions: agent.toolPermissions ?? [],
    sandboxPolicy: agent.sandboxPolicy,
    contextPolicy: agent.contextPolicy,
    systemPrompt: agent.systemPrompt,
  }
}

function buildRuntime(input: EnsureWorkerAgentContractInput, runtimeBase: string | null) {
  return {
    schemaVersion: 1,
    runtimeFamily: 'worker',
    runtimeBase,
    runtimeMode: runtimeModeForBase(runtimeBase),
    adapterContract: runtimeAdapterContract(runtimeBase),
    modelId: input.agent.modelId,
    matrixUserId: input.matrixUserId ?? null,
    participantId: input.participantId ?? null,
    runtimeConfigPath: input.runtimeConfigPath ?? null,
    controllerUrl: input.controllerUrl ?? null,
    sharedStorageRoot: input.sharedStorageRoot ?? null,
    sandboxPolicy: input.agent.sandboxPolicy ?? 'workspace-write',
  }
}

function buildWorkerSoul(agent: WorkspaceAgentRow, runtimeBase: string | null): string {
  return [
    `# ${agent.name} SOUL`,
    '',
    'You are a real AgentHub Worker participant, not a hidden function call.',
    '',
    '## Identity',
    `- Name: ${agent.name}`,
    `- Role: ${agent.role || 'Worker'}`,
    `- Role type: ${agent.roleType || 'custom'}`,
    `- Runtime base: ${runtimeBase || 'unconfigured'}`,
    '',
    '## Responsibilities',
    agent.description || 'Complete assigned work through Matrix rooms, shared task contracts, and ArtifactStore outputs.',
    '',
    '## Runtime Adapter Identity',
    ...runtimeSoulLines(runtimeBase),
    '',
    '## Operating Principles',
    '- Communicate naturally in the room, like a real teammate.',
    '- Treat Human, Manager, and other Workers as first-class collaborators.',
    '- Acknowledge directed @mentions before doing substantial work.',
    '- Ask for clarification when requirements are incomplete or unsafe.',
    '- Write progress, blockers, failures, and artifact refs back to the Room timeline.',
    '- Use shared task contracts: spec.md, plan.md, result.md, and artifacts/.',
    '- Do not invent invisible side channels or claim work completed before evidence exists.',
    '- Keep your runtime state explainable through state.json, rooms.json, tasks.json, and heartbeat fields.',
    '- If a required model, auth, tool, sandbox, or Matrix binding is missing, report the blocker instead of guessing.',
    '',
    '## Delivery Contract',
    '- Read spec.md before execution when present.',
    '- Update result.md or the visible room result with STATUS, SUMMARY, DELIVERABLES, RISKS, and NEXT STEPS.',
    '- Register file outputs as artifacts or put them under the shared task artifacts directory.',
    '- Preserve partial outputs and explain what is reliable when a run fails.',
    '',
    '## Local Role Prompt',
    agent.systemPrompt || 'No extra role prompt.',
  ].join('\n')
}

function buildWorkerAgents(agent: WorkspaceAgentRow): string {
  return [
    `# ${agent.name} AGENTS`,
    '',
    'This file is maintained by AgentHub Controller. The collaboration context block is regenerated during reconcile.',
    '',
    '## Core Rules',
    '- Matrix Room timeline is the communication source of truth.',
    '- WorkerInstance and RuntimeLease are the lifecycle source of truth.',
    '- ArtifactStore and shared task directory are the delivery source of truth.',
    '- Never bypass Room timeline for task assignment, clarification, progress, or completion.',
    '- Preserve user work and report partial outputs when execution fails.',
    '- Controller-injected context is authoritative for current rooms, runtime base, sandbox, and task contracts.',
    '- Skills in skills/*/SKILL.md are executable operating instructions, not decoration.',
  ].join('\n')
}

function buildCollaborationContext(input: EnsureWorkerAgentContractInput, runtimeBase: string | null): string {
  const rooms = input.currentRooms?.length
    ? input.currentRooms.map((room) => `- ${room.title || room.roomId}: ${room.roomKind || 'room'} (${room.providerRoomId || room.roomId})`).join('\n')
    : '- No rooms recorded in local rooms.json yet.'
  return [
    CONTEXT_START,
    '## AgentHub Collaboration Context',
    '',
    `- Worker instance: ${input.workerInstanceId}`,
    `- Workspace agent: ${input.agent.id}`,
    `- Runtime base: ${runtimeBase || 'unconfigured'}`,
    `- Runtime mode: ${runtimeModeForBase(runtimeBase)}`,
    `- Model binding: ${input.agent.modelId || 'unconfigured'}`,
    `- Matrix user id: ${input.matrixUserId || 'unbound'}`,
    `- Participant id: ${input.participantId || 'unbound'}`,
    `- Sandbox policy: ${input.agent.sandboxPolicy || 'workspace-write'}`,
    `- Controller API: ${input.controllerUrl || 'not injected'}`,
    `- Shared storage root: ${input.sharedStorageRoot || 'not injected'}`,
    '',
    '### Current Rooms',
    rooms,
    '',
    '### Runtime Adapter Contract',
    ...runtimeContextLines(runtimeBase),
    '',
    '### Worker Reconcile Contract',
    '- EnsureIdentityAndWorkspace: Matrix identity, participant binding, SOUL/AGENTS/skills/state are present.',
    '- EnsureRuntimeConfig: runtime-specific config points at Controller, Matrix, SharedStorage, model, and sandbox.',
    '- EnsureRuntimeReady: resident runtime listens; bridge runtime proves CLI/auth/model readiness.',
    '- ObserveHealthAndHeartbeat: last sync, last task, queue depth, and error state are explainable.',
    '- RecoverOrRetire: stale leases, stop/sleep/failure, and human-visible diagnostics are handled by Controller.',
    '',
    '### Room Protocol',
    '- Treat explicit @mentions as directed work or clarification requests.',
    '- Reply in the same Room unless the task contract says otherwise.',
    '- Use /stop, /approve, and /deny control messages only according to AgentHub room policy.',
    '',
    '### Task Contract',
    '- Read shared/tasks/{taskId}/spec.md before execution when available.',
    '- Keep result.md structured with STATUS, SUMMARY, DELIVERABLES, and NOTES.',
    '- Put deliverables under artifacts/ or register them with ArtifactStore.',
    CONTEXT_END,
  ].join('\n')
}

function runtimeModeForBase(runtimeBase: string | null): 'resident' | 'bridge' | 'unconfigured' {
  if (!runtimeBase) return 'unconfigured'
  return runtimeBase === 'openclaw' || runtimeBase === 'qwenpaw' ? 'resident' : 'bridge'
}

function runtimeAdapterContract(runtimeBase: string | null) {
  const mode = runtimeModeForBase(runtimeBase)
  const baseProfile = runtimeBaseProfile(runtimeBase)
  return {
    base: runtimeBase ?? 'unconfigured',
    mode,
    baseProfile,
    listensToMatrix: baseProfile.matrixIntegration.owner,
    workspaceContract: ['profile.json', 'runtime.json', 'SOUL.md', 'AGENTS.md', 'skills/', 'state.json', 'rooms.json', 'tasks.json'],
    taskContract: ['shared/tasks/{taskId}/spec.md', 'plan.md', 'result.md', 'artifacts/'],
    parityCapabilities: RUNTIME_PARITY_CAPABILITIES,
    heartbeat: ['lastHeartbeatAt', 'lastMatrixSyncAt', 'lastRuntimeReadyAt', 'lastTaskStartedAt', 'lastTaskCompletedAt', 'lastError', 'queueDepth'],
  }
}

function runtimeBaseProfile(runtimeBase: string | null) {
  switch (runtimeBase) {
    case 'openclaw':
      return {
        label: 'OpenClaw Worker',
        roleEligibility: { manager: true, worker: true },
        implementation: {
          language: 'Node.js',
          architectureMode: 'gateway',
          processModel: 'resident gateway process or Docker container',
          toolIntegration: 'OpenClaw tools and MCP-compatible gateway tools',
          configStrategy: 'openclaw.json plus mirrored SOUL/AGENTS/skills workspace',
          healthSource: 'gateway health, Matrix sync, heartbeat, and Controller runtime state',
          sessionStrategy: 'long-running gateway session',
        },
        matrixIntegration: {
          owner: 'runtime-native',
          pattern: 'OpenClaw Matrix channel listens to joined rooms and replies through Matrix timeline',
        },
        currentLimits: [],
      }
    case 'qwenpaw':
      return {
        label: 'QwenPaw Worker',
        roleEligibility: { manager: true, worker: true },
        implementation: {
          language: 'Python',
          architectureMode: 'workspace',
          processModel: 'resident workspace process or Docker container',
          toolIntegration: 'QwenPaw/CoPaw channels and Controller skills',
          configStrategy: 'workspace files plus mirrored SOUL/AGENTS/skills workspace',
          healthSource: 'workspace loop health, Matrix sync, heartbeat, and Controller runtime state',
          sessionStrategy: 'lightweight resident workspace loop',
        },
        matrixIntegration: {
          owner: 'runtime-native',
          pattern: 'QwenPaw channel listens to joined rooms and replies through Matrix timeline',
        },
        currentLimits: ['AgentHub recognizes this base, but QwenPaw WorkerBackend is not implemented yet.'],
      }
    case 'claude-code':
      return bridgeRuntimeBaseProfile({
        label: 'Claude Code Worker',
        command: 'claude',
        toolIntegration: 'Claude Code native tools and project instructions',
        configStrategy: 'native Claude Code auth/config plus projected SOUL/AGENTS/skills contract',
        sessionStrategy: 'CLI session resume when Claude Code exposes a session id or continue flag',
      })
    case 'opencode':
      return bridgeRuntimeBaseProfile({
        label: 'OpenCode Worker',
        command: 'opencode',
        toolIntegration: 'OpenCode native tools and auth/config',
        configStrategy: 'native OpenCode config plus projected SOUL/AGENTS/skills contract',
        sessionStrategy: 'AgentHub-managed task session bridge',
      })
    case 'codex':
      return bridgeRuntimeBaseProfile({
        label: 'Codex Worker',
        command: 'codex',
        toolIntegration: 'Codex CLI native tools and auth/config',
        configStrategy: 'native Codex auth/config plus projected SOUL/AGENTS/skills contract',
        sessionStrategy: 'AgentHub-managed task session bridge',
      })
    case 'gemini':
      return bridgeRuntimeBaseProfile({
        label: 'Gemini CLI Worker',
        command: 'gemini',
        toolIntegration: 'Gemini CLI native tools and auth/config',
        configStrategy: 'native Gemini config plus projected SOUL/AGENTS/skills contract',
        sessionStrategy: 'AgentHub-managed task session bridge',
      })
    default:
      return {
        label: 'Unconfigured Worker',
        roleEligibility: { manager: false, worker: false },
        implementation: {
          language: 'none',
          architectureMode: 'unconfigured',
          processModel: 'blocked',
          toolIntegration: 'none',
          configStrategy: 'requires explicit Worker runtime base and compatible model',
          healthSource: 'Controller validation only',
          sessionStrategy: 'blocked until configured',
        },
        matrixIntegration: {
          owner: 'unconfigured',
          pattern: 'no runtime listener until Controller receives an explicit base',
        },
        currentLimits: ['Worker runtime base is missing.'],
      }
  }
}

function bridgeRuntimeBaseProfile(input: {
  label: string
  command: string
  toolIntegration: string
  configStrategy: string
  sessionStrategy: string
}) {
  return {
    label: input.label,
    roleEligibility: { manager: false, worker: true },
    implementation: {
      language: 'native CLI',
      architectureMode: 'bridge',
      processModel: 'AgentHub-managed CLI subprocess; long-running bridge is a later upgrade',
      toolIntegration: input.toolIntegration,
      configStrategy: input.configStrategy,
      healthSource: `${input.command} command probe, native version check, model/auth/config, cwd, and WorkerRuntime heartbeat`,
      sessionStrategy: input.sessionStrategy,
    },
    matrixIntegration: {
      owner: 'agenthub-supervisor',
      pattern: 'AgentHub Matrix listener imports room events, invokes the CLI bridge, then writes replies back to Matrix timeline',
    },
    currentLimits: ['Bridge mode is compatible with the common contract but is not yet a runtime-native Matrix listener.'],
  }
}

function runtimeSoulLines(runtimeBase: string | null): string[] {
  switch (runtimeBase) {
    case 'openclaw':
      return [
        '- You run as an OpenClaw Worker when resident mode is enabled.',
        '- Prefer native Matrix channel listening and OpenClaw tools/MCP for long-running collaboration.',
        '- Keep gateway/session behavior aligned with the same SOUL/AGENTS/skills contract used by other Worker bases.',
      ]
    case 'qwenpaw':
      return [
        '- You run as a QwenPaw/CoPaw-style Worker when resident mode is enabled.',
        '- Prefer lightweight workspace-mode behavior with the same Matrix, skills, and shared storage contract.',
        '- Keep memory and resource use small while preserving room-visible progress.',
      ]
    case 'claude-code':
      return [
        '- You run through the Claude Code Worker base.',
        '- Follow Claude Code native project instructions, but AgentHub AGENTS.md and SOUL.md remain the collaboration contract.',
        '- Keep CLI sessions resumable when the runtime provides a session id.',
      ]
    case 'opencode':
      return [
        '- You run through the OpenCode Worker base.',
        '- Use OpenCode native auth/config, while AgentHub supplies Matrix room context, task contract, and artifact rules.',
        '- Treat local bridge execution as a compatibility layer until resident Worker mode is available.',
      ]
    case 'codex':
      return [
        '- You run through the Codex Worker base.',
        '- Use Codex native auth/config; AgentHub must not invent a hidden default model for you.',
        '- Respect sandbox and project safety rules before editing files.',
      ]
    case 'gemini':
      return [
        '- You run through the Gemini CLI Worker base.',
        '- Use Gemini native auth/config, while AgentHub supplies Matrix room context and shared task contracts.',
        '- Report configuration or tool blockers visibly instead of falling back to another base.',
      ]
    default:
      return [
        '- Runtime base is not configured yet.',
        '- Do not start execution until Controller or the human supplies an explicit Worker runtime base and compatible model.',
      ]
  }
}

function runtimeContextLines(runtimeBase: string | null): string[] {
  const mode = runtimeModeForBase(runtimeBase)
  const profile = runtimeBaseProfile(runtimeBase)
  return [
    `- Mode: ${mode}`,
    `- Base profile: ${profile.label}`,
    `- Architecture mode: ${profile.implementation.architectureMode}`,
    `- Process model: ${profile.implementation.processModel}`,
    `- Matrix listener owner: ${profile.matrixIntegration.owner}`,
    `- Matrix pattern: ${profile.matrixIntegration.pattern}`,
    `- Runtime readiness: ${profile.implementation.healthSource}`,
    '- The upper-layer Manager should see the same worker capabilities regardless of runtime base: identity, skills, workspace, heartbeat, room listener, and task contract.',
    `- Parity capabilities: ${RUNTIME_PARITY_CAPABILITIES.join(', ')}`,
    profile.currentLimits.length ? `- Current limits: ${profile.currentLimits.join(' ')}` : '- Current limits: none recorded.',
  ]
}

function upsertCollaborationContext(path: string, baseContent: string, context: string) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : baseContent
  const start = existing.indexOf(CONTEXT_START)
  const end = existing.indexOf(CONTEXT_END)
  if (start >= 0 && end > start) {
    const before = existing.slice(0, start).trimEnd()
    const after = existing.slice(end + CONTEXT_END.length).trimStart()
    writeFileSync(path, `${before}\n\n${context}${after ? `\n\n${after}` : ''}\n`, 'utf8')
    return
  }
  writeFileSync(path, `${existing.trimEnd()}\n\n${context}\n`, 'utf8')
}

function writeIfMissing(path: string, content: string) {
  if (existsSync(path)) return
  writeFileSync(path, `${content.trimEnd()}\n`, 'utf8')
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function writeJsonIfMissing(path: string, value: unknown) {
  if (existsSync(path)) return
  writeJson(path, value)
}

async function syncWorkerSkills(skillsDir: string, skillIds: string[]) {
  if (!skillIds.length) return
  const skills = await globalSkillRegistry.loadSkillsByIds(skillIds)
  for (const skill of skills) {
    const skillDir = join(skillsDir, safePathSegment(skill.id))
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skill.body, 'utf8')
  }
}

function readWorkerRuntimeBase(roleProfile: unknown) {
  if (!roleProfile || typeof roleProfile !== 'object') return null
  const value = (roleProfile as Record<string, unknown>).workerRuntimeBase
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
