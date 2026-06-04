import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentHubUserDataRoot } from '../system-paths'
import type { ManagerTool, SkillDefinition } from './types'

// ─── Skill Loader ────────────────────────────────────────────────────
// Aligned with HiClaw's skill loading pattern:
// - Each skill lives in skills/<name>/SKILL.md
// - SKILL.md has YAML frontmatter + structured sections
// - Skills are loaded lazily and presented as tools to the LLM

/**
 * Load all skills from the manager's skills directory.
 * Returns parsed SkillDefinition objects with extracted tools.
 */
export function loadManagerSkills(workspaceId?: string | null): SkillDefinition[] {
  const skillsDir = getSkillsDir(workspaceId)
  ensureBuiltinSkills(skillsDir)
  const skills: SkillDefinition[] = []
  const entries = readdirSync(skillsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillPath = join(skillsDir, entry.name, 'SKILL.md')
    if (!existsSync(skillPath)) continue
    const raw = readFileSync(skillPath, 'utf8')
    const parsed = parseSkillMd(raw, entry.name)
    if (parsed) skills.push(parsed)
  }
  return skills
}

/**
 * Extract all tools from loaded skills.
 */
export function loadManagerTools(workspaceId?: string | null): ManagerTool[] {
  const skills = loadManagerSkills(workspaceId)
  return skills.flatMap((skill) => skill.tools)
}

/**
 * Build the tools section for the LLM prompt.
 * Formats each skill's tools as a callable function description.
 */
