import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let app: { request: (input: string, init?: RequestInit) => Promise<Response> }
let dbApi: typeof import('../packages/db/src/index')
let originalFetch: typeof fetch
let globalMockedFetch: typeof fetch

setDefaultTimeout(30000)

beforeAll(async () => {
  if (process.env.AGENTHUB_TEST_PRELOADED !== '1') {
    const tempDir = mkdtempSync(join(tmpdir(), 'agenthub-smoke-'))
    process.env.DATABASE_URL = join(tempDir, 'agenthub-smoke.db')
  }
  process.env.LLM_API_KEY = 'test-key'
  process.env.OPENAI_API_KEY = ''
  process.env.ANTHROPIC_API_KEY = ''
  process.env.ENABLE_LOCAL_CLI_PROBES = 'false'
  process.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'
  process.env.AGENTHUB_SKIP_LEGACY_SCHEMA = '1'
  Bun.env.ENABLE_LOCAL_CLI_PROBES = 'false'
  Bun.env.ENABLE_CODEX_CHATGPT_AUTH = 'false'

  dbApi = await import('../packages/db/src/index')
  migrate(dbApi.db, { migrationsFolder: resolve('packages/db/drizzle') })
  await dbApi.db.insert(dbApi.users).values({
    id: 'default-user',
    email: 'local@agenthub.local',
    username: 'You',
    passwordHash: 'test-only',
  }).onConflictDoNothing()
  ;({ app } = await import('../apps/server/src/app'))
  originalFetch = globalThis.fetch
  globalMockedFetch = async (input, init) => {
    const url = fetchInputUrl(input)
    if (url.includes('/chat/completions') || url.includes('/v1/messages')) {
      return mockLlmResponse(url, await fetchInputInit(input, init))
    }
    return originalFetch(input, init)
  }
  globalThis.fetch = globalMockedFetch
})

function fetchInputUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

async function fetchInputInit(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  if (init?.body || !(input instanceof Request)) return init
  const body = await input.clone().text().catch(() => '')
  return {
    ...init,
    body,
  }
}

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
        const data = JSON.stringify({
          choices: [{ delta: { content: chunk }, index: 0 }],
        })
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

function mockSseJsonResponse(content: string) {
  return mockSseStream([content])
}

function mockLlmResponse(url: string, init?: RequestInit) {
  const body = parseRequestJson(init)
  const prompt = collectPromptText(body)

  if (prompt.includes('你是 AgentHub 群聊里的主 Agent（Orchestrator）。')) {
    return mockSseJsonResponse(
      JSON.stringify({
        action: 'plan',
        message: '我先拆解任务并安排成员协作。',
        reason: '用户提出了需要多 Agent 协作完成的工作目标',
      }),
    )
  }

  if (prompt.includes('你是 AgentHub 的 Agent 草案生成器。')) {
    return mockSseJsonResponse(
      JSON.stringify({
        name: 'Codex Frontend',
        role: '前端实现',
        roleType: 'coder',
        description: '使用 Codex 完成前端实现和 workspace 文件修改。',
        avatar: null,
        systemPrompt: '你负责按用户目标实现前端代码，完成后说明变更和验证结果。',
        roleProfile: null,
        color: '#2563eb',
        modelId: null,
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
        capabilityTags: ['frontend', 'implementation'],
        toolPermissions: ['chat', 'workspace:read', 'workspace:write'],
        sandboxPolicy: 'workspace-write',
        contextPolicy: 'workspace-aware',
        autoInvoke: true,
        approvalRequired: false,
      }),
    )
  }

  if (prompt.includes('Create a concise multi-agent execution plan') || prompt.includes('Return strict JSON only. Do not include Markdown fences or explanations.')) {
    const agentKey = extractPlannerAgentKey(body)
    return mockSseJsonResponse(
      JSON.stringify({
        collaborationMode: 'pipeline',
        title: '贪吃蛇游戏协作计划',
        summary: '由 Builder 完成核心实现。',
        phases: [
          {
            id: 'build',
            title: '实现',
            purpose: '完成游戏主体',
            taskIds: ['task-build'],
          },
        ],
        tasks: [
          {
            id: 'task-build',
            phaseId: 'build',
            title: '实现贪吃蛇游戏',
            description: '创建游戏主体、交互和基础样式。',
            agentKey,
            taskType: 'code',
            dependencies: [],
            maxRetries: 1,
          },
        ],
      }),
    )
  }

  if (body.stream !== true) {
    if (url.includes('/v1/messages')) {
      return Response.json({ content: [{ type: 'text', text: 'Task completed successfully.' }] })
    }
    return Response.json({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Task completed successfully.' },
          finish_reason: 'stop',
        },
      ],
    })
  }
  return mockSseStream(['Task completed successfully.'])
}

