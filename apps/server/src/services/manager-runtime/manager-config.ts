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
  {
    name: 'team-management',
    body: skillDoc({
      title: 'Team Management',
      purpose: 'Group N Workers under a single Team Leader so the Manager only delegates to the Leader, never to team workers directly.',
      controllerApi: [
        'POST /api/controller/teams',
        'GET /api/controller/teams',
        'POST /api/controller/teams/{teamId}/members',
        'DELETE /api/controller/teams/{teamId}/members/{agentId}',
        'POST /api/internal/manager/actions action=delegate_to_team',
      ],
      rules: [
        'A Team = 1 Team Leader container + N Worker containers. Leader must use a team-leader runtime base (closest in AgentHub: qwenpaw).',
        'Manager only @mentions the Team Leader in the Leader Room. Never @mention team workers directly.',
        'Team workers’ groupAllowFrom includes [Leader, Team Admin], not Manager.',
        'Tasks delegated to a team carry metadata.delegatedToTeam=<teamId> so the Manager routes status through the Leader.',
      ],
      gotchas: [
        'Team Leader is a Worker container with team-leader runtime base, not a Manager runtime.',
        'Team Room = Leader + Team Admin + all team workers. Global Admin is only present if they are also the Team Admin.',
        'Leader Room is a 3-party room: Manager + Global Admin + Leader (same as a regular Worker Room).',
        'Deleting a team deletes the Leader container first, then each team worker container, then the team record.',
      ],
      operationReference: [
        { situation: 'Admin asks to start a team-based project', action: 'POST /api/controller/teams, then POST /api/internal/manager/actions with action=delegate_to_team' },
        { situation: 'Add or remove a worker from an existing team', action: 'POST or DELETE /api/controller/teams/{teamId}/members' },
        { situation: 'Inspect team composition', action: 'GET /api/controller/teams' },
        { situation: 'Delete the entire team', action: 'DELETE /api/controller/teams/{teamId} (cascades to containers)' },
      ],
    }),
  },
  {
    name: 'project-management',
    body: skillDoc({
      title: 'Project Management',
      purpose: 'Coordinate multi-worker projects through a single plan.md source of truth and a dedicated Project Room.',
      controllerApi: [
        'POST /api/controller/projects',
        'GET /api/controller/projects/{projectId}',
        'PATCH /api/controller/projects/{projectId}/plan',
        'POST /api/controller/projects/{projectId}/advance-phase',
        'POST /api/controller/projects/{projectId}/complete',
      ],
      rules: [
        'Every project has exactly one Project Room (Matrix) and one plan.md (single source of truth).',
        'The Project Room MUST always include the human admin — non-negotiable.',
        'Never advance to the next phase while a REVISION_NEEDED marker is pending.',
        'plan.md is canonical; the SQLite workspace_tasks table is a derived projection.',
      ],
      gotchas: [
        '“All tasks complete” finalization is mandatory even in unattended mode — always update plan.md and notify the admin.',
        'YOLO mode check: if AGENTHUB_YOLO=1 or ~/yolo-mode exists, auto-confirm the plan in step 1c; never block on a “please confirm” question.',
        'When the plan changes mid-project, use PATCH /api/controller/projects/{projectId}/plan rather than ad-hoc task edits.',
        'Always adapt to the admin’s preferred language when posting in rooms or DMs.',
      ],
      operationReference: [
        { situation: 'Admin asks to start a multi-worker project', action: 'POST /api/controller/projects (auto-creates Project Room + plan.md)' },
        { situation: 'Worker reports task completion in Project Room', action: 'Update plan.md first, then POST /api/controller/projects/{projectId}/advance-phase' },
        { situation: 'Plan needs adjustment', action: 'PATCH /api/controller/projects/{projectId}/plan' },
        { situation: 'Project fully complete', action: 'POST /api/controller/projects/{projectId}/complete' },
      ],
      bestPractices: [
        'Always sync plan.md to ArtifactStore after every phase transition.',
        'Read SOUL.md before composing notifications to use the persona and language defined there.',
        'Use plan.md as the only place where task status is recorded; avoid duplicating state in chat messages.',
      ],
    }),
  },
  {
    name: 'hiclaw-find-worker',
    body: skillDoc({
      title: 'Worker Marketplace Discovery',
      purpose: 'Search and import Worker templates from a marketplace when the admin has not specified an existing Worker.',
      controllerApi: [
        'GET /api/controller/worker-marketplace/search?q={query}&limit=3',
        'GET /api/controller/worker-marketplace/packages/{packageUri}',
        'POST /api/controller/worker-marketplace/install',
      ],
      rules: [
        'Only use this skill for marketplace search and install — hand-created workers go through worker-management.',
        'Always confirm with the admin before installing a search result.',
        'If the admin gives a nacos://... URI directly, treat it as an explicit package import — confirm the Worker name, then install.',
        'Do not fall back to worker-management after a marketplace install fails unless the admin explicitly asks.',
      ],
      gotchas: [
        'Marketplace only returns nacos:// package URIs; do not interpret them as zip files or other formats.',
        'Installation creates a Worker with runtimeBase: qwenpaw by default unless the admin specifies otherwise.',
        'Report install failures with the key error from the response body; do not retry automatically.',
        'Some templates require additional setup (MCP servers, environment variables) — list these in the install result.',
      ],
      operationReference: [
        { situation: 'Admin assigns work without specifying a Worker', action: 'GET /api/controller/worker-marketplace/search?q={requirement}, then recommend top 3' },
        { situation: 'Admin gives a nacos:// URI directly', action: 'POST /api/controller/worker-marketplace/install with packageUri' },
        { situation: 'Admin confirms a specific candidate from search', action: 'POST /api/controller/worker-marketplace/install with templateName' },
        { situation: 'Marketplace unavailable', action: 'Report failure to admin; do not silently fall back to worker-management' },
      ],
      bestPractices: [
        'Search by capability tags first (e.g., react, rust, ml), then by natural language query.',
        'Always include name, role, and capabilityTags in the recommendation.',
        'Prefer templates with high install count and recent activity.',
      ],
    }),
  },
  {
    name: 'task-coordination',
    body: skillDoc({
      title: 'Task Directory Coordination',
      purpose: 'Prevent conflicts when both Manager and Worker modify the same task directory by using .processing marker events on the task room timeline.',
      controllerApi: [
        'POST /api/controller/tasks/{taskId}/processing-marker',
        'GET /api/controller/tasks/{taskId}/processing-marker',
        'DELETE /api/controller/tasks/{taskId}/processing-marker',
        'POST /api/controller/tasks/{taskId}/acquire (atomic check-and-create)',
      ],
      rules: [
        'Always check for a processing marker before modifying a task directory.',
        'Always create a marker before doing git ops, plan.md updates, or other workspace-level changes.',
        'Always remove the marker when work is done; rely on the 15-minute expiration as a safety net.',
        '15-minute default expiration prevents deadlocks from crashed processes.',
      ],
      gotchas: [
        'The marker payload is a JSON object: { processor, startedAt, expiresAt, operation }.',
        'Expiration is checked on read; expired markers are treated as “safe to proceed”.',
        'Never modify a task directory when a valid (non-expired) marker exists — wait or coordinate with the processor.',
        'This skill is the integration point for git-delegation-management (Manager) and the Worker’s git-delegation skill.',
      ],
      coordinationProtocol: [
        '1. Read the latest task.processing.* event from the task room timeline.',
        '2. If a non-expired marker exists, do not modify — wait or coordinate.',
        '3. If safe, append a task.processing.acquired event with the new marker payload.',
        '4. Perform the modifications.',
        '5. Append a task.processing.released event to clear the marker.',
      ],
      operationReference: [
        { situation: 'Manager about to modify a Worker’s task workspace', action: 'POST /api/controller/tasks/{taskId}/acquire (atomic check-and-create)' },
        { situation: 'Worker about to modify its own workspace', action: 'GET /api/controller/tasks/{taskId}/processing-marker, then POST if safe' },
        { situation: 'Work complete', action: 'DELETE /api/controller/tasks/{taskId}/processing-marker' },
        { situation: 'Process crashed leaving a stale marker', action: 'Wait for expiration (15 min) or call DELETE with force=true' },
      ],
      bestPractices: [
        'Always include operation in the marker for debugging (e.g., git-delegation, plan-md-update).',
        'Use short, descriptive processor names (manager, worker-alice, etc.).',
        'If you find an expired marker, clean it up before creating your own.',
      ],
    }),
  },
]

