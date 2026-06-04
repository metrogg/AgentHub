import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { workspaceAgents } from '@agenthub/db'
import { agentHubUserDataRoot, safePathSegment } from '../system-paths'
import { globalSkillRegistry } from '../skill-registry'

type WorkspaceAgentRow = typeof workspaceAgents.$inferSelect

export interface WorkerWorkspace {
  root: string
  profilePath: string
  soulPath: string
  agentsPath: string
  statePath: string
  roomsPath: string
  skillsPath: string
}

export function resolveWorkerWorkspaceRoot(): string {
  return join(agentHubUserDataRoot(), 'workers')
}

export function resolveWorkerWorkspace(workerInstanceId: string): WorkerWorkspace {
  const root = join(resolveWorkerWorkspaceRoot(), workerInstanceId)
  return {
    root,
    profilePath: join(root, 'profile.json'),
    soulPath: join(root, 'SOUL.md'),
    agentsPath: join(root, 'AGENTS.md'),
    statePath: join(root, 'state.json'),
    roomsPath: join(root, 'rooms.json'),
    skillsPath: join(root, 'skills'),
  }
}

export async function ensureWorkerWorkspace(
  workerInstanceId: string,
  agent: WorkspaceAgentRow,
): Promise<WorkerWorkspace> {
  const ws = resolveWorkerWorkspace(workerInstanceId)

  mkdirSync(ws.root, { recursive: true })
  mkdirSync(ws.skillsPath, { recursive: true })

  const profile = {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    roleType: agent.roleType,
    description: agent.description,
    modelId: agent.modelId,
    runtimeType: agent.runtimeType,
    codeAgentType: agent.codeAgentType,
    capabilityTags: agent.capabilityTags,
    skillIds: agent.skillIds,
    toolPermissions: agent.toolPermissions,
    sandboxPolicy: agent.sandboxPolicy,
    systemPrompt: agent.systemPrompt,
  }
  writeFileSync(ws.profilePath, JSON.stringify(profile, null, 2), 'utf8')

  writeFileSync(ws.soulPath, buildWorkerSoul(agent), 'utf8')
  writeFileSync(ws.agentsPath, buildWorkerAgents(agent), 'utf8')

  // Initialize empty state/rooms if they do not exist yet
  try {
    const { readFileSync } = await import('node:fs')
    readFileSync(ws.statePath)
  } catch {
    writeFileSync(ws.statePath, JSON.stringify({ version: 1, status: 'created' }, null, 2), 'utf8')
  }
  try {
    const { readFileSync } = await import('node:fs')
    readFileSync(ws.roomsPath)
  } catch {
    writeFileSync(ws.roomsPath, JSON.stringify({ rooms: [] }, null, 2), 'utf8')
  }

  await syncWorkerSkills(ws.skillsPath, agent.skillIds ?? [])

  return ws
}

function buildWorkerSoul(agent: WorkspaceAgentRow): string {
  return [
    `# ${agent.name}`,
    '',
    `## 角色`,
    agent.role || 'Worker',
    '',
    `## 描述`,
    agent.description || 'AgentHub 协作网络中的 Worker Agent。',
    '',
    `## 系统提示`,
    agent.systemPrompt || '无系统提示',
    '',
    `## 能力标签`,
    ...(agent.capabilityTags?.length ? agent.capabilityTags.map((t) => `- ${t}`) : ['- 通用']),
    '',
    `## 可用工具`,
    ...(agent.toolPermissions?.length ? agent.toolPermissions.map((t) => `- ${t}`) : ['- chat']),
  ].join('\n')
}

function buildWorkerAgents(agent: WorkspaceAgentRow): string {
  return [
    `# ${agent.name} 行为规则`,
    '',
    '## 核心原则',
    '- 你是 AgentHub 协作网络中的 Worker Agent。',
    '- 你通过 Matrix Room 与 Manager 和人类协作。',
    '- 所有执行过程必须透明可审计。',
    '',
    '## 通信规范',
    '- 收到任务后，先在 room 中确认"已接单"。',
    '- 执行过程中定期汇报进度。',
    '- 遇到阻塞时主动请求澄清，不要猜测。',
    '- 完成后汇报结果和产物。',
    '',
    '## 文件规范',
    '- 产物优先写入 ArtifactStore。',
    '- 任务结果按 shared task directory 规范写入 result.md。',
  ].join('\n')
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
