import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentHubUserDataRoot } from '../system-paths'

export interface ManagerConfigPaths {
  root: string
  soulPath: string
  agentsPath: string
  skillsDir: string
  workerRegistryPath: string
  statePath: string
}

const DEFAULT_SOUL = [
  '# AgentHub Manager SOUL',
  '',
  'You are the visible coordinator of an AgentHub room.',
  'Act like an AI team lead: observe the room, respond naturally, ask clarifying questions when needed, assign work to suitable workers, and keep humans in the loop.',
  'Do not force every human message into a task plan. Ordinary conversation should receive an ordinary room reply.',
  'All coordination must be transparent through room timeline events.',
  '',
].join('\n')

const DEFAULT_AGENTS = [
  '# AgentHub Manager AGENTS',
  '',
  '- Human participants are first-class collaborators.',
  '- Workers are real execution participants, not hidden function calls.',
  '- Task rooms are the place where assigned work, progress, failures, clarification requests, and artifacts become auditable.',
  '',
].join('\n')

const DEFAULT_WORKER_REGISTRY = {
  schemaVersion: 1,
  workers: [],
}

const DEFAULT_STATE = {
  schemaVersion: 1,
  status: 'ready',
}

export function managerConfigPaths(workspaceId?: string | null): ManagerConfigPaths {
  const root = join(agentHubUserDataRoot(), 'manager', workspaceId || 'global')
  return {
    root,
    soulPath: join(root, 'SOUL.md'),
    agentsPath: join(root, 'AGENTS.md'),
    skillsDir: join(root, 'skills'),
    workerRegistryPath: join(root, 'workers-registry.json'),
    statePath: join(root, 'state.json'),
  }
}

export function ensureManagerConfig(workspaceId?: string | null) {
  const paths = managerConfigPaths(workspaceId)
  mkdirSync(paths.root, { recursive: true })
  mkdirSync(paths.skillsDir, { recursive: true })
  writeIfMissing(paths.soulPath, DEFAULT_SOUL)
  writeIfMissing(paths.agentsPath, DEFAULT_AGENTS)
  writeJsonIfMissing(paths.workerRegistryPath, DEFAULT_WORKER_REGISTRY)
  writeJsonIfMissing(paths.statePath, DEFAULT_STATE)
  return paths
}

export function readManagerPromptConfig(workspaceId?: string | null) {
  const paths = ensureManagerConfig(workspaceId)
  return {
    paths,
    soul: readFileSync(paths.soulPath, 'utf8'),
    agents: readFileSync(paths.agentsPath, 'utf8'),
  }
}

function writeIfMissing(path: string, content: string) {
  if (existsSync(path)) return
  writeFileSync(path, content, 'utf8')
}

function writeJsonIfMissing(path: string, value: unknown) {
  if (existsSync(path)) return
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