function skillDoc(input: {
  title: string
  purpose: string
  controllerApi: string[]
  rules: string[]
  gotchas?: string[]
  operationReference?: Array<{ situation: string; action: string }>
  coordinationProtocol?: string[]
  bestPractices?: string[]
}) {
  const sections: string[] = [
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
  ]

  if (input.gotchas && input.gotchas.length > 0) {
    sections.push('## Gotchas', ...input.gotchas.map((item) => `- ${item}`), '')
  }

  if (input.operationReference && input.operationReference.length > 0) {
    sections.push(
      '## Operation Reference',
      '| Situation | Action |',
      '|---|---|',
      ...input.operationReference.map((item) => `| ${item.situation} | ${item.action} |`),
      '',
    )
  }

  if (input.coordinationProtocol && input.coordinationProtocol.length > 0) {
    sections.push('## Coordination Protocol', ...input.coordinationProtocol, '')
  }

  if (input.bestPractices && input.bestPractices.length > 0) {
    sections.push('## Best Practices', ...input.bestPractices.map((item) => `- ${item}`), '')
  }

  sections.push(
    '## Decision Pattern',
    '1. Read the Matrix room timeline and shared task refs.',
    '2. Decide whether this skill is necessary.',
    '3. Call the smallest Controller API action that changes real resources.',
    '4. Report the result back to the Matrix room.',
    '',
  )

  return sections.join('\n')
}
