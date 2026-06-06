export interface ControllerApiFieldSchema {
  type: 'string' | 'string[]' | 'boolean' | 'number' | 'object' | 'object[]'
  required?: boolean
  enum?: string[]
  description: string
}

export interface ControllerApiOperationSchema {
  id: string
  skill: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  summary: string
  danger: 'read' | 'write' | 'destructive'
  approval: 'not_required' | 'recommended' | 'required'
  audit: string[]
  query?: Record<string, ControllerApiFieldSchema>
  body?: Record<string, ControllerApiFieldSchema>
}

export interface ControllerApiSchemaDocument {
  schema: 'agenthub.controller-api.v1alpha1'
  version: string
  auth: {
    type: 'manager-matrix-token'
    header: 'Authorization: Bearer <token>'
  }
  invariants: string[]
  operations: ControllerApiOperationSchema[]
}

export const CONTROLLER_WORKER_RUNTIME_BASES = ['openclaw', 'qwenpaw', 'copaw', 'opencode', 'claude-code', 'codex', 'gemini']

export const CONTROLLER_ROOM_KINDS = ['group', 'manager_dm', 'task', 'direct', 'human_intervention']

export const CONTROLLER_APPLY_MANIFEST_KINDS = ['Manager', 'Worker', 'Room', 'Task', 'Team', 'Human']

export function getControllerApiSchema(): ControllerApiSchemaDocument {
  return CONTROLLER_API_SCHEMA
}

