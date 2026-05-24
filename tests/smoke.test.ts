import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { mkdtempSync } from 'node:fs'
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
})
