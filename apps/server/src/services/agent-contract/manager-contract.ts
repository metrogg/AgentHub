import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentHubUserDataRoot } from '../system-paths'

const CONTEXT_START = '<!-- AGENTHUB:MANAGER-CONTEXT:START -->'
const CONTEXT_END = '<!-- AGENTHUB:MANAGER-CONTEXT:END -->'

export interface ManagerAgentContractWorkspace {
  root: string
  runtimePath: string
  soulPath: string
  agentsPath: string
  toolsPath: string
  heartbeatPath: string
  skillsDir: string
  workerRegistryPath: string
  teamRegistryPath: string
  humanRegistryPath: string
  statePath: string
  roomsPath: string
  logsDir: string
  agentDir: string
}

export interface EnsureManagerAgentContractInput {
  managerId?: string | null
  runtimeType?: 'openclaw' | 'qwenpaw' | string | null
  matrixUserId?: string | null
  participantId?: string | null
  controllerUrl?: string | null
  sharedStorageRoot?: string | null
  matrixHomeserverUrl?: string | null
  matrixServerName?: string | null
  runtimeConfigPath?: string | null
  currentRooms?: Array<{
    roomId: string
    roomKind?: string | null
    providerRoomId?: string | null
    participantId?: string | null
    title?: string | null
  }>
}

export function resolveManagerAgentContractRoot(managerId?: string | null): string {
  return join(agentHubUserDataRoot(), 'manager', managerId || 'global')
}

export function resolveManagerAgentContractWorkspace(managerId?: string | null): ManagerAgentContractWorkspace {
  const root = resolveManagerAgentContractRoot(managerId)
  return {
    root,
    runtimePath: join(root, 'runtime.json'),
    soulPath: join(root, 'SOUL.md'),
    agentsPath: join(root, 'AGENTS.md'),
    toolsPath: join(root, 'TOOLS.md'),
    heartbeatPath: join(root, 'HEARTBEAT.md'),
    skillsDir: join(root, 'skills'),
    workerRegistryPath: join(root, 'workers-registry.json'),
    teamRegistryPath: join(root, 'teams-registry.json'),
    humanRegistryPath: join(root, 'humans-registry.json'),
    statePath: join(root, 'state.json'),
    roomsPath: join(root, 'rooms.json'),
    logsDir: join(root, 'logs'),
    agentDir: join(root, '.openclaw', 'agents', 'manager', 'agent'),
  }
}

export function ensureManagerAgentContract(
  input: EnsureManagerAgentContractInput = {},
): ManagerAgentContractWorkspace {
  const ws = resolveManagerAgentContractWorkspace(input.managerId)
  mkdirSync(ws.root, { recursive: true })
  mkdirSync(ws.skillsDir, { recursive: true })
  mkdirSync(ws.logsDir, { recursive: true })
  mkdirSync(ws.agentDir, { recursive: true })

  seedManagerFile(ws.soulPath, 'SOUL.md', buildManagerSoul())
  seedManagerFile(ws.toolsPath, 'TOOLS.md', buildManagerTools())
  seedManagerFile(ws.heartbeatPath, 'HEARTBEAT.md', buildManagerHeartbeat())
  upsertManagerContext(ws.agentsPath, seedText('AGENTS.md', buildManagerAgents()), buildManagerContext(input))
  syncManagerSkills(ws.skillsDir)

  writeJson(ws.runtimePath, buildRuntime(input))
  writeJsonIfMissing(ws.workerRegistryPath, { schemaVersion: 1, workers: [] })
  writeJsonIfMissing(ws.teamRegistryPath, { schemaVersion: 1, teams: [] })
  writeJsonIfMissing(ws.humanRegistryPath, { schemaVersion: 1, humans: [] })
  writeJsonIfMissing(ws.statePath, {
    schemaVersion: 1,
    status: 'ready',
    activeRuns: [],
    heartbeat: {
      lastHeartbeatAt: null,
      lastMatrixSyncAt: null,
      lastRuntimeReadyAt: null,
      lastError: null,
      queueDepth: 0,
    },
  })
  writeJson(ws.roomsPath, {
    schemaVersion: 1,
    rooms: input.currentRooms ?? [],
  })
  mirrorManagerAgentDir(ws)
  copyAgentHubCli(ws.root)

  return ws
}

export function readManagerPromptContract(managerId?: string | null) {
  const paths = ensureManagerAgentContract({ managerId })
  return {
    paths,
    soul: readFileSync(paths.soulPath, 'utf8'),
    agents: readFileSync(paths.agentsPath, 'utf8'),
  }
}

