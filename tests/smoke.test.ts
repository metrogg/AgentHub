import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: { request: (input: string, init?: RequestInit) => Promise<Response> }
let dbApi: typeof import('../packages/db/src/index')
let originalFetch: typeof fetch
let globalMockedFetch: typeof fetch

beforeAll(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'agenthub-smoke-'))
  process.env.DATABASE_URL = join(tempDir, 'agenthub-smoke.db')
  process.env.LLM_API_KEY = 'test-key'
  process.env.OPENAI_API_KEY = ''
  process.env.ANTHROPIC_API_KEY = ''
  process.env.ENABLE_LOCAL_CLI_PROBES = 'false'
  process.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'
  process.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'

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
  globalMockedFetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/chat/completions') || url.includes('/v1/messages')) {
      return mockSseStream(['Task completed successfully.'])
    }
    return originalFetch(input, init)
  }
  globalThis.fetch = globalMockedFetch
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

function mockSseStream(chunks: string[]) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const data = JSON.stringify({ choices: [{ delta: { content: chunk } }] })
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function createLlmWorkspaceAgent(
  workspaceId: string,
  overrides: Partial<{
    name: string
    role: string
    roleType: string
    description: string
    systemPrompt: string
    sandboxPolicy: string
  }> = {},
) {
  return json<{ id: string; name: string; role: string }>(
    await postJson(`/api/workspaces/${workspaceId}/agents`, {
      name: overrides.name ?? 'Smoke LLM Agent',
      role: overrides.role ?? '测试 Agent',
      roleType: overrides.roleType ?? 'custom',
      description: overrides.description ?? 'Smoke-test LLM runtime agent.',
      systemPrompt: overrides.systemPrompt ?? 'Reply briefly for smoke tests.',
      runtimeType: 'llm',
      capabilityTags: ['smoke'],
      toolPermissions: ['chat'],
      sandboxPolicy: overrides.sandboxPolicy ?? 'read-only',
      contextPolicy: 'workspace-aware',
      autoInvoke: true,
      approvalRequired: false,
    }),
  )
}

