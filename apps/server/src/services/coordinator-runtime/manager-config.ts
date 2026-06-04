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
  '- Understand natural language first, then call the smallest suitable skill. Skills operate AgentHub Controller APIs; they are not prompt-only templates.',
  '- Use Matrix rooms for coordination and shared task object refs for files. Do not create invisible side channels.',
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
  ensureBuiltinManagerSkills(paths.skillsDir)
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

function ensureBuiltinManagerSkills(skillsDir: string) {
  for (const skill of BUILTIN_MANAGER_SKILLS) {
    const dir = join(skillsDir, skill.name)
    mkdirSync(dir, { recursive: true })
    writeIfMissing(join(dir, 'SKILL.md'), skill.body)
  }
}

const BUILTIN_MANAGER_SKILLS = [
  {
    name: 'worker-management',
    body: skillDoc({
      title: 'Worker Management',
      purpose: 'Create, inspect, wake, sleep, stop, and update Worker participants.',
      controllerApi: [
        'POST /api/controller/workers',
        'GET /api/controller/workers',
        'POST /api/controller/workers/{workerId}/wake',
        'POST /api/controller/workers/{workerId}/sleep',
        'POST /api/controller/workers/{workerId}/stop',
      ],
      rules: [
        'Prefer existing suitable workers before proposing a new one.',
        'New worker creation must be visible in the room and user-confirmed unless the room policy explicitly allows autonomous staffing.',
        'Every worker must have a Matrix identity, a runtime base, a model binding, skill scope, and shared-storage access scope.',
      ],
    }),
  },
  {
    name: 'task-management',
    body: skillDoc({
      title: 'Task Management',
      purpose: 'Turn user goals into visible task room assignments and reconcile task lifecycle.',
      controllerApi: [
        'POST /api/controller/runs',
        'POST /api/controller/runs/{runId}/tasks',
        'POST /api/controller/tasks/{taskId}/assign',
        'POST /api/controller/tasks/{taskId}/reconcile',
        'POST /api/controller/tasks/{taskId}/complete',
      ],
      rules: [
        'Do not force ordinary conversation into a task.',
        'When work is needed, assign through a Matrix task room and include shared/tasks/{taskId}/spec.md, meta.json, plan.md, and result.md refs.',
        'Clarification requests happen in the same Matrix room, not through hidden tables.',
      ],
    }),
  },
  {
    name: 'channel-management',
    body: skillDoc({
      title: 'Channel Management',
      purpose: 'Create and maintain Matrix rooms, participants, mentions, and visibility policy.',
      controllerApi: [
        'POST /api/controller/rooms',
        'POST /api/controller/rooms/{roomId}/participants',
        'POST /api/controller/rooms/{roomId}/events',
        'POST /api/controller/rooms/{roomId}/mentions',
      ],
      rules: [
        'Matrix room timeline is the collaboration source of truth.',
        'Human, Manager, and Worker participants should be visible and auditable.',
        'Use @mentions for directed work and status requests.',
      ],
    }),
  },
  {
    name: 'file-sync-management',
    body: skillDoc({
      title: 'File Sync Management',
      purpose: 'Manage shared task contracts and artifact references through MinIO/S3-compatible storage.',
      controllerApi: [
        'POST /api/controller/shared-objects',
        'GET /api/controller/shared-objects/{objectKey}',
        'POST /api/controller/artifacts',
      ],
      rules: [
        'Shared storage refs are canonical; local files are mirrors.',
        'Workers must publish final result.md and artifacts under shared/tasks/{taskId}/.',
        'Never ask downstream workers to guess relative paths that were not published as object refs.',
      ],
    }),
  },
  {
    name: 'human-management',
    body: skillDoc({
      title: 'Human Management',
      purpose: 'Treat human users as first-class collaborators who can observe, interrupt, clarify, approve, or take over.',
      controllerApi: [
        'POST /api/controller/humans',
        'POST /api/controller/approvals',
        'POST /api/controller/interventions',
      ],
      rules: [
        'Human-in-the-loop happens in Matrix rooms.',
        'Ask for approval before staffing changes or dangerous actions unless policy says otherwise.',
        'Human messages in task rooms are authoritative context for the assigned worker.',
      ],
    }),
  },
]

function skillDoc(input: {
  title: string
  purpose: string
  controllerApi: string[]
  rules: string[]
}) {
  return [
    `# ${input.title}`,
    '',
    '## Purpose',
    input.purpose,
    '',
    '## Controller API Surface',
    ...input.controllerApi.map((item) => `- ${item}`),
    '',
    '## Rules',
    ...input.rules.map((item) => `- ${item}`),
    '',
    '## Decision Pattern',
    '1. Read the Matrix room timeline and shared task refs.',
    '2. Decide whether this skill is necessary.',
    '3. Call the smallest Controller API action that changes real resources.',
    '4. Report the result back to the Matrix room.',
    '',
  ].join('\n')
}