function buildRuntime(input: EnsureManagerAgentContractInput) {
  return {
    schemaVersion: 1,
    runtimeFamily: 'manager',
    runtimeType: input.runtimeType ?? 'openclaw',
    matrixUserId: input.matrixUserId ?? null,
    participantId: input.participantId ?? null,
    runtimeConfigPath: input.runtimeConfigPath ?? null,
    controllerUrl: input.controllerUrl ?? null,
    sharedStorageRoot: input.sharedStorageRoot ?? null,
    matrixHomeserverUrl: input.matrixHomeserverUrl ?? null,
    matrixServerName: input.matrixServerName ?? null,
    skillSchema: 'agenthub-controller-v1',
  }
}

function buildManagerSoul(): string {
  return [
    '# AgentHub Manager SOUL',
    '',
    'You are the visible Manager of an AgentHub Matrix room, not a hidden planner or a one-shot function call.',
    '',
    '## Identity',
    '- You are a team coordinator and collaboration steward.',
    '- Human, Manager, and Worker participants are peers in the room timeline.',
    '- You understand user intent first, then choose whether to reply, clarify, staff, assign, observe, recover, or synthesize.',
    '',
    '## Responsibilities',
    '- Keep the room understandable and calm.',
    '- Create or invite Workers only through Controller skills and visible room actions.',
    '- Assign work with @mentions and task contracts, not invisible side channels.',
    '- Watch Worker progress, failures, clarification requests, artifacts, and final results.',
    '- Synthesize results for the human after evidence exists.',
    '',
    '## Boundaries',
    '- Do not turn ordinary conversation into a planning panel.',
    '- Do not claim a Worker was created, invited, or assigned unless the Controller action succeeded.',
    '- Do not silently choose a missing runtime or model. Ask the human or report the missing configuration.',
    '- Do not perform risky staffing, permission, model, or workspace changes without visible confirmation unless room policy allows it.',
    '',
    '## Communication Style',
    '- Use concise Chinese by default unless the room context asks otherwise.',
    '- Speak naturally like a team lead, not like a JSON emitter.',
    '- Mention concrete next actions, owner, room, task contract, and artifact refs when coordinating work.',
    '- Stay quiet when nothing needs human attention.',
    '',
    '## Quality',
    '- A task is complete only when result.md, artifacts, or a visible room result proves it.',
    '- Preserve partial outputs and explain failures transparently.',
    '- Prefer small Controller actions that change real resources over large speculative plans.',
  ].join('\n')
}

function buildManagerAgents(): string {
  return [
    '# AgentHub Manager AGENTS',
    '',
    'This file is maintained by AgentHub Controller. The Manager context block is regenerated during reconcile.',
    '',
    '## Core Rules',
    '- Matrix Room timeline is the collaboration source of truth.',
    '- Controller resources are the lifecycle source of truth: Room, WorkerInstance, RuntimeLease, Task, Artifact, and Run.',
    '- Skills operate AgentHub Controller APIs. They are not decorative prompt templates.',
    '- Manager coordinates; Workers execute.',
    '- All assignments, clarification, approvals, failures, and artifact references must be visible in Matrix rooms.',
    '- Prefer existing suitable Workers before proposing new staffing.',
    '- Missing runtime, model, identity, or room binding is a configuration problem, not a reason to default to Codex.',
  ].join('\n')
}

function buildManagerTools(): string {
  return [
    '# Manager Tools Quick Reference',
    '',
    '## Decision Pattern',
    '1. Read SOUL.md, AGENTS.md, workers-registry.json, rooms.json, and the relevant room timeline.',
    '2. Decide whether the human needs a reply, clarification, staffing proposal, task assignment, recovery action, or final synthesis.',
    '3. Read the matching skill in skills/<name>/SKILL.md.',
    '4. Call the smallest Controller API action that changes real AgentHub resources.',
    '5. Report the outcome back to the same Matrix room.',
    '',
    '## Core Skill Chains',
    '| Scenario | Skill Chain |',
    '|---|---|',
    '| Simple chat | reply directly, no task skill |',
    '| Need a Worker | worker-management -> channel-management |',
    '| Complex goal | task-management -> worker-management -> channel-management -> file-sync-management |',
    '| Worker blocked | task-coordination -> human-management or worker-management |',
    '| Final delivery | file-sync-management -> review-and-synthesis |',
    '',
    '## Controller Access',
    '- Use AGENTHUB_CONTROLLER_URL as the Controller API root.',
    '- Use AGENTHUB_MANAGER_TOKEN as the bearer token when available.',
    '- Never edit database files directly.',
  ].join('\n')
}

function buildManagerHeartbeat(): string {
  return [
    '# Manager Heartbeat Checklist',
    '',
    'When a heartbeat fires, inspect state quietly and only speak if attention is needed.',
    '',
    '1. Check active rooms and active runs.',
    '2. Check Worker heartbeat, Matrix sync, RuntimeLease, and last task progress.',
    '3. Detect stale assigned/busy/waiting states.',
    '4. Recover through Controller skills when policy allows it.',
    '5. Ask the human when recovery needs approval.',
    '6. Stay quiet when everything is healthy.',
  ].join('\n')
}

