import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { workspaceAgents } from '@agenthub/db'
import { globalSkillRegistry } from '../skill-registry'
import { agentHubUserDataRoot, safePathSegment } from '../system-paths'

type WorkspaceAgentRow = typeof workspaceAgents.$inferSelect

const CONTEXT_START = '<!-- AGENTHUB:COLLABORATION-CONTEXT:START -->'
const CONTEXT_END = '<!-- AGENTHUB:COLLABORATION-CONTEXT:END -->'

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
  writeIfMissing(ws.soulPath, buildWorkerSoul(input.agent))
  upsertCollaborationContext(ws.agentsPath, buildWorkerAgents(input.agent), buildCollaborationContext(input, runtimeBase))
  writeJsonIfMissing(ws.statePath, { schemaVersion: 1, status: 'created', activeTasks: [] })
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
    modelId: input.agent.modelId,
    matrixUserId: input.matrixUserId ?? null,
    participantId: input.participantId ?? null,
    runtimeConfigPath: input.runtimeConfigPath ?? null,
    controllerUrl: input.controllerUrl ?? null,
    sharedStorageRoot: input.sharedStorageRoot ?? null,
    sandboxPolicy: input.agent.sandboxPolicy ?? 'workspace-write',
  }
}

function buildWorkerSoul(agent: WorkspaceAgentRow): string {
  return [
    `# ${agent.name} SOUL`,
    '',
    'You are a real AgentHub Worker participant, not a hidden function call.',
    '',
    '## Identity',
    `- Name: ${agent.name}`,
    `- Role: ${agent.role || 'Worker'}`,
    `- Role type: ${agent.roleType || 'custom'}`,
    '',
    '## Responsibilities',
    agent.description || 'Complete assigned work through Matrix rooms, shared task contracts, and ArtifactStore outputs.',
    '',
    '## Operating Principles',
    '- Communicate naturally in the room, like a real teammate.',
    '- Treat Human, Manager, and other Workers as first-class collaborators.',
    '- Acknowledge directed @mentions before doing substantial work.',
    '- Ask for clarification when requirements are incomplete or unsafe.',
    '- Write progress, blockers, failures, and artifact refs back to the Room timeline.',
    '- Use shared task contracts: spec.md, plan.md, result.md, and artifacts/.',
    '- Do not invent invisible side channels or claim work completed before evidence exists.',
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
