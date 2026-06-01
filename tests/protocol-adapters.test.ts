import { describe, expect, test } from 'bun:test'
import {
  buildA2ATaskFromWorkspaceTask,
  buildWorkspaceAgentCard,
  toA2ATaskState,
} from '../apps/server/src/services/protocols/a2a-adapter'
import {
  A2A_AGENTHUB_METADATA_KEY,
  buildA2ADispatchEnvelope,
  buildA2AExecutionTask,
} from '../apps/server/src/services/protocols/a2a-internal'
import {
  buildAgUiEventsFromRunEvent,
  buildAgUiRunStartedEvent,
  buildAgUiTaskStatusEvent,
} from '../apps/server/src/services/protocols/ag-ui-adapter'
import { buildMcpManifest } from '../apps/server/src/services/protocols/mcp-adapter'

describe('protocol adapters', () => {
  const workspace = { id: 'ws-1', name: 'Demo Workspace', goal: 'Build a site' }
  const agent = {
    id: 'agent-1',
    name: 'Researcher',
    role: 'Researcher',
    roleType: 'researcher',
    description: 'Find reliable material',
    runtimeType: 'code-agent',
    codeAgentType: 'opencode',
    capabilityTags: ['research', 'web'],
    toolPermissions: ['chat'],
    sandboxPolicy: 'read-only',
  }

  test('builds an A2A agent card from workspace agents', () => {
    const card = buildWorkspaceAgentCard({
      agent,
      agents: [agent],
      baseUrl: 'http://localhost:8000',
      workspace,
    })

    expect(card.name).toBe('Researcher')
    expect(card.url).toContain('/api/protocols/a2a/workspaces/ws-1/agents/agent-1')
    expect(card.skills[0]?.id).toBe('agent-1')
    expect(card.skills[0]?.tags).toContain('researcher')
  })

  test('maps AgentHub task states to A2A task states', () => {
    expect(toA2ATaskState('pending')).toBe('submitted')
    expect(toA2ATaskState('running')).toBe('working')
    expect(toA2ATaskState('done')).toBe('completed')
    expect(toA2ATaskState('blocked')).toBe('input-required')
    expect(toA2ATaskState('skipped')).toBe('rejected')
  })

  test('builds A2A tasks with artifacts and AG-UI events', () => {
    const task = buildA2ATaskFromWorkspaceTask({
      contextId: 'ws-1',
      task: {
        id: 'task-1',
        title: 'Research the site',
        status: 'running',
        agentId: 'agent-1',
        progressPercent: 42,
        progressStatus: 'Searching references',
        artifacts: [{ id: 'artifact-1', kind: 'file', path: 'notes.md', title: 'notes.md' }],
      },
    })

    expect(task.kind).toBe('task')
    expect(task.status.state).toBe('working')
    expect(task.artifacts?.[0]?.artifactId).toBe('artifact-1')

    const event = buildAgUiTaskStatusEvent({
      agentName: 'Researcher',
      artifactCount: 1,
      progressPercent: 42,
      progressStatus: 'Searching references',
      status: 'running',
      taskId: 'task-1',
      taskTitle: 'Research the site',
    })

    expect(event.name).toBe('agenthub.task.status')
    expect(event.runId).toBeUndefined()
    expect(event.threadId).toBeUndefined()
    expect(event.value).toMatchObject({ status: 'running', taskId: 'task-1' })

    const runStarted = buildAgUiRunStartedEvent({
      runId: 'run-1',
      threadId: 'thread-1',
    })
    expect(runStarted.type).toBe('RUN_STARTED')
  })

  test('uses A2A message/send as the internal agent dispatch envelope', () => {
    const dispatch = buildA2ADispatchEnvelope({
      agent: {
        id: 'agent-1',
        key: 'researcher',
        name: 'Researcher',
        role: 'Researcher',
        roleType: 'researcher',
        runtimeType: 'llm',
        capabilityTags: [],
        toolPermissions: [],
        sandboxPolicy: 'read-only',
      },
      childSessionId: 'child-1',
      groupSessionId: 'group-1',
      plan: {
        runId: 'run-1',
        title: 'Research',
        goal: 'Find facts',
        agents: [
          {
            id: 'orch-1',
            key: 'orchestrator',
            name: 'Orchestrator',
            role: 'Coordinator',
            roleType: 'orchestrator',
            runtimeType: 'llm',
            capabilityTags: [],
            toolPermissions: [],
            sandboxPolicy: 'read-only',
          },
        ],
        tasks: [],
      },
      prompt: 'Please research current AI coding tools.',
      task: {
        id: 'task-1',
        title: 'Research current tools',
        description: 'Collect facts',
        agentId: 'agent-1',
        dependencies: ['task-0'],
        taskType: 'research',
      },
      userMessageId: 'msg-1',
      workspaceId: 'ws-1',
    })

    expect(dispatch.method).toBe('message/send')
    expect(dispatch.params.message.kind).toBe('message')
    expect(dispatch.params.message.taskId).toBe('task-1')
    expect(dispatch.params.message.referenceTaskIds).toEqual(['task-0'])
    expect(dispatch.params.message.metadata?.[A2A_AGENTHUB_METADATA_KEY]).toMatchObject({
      runId: 'run-1',
      toAgentName: 'Researcher',
    })

    const task = buildA2AExecutionTask({
      envelope: dispatch,
      status: 'done',
      output: 'Done',
      artifacts: [{ id: 'artifact-1', path: 'report.md', title: 'report.md' }],
    })

    expect(task.id).toBe('task-1')
    expect(task.status.state).toBe('completed')
    expect(task.history?.[0]?.messageId).toBe('msg-1')
    expect(task.artifacts?.[0]?.artifactId).toBe('artifact-1')
  })

  test('converts persisted run events into AG-UI events', () => {
    const events = buildAgUiEventsFromRunEvent({
      agentId: 'agent-1',
      groupSessionId: 'thread-1',
      payload: { agentName: 'Researcher', taskTitle: 'Research the site' },
      runId: 'run-1',
      taskId: 'task-1',
      type: 'task.started',
    })

    expect(events.map((event) => event.type)).toEqual(['STEP_STARTED', 'CUSTOM'])
    expect(events[1]).toMatchObject({
      name: 'agenthub.task.status',
      runId: 'run-1',
      threadId: 'thread-1',
      value: { status: 'running', taskId: 'task-1', runId: 'run-1', threadId: 'thread-1' },
    })

    const blackboardEvents = buildAgUiEventsFromRunEvent({
      groupSessionId: 'thread-1',
      payload: {
        agentName: 'Researcher',
        key: 'task_task-1_output',
        summary: 'Found good references',
        taskTitle: 'Research the site',
      },
      runId: 'run-1',
      taskId: 'task-1',
      type: 'blackboard.written',
    })
    expect(blackboardEvents[0]).toMatchObject({
      name: 'agenthub.blackboard.written',
      runId: 'run-1',
      threadId: 'thread-1',
    })

    const synthesizingEvents = buildAgUiEventsFromRunEvent({
      groupSessionId: 'thread-1',
      payload: { artifactCount: 2, summary: 'joining results' },
      runId: 'run-1',
      type: 'run.synthesizing',
    })
    expect(synthesizingEvents[0]).toMatchObject({
      name: 'agenthub.run.status',
      value: { status: 'synthesizing', artifactCount: 2 },
    })

    const memberProposalEvents = buildAgUiEventsFromRunEvent({
      groupSessionId: 'thread-1',
      payload: {
        goal: 'Build the report',
        messageId: 'proposal-message-1',
        status: 'completed',
        taskIds: ['task-1'],
      },
      runId: 'run-1',
      type: 'member_proposal.continued',
    })
    expect(memberProposalEvents[0]).toMatchObject({
      name: 'agenthub.member_proposal.continue',
      runId: 'run-1',
      threadId: 'thread-1',
      value: {
        messageId: 'proposal-message-1',
        status: 'completed',
        taskIds: ['task-1'],
      },
    })
  })

  test('publishes a conservative MCP manifest', () => {
    const manifest = buildMcpManifest()
    expect(manifest.status).toBe('adapter-ready')
    expect(manifest.plannedTools.map((tool) => tool.name)).toContain('agenthub.workspace.inspect')
  })
})