async function waitForTaskStatus(workspaceId: string, taskId: string, status: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const full = await json<{ tasks: Array<{ id: string; status: string }> }>(
      await app.request(`/api/workspaces/${workspaceId}`),
    )
    const task = full.tasks.find((item) => item.id === taskId)
    if (task?.status === status) return task
    await new Promise((resolve) => setTimeout(resolve, 100))
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
      await postJson('/api/sessions', { title: 'Smoke chat', type: 'direct' }),
    )
    const message = await json<{ id: string; content: string }>(
      await postJson(`/api/messages/${session.id}`, {
        content: 'hello smoke',
        type: 'text',
        metadata: { skipAgentReply: true },
      }),
    )
    const list = await json<{ items: Array<{ id: string; content: string }> }>(
      await app.request(`/api/messages/${session.id}`),
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
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200,
        })
      }
      return originalFetch(input, init)
    }

    const result = await json<{ ok: boolean; status?: number }>(
      await postJson('/api/settings/test-model', {
        provider: 'openai',
        apiEndpoint: 'https://mock.local/v1',
        apiKey: 'sk-test-12345678',
        modelId: 'mock-model',
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)

    globalThis.fetch = globalMockedFetch
  })

  test('workspace task dispatch creates a session and marks failed when no LLM key is configured', async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/chat/completions') || url.includes('/v1/messages')) {
        return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
        })
      }
      return originalFetch(input, init)
    }

    const full = await json<{
      workspace: { id: string }
      tasks: Array<{ id: string }>
    }>(
      await postJson('/api/workspaces', {
        name: 'Smoke workspace',
        goal: 'Verify dispatch',
        template: 'blank',
      }),
    )
    const agent = await createLlmWorkspaceAgent(full.workspace.id)
    const agentId = agent.id
    expect(agentId).toBeTruthy()

    const task = await json<{ id: string }>(
      await postJson(`/api/workspaces/${full.workspace.id}/tasks`, {
        title: 'Smoke task',
        description: 'This should fail gracefully without credentials.',
        agentId,
      }),
    )
    const dispatched = await json<{
      task: { status: string; sessionId: string | null }
      sessionId: string
    }>(await postJson(`/api/workspaces/${full.workspace.id}/tasks/${task.id}/dispatch`, {}))

    expect(dispatched.sessionId).toBeTruthy()
    expect(dispatched.task.status).toBe('running')
    await waitForTaskStatus(full.workspace.id, task.id, 'failed')

    globalThis.fetch = globalMockedFetch
  })

  test('auto workspace creates a local project folder under configured root', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agenthub-auto-workspace-'))
    await json<{ success: boolean }>(
      await postJson('/api/settings', {
        APP_SETTINGS: JSON.stringify({ workspaceStorageRoot: workspaceRoot }),
      }),
    )

    const full = await json<{
      workspace: { id: string; name: string; projectPath: string | null }
    }>(
      await postJson('/api/workspaces/auto', {
        name: 'Auto workspace smoke',
        goal: 'Verify automatic folder allocation',
        template: 'blank',
      }),
    )

    expect(full.workspace.id).toBeTruthy()
    expect(full.workspace.name).toBe('Auto workspace smoke')
    expect(full.workspace.projectPath?.startsWith(workspaceRoot)).toBe(true)
    expect(existsSync(full.workspace.projectPath!)).toBe(true)
  })

  test('agent workdir is seeded from workspace without requiring git', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'agenthub-workdir-'))
    writeFileSync(join(projectRoot, 'index.html'), '<main>hello</main>')
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true })
    writeFileSync(join(projectRoot, 'node_modules', 'ignored.txt'), 'skip me')

    const { prepareAgentWorkdir } =
      await import('../apps/server/src/services/execution/agent-workdir')
    const workdir = prepareAgentWorkdir({
      projectPath: projectRoot,
      runId: 'run-1',
      taskId: 'task-1',
      agentId: 'coder',
      agentName: 'Coder',
      sandboxPolicy: 'workspace-write',
    })

    expect(workdir?.executionPath).toContain(join('.agenthub', 'workdirs'))
    expect(existsSync(join(workdir!.executionPath, 'index.html'))).toBe(true)
    expect(existsSync(join(workdir!.executionPath, 'node_modules', 'ignored.txt'))).toBe(false)
  })

  test('classic workspace seeds role agents and editable relations', async () => {
    const full = await json<{
      workspace: { id: string }
      agents: Array<{ id: string; name: string; roleType: string }>
      agentRelations: Array<{ sourceAgentId: string; targetAgentId: string; relationType: string }>
    }>(
      await postJson('/api/workspaces', {
        name: 'Role relation workspace',
        goal: 'Coordinate agents by role',
        template: 'classic',
      }),
    )

    expect(full.agents.map((agent) => agent.roleType)).toEqual([
      'orchestrator',
      'researcher',
      'architect',
      'coder',
      'reviewer',
    ])
    expect(full.agents.map((agent) => agent.name)).toEqual([
      'Orchestrator',
      'Researcher',
      'Designer',
      'Builder',
      'QA Reviewer',
    ])
    expect(full.agentRelations.map((relation) => relation.relationType)).toContain('handoff_to')
    expect(full.agentRelations.map((relation) => relation.relationType)).toContain('reviewed_by')
    expect(full.agentRelations.map((relation) => relation.relationType)).toContain('reports_to')
    expect(full.agentRelations.map((relation) => relation.relationType)).toContain('fallback_to')

    const coder = full.agents.find((agent) => agent.roleType === 'coder')!
    const reviewer = full.agents.find((agent) => agent.roleType === 'reviewer')!
    const orchestrator = full.agents.find((agent) => agent.roleType === 'orchestrator')!

    const replaced = await json<{
      items: Array<{
        sourceAgentId: string
        targetAgentId: string
        relationType: string
        note: string | null
      }>
    }>(
      await app.request(`/api/workspaces/${full.workspace.id}/agent-relations`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          relations: [
            {
              sourceAgentId: coder.id,
              targetAgentId: reviewer.id,
              relationType: 'reviewed_by',
              note: 'Reviewer checks Coder output',
            },
            {
              sourceAgentId: coder.id,
              targetAgentId: reviewer.id,
              relationType: 'reviewed_by',
              note: 'Duplicate should be deduped',
            },
            {
              sourceAgentId: coder.id,
              targetAgentId: orchestrator.id,
              relationType: 'fallback_to',
            },
          ],
        }),
      }),
    )

    expect(replaced.items).toHaveLength(2)
    expect(replaced.items.find((relation) => relation.relationType === 'reviewed_by')?.note).toBe(
      'Reviewer checks Coder output',
    )

    const listed = await json<{
      items: Array<{ sourceAgentId: string; targetAgentId: string; relationType: string }>
    }>(await app.request(`/api/workspaces/${full.workspace.id}/agent-relations`))
    expect(listed.items.map((relation) => relation.relationType).sort()).toEqual([
      'fallback_to',
      'reviewed_by',
    ])
  })

  test('group session sync keeps unselected workspace agents and dedupes members', async () => {
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Group member sync workspace',
        goal: 'Verify selected group members',
        template: 'blank',
      }),
    )

    const agentInputs = [
      { name: 'Orchestrator', role: '总指挥', roleType: 'orchestrator' },
      { name: 'Architect', role: '规划', roleType: 'architect' },
      { name: 'Coder', role: '实现', roleType: 'coder' },
    ]
    const agents = []
    for (const input of agentInputs) {
      agents.push(
        await json<{ id: string }>(
          await postJson(`/api/workspaces/${full.workspace.id}/agents`, input),
        ),
      )
    }

    const selectedAgentIds = [agents[0]!.id, agents[1]!.id]
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {
        agentIds: selectedAgentIds,
      }),
    )

    await dbApi.db.insert(dbApi.sessionMembers).values([
      {
        sessionId: group.session.id,
        memberType: 'agent',
        memberId: agents[0]!.id,
      },
      {
        sessionId: group.session.id,
        memberType: 'agent',
        memberId: agents[2]!.id,
      },
    ])

    await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {
        agentIds: selectedAgentIds,
      }),
    )

    const syncedGroup = await json<{
      metadata: { agentIds?: string[]; agentCount?: number; memberCount?: number }
    }>(await app.request(`/api/sessions/${group.session.id}`))
    expect(syncedGroup.metadata.agentIds?.sort()).toEqual(selectedAgentIds.slice().sort())
    expect(syncedGroup.metadata.agentCount).toBe(2)
    expect(syncedGroup.metadata.memberCount).toBe(3)

    const after = await json<{ agents: Array<{ id: string }> }>(
      await app.request(`/api/workspaces/${full.workspace.id}`),
    )
    expect(after.agents.map((agent) => agent.id).sort()).toEqual(
      agents.map((agent) => agent.id).sort(),
    )

    const members = await dbApi.db
      .select()
      .from(dbApi.sessionMembers)
      .where(dbApi.eq(dbApi.sessionMembers.sessionId, group.session.id))
    const memberKeys = members.map((member) => `${member.memberType}:${member.memberId}`).sort()
    expect(memberKeys).toEqual(
      ['agent:' + agents[0]!.id, 'agent:' + agents[1]!.id, 'user:default-user'].sort(),
    )
  })

  test('artifact demo endpoint persists inline preview metadata', async () => {
    const session = await json<{ id: string }>(
      await postJson('/api/sessions', { title: 'Artifact chat', type: 'direct' }),
    )
    const message = await json<{ metadata: { artifacts?: Array<{ kind: string }> } }>(
      await postJson(`/api/messages/${session.id}/artifact-demo`, {
        content: '生成网页预览、diff 并部署',
      }),
    )

    expect(message.metadata.artifacts?.map((artifact) => artifact.kind)).toContain('web_preview')
    expect(message.metadata.artifacts?.map((artifact) => artifact.kind)).toContain('diff')
    expect(message.metadata.artifacts?.map((artifact) => artifact.kind)).toContain('deploy')
  })

  test('agent adapter catalog reports main code agent platforms', async () => {
    const catalog = await json<{
      items: Array<{
        id: string
        command: string
        installed: boolean
        configured: boolean
        executionEnabled: boolean
      }>
    }>(await app.request('/api/coding-tools/agent-adapters'))

    expect(catalog.items.map((item) => item.id)).toContain('codex')
    expect(catalog.items.map((item) => item.id)).toContain('claude-code')
    expect(catalog.items.map((item) => item.id)).toContain('opencode')
    expect(catalog.items.find((item) => item.id === 'codex')?.command).toBe('codex')
  })

  test('agent draft can be confirmed into a workspace agent', async () => {
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Agent draft workspace',
        goal: 'Create agents',
        template: 'classic',
      }),
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )
    const draftCard = await json<{
      id: string
      metadata: {
        agentDraft?: {
          name: string
          runtimeType: string
          codeAgentType?: string | null
          toolPermissions: string[]
        }
      }
    }>(
      await postJson(`/api/messages/${group.session.id}/agent-draft`, {
        content: '创建一个 Codex 前端实现 Agent，允许读取和写入 workspace',
      }),
    )

    expect(draftCard.metadata.agentDraft?.runtimeType).toBe('code-agent')
    expect(draftCard.metadata.agentDraft?.codeAgentType).toBe('codex')
    expect(draftCard.metadata.agentDraft?.toolPermissions).toContain('workspace:read')
    expect(draftCard.metadata.agentDraft?.toolPermissions).toContain('workspace:write')

    const confirmed = await json<{
      agent: { id: string; name: string; codeAgentType: string | null }
    }>(
      await postJson(`/api/messages/${group.session.id}/agent-draft/${draftCard.id}/confirm`, {
        draft: draftCard.metadata.agentDraft,
      }),
    )
    const after = await json<{ agents: Array<{ id: string }> }>(
      await app.request(`/api/workspaces/${full.workspace.id}`),
    )

    expect(confirmed.agent.codeAgentType).toBe('codex')
    expect(after.agents.map((agent) => agent.id)).toContain(confirmed.agent.id)

    const confirmedAgain = await json<{ agent: { id: string } }>(
      await postJson(`/api/messages/${group.session.id}/agent-draft/${draftCard.id}/confirm`, {
        draft: draftCard.metadata.agentDraft,
      }),
    )
    const afterAgain = await json<{ agents: Array<{ id: string }> }>(
      await app.request(`/api/workspaces/${full.workspace.id}`),
    )

    expect(confirmedAgain.agent.id).toBe(confirmed.agent.id)
    expect(afterAgain.agents.length).toBe(after.agents.length)
  })

  test('agent draft request in direct chat returns a group prompt instead of creating an agent', async () => {
    const session = await json<{ id: string }>(
      await postJson('/api/sessions', { title: 'Direct agent builder', type: 'direct' }),
    )
    const prompt = await json<{
      content: string
      metadata: { agentDraftStatus?: string; agentDraft?: unknown }
    }>(
      await postJson(`/api/messages/${session.id}/agent-draft`, {
        content: '创建一个 Codex 前端实现 Agent',
      }),
    )

    expect(prompt.content).toContain('Agent Group')
    expect(prompt.metadata.agentDraftStatus).toBe('requires_group')
    expect(prompt.metadata.agentDraft).toBeUndefined()
  })

  test('orchestrator plan includes agent selection rationale', async () => {
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Routed plan workspace',
        goal: 'Explain routing',
        template: 'classic',
      }),
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )

    const loadingCard = await json<{
      id: string
      metadata: {
        plan?: {
          tasks: Array<{
            id: string
            taskType?: string
            agentSelection?: {
              selectedAgentKey: string
              reviewerAgentKey?: string
              fallbackAgentKey?: string
              rationale: string[]
            }
          }>
        }
      }
    }>(
      await postJson(`/api/messages/${group.session.id}/orchestrator-plan`, {
        content: '@orchestrator implement a small UI change and review it',
      }),
    )

    // 后端异步生成 plan，轮询等待结果
    let card = loadingCard
    for (let i = 0; i < 20; i++) {
      const tasks = card.metadata.plan?.tasks ?? []
      if (tasks.length > 0) break
      await new Promise((r) => setTimeout(r, 50))
      const refreshed = await json<{ items: Array<typeof card> }>(
        await app.request(`/api/messages/${group.session.id}`),
      )
      const found = refreshed.items.find((m) => m.id === loadingCard.id)
      if (found) card = found
    }

    const tasks = card.metadata.plan?.tasks ?? []
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((task) => task.agentSelection?.selectedAgentKey)).toBe(true)
    expect(tasks.every((task) => task.agentSelection?.rationale.length)).toBe(true)
    // 只要 plan 中有需要审查的 task（code/test/verify），就检查 reviewerAgentKey
    const reviewableTask = tasks.find((task) =>
      ['code', 'test', 'verify'].includes(task.taskType ?? ''),
    )
    if (reviewableTask) {
      expect(reviewableTask.agentSelection?.reviewerAgentKey).toBeTruthy()
    }
  })

  test('orchestrator dispatch returns run id and stores it on the task card', async () => {
    const full = await json<{ workspace: { id: string }; agents: Array<{ id: string }> }>(
      await postJson('/api/workspaces', {
        name: 'Dispatch run workspace',
        goal: 'Trace dispatch',
        template: 'blank',
        projectPath: process.cwd(),
      }),
    )
    const traceAgent = await createLlmWorkspaceAgent(full.workspace.id, {
      name: 'Trace Agent',
      role: '验证执行',
      systemPrompt: 'Complete the assigned smoke-test task briefly.',
    })
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )
    const plan = {
      kind: 'orchestrator_plan',
      title: 'Trace dispatch',
      goal: 'Verify run id',
      summary: 'Dispatch run id smoke plan',
      agents: [
        {
          key: traceAgent.id,
          name: traceAgent.name,
          role: traceAgent.role,
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
          agentKey: traceAgent.id,
          taskType: 'test',
          dependencies: [],
          maxRetries: 0,
          outputContract: {
            requiredBlackboardWrites: [
              { key: 'task_trace-task_output', schemaType: 'task_output' },
            ],
            requiredArtifacts: [],
            allowedPaths: ['apps/web/src/**'],
            acceptanceCriteria: ['validation command passes'],
          },
          validation: {
            commands: ['bun --version'],
            requiresReview: true,
          },
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
      await postJson(
        `/api/messages/${group.session.id}/orchestrator-plan/${card!.id}/dispatch`,
        {},
      ),
    )

    expect(dispatched.runId).toBeTruthy()
    expect(dispatched.workspaceId).toBe(full.workspace.id)
    expect(dispatched.groupSessionId).toBe(group.session.id)

    const [updatedCard] = await dbApi.db
      .select()
      .from(dbApi.messages)
      .where(dbApi.eq(dbApi.messages.id, card!.id))
      .limit(1)
    const metadata = updatedCard?.metadata as {
      plan?: { dispatchResult?: { runId?: string } }
    } | null
    expect(metadata?.plan?.dispatchResult?.runId).toBe(dispatched.runId)

    const [runRecord] = await dbApi.db
      .select()
      .from(dbApi.orchestratorRuns)
      .where(dbApi.eq(dbApi.orchestratorRuns.id, dispatched.runId))
      .limit(1)
    const runPlan = runRecord?.plan as {
      phases?: Array<{ id: string; taskIds: string[] }>
      taskLedger?: {
        runId: string
        tasks: Array<{
          id: string
          phaseId: string
          status: string
          outputContract?: {
            requiredArtifacts?: string[]
            allowedPaths?: string[]
            acceptanceCriteria?: string[]
          }
          validation?: { commands?: string[]; requiresReview?: boolean }
        }>
      }
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
    expect(['pending', 'running', 'done']).toContain(runPlan?.taskLedger?.tasks[0]?.status)
    expect(runPlan?.taskLedger?.tasks[0]?.outputContract?.allowedPaths).toContain('apps/web/src/**')
    expect(runPlan?.taskLedger?.tasks[0]?.validation?.commands).toEqual(['bun --version'])
    expect(runPlan?.taskLedger?.tasks[0]?.validation?.requiresReview).toBe(true)
    expect(runPlan?.progressLedger?.runId).toBe(dispatched.runId)
    expect(runPlan?.progressLedger?.status).toBe('running')
    expect([
      ...(runPlan?.progressLedger?.pendingTaskIds ?? []),
      ...(runPlan?.progressLedger?.runningTaskIds ?? []),
      ...(runPlan?.progressLedger?.completedTaskIds ?? []),
    ]).toContain('trace-task')

    const events = await json<{ items: Array<{ type: string; payload: Record<string, unknown> }> }>(
      await app.request(`/api/orchestrator-runs/${dispatched.runId}/events`),
    )
    expect(events.items.map((event) => event.type)).toContain('run.started')
    expect(events.items.map((event) => event.type)).toContain('plan.created')
    expect(events.items.find((event) => event.type === 'plan.created')?.payload.taskCount).toBe(1)

    await waitForTaskStatus(dispatched.workspaceId, 'trace-task', 'done')
    const blackboardEntries = await json<{
      items: Array<{ key: string; value: { schemaType: string; summary: string; output: string } }>
    }>(
      await app.request(
        `/api/orchestrator-runs/${dispatched.runId}/blackboard?schemaType=task_output`,
      ),
    )
    expect(blackboardEntries.items).toHaveLength(1)
    expect(blackboardEntries.items[0]!.key).toBe('task_trace-task_output')
    expect(blackboardEntries.items[0]!.value.schemaType).toBe('task_output')
    expect(blackboardEntries.items[0]!.value.summary).toBeTruthy()
    expect(blackboardEntries.items[0]!.value.output).toBeTruthy()

    const testResults = await json<{
      items: Array<{
        key: string
        value: { schemaType: string; command: string; status: string; outputSummary: string }
      }>
    }>(
      await app.request(
        `/api/orchestrator-runs/${dispatched.runId}/blackboard?schemaType=test_result`,
      ),
    )
    expect(testResults.items).toHaveLength(1)
    expect(testResults.items[0]!.key).toBe('tests/trace-task/1')
    expect(testResults.items[0]!.value.schemaType).toBe('test_result')
    expect(testResults.items[0]!.value.command).toBe('bun --version')
    expect(testResults.items[0]!.value.status).toBe('passed')
    expect(testResults.items[0]!.value.outputSummary).toBeTruthy()
  })

  test('TaskGraph topological sort and cycle detection', async () => {
    const { TaskGraph } = await import('../apps/server/src/services/orchestrator/task-graph')
    const tasks = [
      { id: 'a', title: 'A', description: '', agentId: '1', dependencies: [], maxRetries: 2 },
      { id: 'b', title: 'B', description: '', agentId: '1', dependencies: ['a'], maxRetries: 2 },
      { id: 'c', title: 'C', description: '', agentId: '1', dependencies: ['a'], maxRetries: 2 },
      {
        id: 'd',
        title: 'D',
        description: '',
        agentId: '1',
        dependencies: ['b', 'c'],
        maxRetries: 2,
      },
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

  test('agent router explains selected coder with reviewer and fallback relations', async () => {
    const { selectAgentForTask } =
      await import('../apps/server/src/services/orchestrator/agent-router')
    const agents = [
      {
        id: 'architect',
        key: 'architect',
        name: 'Architect',
        role: 'Architecture',
        roleType: 'architect',
        runtimeType: 'llm',
        capabilityTags: ['planning', 'architecture'],
        toolPermissions: ['workspace:read'],
        sandboxPolicy: 'read-only',
      },
      {
        id: 'coder',
        key: 'coder',
        name: 'Coder',
        role: 'Implementation',
        roleType: 'coder',
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
        capabilityTags: ['code', 'implementation'],
        toolPermissions: ['workspace:read', 'workspace:write'],
        sandboxPolicy: 'workspace-write',
      },
      {
        id: 'reviewer',
        key: 'reviewer',
        name: 'Reviewer',
        role: 'Review',
        roleType: 'reviewer',
        runtimeType: 'llm',
        capabilityTags: ['review', 'quality'],
        toolPermissions: ['workspace:read'],
        sandboxPolicy: 'read-only',
      },
    ]
    const selection = selectAgentForTask({
      task: {
        id: 'build',
        title: 'Implement UI',
        description: 'Change React components',
        agentId: '',
        taskType: 'code',
        dependencies: [],
        maxRetries: 1,
      },
      agents: agents as any,
      relations: [
        { sourceAgentId: 'coder', targetAgentId: 'reviewer', relationType: 'reviewed_by' },
        { sourceAgentId: 'coder', targetAgentId: 'architect', relationType: 'fallback_to' },
      ],
    })

    expect(selection.selectedAgentKey).toBe('coder')
    expect(selection.reviewerAgentKey).toBe('reviewer')
    expect(selection.fallbackAgentKey).toBe('architect')
    expect(selection.score).toBeGreaterThan(0)
    expect(selection.rationale.join(' ')).toContain('code')
  })

  test('task validation skips commands outside the safe allowlist', async () => {
    const { runTaskValidation } =
      await import('../apps/server/src/services/orchestrator/task-validation')
    const results = await runTaskValidation({ commands: ['echo unsafe'] })

    expect(results).toHaveLength(1)
    expect(results[0]!.command).toBe('echo unsafe')
    expect(results[0]!.status).toBe('skipped')
    expect(results[0]!.outputSummary).toContain('not allowed')
  })

  test('task output contract enforces allowed paths and required artifacts', async () => {
    const { validateTaskOutputContract } =
      await import('../apps/server/src/services/orchestrator/task-contract')
    const baseTask = {
      id: 'code-task',
      title: 'Code task',
      description: 'Modify allowed files only.',
      agentId: 'agent-1',
      dependencies: [],
      maxRetries: 0,
      outputContract: {
        requiredBlackboardWrites: [
          { key: 'task_code-task_output', schemaType: 'task_output' as const },
        ],
        requiredArtifacts: ['diff'],
        allowedPaths: ['apps/web/src/**'],
      },
    }

    const pass = validateTaskOutputContract({
      task: baseTask,
      artifacts: [{ kind: 'diff', filePath: 'apps/web/src/App.tsx' }],
      writtenBlackboardKeys: ['task_code-task_output'],
    })
    expect(pass.status).toBe('passed')

    const failPath = validateTaskOutputContract({
      task: baseTask,
      artifacts: [{ kind: 'diff', filePath: 'packages/db/src/schema.ts' }],
      writtenBlackboardKeys: ['task_code-task_output'],
    })
    expect(failPath.status).toBe('failed')
    expect(failPath.violations.some((item) => item.type === 'path_not_allowed')).toBe(true)

    const failArtifact = validateTaskOutputContract({
      task: baseTask,
      artifacts: [],
      writtenBlackboardKeys: ['task_code-task_output'],
    })
    expect(failArtifact.status).toBe('failed')
    expect(failArtifact.violations.some((item) => item.type === 'missing_artifact')).toBe(true)
  })

  test('ConflictResolver detects file conflicts across agents', async () => {
    const { ConflictResolver } =
      await import('../apps/server/src/services/orchestrator/conflict-resolver')
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
      await postJson('/api/workspaces', {
        name: 'Run events workspace',
        goal: 'Trace events',
        template: 'classic',
      }),
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
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
      items: Array<{
        type: string
        payload: Record<string, unknown>
        taskId: string | null
        agentId: string | null
      }>
    }>(await app.request(`/api/orchestrator-runs/${run!.id}/events`))

    expect(events.items.map((event) => event.type)).toEqual(['run.started', 'task.started'])
    expect(events.items[0]!.payload.title).toBe('Trace run')
    expect(events.items[1]!.taskId).toBe('task-a')
    expect(events.items[1]!.agentId).toBe('agent-a')
  })

  test('orchestrator run can be cancelled and marks unfinished tasks', async () => {
    const full = await json<{ workspace: { id: string }; agents: Array<{ id: string }> }>(
      await postJson('/api/workspaces', {
        name: 'Cancel run workspace',
        goal: 'Cancel run',
        template: 'classic',
      }),
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )
    const agentId = full.agents[0]!.id
    const runId = crypto.randomUUID()
    const plan = {
      runId,
      title: 'Cancelable run',
      goal: 'Stop this run',
      agents: [
        {
          id: agentId,
          key: 'architect',
          name: 'Architect',
          role: '规划',
          runtimeType: 'llm',
          capabilityTags: [],
          toolPermissions: [],
          sandboxPolicy: 'read-only',
        },
      ],
      tasks: [
        {
          id: 'cancel-task',
          title: 'Cancelable task',
          description: 'This task should be cancelled.',
          agentId,
          dependencies: [],
          maxRetries: 0,
        },
      ],
    }
    const { initializeRunLedger } =
      await import('../apps/server/src/services/orchestrator/run-ledger')
    await dbApi.db.insert(dbApi.orchestratorRuns).values({
      id: runId,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      status: 'running',
      plan: initializeRunLedger(plan as any) as unknown as Record<string, unknown>,
    })
    await dbApi.db.insert(dbApi.workspaceTasks).values({
      id: 'cancel-task',
      workspaceId: full.workspace.id,
      agentId,
      title: 'Cancelable task',
      description: 'This task should be cancelled.',
      status: 'pending',
      orderIdx: 0,
      runId,
    })

    const cancelled = await json<{
      run: { id: string; status: string }
      activeRunCancelled: boolean
    }>(await postJson(`/api/orchestrator-runs/${runId}/cancel`, {}))
    expect(cancelled.run.id).toBe(runId)
    expect(cancelled.run.status).toBe('cancelled')
    expect(cancelled.activeRunCancelled).toBe(false)

    const [runRecord] = await dbApi.db
      .select()
      .from(dbApi.orchestratorRuns)
      .where(dbApi.eq(dbApi.orchestratorRuns.id, runId))
      .limit(1)
    const runPlan = runRecord?.plan as {
      progressLedger?: { status: string; cancelledTaskIds: string[] }
    } | null
    expect(runRecord?.status).toBe('cancelled')
    expect(runPlan?.progressLedger?.status).toBe('cancelled')
    expect(runPlan?.progressLedger?.cancelledTaskIds).toContain('cancel-task')

    const [taskRecord] = await dbApi.db
      .select()
      .from(dbApi.workspaceTasks)
      .where(dbApi.eq(dbApi.workspaceTasks.id, 'cancel-task'))
      .limit(1)
    expect(taskRecord?.status).toBe('cancelled')

    const events = await json<{ items: Array<{ type: string }> }>(
      await app.request(`/api/orchestrator-runs/${runId}/events`),
    )
    expect(events.items.map((event) => event.type)).toContain('run.cancelled')
  })

  test('run events update the persisted progress ledger', async () => {
    const full = await json<{ workspace: { id: string }; agents: Array<{ id: string }> }>(
      await postJson('/api/workspaces', {
        name: 'Ledger workspace',
        goal: 'Trace ledger',
        template: 'classic',
      }),
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )

    const plan = {
      runId: crypto.randomUUID(),
      title: 'Ledger run',
      goal: 'Track progress ledger',
      agents: [{ id: full.agents[0]!.id, key: 'architect', name: 'Architect', role: 'Plan' }],
      phases: [
        { id: 'analysis', title: 'Analysis', purpose: 'Understand scope', taskIds: ['scan'] },
      ],
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
    const { initializeRunLedger } =
      await import('../apps/server/src/services/orchestrator/run-ledger')
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
      payload: {
        strategy: 'local_replan',
        reason: 'Need a narrower scan',
        changedTaskIds: ['scan'],
      },
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
      await postJson('/api/workspaces', {
        name: 'Typed blackboard workspace',
        goal: 'Trace typed entries',
        template: 'classic',
      }),
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )
    const [run] = await dbApi.db
      .insert(dbApi.orchestratorRuns)
      .values({
        workspaceId: full.workspace.id,
        groupSessionId: group.session.id,
        status: 'running',
        plan: {
          runId: 'typed-run',
          title: 'Typed run',
          goal: 'Trace typed entries',
          agents: [],
          tasks: [],
        },
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
      }),
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
      items: Array<{
        key: string
        value: { schemaType: string; summary: string; fact?: string }
        agentId: string | null
        taskId: string | null
      }>
    }>(await app.request(`/api/orchestrator-runs/${run!.id}/blackboard?schemaType=fact`))

    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.key).toBe('facts/server')
    expect(body.items[0]!.value.schemaType).toBe('fact')
    expect(body.items[0]!.value.summary).toBe('Server framework identified')
    expect(body.items[0]!.value.fact).toBe('Server uses Hono routes.')
    expect(body.items[0]!.agentId).toBe(full.agents[0]!.id)
    expect(body.items[0]!.taskId).toBe('scan')
  })

  test('Claude Code adapter follows official headless CLI contracts', async () => {
    const { __codeAgentAdapterTestHooks } =
      await import('../apps/server/src/services/code-agent-adapter')

    const args = __codeAgentAdapterTestHooks.buildClaudeArgs('hello', {
      sandboxPolicy: 'workspace-write',
      modelId: 'claude-sonnet-4',
      toolConfig: {
        settings: 'C:/agenthub/claude-settings.json',
        addDirs: ['C:/project/shared', 'C:/project/design'],
      },
    })
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(args).toContain('--verbose')
    expect(args).toContain('--include-partial-messages')
    expect(args).toContain('--settings')
    expect(args).toContain('C:/agenthub/claude-settings.json')
    expect(args.filter((item) => item === '--add-dir')).toHaveLength(2)

    const readOnlyArgs = __codeAgentAdapterTestHooks.buildClaudeArgs('hello', {
      sandboxPolicy: 'read-only',
      toolConfig: { permissionMode: 'bypassPermissions', skipPermissions: true },
    })
    expect(readOnlyArgs[readOnlyArgs.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(readOnlyArgs).not.toContain('--dangerously-skip-permissions')

    const dangerArgs = __codeAgentAdapterTestHooks.buildClaudeArgs('hello', {
      sandboxPolicy: 'danger-full-access',
      toolConfig: { permissionMode: 'bypassPermissions' },
    })
    expect(dangerArgs[dangerArgs.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(dangerArgs).toContain('--dangerously-skip-permissions')
  })

  test('Claude Code stream-json parser records tools, files, commands, and final text', async () => {
    const { __codeAgentAdapterTestHooks } =
      await import('../apps/server/src/services/code-agent-adapter')
    const commands: Array<{ command: string; cwd?: string }> = []
    const files: Array<{ path: string; status: string }> = []
    const toolCalls: Array<{ name: string; input?: Record<string, unknown> }> = []
    const logs: Array<{ stream: string; text: string }> = []
    let text = ''
    const handlers = {
      addCommand: (command: string, cwd?: string) => commands.push({ command, cwd }),
      addFile: (path: string, status: any) => files.push({ path, status }),
      addToolCall: (name: string, input?: Record<string, unknown>) =>
        toolCalls.push({ name, input }),
      addLog: (stream: any, logText: string) => logs.push({ stream, text: logText }),
      onText: (chunk: string) => {
        text += chunk
      },
    }

    const lines = [
      { type: 'system', subtype: 'init', cwd: 'C:/project' },
      {
        type: 'stream_event',
        event: {
          content_block: {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'bun test', cwd: 'C:/project' },
          },
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: 'src/report.md' } },
            { type: 'text', text: '完成' },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: '全部完成' },
    ].map((line) => JSON.stringify(line))
    let buffer = __codeAgentAdapterTestHooks.consumeClaudeStreamJson(
      `${lines[0]}\n${lines[1]!.slice(0, 30)}`,
      '',
      handlers,
    )
    buffer = __codeAgentAdapterTestHooks.consumeClaudeStreamJson(
      `${lines[1]!.slice(30)}\n${lines[2]}\n${lines[3]}`,
      buffer,
      handlers,
    )
    buffer = __codeAgentAdapterTestHooks.consumeClaudeStreamJson('\n', buffer, handlers)

    expect(commands).toEqual([{ command: 'bun test', cwd: 'C:/project' }])
    expect(files).toEqual([{ path: 'src/report.md', status: 'created' }])
    expect(toolCalls.map((item) => item.name)).toEqual(['Bash', 'Write'])
    expect(text).toBe('完成')
    expect(logs.map((item) => item.text)).toContain('全部完成')
    expect(buffer).toBe('')
    expect(__codeAgentAdapterTestHooks.extractClaudeResultMessage(lines.join('\n'))).toBe(
      '全部完成',
    )
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
      const proc = Bun.spawn(['git', ...args], {
        cwd: branchCtx.worktreePath,
        stdout: 'pipe',
        stderr: 'pipe',
      })
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
  }, 15_000)
})
