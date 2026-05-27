import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: { request: (input: string, init?: RequestInit) => Promise<Response> }
let dbApi: typeof import('../packages/db/src/index')
let originalFetch: typeof fetch

beforeAll(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agenthub-smoke-'))
  process.env.DATABASE_URL = join(tempDir, 'agenthub-smoke.db')
  process.env.LLM_API_KEY = ''
  process.env.OPENAI_API_KEY = ''
  process.env.ANTHROPIC_API_KEY = ''
  process.env.ENABLE_LOCAL_CLI_PROBES = 'false'
  process.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'

  dbApi = await import('../packages/db/src/index')
  migrate(dbApi.db, { migrationsFolder: resolve('packages/db/drizzle') })
  await dbApi.db.insert(dbApi.users).values({
    id: 'default-user',
    email: 'local@agenthub.local',
    username: 'You',
    passwordHash: 'test-only',
  })

  ;({ app } = await import('../apps/server/src/app'))
  originalFetch = globalThis.fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

async function json<T>(response: Response): Promise<T> {
  expect(response.ok).toBe(true)
  return response.json() as Promise<T>
}

function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function waitForTaskStatus(workspaceId: string, taskId: string, status: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const full = await json<{ tasks: Array<{ id: string; status: string }> }>(await app.request(`/api/workspaces/${workspaceId}`))
    const task = full.tasks.find((item) => item.id === taskId)
    if (task?.status === status) return task
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Task ${taskId} did not reach ${status}`)
}

describe('AgentHub smoke tests', () => {
  test('health endpoint responds', async () => {
    const body = await json<{ status: string; version: string }>(await app.request('/health'))
    expect(body.status).toBe('ok')
    expect(body.version).toBe('0.1.0')
  })

  test('session and message APIs persist a skipped-reply message', async () => {
    const session = await json<{ id: string; title: string }>(
      await postJson('/api/sessions', { title: 'Smoke chat', type: 'direct' })
    )
    const message = await json<{ id: string; content: string }>(
      await postJson(`/api/messages/${session.id}`, {
        content: 'hello smoke',
        type: 'text',
        metadata: { skipAgentReply: true },
      })
    )
    const list = await json<{ items: Array<{ id: string; content: string }> }>(
      await app.request(`/api/messages/${session.id}`)
    )

    expect(message.content).toBe('hello smoke')
    expect(list.items.map((item) => item.id)).toContain(message.id)
  })

  test('settings model test can be mocked without real credentials', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === 'https://mock.local/v1/chat/completions') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
        expect(body.model).toBe('mock-model')
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 })
      }
      return originalFetch(input, init)
    }

    const result = await json<{ ok: boolean; status?: number }>(
      await postJson('/api/settings/test-model', {
        provider: 'openai',
        apiEndpoint: 'https://mock.local/v1',
        apiKey: 'sk-test-12345678',
        modelId: 'mock-model',
      })
    )

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  test('workspace task dispatch creates a session and marks failed when no LLM key is configured', async () => {
    const full = await json<{ workspace: { id: string }; agents: Array<{ id: string }>; tasks: Array<{ id: string }> }>(
      await postJson('/api/workspaces', { name: 'Smoke workspace', goal: 'Verify dispatch', template: 'classic' })
    )
    const agentId = full.agents[0]?.id
    expect(agentId).toBeTruthy()

    const task = await json<{ id: string }>(
      await postJson(`/api/workspaces/${full.workspace.id}/tasks`, {
        title: 'Smoke task',
        description: 'This should fail gracefully without credentials.',
        agentId,
      })
    )
    const dispatched = await json<{ task: { status: string; sessionId: string | null }; sessionId: string }>(
      await postJson(`/api/workspaces/${full.workspace.id}/tasks/${task.id}/dispatch`, {})
    )

    expect(dispatched.sessionId).toBeTruthy()
    expect(dispatched.task.status).toBe('running')
    await waitForTaskStatus(full.workspace.id, task.id, 'failed')
  })

  test('artifact demo endpoint persists inline preview metadata', async () => {
    const session = await json<{ id: string }>(
      await postJson('/api/sessions', { title: 'Artifact chat', type: 'direct' })
    )
    const message = await json<{ metadata: { artifacts?: Array<{ kind: string }> } }>(
      await postJson(`/api/messages/${session.id}/artifact-demo`, {
        content: '生成网页预览、diff 并部署',
      })
    )

    expect(message.metadata.artifacts?.map((artifact) => artifact.kind)).toContain('web_preview')
    expect(message.metadata.artifacts?.map((artifact) => artifact.kind)).toContain('diff')
    expect(message.metadata.artifacts?.map((artifact) => artifact.kind)).toContain('deploy')
  })

  test('agent adapter catalog reports main code agent platforms', async () => {
    const catalog = await json<{ items: Array<{ id: string; command: string; installed: boolean; configured: boolean; executionEnabled: boolean }> }>(
      await app.request('/api/coding-tools/agent-adapters')
    )

    expect(catalog.items.map((item) => item.id)).toContain('codex')
    expect(catalog.items.map((item) => item.id)).toContain('claude-code')
    expect(catalog.items.map((item) => item.id)).toContain('opencode')
    expect(catalog.items.find((item) => item.id === 'codex')?.command).toBe('codex')
  })

  test('agent draft can be confirmed into a workspace agent', async () => {
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', { name: 'Agent draft workspace', goal: 'Create agents', template: 'classic' })
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {})
    )
    const draftCard = await json<{ id: string; metadata: { agentDraft?: { name: string; runtimeType: string; codeAgentType?: string | null; toolPermissions: string[] } } }>(
      await postJson(`/api/messages/${group.session.id}/agent-draft`, {
        content: '创建一个 Codex 前端实现 Agent，允许读取和写入 workspace',
      })
    )

    expect(draftCard.metadata.agentDraft?.runtimeType).toBe('code-agent')
    expect(draftCard.metadata.agentDraft?.codeAgentType).toBe('codex')
    expect(draftCard.metadata.agentDraft?.toolPermissions).toContain('workspace:read')
    expect(draftCard.metadata.agentDraft?.toolPermissions).toContain('workspace:write')

    const confirmed = await json<{ agent: { id: string; name: string; codeAgentType: string | null } }>(
      await postJson(`/api/messages/${group.session.id}/agent-draft/${draftCard.id}/confirm`, {
        draft: draftCard.metadata.agentDraft,
      })
    )
    const after = await json<{ agents: Array<{ id: string }> }>(await app.request(`/api/workspaces/${full.workspace.id}`))

    expect(confirmed.agent.codeAgentType).toBe('codex')
    expect(after.agents.map((agent) => agent.id)).toContain(confirmed.agent.id)

    const confirmedAgain = await json<{ agent: { id: string } }>(
      await postJson(`/api/messages/${group.session.id}/agent-draft/${draftCard.id}/confirm`, {
        draft: draftCard.metadata.agentDraft,
      })
    )
    const afterAgain = await json<{ agents: Array<{ id: string }> }>(await app.request(`/api/workspaces/${full.workspace.id}`))

    expect(confirmedAgain.agent.id).toBe(confirmed.agent.id)
    expect(afterAgain.agents.length).toBe(after.agents.length)
  })

  test('agent draft request in direct chat returns a group prompt instead of creating an agent', async () => {
    const session = await json<{ id: string }>(
      await postJson('/api/sessions', { title: 'Direct agent builder', type: 'direct' })
    )
    const prompt = await json<{ content: string; metadata: { agentDraftStatus?: string; agentDraft?: unknown } }>(
      await postJson(`/api/messages/${session.id}/agent-draft`, {
        content: '创建一个 Codex 前端实现 Agent',
      })
    )

    expect(prompt.content).toContain('Agent Group')
    expect(prompt.metadata.agentDraftStatus).toBe('requires_group')
    expect(prompt.metadata.agentDraft).toBeUndefined()
  })

  test('orchestrator dispatch returns run id and stores it on the task card', async () => {
    const full = await json<{ workspace: { id: string }; agents: Array<{ id: string }> }>(
      await postJson('/api/workspaces', { name: 'Dispatch run workspace', goal: 'Trace dispatch', template: 'classic' })
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {})
    )
    const plan = {
      kind: 'orchestrator_plan',
      title: 'Trace dispatch',
      goal: 'Verify run id',
      summary: 'Dispatch run id smoke plan',
      agents: [
        {
          key: 'architect',
          name: 'Architect',
          role: '规划',
          color: '#6366f1',
          systemPrompt: 'Plan only.',
          runtimeType: 'llm',
          capabilityTags: [],
          toolPermissions: [],
          sandboxPolicy: 'read-only',
        },
      ],
      tasks: [
        {
          id: 'trace-task',
          title: 'Trace task',
          description: 'Verify dispatch response carries run id.',
          agentKey: 'architect',
          dependencies: [],
          maxRetries: 0,
        },
      ],
    }
    const [card] = await dbApi.db
      .insert(dbApi.messages)
      .values({
        sessionId: group.session.id,
        senderId: 'orchestrator',
        senderType: 'agent',
        type: 'task_card',
        content: plan.summary,
        metadata: { plan },
      })
      .returning()
    expect(card?.id).toBeTruthy()

    const dispatched = await json<{ runId: string; workspaceId: string; groupSessionId: string }>(
      await postJson(`/api/messages/${group.session.id}/orchestrator-plan/${card!.id}/dispatch`, {})
    )

    expect(dispatched.runId).toBeTruthy()
    expect(dispatched.workspaceId).toBe(full.workspace.id)
    expect(dispatched.groupSessionId).toBe(group.session.id)

    const [updatedCard] = await dbApi.db
      .select()
      .from(dbApi.messages)
      .where(dbApi.eq(dbApi.messages.id, card!.id))
      .limit(1)
    const metadata = updatedCard?.metadata as { plan?: { dispatchResult?: { runId?: string } } } | null
    expect(metadata?.plan?.dispatchResult?.runId).toBe(dispatched.runId)

    const [runRecord] = await dbApi.db
      .select()
      .from(dbApi.orchestratorRuns)
      .where(dbApi.eq(dbApi.orchestratorRuns.id, dispatched.runId))
      .limit(1)
    const runPlan = runRecord?.plan as {
      phases?: Array<{ id: string; taskIds: string[] }>
      taskLedger?: { runId: string; tasks: Array<{ id: string; phaseId: string; status: string }> }
      progressLedger?: {
        runId: string
        status: string
        pendingTaskIds: string[]
        runningTaskIds: string[]
        completedTaskIds: string[]
      }
    } | null
    expect(runPlan?.phases?.[0]?.taskIds).toContain('trace-task')
    expect(runPlan?.taskLedger?.runId).toBe(dispatched.runId)
    expect(runPlan?.taskLedger?.tasks[0]?.phaseId).toBeTruthy()
    expect(runPlan?.taskLedger?.tasks[0]?.status).toBe('pending')
    expect(runPlan?.progressLedger?.runId).toBe(dispatched.runId)
    expect(runPlan?.progressLedger?.status).toBe('running')
    expect(runPlan?.progressLedger?.pendingTaskIds).toContain('trace-task')
    expect(runPlan?.progressLedger?.runningTaskIds).toEqual([])
    expect(runPlan?.progressLedger?.completedTaskIds).toEqual([])

    const events = await json<{ items: Array<{ type: string; payload: Record<string, unknown> }> }>(
      await app.request(`/api/orchestrator-runs/${dispatched.runId}/events`)
    )
    expect(events.items.map((event) => event.type)).toContain('run.started')
    expect(events.items.map((event) => event.type)).toContain('plan.created')
    expect(events.items.find((event) => event.type === 'plan.created')?.payload.taskCount).toBe(1)

    await waitForTaskStatus(dispatched.workspaceId, 'trace-task', 'done')
    const blackboardEntries = await json<{ items: Array<{ key: string; value: { schemaType: string; summary: string; output: string } }> }>(
      await app.request(`/api/orchestrator-runs/${dispatched.runId}/blackboard?schemaType=task_output`)
    )
    expect(blackboardEntries.items).toHaveLength(1)
    expect(blackboardEntries.items[0]!.key).toBe('task_trace-task_output')
    expect(blackboardEntries.items[0]!.value.schemaType).toBe('task_output')
    expect(blackboardEntries.items[0]!.value.summary).toBeTruthy()
    expect(blackboardEntries.items[0]!.value.output).toBeTruthy()
  })

  test('TaskGraph topological sort and cycle detection', async () => {
    const { TaskGraph } = await import('../apps/server/src/services/orchestrator/task-graph')
    const tasks = [
      { id: 'a', title: 'A', description: '', agentId: '1', dependencies: [], maxRetries: 2 },
      { id: 'b', title: 'B', description: '', agentId: '1', dependencies: ['a'], maxRetries: 2 },
      { id: 'c', title: 'C', description: '', agentId: '1', dependencies: ['a'], maxRetries: 2 },
      { id: 'd', title: 'D', description: '', agentId: '1', dependencies: ['b', 'c'], maxRetries: 2 },
    ]
    const graph = new TaskGraph(tasks)

    expect(graph.detectCycles()).toBe(false)
    const order = graph.getExecutionOrder()
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))

    graph.setStatus('a', 'done')
    graph.setStatus('b', 'running')
    expect(graph.getReadyTasks().map((t) => t.id)).toContain('c')
    expect(graph.getReadyTasks().map((t) => t.id)).not.toContain('b')
    expect(graph.getReadyTasks().map((t) => t.id)).not.toContain('d')
  })

  test('TaskGraph detects circular dependencies', async () => {
    const { TaskGraph } = await import('../apps/server/src/services/orchestrator/task-graph')
    const tasks = [
      { id: 'a', title: 'A', description: '', agentId: '1', dependencies: ['c'], maxRetries: 2 },
      { id: 'b', title: 'B', description: '', agentId: '1', dependencies: ['a'], maxRetries: 2 },
      { id: 'c', title: 'C', description: '', agentId: '1', dependencies: ['b'], maxRetries: 2 },
    ]
    const graph = new TaskGraph(tasks)
    expect(graph.detectCycles()).toBe(true)
  })

  test('ConflictResolver detects file conflicts across agents', async () => {
    const { ConflictResolver } = await import('../apps/server/src/services/orchestrator/conflict-resolver')
    const resolver = new ConflictResolver()
    const results = [
      {
        agentId: 'agent-1',
        agentName: 'Coder A',
        artifacts: [
          { kind: 'diff', filePath: 'src/app.ts', diff: '+line A', fullContent: 'line A' },
        ],
      },
      {
        agentId: 'agent-2',
        agentName: 'Coder B',
        artifacts: [
          { kind: 'diff', filePath: 'src/app.ts', diff: '+line B', fullContent: 'line B' },
        ],
      },
    ]

    const reports = await resolver.detectAndResolve(results)
    expect(reports.length).toBe(1)
    expect(reports[0]!.filePath).toBe('src/app.ts')
    expect(reports[0]!.variants.length).toBe(2)
    expect(reports[0]!.resolution).toBe('needs-human')
  })

  test('orchestrator run events are persisted and exposed in order', async () => {
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', { name: 'Run events workspace', goal: 'Trace events', template: 'classic' })
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {})
    )
    const [run] = await dbApi.db
      .insert(dbApi.orchestratorRuns)
      .values({
        workspaceId: full.workspace.id,
        groupSessionId: group.session.id,
        status: 'running',
        plan: { title: 'Trace run' },
      })
      .returning()
    expect(run?.id).toBeTruthy()

    const { emitRunEvent } = await import('../apps/server/src/services/orchestrator/run-events')
    await emitRunEvent({
      runId: run!.id,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      type: 'run.started',
      payload: { title: 'Trace run' },
    })
    await emitRunEvent({
      runId: run!.id,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      taskId: 'task-a',
      agentId: 'agent-a',
      type: 'task.started',
      payload: { taskTitle: 'A', agentName: 'Agent A' },
    })

    const events = await json<{
      items: Array<{ type: string; payload: Record<string, unknown>; taskId: string | null; agentId: string | null }>
    }>(await app.request(`/api/orchestrator-runs/${run!.id}/events`))

    expect(events.items.map((event) => event.type)).toEqual(['run.started', 'task.started'])
    expect(events.items[0]!.payload.title).toBe('Trace run')
    expect(events.items[1]!.taskId).toBe('task-a')
    expect(events.items[1]!.agentId).toBe('agent-a')
  })

  test('run events update the persisted progress ledger', async () => {
    const full = await json<{ workspace: { id: string }; agents: Array<{ id: string }> }>(
      await postJson('/api/workspaces', { name: 'Ledger workspace', goal: 'Trace ledger', template: 'classic' })
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {})
    )

    const plan = {
      runId: crypto.randomUUID(),
      title: 'Ledger run',
      goal: 'Track progress ledger',
      agents: [{ id: full.agents[0]!.id, key: 'architect', name: 'Architect', role: 'Plan' }],
      phases: [{ id: 'analysis', title: 'Analysis', purpose: 'Understand scope', taskIds: ['scan'] }],
      tasks: [
        {
          id: 'scan',
          phaseId: 'analysis',
          title: 'Scan',
          description: 'Inspect scope',
          agentId: full.agents[0]!.id,
          dependencies: [],
          maxRetries: 1,
        },
      ],
    }
    const { initializeRunLedger } = await import('../apps/server/src/services/orchestrator/run-ledger')
    const planWithLedger = initializeRunLedger(plan)
    const [run] = await dbApi.db
      .insert(dbApi.orchestratorRuns)
      .values({
        id: plan.runId,
        workspaceId: full.workspace.id,
        groupSessionId: group.session.id,
        status: 'running',
        plan: planWithLedger as unknown as Record<string, unknown>,
      })
      .returning()
    expect(run?.id).toBeTruthy()

    const { emitRunEvent } = await import('../apps/server/src/services/orchestrator/run-events')
    await emitRunEvent({
      runId: run!.id,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      taskId: 'scan',
      agentId: full.agents[0]!.id,
      type: 'task.started',
      payload: { title: 'Scan' },
    })
    await emitRunEvent({
      runId: run!.id,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      taskId: 'scan',
      agentId: full.agents[0]!.id,
      type: 'blackboard.written',
      payload: { key: 'task_scan_output', summary: 'Scoped' },
    })
    await emitRunEvent({
      runId: run!.id,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      taskId: 'scan',
      agentId: full.agents[0]!.id,
      type: 'task.completed',
      payload: { artifactCount: 0 },
    })
    await emitRunEvent({
      runId: run!.id,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      type: 'run.replanned',
      severity: 'warning',
      payload: { strategy: 'local_replan', reason: 'Need a narrower scan', changedTaskIds: ['scan'] },
    })

    const [updatedRun] = await dbApi.db
      .select()
      .from(dbApi.orchestratorRuns)
      .where(dbApi.eq(dbApi.orchestratorRuns.id, run!.id))
      .limit(1)
    const updatedPlan = updatedRun?.plan as {
      taskLedger?: { tasks: Array<{ id: string; status: string }> }
      progressLedger?: {
        currentPhaseId?: string
        pendingTaskIds: string[]
        runningTaskIds: string[]
        completedTaskIds: string[]
        blackboardKeys: string[]
        replanHistory: Array<{ strategy: string; reason: string }>
      }
    } | null

    expect(updatedPlan?.taskLedger?.tasks.find((task) => task.id === 'scan')?.status).toBe('done')
    expect(updatedPlan?.progressLedger?.currentPhaseId).toBe('analysis')
    expect(updatedPlan?.progressLedger?.pendingTaskIds).toEqual([])
    expect(updatedPlan?.progressLedger?.runningTaskIds).toEqual([])
    expect(updatedPlan?.progressLedger?.completedTaskIds).toEqual(['scan'])
    expect(updatedPlan?.progressLedger?.blackboardKeys).toContain('task_scan_output')
    expect(updatedPlan?.progressLedger?.replanHistory[0]?.strategy).toBe('local_replan')
  })

  test('typed blackboard entries are validated and exposed through run detail API', async () => {
    const full = await json<{ workspace: { id: string }; agents: Array<{ id: string }> }>(
      await postJson('/api/workspaces', { name: 'Typed blackboard workspace', goal: 'Trace typed entries', template: 'classic' })
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {})
    )
    const [run] = await dbApi.db
      .insert(dbApi.orchestratorRuns)
      .values({
        workspaceId: full.workspace.id,
        groupSessionId: group.session.id,
        status: 'running',
        plan: { runId: 'typed-run', title: 'Typed run', goal: 'Trace typed entries', agents: [], tasks: [] },
      })
      .returning()
    expect(run?.id).toBeTruthy()

    const { blackboard, Blackboard } = await import('../apps/server/src/services/blackboard')
    const namespace = Blackboard.namespace(full.workspace.id, run!.id)
    await expect(
      blackboard.write({
        namespace,
        key: 'facts/invalid',
        value: {
          schemaType: 'fact',
          summary: 'Missing fact field',
          confidence: 0.9,
          sourceAgentId: full.agents[0]!.id,
          taskId: 'scan',
          source: 'agent',
        },
        agentId: full.agents[0]!.id,
        taskId: 'scan',
      })
    ).rejects.toThrow(/Invalid blackboard entry/)

    const ref = await blackboard.write({
      namespace,
      key: 'facts/server',
      value: {
        schemaType: 'fact',
        summary: 'Server framework identified',
        confidence: 0.9,
        sourceAgentId: full.agents[0]!.id,
        taskId: 'scan',
        fact: 'Server uses Hono routes.',
        source: 'agent',
      },
      agentId: full.agents[0]!.id,
      taskId: 'scan',
    })
    expect(ref.version).toBe(1)

    const body = await json<{
      items: Array<{ key: string; value: { schemaType: string; summary: string; fact?: string }; agentId: string | null; taskId: string | null }>
    }>(await app.request(`/api/orchestrator-runs/${run!.id}/blackboard?schemaType=fact`))

    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.key).toBe('facts/server')
    expect(body.items[0]!.value.schemaType).toBe('fact')
    expect(body.items[0]!.value.summary).toBe('Server framework identified')
    expect(body.items[0]!.value.fact).toBe('Server uses Hono routes.')
    expect(body.items[0]!.agentId).toBe(full.agents[0]!.id)
    expect(body.items[0]!.taskId).toBe('scan')
  })

  test('GitBranchManager prepares and cleans up agent branches', async () => {
    const { GitBranchManager } = await import('../apps/server/src/services/git/branch-manager')
    const gitDir = mkdtempSync(join(tmpdir(), 'agenthub-git-'))

    // 初始化 git 仓库
    const exec = (args: string[]) => {
      const proc = Bun.spawn(['git', ...args], { cwd: gitDir, stdout: 'pipe', stderr: 'pipe' })
      return proc.exited
    }
    await exec(['init'])
    await exec(['config', 'user.email', 'test@agenthub.local'])
    await exec(['config', 'user.name', 'Test'])
    writeFileSync(join(gitDir, 'README.md'), '# Hello')
    await exec(['add', '.'])
    await exec(['commit', '-m', 'initial'])

    const manager = new GitBranchManager()
    const branchCtx = await manager.prepareBranch(gitDir, 'run-1', 'coder', 'task-1')

    expect(branchCtx.branch).toBe('agenthub/run-1/coder/task-1')
    expect(branchCtx.originalBranch).toBe('master')
    expect(branchCtx.projectPath).toBe(gitDir)
    expect(branchCtx.worktreePath).toBeTruthy()

    // 在 worktree 中创建变更（模拟 Agent 在独立工作目录中工作）
    writeFileSync(join(branchCtx.worktreePath, 'new-file.ts'), 'export const x = 1')
    const worktreeExec = (args: string[]) => {
      const proc = Bun.spawn(['git', ...args], { cwd: branchCtx.worktreePath, stdout: 'pipe', stderr: 'pipe' })
      return proc.exited
    }
    await worktreeExec(['add', '.'])
    await worktreeExec(['commit', '-m', 'agent change'])

    const diff = await manager.collectDiff(gitDir, branchCtx.branch)
    expect(diff).toContain('new-file.ts')

    const files = await manager.collectChangedFiles(gitDir, branchCtx.branch)
    expect(files).toContain('new-file.ts')

    const status = await manager.getFileStatus(gitDir, 'new-file.ts', branchCtx.branch)
    expect(status).toBe('created')

    // 清理分支
    await manager.cleanupBranch(branchCtx)
    const afterCleanup = await exec(['show-ref', '--verify', `refs/heads/${branchCtx.branch}`])
    expect(afterCleanup).not.toBe(0)
  })
})