function parseRequestJson(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {}
  try {
    const parsed = JSON.parse(init.body)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function collectPromptText(body: Record<string, unknown>) {
  const system = typeof body.system === 'string' ? body.system : ''
  const messages = Array.isArray(body.messages) ? body.messages : []
  const text = messages
    .map((message) => {
      if (!message || typeof message !== 'object') return ''
      const item = message as { content?: unknown }
      return collectContentText(item.content)
    })
    .join('\n')
  const responsesInput = Array.isArray(body.input)
    ? body.input
        .map((message) => {
          if (!message || typeof message !== 'object') return ''
          const item = message as { content?: unknown }
          return collectContentText(item.content)
        })
        .join('\n')
    : ''
  return `${system}\n${text}\n${responsesInput}`
}

function collectContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const item = part as { text?: unknown; content?: unknown }
      if (typeof item.text === 'string') return item.text
      if (typeof item.content === 'string') return item.content
      return ''
    })
    .join('\n')
}

function extractPlannerAgentKey(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (typeof content !== 'string') continue
    try {
      const parsed = JSON.parse(content) as {
        agents?: Array<{ key?: unknown; roleType?: unknown; name?: unknown }>
      }
      const agents = Array.isArray(parsed.agents) ? parsed.agents : []
      const coder = agents.find((agent) => agent.roleType === 'coder')
      const first = coder ?? agents[0]
      if (typeof first?.key === 'string' && first.key) return first.key
    } catch {
      // Not the planner JSON payload.
    }
  }
  return 'builder'
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