const CONTROLLER_API_SCHEMA: ControllerApiSchemaDocument = {
  schema: 'agenthub.controller-api.v1alpha1',
  version: '2026-06-07',
  auth: {
    type: 'manager-matrix-token',
    header: 'Authorization: Bearer <token>',
  },
  invariants: [
    'Manager and skills must call /api/controller/* for resource changes.',
    'New collaboration state is written to Matrix Room timeline and Controller resources, not legacy messages.',
    'Worker creation requires an explicit runtime base and model binding.',
    'OpenClaw and QwenPaw are resident runtime bases; OpenCode, Claude Code, Codex, and Gemini are bridge bases until resident adapters exist.',
    'Dangerous or destructive actions must surface approval/audit metadata before productizing.',
  ],
  operations: [
    {
      id: 'workers.create',
      skill: 'worker-management',
      method: 'POST',
      path: '/api/controller/workers',
      summary: 'Create or reconcile a Worker member, Matrix identity, direct room, optional group room membership, and WorkerInstance.',
      danger: 'write',
      approval: 'recommended',
      audit: ['workspaceId', 'name', 'runtimeBase', 'modelId', 'groupSessionId'],
      body: {
        workspaceId: field('string', true, 'Workspace id.'),
        name: field('string', true, 'Worker display name.'),
        runtimeBase: field('string', true, 'Worker runtime base.', CONTROLLER_WORKER_RUNTIME_BASES),
        modelId: field('string', true, 'Explicit Worker model binding.'),
        role: field('string', false, 'Human-readable role.'),
        roleType: field('string', false, 'Workspace role type.'),
        skillIds: field('string[]', false, 'AgentHub skill ids.'),
        groupSessionId: field('string', false, 'Group session to join.'),
        joinGroupRoom: field('boolean', false, 'Whether to join the group room.'),
        createDirectSession: field('boolean', false, 'Whether to create a direct room.'),
        announce: field('boolean', false, 'Whether Manager announces the member in room timeline.'),
      },
    },
    {
      id: 'managers.reconcile',
      skill: 'heartbeat',
      method: 'POST',
      path: '/api/controller/reconcile',
      summary: 'Reconcile Manager identity and normalized SOUL/AGENTS/Skills/registry/state contract.',
      danger: 'write',
      approval: 'not_required',
      audit: ['kind', 'id', 'runtimeType'],
      body: {
        kind: field('string', true, 'Must be Manager.', ['Manager']),
        id: field('string', true, 'Manager id, usually global.'),
        workspaceId: field('string', false, 'Optional workspace id.'),
        payload: field('object', false, 'Optional runtimeType/controllerUrl/sharedStorageRoot/matrix settings and desiredState=running|stopped|observed.'),
      },
    },
    {
      id: 'tasks.assign',
      skill: 'task-management',
      method: 'POST',
      path: '/api/controller/tasks',
      summary: 'Assign a task through ControllerApi: Run, WorkspaceTask, TaskThread, task room, RuntimeLease, shared spec.md, and Matrix @mention.',
      danger: 'write',
      approval: 'not_required',
      audit: ['workspaceId', 'title', 'targetWorkerId', 'runId', 'groupSessionId'],
      body: {
        workspaceId: field('string', true, 'Workspace id.'),
        title: field('string', true, 'Task title.'),
        spec: field('string', false, 'Task specification; becomes shared task spec content.'),
        targetWorkerId: field('string', false, 'WorkspaceAgent id or name.'),
        assignToAgentId: field('string', false, 'WorkspaceAgent id alias.'),
        taskKey: field('string', false, 'Stable Manager task key for dependency graphs.'),
        dependsOn: field('string[]', false, 'Task keys this task depends on.'),
        runId: field('string', false, 'Existing Run id; omitted creates a Run.'),
        groupSessionId: field('string', false, 'Existing group session; omitted creates/reuses workspace group.'),
      },
    },
    {
      id: 'rooms.create',
      skill: 'channel-management',
      method: 'POST',
      path: '/api/controller/rooms',
      summary: 'Create a Matrix-backed Room resource.',
      danger: 'write',
      approval: 'not_required',
      audit: ['ownerId', 'workspaceId', 'kind', 'title'],
      body: {
        ownerId: field('string', true, 'Human owner id.'),
        title: field('string', true, 'Room title.'),
        kind: field('string', false, 'Room kind.', CONTROLLER_ROOM_KINDS),
        workspaceId: field('string', false, 'Workspace id.'),
      },
    },
    {
      id: 'rooms.append_event',
      skill: 'channel-management',
      method: 'POST',
      path: '/api/controller/rooms/{roomId}/events',
      summary: 'Append a Manager/System event to a Room timeline.',
      danger: 'write',
      approval: 'not_required',
      audit: ['roomId', 'senderType', 'type'],
      body: {
        body: field('string', true, 'Timeline message body.'),
        senderType: field('string', false, 'Timeline sender type.', ['manager', 'system', 'worker', 'human']),
        type: field('string', false, 'Timeline event type.'),
        metadata: field('object', false, 'Structured metadata.'),
      },
    },
    {
      id: 'rooms.mention_worker',
      skill: 'channel-management',
      method: 'POST',
      path: '/api/controller/rooms/{roomId}/mentions',
      summary: 'Send a Matrix @mention to a Worker participant in a Room.',
      danger: 'write',
      approval: 'not_required',
      audit: ['roomId', 'workspaceAgentId', 'type'],
      body: {
        workspaceAgentId: field('string', true, 'WorkspaceAgent id to mention.'),
        body: field('string', true, 'Mention message body.'),
        type: field('string', false, 'Timeline event type; defaults to task.assigned.'),
        senderType: field('string', false, 'Sender type; defaults to manager.'),
      },
    },
    {
      id: 'artifacts.register',
      skill: 'artifact-management',
      method: 'POST',
      path: '/api/controller/artifacts',
      summary: 'Register artifact resources and optionally link them to Room timeline context.',
      danger: 'write',
      approval: 'not_required',
      audit: ['workspaceId', 'runId', 'taskId', 'roomId'],
      body: {
        workspaceId: field('string', true, 'Workspace id.'),
        runId: field('string', true, 'Run id.'),
        taskId: field('string', true, 'Task id.'),
        artifacts: field('object[]', true, 'Artifact payloads.'),
        roomId: field('string', false, 'Room id for timeline linkage.'),
        taskThreadId: field('string', false, 'TaskThread id for linkage.'),
      },
    },
    {
      id: 'teams.create',
      skill: 'team-management',
      method: 'POST',
      path: '/api/controller/teams',
      summary: 'Create or reconcile a lightweight Team around an existing leader and existing Worker members.',
      danger: 'write',
      approval: 'recommended',
      audit: ['workspaceId', 'name', 'leaderName', 'workers'],
      body: {
        workspaceId: field('string', true, 'Workspace id.'),
        name: field('string', true, 'Team name.'),
        leaderName: field('string', false, 'Existing or created Team Leader display name.'),
        workers: field('string[]', false, 'Existing WorkspaceAgent ids or names to add to the team room.'),
        description: field('string', false, 'Team purpose.'),
      },
    },
    {
      id: 'humans.create',
      skill: 'human-management',
      method: 'POST',
      path: '/api/controller/humans',
      summary: 'Create or reconcile a Human participant identity.',
      danger: 'write',
      approval: 'recommended',
      audit: ['name', 'displayName', 'permissionLevel'],
      body: {
        name: field('string', true, 'Human stable name.'),
        displayName: field('string', true, 'Human display name.'),
        email: field('string', false, 'Optional human email.'),
        permissionLevel: field('number', false, 'HiClaw-style permission level.'),
      },
    },
    {
      id: 'reconcile.resource',
      skill: 'task-coordination',
      method: 'POST',
      path: '/api/controller/reconcile',
      summary: 'Reconcile a Controller resource now or enqueue it.',
      danger: 'write',
      approval: 'not_required',
      audit: ['kind', 'id', 'workspaceId', 'reason', 'enqueue'],
      body: {
        kind: field('string', true, 'Controller resource kind.', ['Manager', 'Worker', 'Team', 'Human', 'Room', 'Run', 'Task', 'TaskThread', 'RuntimeLease', 'Artifact']),
        id: field('string', true, 'Resource id.'),
        workspaceId: field('string', false, 'Workspace id.'),
        reason: field('string', false, 'Reason for reconciliation.'),
        enqueue: field('boolean', false, 'If true, enqueue instead of immediate reconcile.'),
        payload: field('object', false, 'Optional reconcile payload.'),
      },
    },
    {
      id: 'apply.manifest',
      skill: 'project-management',
      method: 'POST',
      path: '/api/controller/apply',
      summary: 'Apply JSON/YAML Controller manifests. Supported kinds: Manager, Worker, Room, Task, Team, Human.',
      danger: 'write',
      approval: 'recommended',
      audit: ['kind', 'metadata.name', 'spec.workspaceId'],
      body: {
        yaml: field('string', false, `YAML manifest text. Supported kinds: ${CONTROLLER_APPLY_MANIFEST_KINDS.join(', ')}.`),
        json: field('string', false, `JSON manifest text. Supported kinds: ${CONTROLLER_APPLY_MANIFEST_KINDS.join(', ')}.`),
        resource: field('object', false, `Single manifest object. Supported kinds: ${CONTROLLER_APPLY_MANIFEST_KINDS.join(', ')}. Manager spec may include desiredState=running|stopped|observed.`),
        resources: field('object[]', false, `Manifest object list. Supported kinds: ${CONTROLLER_APPLY_MANIFEST_KINDS.join(', ')}.`),
      },
    },
    {
      id: 'audit.list',
      skill: 'heartbeat',
      method: 'GET',
      path: '/api/controller/audit-events',
      summary: 'List recent Controller audit events for Manager patrol, recovery, and room-visible explanations.',
      danger: 'read',
      approval: 'not_required',
      audit: ['workspaceId', 'operationId', 'limit'],
      query: {
        workspaceId: field('string', false, 'Optional workspace id filter.'),
        operationId: field('string', false, 'Optional Controller operation id filter, for example workers.create.'),
        limit: field('number', false, 'Maximum rows to return, capped at 200.'),
      },
    },
    {
      id: 'status.platform',
      skill: 'heartbeat',
      method: 'GET',
      path: '/api/controller/status',
      summary: 'Read Controller platform status.',
      danger: 'read',
      approval: 'not_required',
      audit: [],
    },
    {
      id: 'state.workspace',
      skill: 'memory-management',
      method: 'GET',
      path: '/api/controller/workspace-state',
      summary: 'Read workspace state snapshot for Manager registry/state sync.',
      danger: 'read',
      approval: 'not_required',
      audit: ['workspaceId'],
      query: {
        workspaceId: field('string', true, 'Workspace id.'),
      },
    },
    {
      id: 'heartbeat.manager',
      skill: 'heartbeat',
      method: 'POST',
      path: '/api/controller/heartbeat',
      summary: 'Send Manager heartbeat to Controller.',
      danger: 'write',
      approval: 'not_required',
      audit: ['workspaceId'],
      body: {
        workspaceId: field('string', false, 'Workspace id.'),
      },
    },
  ],
}

function field(
  type: ControllerApiFieldSchema['type'],
  required: boolean,
  description: string,
  values?: string[],
): ControllerApiFieldSchema {
  return values ? { type, required, description, enum: values } : { type, required, description }
}