export function buildToolsPrompt(workspaceId?: string | null): string {
  const skills = loadManagerSkills(workspaceId)
  if (!skills.length) return 'No skills available.'
  const lines: string[] = ['## Available Skills and Tools', '']
  for (const skill of skills) {
    lines.push(`### Skill: ${skill.name}`)
    lines.push(`Description: ${skill.description}`)
    if (skill.purpose) lines.push(`Purpose: ${skill.purpose}`)
    if (skill.rules.length) {
      lines.push('Rules:')
      for (const rule of skill.rules) lines.push(`- ${rule}`)
    }
    if (skill.tools.length) {
      lines.push('Tools:')
      for (const tool of skill.tools) {
        const params = tool.parameters
          .map(
            (p) =>
              `${p.name}: ${p.type}${p.required ? ' (required)' : ''}${p.enum ? ` [${p.enum.join('|')}]` : ''} — ${p.description}`,
          )
          .join('; ')
        lines.push(`  - ${tool.name}: ${tool.description}`)
        if (params) lines.push(`    Parameters: ${params}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ─── Internal ────────────────────────────────────────────────────────

function getSkillsDir(workspaceId?: string | null): string {
  return join(agentHubUserDataRoot(), 'manager', workspaceId || 'global', 'skills')
}

function ensureBuiltinSkills(skillsDir: string) {
  mkdirSync(skillsDir, { recursive: true })
  for (const skill of BUILTIN_SKILLS) {
    const dir = join(skillsDir, skill.name)
    mkdirSync(dir, { recursive: true })
    const skillPath = join(dir, 'SKILL.md')
    if (!existsSync(skillPath)) {
      writeFileSync(skillPath, skill.body, 'utf8')
    }
  }
}

function parseSkillMd(raw: string, fallbackName: string): SkillDefinition | null {
  const lines = raw.split('\n')
  let name = fallbackName
  let description = ''
  // Parse YAML frontmatter
  if (lines[0]?.trim() === '---') {
    let endIdx = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        endIdx = i
        break
      }
    }
    if (endIdx > 0) {
      for (let i = 1; i < endIdx; i++) {
        const line = lines[i]!
        const nameMatch = line.match(/^name:\s*(.+)$/)
        if (nameMatch) name = nameMatch[1]!.trim()
        const descMatch = line.match(/^description:\s*(.+)$/)
        if (descMatch) description = descMatch[1]!.trim()
      }
      lines.splice(0, endIdx + 1)
    }
  }
  const body = lines.join('\n').trim()
  if (!description) {
    const descMatch = body.match(/## Purpose\s*\n(.+?)(?:\n\n|\n##)/s)
    if (descMatch) description = descMatch[1]!.trim()
  }
  const purpose = extractSection(body, 'Purpose')
  const controllerApi = extractListSection(body, 'Controller API Surface')
  const rules = extractListSection(body, 'Rules')
  const decisionPattern = extractSection(body, 'Decision Pattern')
  const tools = extractToolsFromApi(controllerApi, name)
  return {
    name,
    description: description || purpose || name,
    purpose: purpose || description || '',
    controllerApi,
    rules,
    decisionPattern,
    tools,
    raw,
  }
}

function extractSection(body: string, heading: string): string {
  const regex = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`)
  const match = body.match(regex)
  return match?.[1]?.trim() ?? ''
}

function extractListSection(body: string, heading: string): string[] {
  const section = extractSection(body, heading)
  if (!section) return []
  return section
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

function extractToolsFromApi(controllerApi: string[], skillName: string): ManagerTool[] {
  const tools: ManagerTool[] = []
  for (const api of controllerApi) {
    const match = api.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/)
    if (!match) continue
    const method = match[1]!
    const path = match[2]!
    const toolName = apiPathToToolName(method, path)
    const description = `${method} ${path}`
    const parameters = extractParamsFromPath(path)
    tools.push({ name: toolName, description, parameters, skillName })
  }
  return tools
}

function apiPathToToolName(method: string, path: string): string {
  const parts = path
    .replace(/\/api\/controller\//, '')
    .replace(/\{(\w+)\}/g, '')
    .split('/')
    .filter(Boolean)
  const resource = parts.join('.')
  const actionMap: Record<string, string> = {
    GET: 'list',
    POST: 'create',
    PUT: 'update',
    DELETE: 'delete',
    PATCH: 'patch',
  }
  const action = actionMap[method] ?? method.toLowerCase()
  return `controller.${resource}.${action}`
}

function extractParamsFromPath(
  path: string,
): Array<{ name: string; type: 'string'; description: string; required: boolean }> {
  const params: Array<{ name: string; type: 'string'; description: string; required: boolean }> = []
  for (const match of path.matchAll(/\{(\w+)\}/g)) {
    params.push({
      name: match[1]!,
      type: 'string',
      description: `The ${match[1]} path parameter`,
      required: true,
    })
  }
  return params
}

// ─── Builtin Skills (aligned with HiClaw's 16 Manager skills) ────────

const BUILTIN_SKILLS = [
  {
    name: 'worker-management',
    body: `---
name: worker-management
description: Use when you need to create, inspect, wake, sleep, stop, or update Worker participants. Also use for managing Worker skills and capabilities.
---

## Purpose

Manage the lifecycle of Worker agents in the workspace. Workers are the execution units that handle concrete tasks assigned by the Manager.

## Controller API Surface

- POST /api/controller/workers
- GET /api/controller/workers
- POST /api/controller/workers/{workerId}/wake
- POST /api/controller/workers/{workerId}/sleep
- POST /api/controller/workers/{workerId}/stop

## Rules

- Prefer existing suitable workers before proposing a new one.
- New worker creation must be visible in the room and user-confirmed unless the room policy explicitly allows autonomous staffing.
- Every worker must have a Matrix identity, a runtime base, a model binding, skill scope, and shared-storage access scope.
- Worker names must be lowercase alphanumeric with hyphens.

## Decision Pattern

1. Read the room timeline to understand what worker capability is needed.
2. Check existing workers for suitability.
3. If a suitable worker exists, use it. If not, propose creating one.
4. Report the decision back to the room.
`,
  },
  {
    name: 'task-management',
    body: `---
name: task-management
description: Use when you need to create runs, assign tasks to workers, reconcile task lifecycle, or manage task completion. This is the primary skill for turning user goals into executable work.
---

## Purpose

Turn user goals into visible task room assignments and reconcile task lifecycle through the run controller.

## Controller API Surface

- POST /api/controller/runs
- POST /api/controller/runs/{runId}/tasks
- POST /api/controller/tasks/{taskId}/assign
- POST /api/controller/tasks/{taskId}/reconcile
- POST /api/controller/tasks/{taskId}/complete

## Rules

- Do not force ordinary conversation into a task.
- When work is needed, assign through a Matrix task room and include shared/tasks/{taskId}/spec.md, meta.json, plan.md, and result.md refs.
- Clarification requests happen in the same Matrix room, not through hidden tables.
- Use taskKey and dependsOn for dependency graphs.

## Decision Pattern

1. Analyze the user goal to determine if task execution is needed.
2. If yes, create a run and break the goal into tasks.
3. Assign tasks to appropriate workers based on capabilities.
4. Monitor progress through room timeline events.
5. Synthesize results when all tasks complete.
`,
  },
  {
    name: 'channel-management',
    body: `---
name: channel-management
description: Use when you need to create Matrix rooms, manage room participants, send mentions, or control room visibility and access policy.
---

## Purpose

Create and maintain Matrix rooms, participants, mentions, and visibility policy. Matrix rooms are the collaboration spaces where all agent communication happens.

## Controller API Surface

- POST /api/controller/rooms
- POST /api/controller/rooms/{roomId}/participants
- POST /api/controller/rooms/{roomId}/events
- POST /api/controller/rooms/{roomId}/mentions

## Rules

- Matrix room timeline is the collaboration source of truth.
- Human, Manager, and Worker participants should be visible and auditable.
- Use @mentions for directed work and status requests.
- Every room must have a clear purpose (group, task, direct message).

## Decision Pattern

1. Determine if a new room is needed or an existing one suffices.
2. Create rooms with appropriate participants.
3. Use @mentions to direct work to specific workers.
4. Ensure all communication is visible in the room timeline.
`,
  },
  {
    name: 'file-sync-management',
    body: `---
name: file-sync-management
description: Use when you need to manage shared task contracts, register artifacts, or handle file references through the ArtifactStore and SharedStorage.
---

## Purpose

Manage shared task contracts and artifact references through S3-compatible storage. Workers publish their outputs here; downstream workers and the Manager read from here.

## Controller API Surface

- POST /api/controller/shared-objects
- GET /api/controller/shared-objects/{objectKey}
- POST /api/controller/artifacts

## Rules

- Shared storage refs are canonical; local files are mirrors.
- Workers must publish final result.md and artifacts under shared/tasks/{taskId}/.
- Never ask downstream workers to guess relative paths that were not published as object refs.
- Artifacts must be registered with SHA-256 checksums for deduplication.

## Decision Pattern

1. When a worker completes, ensure its outputs are registered as artifacts.
2. When assigning downstream tasks, include upstream artifact refs.
3. When reviewing results, read from ArtifactStore, not local paths.
`,
  },
  {
    name: 'human-management',
    body: `---
name: human-management
description: Use when you need to handle human-in-the-loop interactions: asking for clarification, requesting approval, processing human decisions, or summarizing human interventions.
---

## Purpose

Treat human users as first-class collaborators who can observe, interrupt, clarify, approve, or take over task execution.

## Controller API Surface

- POST /api/controller/humans
- POST /api/controller/approvals
- POST /api/controller/interventions

## Rules

- Human-in-the-loop happens in Matrix rooms.
- Ask for approval before staffing changes or dangerous actions unless policy says otherwise.
- Human messages in task rooms are authoritative context for the assigned worker.
- Clarification requests must be specific and actionable.

## Decision Pattern

1. Identify when human input is needed (missing info, approval gate, risk assessment).
2. Formulate a clear question or proposal in the room.
3. Wait for human response.
4. Incorporate the human's decision into the workflow.
`,
  },
  {
    name: 'project-management',
    body: `---
name: project-management
description: Use when managing multi-worker projects with plans, milestones, phases, and cross-worker coordination. Use for complex goals that need structured decomposition.
---

## Purpose

Manage multi-worker projects with DAG plans, milestone tracking, and cross-worker coordination.

## Controller API Surface

- POST /api/controller/projects
- GET /api/controller/projects/{projectId}
- POST /api/controller/projects/{projectId}/milestones

## Rules

- Projects decompose into phases with clear deliverables.
- Each phase has one or more tasks assigned to specific workers.
- Dependencies between tasks form a DAG that controls execution order.
- Progress is tracked through room timeline events, not hidden state.

## Decision Pattern

1. Analyze the project goal for natural decomposition into phases.
2. Create a plan with phases, tasks, and dependencies.
3. Assign tasks to workers respecting the dependency graph.
4. Track progress and adjust the plan as needed.
5. Synthesize results at project completion.
`,
  },
  {
    name: 'model-switch',
    body: `---
name: model-switch
description: Use when the Manager needs to switch its own LLM model or when a worker's model needs to be changed at runtime.
---

## Purpose

Switch LLM models for the Manager or Workers at runtime without restarting.

## Controller API Surface

- POST /api/controller/model-switch

## Rules

- Model switch should be transparent and logged in the room.
- Verify the target model is available and configured before switching.
- Preserve conversation context across model switches.

## Decision Pattern

1. Identify the need for a model switch (capability, performance, cost).
2. Verify target model availability.
3. Execute the switch and confirm in the room.
`,
  },
  {
    name: 'task-coordination',
    body: `---
name: task-coordination
description: Use when multiple workers need to coordinate on shared files or when preventing file conflicts during parallel execution.
---

## Purpose

Coordinate concurrent file access between workers using lock files and coordination protocols.

## Controller API Surface

- POST /api/controller/coordination/locks
- GET /api/controller/coordination/locks/{lockKey}
- DELETE /api/controller/coordination/locks/{lockKey}

## Rules

- Always check for existing locks before modifying shared files.
- Lock files auto-expire to prevent deadlocks.
- Use the coordination protocol for any file that multiple workers might touch.

## Decision Pattern

1. Before modifying shared resources, acquire a coordination lock.
2. Perform the modification.
3. Release the lock.
4. If a lock is held, wait or escalate to the Manager.
`,
  },
  {
    name: 'team-management',
    body: `---
name: team-management
description: Use when creating or managing teams of workers with a designated team leader for internal coordination.
---

## Purpose

Create and manage teams consisting of a Team Leader and multiple Workers, with delegated internal coordination.

## Controller API Surface

- POST /api/controller/teams
- GET /api/controller/teams/{teamId}
- POST /api/controller/teams/{teamId}/members

## Rules

- Teams have a designated Leader who coordinates internally.
- Manager communicates with the Team Leader, not directly with team Workers.
- Team Workers can communicate with each other in the team room.

## Decision Pattern

1. Determine if a task warrants a team rather than individual workers.
2. Create the team with an appropriate Leader and Workers.
3. Assign the high-level goal to the Team Leader.
4. Monitor progress through the team room timeline.
`,
  },
  {
    name: 'human-intervention',
    body: `---
name: human-intervention
description: Use when a human sends a message during an active run that needs to be processed as an intervention, constraint update, or direction change.
---

## Purpose

Process human interventions during active task execution, including constraint updates, direction changes, and mid-stream corrections.

## Controller API Surface

- POST /api/controller/interventions

## Rules

- Human messages during active runs are interventions, not ignored.
- Interventions must be propagated to affected workers.
- Active workers must be interrupted and re-briefed with new constraints.
- The intervention and its effects must be visible in the room timeline.

## Decision Pattern

1. Detect a human message during an active run.
2. Classify it as a constraint update, direction change, or approval.
3. Interrupt affected workers if needed.
4. Propagate the new constraints to workers.
5. Resume execution with updated context.
`,
  },
  {
    name: 'review-and-synthesis',
    body: `---
name: review-and-synthesis
description: Use when all tasks in a run have completed and you need to review results, synthesize a final report, or perform quality assessment.
---

## Purpose

Review completed task results and synthesize a final report for the user.

## Controller API Surface

- POST /api/controller/runs/{runId}/review
- GET /api/controller/runs/{runId}/artifacts

## Rules

- Review must be based on actual artifacts and task room timeline, not just status codes.
- Synthesis must attribute contributions to specific workers.
- Quality issues must be flagged with specific evidence.
- The final report goes to the group room timeline.

## Decision Pattern

1. Collect all task results from the ArtifactStore.
2. Read each task room timeline for execution details.
3. Assess quality against task contracts.
4. Synthesize a coherent final report.
5. Post the report to the group room.
`,
  },
  {
    name: 'error-recovery',
    body: `---
name: error-recovery
description: Use when a task has failed and you need to decide on recovery strategy: retry, reassign, replan, or escalate to human.
---

## Purpose

Handle task failures with appropriate recovery strategies.

## Controller API Surface

- POST /api/controller/tasks/{taskId}/retry
- POST /api/controller/tasks/{taskId}/reassign
- POST /api/controller/runs/{runId}/replan

## Rules

- Retry with the same worker only if the failure was transient.
- Reassign to a different worker if the failure was capability-related.
- Replan if the failure reveals a fundamental issue with the approach.
- Escalate to human if automated recovery is unlikely to succeed.

## Decision Pattern

1. Analyze the failure reason from the task room timeline.
2. Classify: transient, capability, approach, or unknown.
3. Select recovery strategy based on classification.
4. Execute recovery and report in the room.
`,
  },
  {
    name: 'capacity-management',
    body: `---
name: capacity-management
description: Use when assessing worker capacity, suggesting new workers, or managing idle/busy worker states for optimal resource utilization.
---

## Purpose

Assess and manage worker capacity to ensure optimal resource utilization.

## Controller API Surface

- GET /api/controller/workers
- POST /api/controller/workers/{workerId}/sleep
- POST /api/controller/workers/{workerId}/wake

## Rules

- Idle workers should be put to sleep to save resources.
- Busy workers should not be overloaded.
- Capacity assessment should consider both current load and task queue.

## Decision Pattern

1. Assess current worker states (idle, busy, sleeping).
2. Compare against pending task queue.
3. Suggest capacity adjustments (wake sleeping workers, create new ones).
4. Report capacity status to the room.
`,
  },
  {
    name: 'artifact-management',
    body: `---
name: artifact-management
description: Use when registering, reading, or managing task artifacts and shared task contracts (spec.md, plan.md, result.md).
---

## Purpose

Manage the lifecycle of task artifacts: registration, retrieval, and contract enforcement.

## Controller API Surface

- POST /api/controller/artifacts
- GET /api/controller/artifacts/{artifactId}
- GET /api/controller/shared-tasks/{taskId}/result

## Rules

- Every task must have a spec.md before execution begins.
- Workers must write result.md upon completion.
- Artifacts are the authoritative output, not chat messages.
- Artifact references must use object keys, not local file paths.

## Decision Pattern

1. Before task execution: verify spec.md exists.
2. During execution: register partial artifacts.
3. After execution: verify result.md and final artifacts.
4. For review: read artifacts from ArtifactStore.
`,
  },
  {
    name: 'heartbeat',
    body: `---
name: heartbeat
description: Use for periodic self-check: review active tasks, check worker health, assess capacity, and report status to the room.
---

## Purpose

Periodic autonomous check of system health, task progress, and worker status.

## Controller API Surface

- GET /api/controller/runs/active
- GET /api/controller/workers
- GET /api/controller/tasks/active

## Rules

- Heartbeat checks should be lightweight and fast.
- Only report issues that need attention; don't spam the room.
- Auto-stop idle workers that exceed the timeout.
- Ensure active tasks have healthy workers.

## Decision Pattern

1. Read active runs and their task states.
2. Check worker health (heartbeat staleness).
3. Assess capacity and idle workers.
4. Auto-stop idle workers if timeout exceeded.
5. Report only issues needing attention; otherwise stay silent.
`,
  },
  {
    name: 'memory-management',
    body: `---
name: memory-management
description: Use when recording important decisions, learning from task outcomes, or maintaining long-term context across sessions.
---

## Purpose

Maintain persistent memory across sessions: daily logs, long-term insights, and decision records.

## Controller API Surface

- POST /api/controller/memory/entries
- GET /api/controller/memory/entries

## Rules

- Memory entries are for non-obvious facts and decisions, not raw logs.
- Daily logs capture what happened; long-term memory captures what was learned.
- Memory is consulted before making decisions to avoid repeating mistakes.

## Decision Pattern

1. After significant events, record a memory entry.
2. Before major decisions, consult relevant memory entries.
3. Periodically curate daily logs into long-term insights.
`,
  },
]