describe('AgentHub smoke tests', () => {
  test('health endpoint responds', async () => {
    const body = await json<{ status: string; version: string }>(await app.request('/health'))
    expect(body.status).toBe('ok')
    expect(body.version).toBe('0.1.0')
  })

  test('database enforces collaboration foreign keys', () => {
    const sqlite = new Database(dbApi.databasePath ?? process.env.DATABASE_URL!)
    sqlite.exec('PRAGMA foreign_keys = ON;')

    const foreignKeys = (table: string) =>
      sqlite
        .query(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((row) => {
          const fk = row as { from: string; table: string; to: string; on_delete: string }
          return `${fk.from}->${fk.table}.${fk.to}:${fk.on_delete}`
        })

    expect(foreignKeys('sessions')).toContain('workspace_id->workspaces.id:SET NULL')
    expect(foreignKeys('sessions')).toContain('workspace_agent_id->workspace_agents.id:SET NULL')
    expect(foreignKeys('workspace_tasks')).toContain('session_id->sessions.id:SET NULL')
    expect(foreignKeys('workspace_tasks')).toContain('run_id->orchestrator_runs.id:CASCADE')
    expect(foreignKeys('workspace_tasks')).toContain('agent_id->workspace_agents.id:SET NULL')
    expect(foreignKeys('execution_logs')).toContain('run_id->orchestrator_runs.id:CASCADE')

    const now = Date.now()
    const workspaceId = 'integrity-workspace'
    sqlite
      .query(
        `INSERT INTO workspaces (id, owner_id, name, goal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(workspaceId, 'default-user', 'Integrity workspace', '', now, now)

    let rejected = false
    try {
      sqlite
        .query(
          `INSERT INTO workspace_tasks (
            id, workspace_id, title, description, status, session_id, run_id,
            order_idx, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'integrity-task',
          workspaceId,
          'Invalid task',
          'Should be rejected by DB constraints',
          'pending',
          'missing-session',
          'missing-run',
          0,
          now,
          now,
        )
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
    sqlite.close()
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

  test('development reset clears application data and reseeds the default user', async () => {
    const now = new Date()
    const workspaceId = 'reset-workspace'
    const sessionId = 'reset-session'
    const agentId = 'reset-workspace-agent'
    const reviewerId = 'reset-reviewer-agent'
    const runId = 'reset-run'
    const taskId = 'reset-task'
    const legacyAgentId = 'reset-legacy-agent'

    await dbApi.db.insert(dbApi.workspaces).values({
      id: workspaceId,
      ownerId: 'default-user',
      name: 'Reset workspace',
      goal: 'Reset smoke data',
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.sessions).values({
      id: sessionId,
      title: 'Reset group',
      type: 'group',
      ownerId: 'default-user',
      workspaceId,
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.workspaceAgents).values([
      { id: agentId, workspaceId, name: 'Reset Agent', role: 'Coder', createdAt: now },
      { id: reviewerId, workspaceId, name: 'Reset Reviewer', role: 'Reviewer', createdAt: now },
    ])
    await dbApi.db.insert(dbApi.workspaceAgentRelations).values({
      workspaceId,
      sourceAgentId: agentId,
      targetAgentId: reviewerId,
      relationType: 'reviewed_by',
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.orchestratorRuns).values({
      id: runId,
      workspaceId,
      groupSessionId: sessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.workspaceTasks).values({
      id: taskId,
      workspaceId,
      agentId,
      title: 'Reset task',
      description: 'Reset smoke task',
      status: 'running',
      sessionId,
      runId,
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.messages).values({
      sessionId,
      senderId: 'default-user',
      senderType: 'user',
      type: 'text',
      content: 'reset me',
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.sessionMembers).values({
      sessionId,
      memberId: agentId,
      memberType: 'agent',
      joinedAt: now,
    })
    await dbApi.db.insert(dbApi.workspaceStates).values({
      workspaceId,
      state: '{}',
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.blackboardEntries).values({
      namespace: runId,
      key: 'reset',
      value: { ok: true },
      agentId,
      taskId,
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.taskClarifications).values({
      runId,
      taskId,
      agentId,
      question: 'Reset?',
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.orchestratorRunControls).values({
      runId,
      action: 'pause',
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.executionLogs).values({
      runId,
      sessionId,
      agentId,
      taskId,
      type: 'task_start',
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.agents).values({
      id: legacyAgentId,
      name: 'Legacy Agent',
      provider: 'openai',
      model: 'mock-model',
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.tasks).values({
      sessionId,
      agentId: legacyAgentId,
      title: 'Legacy task',
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.settings).values({
      key: 'RESET_SMOKE',
      value: 'dirty',
      updatedAt: now,
    })

    await json<{ success: boolean }>(
      await postJson('/api/settings/reset-all-data', { confirm: 'RESET_AGENTHUB_DATA' }),
    )

    const emptyTables = [
      dbApi.sessions,
      dbApi.messages,
      dbApi.sessionMembers,
      dbApi.workspaces,
      dbApi.workspaceStates,
      dbApi.workspaceAgents,
      dbApi.workspaceAgentRelations,
      dbApi.workspaceTasks,
      dbApi.orchestratorRuns,
      dbApi.orchestratorRunEvents,
      dbApi.taskClarifications,
      dbApi.orchestratorRunControls,
      dbApi.blackboardEntries,
      dbApi.executionLogs,
      dbApi.agents,
      dbApi.tasks,
      dbApi.settings,
    ]

    for (const table of emptyTables) {
      expect(await dbApi.db.select().from(table)).toHaveLength(0)
    }
    const userRows = await dbApi.db.select().from(dbApi.users)
    expect(userRows).toHaveLength(1)
    expect(userRows[0]?.id).toBe('default-user')
  })

  test('legacy cleanup removes old entries while preserving valid group task sessions', async () => {
    const now = new Date()
    const workspaceId = 'cleanup-workspace'
    const agentId = 'cleanup-agent'
    const groupSessionId = 'cleanup-group'
    const validChildSessionId = 'cleanup-valid-child'
    const legacyChildSessionId = 'cleanup-legacy-child'
    const hiddenChildSessionId = 'cleanup-hidden-child'
    const runId = 'cleanup-run'
    const validTaskId = 'cleanup-valid-task'
    const staleTaskId = 'cleanup-stale-task'
    const legacyAgentId = 'cleanup-legacy-agent'

    await dbApi.db.insert(dbApi.workspaces).values({
      id: workspaceId,
      ownerId: 'default-user',
      name: 'Cleanup workspace',
      goal: 'Cleanup smoke data',
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.workspaceAgents).values({
      id: agentId,
      workspaceId,
      name: 'Cleanup Agent',
      role: 'Coder',
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.sessions).values([
      {
        id: groupSessionId,
        title: 'Cleanup group',
        type: 'group',
        ownerId: 'default-user',
        workspaceId,
        metadata: { kind: 'workspace-agent-group', agentIds: [agentId] },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: validChildSessionId,
        title: 'Cleanup Agent / Task',
        type: 'direct',
        ownerId: 'default-user',
        workspaceId,
        workspaceAgentId: agentId,
        metadata: {
          kind: 'orchestrator-task',
          orchestratorRunId: runId,
          orchestratorTaskId: validTaskId,
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: legacyChildSessionId,
        title: 'Cleanup workspace / Agent',
        type: 'direct',
        ownerId: 'default-user',
        workspaceId,
        workspaceAgentId: agentId,
        metadata: { kind: 'workspace-agent-child' },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: hiddenChildSessionId,
        title: 'Hidden generated child',
        type: 'direct',
        ownerId: 'default-user',
        workspaceId,
        workspaceAgentId: agentId,
        metadata: { hiddenFromSessionTree: true, orchestratorRunId: runId },
        createdAt: now,
        updatedAt: now,
      },
    ])
    await dbApi.db.insert(dbApi.orchestratorRuns).values({
      id: runId,
      workspaceId,
      groupSessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.workspaceTasks).values([
      {
        id: validTaskId,
        workspaceId,
        agentId,
        title: 'Valid task',
        description: 'Should remain',
        status: 'running',
        sessionId: validChildSessionId,
        runId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: staleTaskId,
        workspaceId,
        agentId,
        title: 'Stale task',
        description: 'Old task without run',
        status: 'pending',
        sessionId: legacyChildSessionId,
        createdAt: now,
        updatedAt: now,
      },
    ])
    await dbApi.db.insert(dbApi.messages).values({
      sessionId: legacyChildSessionId,
      senderId: agentId,
      senderType: 'agent',
      type: 'text',
      content: 'legacy',
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.sessionMembers).values({
      sessionId: legacyChildSessionId,
      memberId: agentId,
      memberType: 'agent',
      joinedAt: now,
    })
    await dbApi.db.insert(dbApi.agents).values({
      id: legacyAgentId,
      name: 'Legacy Agent',
      provider: 'openai',
      model: 'mock-model',
      createdAt: now,
    })
    await dbApi.db.insert(dbApi.tasks).values({
      sessionId: groupSessionId,
      agentId: legacyAgentId,
      title: 'Legacy task table row',
      createdAt: now,
      updatedAt: now,
    })
    await dbApi.db.insert(dbApi.settings).values({
      key: 'AGENT_LIBRARY',
      value: JSON.stringify({
        schemaVersion: 2,
        agents: [
          {
            id: 'placeholder-agent',
            name: 'New Agent',
            role: '协作',
            description: '描述这个 Agent 的职责、产出和适合处理的任务。',
            systemPrompt: '你是 AgentHub 中的协作 Agent。先理解目标，再给出清晰、可执行的结果。',
          },
        ],
        relations: [],
      }),
      updatedAt: now,
    })

    const result = await json<{ deletedSessions: number; deletedWorkspaceTasks: number }>(
      await postJson('/api/settings/cleanup-legacy-data', {}),
    )

    expect(result.deletedSessions).toBe(2)
    expect(result.deletedWorkspaceTasks).toBe(1)
    const remainingSessions = await dbApi.db.select().from(dbApi.sessions)
    expect(remainingSessions.map((session) => session.id).sort()).toEqual([
      groupSessionId,
      validChildSessionId,
    ].sort())
    expect(await dbApi.db.select().from(dbApi.workspaceTasks)).toHaveLength(1)
    expect(await dbApi.db.select().from(dbApi.tasks)).toHaveLength(0)
    expect(await dbApi.db.select().from(dbApi.agents)).toHaveLength(0)
    const libraryRows = await dbApi.db
      .select()
      .from(dbApi.settings)
      .where(dbApi.eq(dbApi.settings.key, 'AGENT_LIBRARY'))
    expect(libraryRows).toHaveLength(0)
  })

  test('settings model test can be mocked without real credentials', async () => {
    globalThis.fetch = async (input, init) => {
      const url = fetchInputUrl(input)
      if (url === 'https://mock.local/v1/chat/completions') {
        const nextInit = await fetchInputInit(input, init)
        const body = JSON.parse(String(nextInit?.body ?? '{}')) as { model?: string }
        expect(body.model).toBe('mock-model')
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { role: 'assistant', content: 'OK' },
            },
          ],
        }), {
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
      }),
    )

    expect(full.workspace.id).toBeTruthy()
    expect(full.workspace.name).toBe('Auto workspace smoke')
    expect(full.workspace.projectPath?.startsWith(workspaceRoot)).toBe(true)
    expect(existsSync(full.workspace.projectPath!)).toBe(true)
  })

  test('agent workdir stays isolated from workspace files', async () => {
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
    expect(existsSync(join(workdir!.executionPath, 'index.html'))).toBe(false)
    expect(existsSync(join(workdir!.executionPath, 'node_modules', 'ignored.txt'))).toBe(false)
  })

  test('workspace creation does not auto-seed default agents and relations', async () => {
    const full = await json<{
      workspace: { id: string }
      agents: Array<{ id: string; name: string; roleType: string }>
      agentRelations: Array<{ sourceAgentId: string; targetAgentId: string; relationType: string }>
    }>(
      await postJson('/api/workspaces', {
        name: 'Role relation workspace',
        goal: 'Coordinate agents by role',
      }),
    )

    expect(full.agents).toEqual([])
    expect(full.agentRelations).toEqual([])

    const orchestrator = await json<{ id: string; roleType: string }>(
      await postJson(`/api/workspaces/${full.workspace.id}/agents`, {
        name: 'Orchestrator',
        role: '总指挥',
        roleType: 'orchestrator',
      }),
    )
    const coder = await json<{ id: string; roleType: string }>(
      await postJson(`/api/workspaces/${full.workspace.id}/agents`, {
        name: 'Builder',
        role: '实现',
        roleType: 'coder',
      }),
    )
    const reviewer = await json<{ id: string; roleType: string }>(
      await postJson(`/api/workspaces/${full.workspace.id}/agents`, {
        name: 'QA Reviewer',
        role: '验收',
        roleType: 'reviewer',
      }),
    )

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

  test('confirmed member proposal can continue into a dynamic DAG run', async () => {
    const { CORE_AGENT_EXPERT_PROFILES } = await import('../packages/shared/src/expert-profiles')
    const productProfile = CORE_AGENT_EXPERT_PROFILES.find((profile) => profile.id === 'product-manager')
    expect(productProfile).toBeTruthy()

    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Proposal continue workspace',
        goal: 'Continue after adding members',
      }),
    )
    const orchestrator = await createLlmWorkspaceAgent(full.workspace.id, {
      name: 'Orchestrator',
      role: '协调者',
      roleType: 'orchestrator',
    })
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )
    const goal = '规划一个课程学习产品的需求和交付路径'
    await json<{ id: string }>(
      await postJson(`/api/messages/${group.session.id}`, {
        content: goal,
        type: 'text',
        metadata: { skipAgentReply: true },
      }),
    )
    const [proposalCard] = await dbApi.db
      .insert(dbApi.messages)
      .values({
        sessionId: group.session.id,
        senderId: orchestrator.id,
        senderType: 'agent',
        type: 'text',
        content: '当前群聊缺少产品拆解能力，建议补充产品经理。',
        metadata: {
          systemEvent: 'orchestrator_decision',
          orchestratorDecision: 'clarify',
          memberProposalStatus: 'pending',
          memberProposalGoal: goal,
          memberProposals: [
            {
              expertProfileId: productProfile!.id,
              name: productProfile!.name,
              role: productProfile!.role,
              category: productProfile!.category,
              runtimeType: productProfile!.runtimeType,
              codeAgentType: productProfile!.codeAgentType ?? null,
              color: productProfile!.color,
              capabilityTags: productProfile!.capabilityTags,
              reason: '需要产品目标拆解',
              expectedContribution: '补齐需求分析和范围界定',
            },
          ],
        },
      })
      .returning()

    const confirmed = await json<{ agents: Array<{ id: string; roleType: string }>; message: any }>(
      await postJson(
        `/api/messages/${group.session.id}/member-proposals/${proposalCard!.id}/confirm`,
        { profileIds: [productProfile!.id] },
      ),
    )
    expect(confirmed.agents).toHaveLength(1)
    expect(confirmed.message.metadata.memberProposalStatus).toBe('confirmed')

    const continued = await json<{ started: boolean; message: any }>(
      await postJson(
        `/api/messages/${group.session.id}/member-proposals/${proposalCard!.id}/continue`,
        {},
      ),
    )
    expect(continued.started).toBe(true)
    expect(continued.message.metadata.memberProposalContinueStatus).toBe('running')

    let runs: any[] = []
    let tasks: any[] = []
    let proposalMessage: any
    for (let i = 0; i < 120; i++) {
      runs = await dbApi.db
        .select()
        .from(dbApi.orchestratorRuns)
        .where(dbApi.eq(dbApi.orchestratorRuns.groupSessionId, group.session.id))
      const run = runs[0]
      if (run) {
        tasks = await dbApi.db
          .select()
          .from(dbApi.workspaceTasks)
          .where(dbApi.eq(dbApi.workspaceTasks.runId, run.id))
        const [latestProposalMessage] = await dbApi.db
          .select()
          .from(dbApi.messages)
          .where(dbApi.eq(dbApi.messages.id, proposalCard!.id))
          .limit(1)
        proposalMessage = latestProposalMessage
        if (
          tasks.length > 0 &&
          latestProposalMessage?.metadata?.memberProposalContinueStatus === 'completed'
        ) {
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(runs.length).toBeGreaterThan(0)
    expect(tasks.length).toBeGreaterThan(0)
    expect(proposalMessage?.metadata?.memberProposalContinueStatus).toBe('completed')
    expect(proposalMessage?.metadata?.continuedRunId).toBe(runs[0]!.id)

    const agUiEvents = await json<{ items: Array<{ name?: string; value?: any }> }>(
      await app.request(`/api/protocols/ag-ui/runs/${runs[0]!.id}/events`),
    )
    expect(
      agUiEvents.items.some(
        (event) =>
          event.name === 'agenthub.member_proposal.continue' &&
          event.value?.messageId === proposalCard!.id &&
          event.value?.status === 'completed',
      ),
    ).toBe(true)
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
        agentId: 'coder',
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
    expect(selection.score).toBe(100)
    expect(selection.rationale).toContain('Using Orchestrator-provided assignment')
  })

  test('agent router honors Orchestrator planning assignment without rerouting', async () => {
    const { selectAgentForTask } =
      await import('../apps/server/src/services/orchestrator/agent-router')
    const agents = [
      {
        id: 'designer',
        key: 'designer',
        name: 'Designer',
        role: '产品与视觉设计',
        roleType: 'designer',
        runtimeType: 'llm',
        capabilityTags: ['design', 'planning', 'requirements'],
        toolPermissions: ['workspace:read'],
        sandboxPolicy: 'read-only',
      },
      {
        id: 'builder',
        key: 'builder',
        name: 'Builder',
        role: '工程实现',
        roleType: 'coder',
        runtimeType: 'code-agent',
        codeAgentType: 'opencode',
        capabilityTags: ['code', 'implementation', 'workspace-write'],
        toolPermissions: ['workspace:read', 'workspace:write'],
        sandboxPolicy: 'workspace-write',
      },
    ]

    const selection = selectAgentForTask({
      task: {
        id: 'scope',
        title: '梳理目标与交付范围',
        description: '围绕「帮我开发一个贪吃蛇游戏」定义目标、交付物、边界和验收标准。',
        agentId: 'designer',
        dependencies: [],
        maxRetries: 1,
      },
      agents: agents as any,
    })

    expect(selection.selectedAgentKey).toBe('designer')
  })

  test('orchestrator decision routes build requests to planning', async () => {
    const { decideOrchestratorAction } = await import(
      '../apps/server/src/services/orchestrator/orchestrator-decision'
    )

    const decision = await decideOrchestratorAction({
      content: '开发一个坦克大战',
      agents: [
        {
          id: 'orchestrator',
          name: 'Orchestrator',
          roleType: 'orchestrator',
          runtimeType: 'llm',
        },
        {
          id: 'builder',
          name: 'Builder',
          roleType: 'coder',
          runtimeType: 'code-agent',
        },
      ] as any,
    })

    expect(decision.action).toBe('plan')
  })

  test('group build requests auto-start an orchestrator run instead of posting a plan card', async () => {
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Auto orchestration workspace',
        goal: 'Auto-start team collaboration',
        projectPath: process.cwd(),
      }),
    )
    await createLlmWorkspaceAgent(full.workspace.id, {
      name: 'Orchestrator',
      role: '总指挥',
      roleType: 'orchestrator',
      sandboxPolicy: 'read-only',
      systemPrompt: 'Coordinate the team briefly.',
    })
    const builder = await createLlmWorkspaceAgent(full.workspace.id, {
      name: 'Builder',
      role: '工程实现',
      roleType: 'coder',
      sandboxPolicy: 'read-only',
      systemPrompt: 'Complete the assigned task briefly.',
    })
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )

    await json<{ id: string }>(
      await postJson(`/api/messages/${group.session.id}`, {
        content: '帮我做一个贪吃蛇游戏',
        type: 'text',
      }),
    )

    let runs = await dbApi.db
      .select()
      .from(dbApi.orchestratorRuns)
      .where(dbApi.eq(dbApi.orchestratorRuns.groupSessionId, group.session.id))
    let tasks: any[] = []
    for (let i = 0; i < 120; i++) {
      runs = await dbApi.db
        .select()
        .from(dbApi.orchestratorRuns)
        .where(dbApi.eq(dbApi.orchestratorRuns.groupSessionId, group.session.id))
      const run = runs[0]
      if (run) {
        tasks = await dbApi.db
          .select()
          .from(dbApi.workspaceTasks)
          .where(dbApi.eq(dbApi.workspaceTasks.runId, run.id))
        if (tasks.length > 0) break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const { items } = await json<{ items: Array<{ type: string; content: string; metadata?: any }> }>(
      await app.request(`/api/messages/${group.session.id}`),
    )
    const handoffMessage = items.find(
      (message) => message.metadata?.systemEvent === 'orchestrator_handoff',
    )
    const thinkingMessage = items.find(
      (message) => message.metadata?.systemEvent === 'orchestrator_thinking',
    )
    const planCard = items.find((message) => message.type === 'task_card')

    expect(thinkingMessage).toBeUndefined()
    expect(handoffMessage).toBeUndefined()
    expect(planCard).toBeUndefined()

    expect(runs.length).toBeGreaterThan(0)
    const run = runs[0]!
    expect(['running', 'synthesizing', 'completed', 'failed']).toContain(run.status)

    expect(tasks.length).toBeGreaterThan(0)
    for (const task of tasks) {
      expect(task.sessionId).toBeTruthy()
      const [taskSession] = await dbApi.db
        .select()
        .from(dbApi.sessions)
        .where(dbApi.eq(dbApi.sessions.id, task.sessionId!))
        .limit(1)
      expect(taskSession?.metadata?.kind).toBe('orchestrator-task')
      expect(taskSession?.workspaceAgentId).toBeTruthy()
    }

    const childSessions = await dbApi.db
      .select()
      .from(dbApi.sessions)
      .where(
        dbApi.eq(dbApi.sessions.workspaceAgentId, builder.id),
      )
    expect(childSessions.some((session) => session.metadata?.kind === 'orchestrator-task')).toBe(true)
    expect(childSessions.every((session) => session.metadata?.kind === 'orchestrator-task')).toBe(true)

    let childMessageCount = 0
    for (let i = 0; i < 30; i++) {
      const messagesByTask = await Promise.all(
        tasks.map((task) =>
          dbApi.db
            .select()
            .from(dbApi.messages)
            .where(dbApi.eq(dbApi.messages.sessionId, task.sessionId!)),
        ),
      )
      childMessageCount = messagesByTask.reduce((count, list) => count + list.length, 0)
      if (childMessageCount > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(childMessageCount).toBeGreaterThan(0)
  })

  test('task.queued events persist dynamic tasks into the run ledger and plan', async () => {
    const { initializeRunLedger, updateProgressLedgerFromEvent } = await import(
      '../apps/server/src/services/orchestrator/run-ledger'
    )
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Dynamic task ledger workspace',
        goal: 'Track dynamic tasks',
      }),
    )
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )

    const runId = crypto.randomUUID()
    const initialPlan = initializeRunLedger({
      runId,
      title: 'Dynamic task test',
      goal: 'Ensure queued tasks are durable',
      phases: [{ id: 'analysis', title: '分析', purpose: '理解目标', taskIds: [] }],
      agents: [],
      tasks: [],
    })
    await dbApi.db.insert(dbApi.orchestratorRuns).values({
      id: runId,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      status: 'running',
      plan: initialPlan as any,
    })

    await updateProgressLedgerFromEvent({
      runId,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      taskId: 'dynamic-review',
      agentId: 'reviewer-agent',
      type: 'task.queued',
      payload: {
        phaseId: 'verification',
        title: '复核动态产物',
        description: '检查动态追加任务是否可恢复。',
        taskType: 'review',
        dependencies: ['worker-task'],
      },
    })

    const [run] = await dbApi.db
      .select()
      .from(dbApi.orchestratorRuns)
      .where(dbApi.eq(dbApi.orchestratorRuns.id, runId))
      .limit(1)
    const plan = run!.plan as any
    expect(plan.tasks.some((task: any) => task.id === 'dynamic-review')).toBe(true)
    expect(plan.phases.find((phase: any) => phase.id === 'verification')?.taskIds).toContain(
      'dynamic-review',
    )
    expect(plan.taskLedger.tasks.find((task: any) => task.id === 'dynamic-review')?.status).toBe(
      'pending',
    )
    expect(
      plan.taskLedger.agentAssignments.find((item: any) => item.agentId === 'reviewer-agent')
        ?.taskIds,
    ).toContain('dynamic-review')
    expect(plan.progressLedger.pendingTaskIds).toContain('dynamic-review')
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
      taskType: 'code' as const,
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

  test('task output contract treats model semantic blackboard keys as advisory', async () => {
    const { normalizeTaskOutputContract } =
      await import('../apps/server/src/services/orchestrator/planner')
    const { validateTaskOutputContract } =
      await import('../apps/server/src/services/orchestrator/task-contract')
    const taskId = 'design-task'
    const outputContract = normalizeTaskOutputContract(
      {
        requiredBlackboardWrites: [{ key: 'design_spec', schemaType: 'task_output' }],
        requiredArtifacts: ['design_document.md'],
      },
      taskId,
    )

    expect(outputContract?.requiredBlackboardWrites).toEqual([
      { key: 'task_design-task_output', schemaType: 'task_output' },
    ])

    const result = validateTaskOutputContract({
      task: {
        id: taskId,
        title: 'Design task',
        description: 'Produce a design document.',
        agentId: 'agent-1',
        dependencies: [],
        maxRetries: 0,
        outputContract: {
          requiredBlackboardWrites: [{ key: 'design_spec', schemaType: 'task_output' }],
          requiredArtifacts: ['design_document.md'],
        },
      },
      artifacts: [{ kind: 'file', filePath: 'design_document.md' }],
      writtenBlackboardKeys: ['task_design-task_output'],
    })

    expect(result.status).toBe('passed')
  })

  test('planner JSON parsing tolerates comments without inventing fallback content', async () => {
    const { extractJsonObject, parseJsonObject } =
      await import('../apps/server/src/services/orchestrator/planner')
    const text = [
      'planner output:',
      '{',
      '  // model-added note',
      '  "title": "坦克大战",',
      '  "url": "https://example.com/a//b",',
      '  "tasks": [',
      '    { "id": "build", "dependencies": [], },',
      '  ],',
      '}',
      'done',
    ].join('\n')

    const json = extractJsonObject(text)
    expect(json).toBeTruthy()
    const parsed = parseJsonObject(json!) as { title?: string; url?: string; tasks?: unknown[] }
    expect(parsed.title).toBe('坦克大战')
    expect(parsed.url).toBe('https://example.com/a//b')
    expect(parsed.tasks).toHaveLength(1)
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
    await dbApi.db.insert(dbApi.workspaceTasks).values({
      id: 'protocol-task-a',
      workspaceId: full.workspace.id,
      title: 'Protocol task A',
      description: 'Expose this task through A2A.',
      status: 'running',
      sessionId: group.session.id,
      runId: run!.id,
      orderIdx: 0,
      artifacts: [{ id: 'artifact-a', kind: 'file', path: 'notes.md', title: 'notes.md' }],
    })

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

    const agUiEvents = await json<{ items: Array<{ type: string; name?: string; value?: Record<string, unknown> }> }>(
      await app.request(`/api/protocols/ag-ui/runs/${run!.id}/events`),
    )
    expect(agUiEvents.items.map((event) => event.type)).toContain('RUN_STARTED')
    expect(agUiEvents.items.some((event) => event.name === 'agenthub.task.status')).toBe(true)

    const a2aTasks = await json<{ items: Array<{ id: string; kind: string; status: { state: string } }> }>(
      await app.request(`/api/protocols/a2a/runs/${run!.id}/tasks`),
    )
    expect(a2aTasks.items[0]!.id).toBe('protocol-task-a')
    expect(a2aTasks.items[0]!.kind).toBe('task')
    expect(a2aTasks.items[0]!.status.state).toBe('working')
  })

  test('task result reports normalize artifacts and validation metadata', async () => {
    const { buildTaskResultReport, taskResultReportEventPayload } = await import(
      '../apps/server/src/services/orchestrator/orchestrator-engine'
    )

    const report = buildTaskResultReport({
      runId: 'report-run',
      task: {
        id: 'report-task',
        title: 'Report task',
        description: '',
        agentId: 'report-agent',
        dependencies: [],
        maxRetries: 0,
      } as any,
      agent: {
        id: 'report-agent',
        key: 'report-agent',
        name: 'Reporter',
        role: 'Coder',
        runtimeType: 'llm',
        capabilityTags: [],
        toolPermissions: [],
        sandboxPolicy: 'read-only',
      } as any,
      status: 'done' as any,
      summary: {
        filesCreated: ['apps/web/src/foo.ts'],
        filesModified: [],
        interfaces: [],
        dependencies: [],
        decisions: ['采用分层收口'],
        brief: '已完成收口',
      },
      outputRef: { key: 'task_report-task_output', version: 2 } as any,
      artifacts: [{ id: 'artifact-1', type: 'file', title: 'foo.ts', filePath: 'foo.ts' }],
      validationResults: [
        { command: 'bun test', status: 'passed', durationMs: 12, outputSummary: 'ok' } as any,
      ],
      contractResult: { status: 'passed', violations: [] } as any,
      durationMs: 1234,
      childSessionId: 'child-report',
      blackboardKeys: ['task_report-task_output', 'artifacts/artifact-1'],
    })

    expect(report.schemaType).toBe('task_result_report')
    expect(report.artifactCount).toBe(1)
    expect(report.validationStatus).toBe('passed')
    expect(report.blackboardKeys).toContain('task_report-task_output')

    const payload = taskResultReportEventPayload(report)
    expect(payload.taskResultReport).toBe(report)
    expect(payload.artifactCount).toBe(1)
    expect(payload.childSessionId).toBe('child-report')
  })

  test('orchestrator run can be cancelled and marks unfinished tasks', async () => {
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Cancel run workspace',
        goal: 'Cancel run',
      }),
    )
    const runAgent = await createLlmWorkspaceAgent(full.workspace.id, {
      name: 'Architect',
      role: '规划',
      roleType: 'architect',
    })
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )
    const agentId = runAgent.id
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
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Ledger workspace',
        goal: 'Trace ledger',
      }),
    )
    const runAgent = await createLlmWorkspaceAgent(full.workspace.id, {
      name: 'Architect',
      role: '规划',
      roleType: 'architect',
    })
    const group = await json<{ session: { id: string } }>(
      await postJson(`/api/workspaces/${full.workspace.id}/group-session`, {}),
    )

    const plan = {
      runId: crypto.randomUUID(),
      title: 'Ledger run',
      goal: 'Track progress ledger',
      agents: [{ id: runAgent.id, key: 'architect', name: 'Architect', role: 'Plan' }],
      phases: [
        { id: 'analysis', title: 'Analysis', purpose: 'Understand scope', taskIds: ['scan'] },
      ],
      tasks: [
        {
          id: 'scan',
          phaseId: 'analysis',
          title: 'Scan',
          description: 'Inspect scope',
          agentId: runAgent.id,
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
      agentId: runAgent.id,
      type: 'task.started',
      payload: { title: 'Scan' },
    })
    await emitRunEvent({
      runId: run!.id,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      taskId: 'scan',
      agentId: runAgent.id,
      type: 'blackboard.written',
      payload: { key: 'task_scan_output', summary: 'Scoped' },
    })
    await emitRunEvent({
      runId: run!.id,
      workspaceId: full.workspace.id,
      groupSessionId: group.session.id,
      taskId: 'scan',
      agentId: runAgent.id,
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
    const full = await json<{ workspace: { id: string } }>(
      await postJson('/api/workspaces', {
        name: 'Typed blackboard workspace',
        goal: 'Trace typed entries',
      }),
    )
    const runAgent = await createLlmWorkspaceAgent(full.workspace.id, {
      name: 'Researcher',
      role: '调研',
      roleType: 'researcher',
    })
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
          sourceAgentId: runAgent.id,
          taskId: 'scan',
          source: 'agent',
        },
        agentId: runAgent.id,
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
        sourceAgentId: runAgent.id,
        taskId: 'scan',
        fact: 'Server uses Hono routes.',
        source: 'agent',
      },
      agentId: runAgent.id,
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
    expect(body.items[0]!.agentId).toBe(runAgent.id)
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

  test('OpenCode adapter keeps prompt message before attached prompt file', async () => {
    const { __codeAgentAdapterTestHooks } =
      await import('../apps/server/src/services/code-agent-adapter')

    const args = __codeAgentAdapterTestHooks.buildOpencodeArgs('Read attached task prompt', {
      cwd: 'C:/project',
      modelId: 'deepseek-chat',
      modelProvider: 'deepseek',
      sandboxPolicy: 'read-only',
      promptFile: 'C:/tmp/agenthub-task.md',
    })

    expect(args[0]).toBe('run')
    expect(args).toContain('--file')
    expect(args[args.indexOf('--file') + 1]).toBe('C:/tmp/agenthub-task.md')
    expect(args.indexOf('Read attached task prompt')).toBeLessThan(args.indexOf('--file'))
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
  }, 60_000)
})