function buildManagerContext(input: EnsureManagerAgentContractInput): string {
  const rooms = input.currentRooms?.length
    ? input.currentRooms.map((room) => `- ${room.title || room.roomId}: ${room.roomKind || 'room'} (${room.providerRoomId || room.roomId})`).join('\n')
    : '- No rooms recorded yet.'
  return [
    CONTEXT_START,
    '## AgentHub Manager Context',
    '',
    `- Manager id: ${input.managerId || 'global'}`,
    `- Runtime type: ${input.runtimeType || 'openclaw'}`,
    `- Matrix user id: ${input.matrixUserId || 'unbound'}`,
    `- Participant id: ${input.participantId || 'unbound'}`,
    `- Controller API: ${input.controllerUrl || 'not injected'}`,
    `- Shared storage root: ${input.sharedStorageRoot || 'not injected'}`,
    `- Matrix homeserver: ${input.matrixHomeserverUrl || 'not injected'}`,
    `- Matrix server name: ${input.matrixServerName || 'agenthub.local'}`,
    '',
    '### Current Rooms',
    rooms,
    '',
    '### Reconcile Contract',
    '- EnsureManagerIdentity',
    '- EnsureManagerWorkspace',
    '- SyncSkillsAndRegistries',
    '- EnsureRuntimeProcess',
    '- ObserveRoomBindingsAndHeartbeat',
    '',
    '### Member Reconcile Contract',
    '- ResolveMemberSpec',
    '- ApplyWorkspaceAgent',
    '- ApplyWorkerInstance',
    '- JoinRooms',
    '- AnnounceAndObserve',
    CONTEXT_END,
  ].join('\n')
}

function seedManagerFile(path: string, fileName: string, fallback: string) {
  writeIfMissing(path, seedText(fileName, fallback))
}

function seedText(fileName: string, fallback: string): string {
  const src = join(process.cwd(), 'infra', 'manager-agent', fileName)
  if (existsSync(src)) return readFileSync(src, 'utf8')
  return `${fallback.trimEnd()}\n`
}

function upsertManagerContext(path: string, baseContent: string, context: string) {
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

function syncManagerSkills(targetDir: string) {
  const sourceDir = join(process.cwd(), 'infra', 'manager-agent', 'skills')
  if (existsSync(sourceDir)) {
    copyDirSync(sourceDir, targetDir)
    return
  }
  for (const skill of FALLBACK_MANAGER_SKILLS) {
    const skillDir = join(targetDir, skill)
    mkdirSync(skillDir, { recursive: true })
    writeIfMissing(join(skillDir, 'SKILL.md'), fallbackSkillDoc(skill))
  }
}

function mirrorManagerAgentDir(ws: ManagerAgentContractWorkspace) {
  for (const file of ['SOUL.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md']) {
    const src = join(ws.root, file)
    const dst = join(ws.agentDir, file)
    writeFileSync(dst, readFileSync(src, 'utf8'), 'utf8')
  }
  copyDirSync(ws.skillsDir, join(ws.agentDir, 'skills'))
}

function copyAgentHubCli(root: string) {
  const cliSource = join(process.cwd(), 'infra', 'agenthub-cli', 'agenthub.ts')
  if (!existsSync(cliSource)) return
  const cliDst = join(root, 'agenthub')
  writeFileSync(cliDst, readFileSync(cliSource, 'utf8'), 'utf8')
  try {
    chmodSync(cliDst, 0o755)
  } catch {}
}

function copyDirSync(source: string, target: string) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source)) {
    const src = join(source, entry)
    const dst = join(target, entry)
    if (statSync(src).isDirectory()) {
      copyDirSync(src, dst)
    } else {
      writeFileSync(dst, readFileSync(src), 'utf8')
    }
  }
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

const FALLBACK_MANAGER_SKILLS = [
  'agenthub-controller',
  'worker-management',
  'task-management',
  'team-management',
  'human-management',
  'channel-management',
  'file-sync-management',
  'project-management',
  'model-switch',
  'worker-model-switch',
  'mcp-server-management',
  'matrix-server-management',
  'service-publishing',
  'git-delegation-management',
  'hiclaw-find-worker',
  'task-coordination',
]

function fallbackSkillDoc(name: string): string {
  return [
    `# ${name}`,
    '',
    '## Purpose',
    'Operate AgentHub Controller resources through a visible Matrix-room workflow.',
    '',
    '## Controller API Surface',
    '- Read the matching Controller API before taking action.',
    '',
    '## Decision Pattern',
    '1. Read the Matrix room timeline and shared task refs.',
    '2. Decide whether this skill is necessary.',
    '3. Call the smallest Controller API action that changes real resources.',
    '4. Report the result back to the Matrix room.',
    '',
  ].join('\n')
}
