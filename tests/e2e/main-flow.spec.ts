import { expect, test, type Page, type Request, type Route } from '@playwright/test'

const now = '2026-06-04T12:00:00.000Z'

type Session = {
  id: string
  ownerId: string
  title: string
  type: 'direct' | 'group'
  workspaceId?: string | null
  workspaceAgentId?: string | null
  metadata?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  lastMessage?: { content: string; senderType: string } | null
}

type Message = {
  id: string
  sessionId: string
  senderId: string
  senderType: 'user' | 'agent' | 'system'
  type: 'text'
  content: string
  metadata: Record<string, unknown> | null
  replyToMessageId?: string | null
  createdAt: string
}

type Workspace = {
  id: string
  ownerId: string
  name: string
  goal: string
  projectPath: string | null
  createdAt: string
  updatedAt: string
}

type WorkspaceAgent = {
  id: string
  workspaceId: string
  name: string
  role: string
  roleType: string
  description: string
  avatar: string | null
  systemPrompt: string
  roleProfile: Record<string, unknown> | null
  color: string
  modelId: string | null
  runtimeType: string
  codeAgentType: string | null
  capabilityTags: string[]
  skillIds: string[]
  toolPermissions: string[]
  sandboxPolicy: string
  contextPolicy: string
  autoInvoke: boolean
  approvalRequired: boolean
  orderIdx: number
  createdAt: string
}

const savedAgent = {
  id: 'agent-coder',
  name: 'E2E Coder',
  role: 'Frontend',
  roleType: 'coder',
  description: 'Playwright main flow coding agent',
  avatar: null,
  systemPrompt: 'You are the E2E coding agent.',
  roleProfile: null,
  color: '#2563eb',
  modelId: null,
  runtimeType: 'code-agent',
  codeAgentType: 'codex',
  capabilityTags: ['frontend'],
  skillIds: [],
  toolPermissions: ['filesystem'],
  sandboxPolicy: 'workspace-write',
  contextPolicy: 'workspace-aware',
  autoInvoke: true,
  approvalRequired: false,
  createdAt: now,
  updatedAt: now,
}

const agentLibraryState = {
  schemaVersion: 2,
  agents: [savedAgent],
  relations: [],
}

test('main chat flow covers sessions, agents, quote, preview, diff and workspace files', async ({
  page,
}) => {
  const backend = await installAgentHubMock(page)

  await page.goto('/')

  await page.getByTestId('welcome-composer-input').fill('Build a tiny dashboard')
  await page.getByTestId('welcome-composer-send').click()

  await expect(page).toHaveURL(/\/chat\/session-main$/)
  await expect(page.getByTestId('message-user-main-1')).toContainText('Build a tiny dashboard')
  await expect(page.getByTestId('message-agent-main-1')).toContainText('Static Preview')

  await page.getByTestId('artifact-preview-button').first().click()
  await expect(page.getByTestId('artifact-preview-panel')).toBeVisible()
  await expect(page.getByTestId('artifact-preview-panel')).toContainText('Static Preview')

  await page.getByTestId('diff-apply-button').click()
  await page.getByTestId('confirm-dialog-confirm').click()
  await expect.poll(() => backend.appliedDiffs.length).toBe(1)
  await expect(page.getByTestId('diff-apply-button')).toBeDisabled()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('artifact-preview-panel')).toBeHidden()

  await page.getByTestId('sidebar-dock-agents').click()
  await page.getByTestId('agent-row-agent-coder').click()
  await expect(page).toHaveURL(/\/chat\/session-agent$/)

  await page.getByTestId('chat-composer-input').fill('Please inspect the workspace file.')
  await page.getByTestId('chat-composer-send').click()

  await expect(page.getByTestId('message-user-agent-1')).toContainText(
    'Please inspect the workspace file.',
  )
  await expect(page.getByTestId('message-agent-agent-1')).toContainText('Agent reply for')

  await page.getByTestId('message-agent-agent-1').hover()
  await page.getByTestId('message-quote-agent-agent-1').click()
  await page.getByTestId('chat-composer-input').fill('Use that as context.')
  await page.getByTestId('chat-composer-send').click()

  await expect(page.getByTestId('message-user-agent-2')).toContainText('Use that as context.')
  await expect(page.getByTestId('message-user-agent-2')).toContainText('Agent reply for')
  await expect(page.getByTestId('message-agent-agent-2')).toContainText('Agent reply for')

  await page.getByTestId('workspace-file-row-src/App.tsx').click()
  await page.getByTestId('workspace-file-open-preview').click()
  await expect(page.getByTestId('artifact-preview-panel')).toBeVisible()
  await expect(page.getByTestId('artifact-preview-panel')).toContainText('App.tsx')
})

async function installAgentHubMock(page: Page) {
  await page.addInitScript((libraryState) => {
    window.localStorage.setItem('agenthub.agentLibrary', JSON.stringify(libraryState))

    const sockets: Array<{
      readyState: number
      emit: (event: unknown) => void
      send: (payload: string) => void
      close: () => void
    }> = []

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      url: string
      readyState = FakeWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null

      constructor(url: string) {
        super()
        this.url = url
        sockets.push(this)
        window.setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN
          const event = new Event('open')
          this.onopen?.(event)
          this.dispatchEvent(event)
        }, 0)
      }

      send(_payload: string) {}

      close() {
        this.readyState = FakeWebSocket.CLOSED
        const event = new Event('close')
        this.onclose?.(event)
        this.dispatchEvent(event)
      }

      emit(event: unknown) {
        const message = new MessageEvent('message', { data: JSON.stringify(event) })
        this.onmessage?.(message)
        this.dispatchEvent(message)
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    })
    ;(window as any).__agenthubDispatchWs = (event: unknown) => {
      for (const socket of sockets) {
        if (socket.readyState === FakeWebSocket.OPEN) socket.emit(event)
      }
    }
  }, agentLibraryState)

  const workspaces = new Map<string, Workspace>()
  const agents = new Map<string, WorkspaceAgent[]>()
  const sessions: Session[] = []
  const messages = new Map<string, Message[]>()
  const appliedDiffs: string[] = []

  const mainWorkspace = makeWorkspace({
    id: 'workspace-main',
    goal: 'Main flow test workspace',
    name: 'E2E Workspace',
  })
  const mainAgent = makeWorkspaceAgent({
    id: 'workspace-agent-main',
    workspaceId: mainWorkspace.id,
    orderIdx: 0,
  })
  workspaces.set(mainWorkspace.id, mainWorkspace)
  agents.set(mainWorkspace.id, [mainAgent])

  function listSessions() {
    return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  function upsertSession(session: Session) {
    const index = sessions.findIndex((item) => item.id === session.id)
    if (index >= 0) sessions[index] = session
    else sessions.unshift(session)
    return session
  }

  function setLastMessage(sessionId: string, message: Message) {
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) return
    session.lastMessage = { content: message.content, senderType: message.senderType }
    session.updatedAt = message.createdAt
  }

  async function dispatchCompleted(message: Message) {
    await page.evaluate((payload) => {
      ;(window as any).__agenthubDispatchWs?.({
        type: 'message:completed',
        payload: { message: payload },
      })
    }, message)
  }

  function appendMessage(message: Message) {
    const list = messages.get(message.sessionId) ?? []
    list.push(message)
    messages.set(message.sessionId, list)
    setLastMessage(message.sessionId, message)
    return message
  }

  function makeUserMessage(
    sessionId: string,
    body: { content?: string; metadata?: Record<string, unknown> | null; type?: string },
  ) {
    const sessionMessages = messages.get(sessionId) ?? []
    const index = sessionMessages.filter((message) => message.senderType === 'user').length + 1
    const prefix = sessionId === 'session-main' ? 'main' : 'agent'
    const metadata = body.metadata ?? null
    return appendMessage({
      id: `user-${prefix}-${index}`,
      sessionId,
      senderId: 'default-user',
      senderType: 'user',
      type: 'text',
      content: body.content ?? '',
      metadata,
      replyToMessageId:
        metadata && typeof metadata.replyToMessageId === 'string'
          ? metadata.replyToMessageId
          : null,
      createdAt: new Date(Date.parse(now) + sessionMessages.length * 1000).toISOString(),
    })
  }

  function makeAgentMessage(sessionId: string, userContent: string) {
    const sessionMessages = messages.get(sessionId) ?? []
    const index = sessionMessages.filter((message) => message.senderType === 'agent').length + 1
    const prefix = sessionId === 'session-main' ? 'main' : 'agent'
    const artifacts =
      sessionId === 'session-main' && index === 1
        ? [
            {
              id: 'diff-app',
              type: 'diff',
              title: 'App.tsx change',
              description: 'A staged dashboard change',
              filePath: 'src/App.tsx',
              status: 'modified',
              diff:
                'diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-export const title = "old"\n+export const title = "new"\n',
            },
            {
              id: 'preview-web',
              type: 'preview',
              title: 'Static Preview',
              url: 'data:text/html,<h1>AgentHub E2E Preview</h1>',
              previewKind: 'static-html',
            },
          ]
        : []

    return appendMessage({
      id: `agent-${prefix}-${index}`,
      sessionId,
      senderId: 'workspace-agent-main',
      senderType: 'agent',
      type: 'text',
      content:
        sessionId === 'session-main'
          ? 'AgentHub Deploy completed. Static Preview is ready.'
          : `Agent reply for: ${userContent}`,
      metadata: {
        agentName: 'E2E Coder',
        runtimeType: 'code-agent',
        codeAgentType: 'codex',
        ...(artifacts.length ? { artifacts } : {}),
      },
      replyToMessageId: null,
      createdAt: new Date(Date.parse(now) + (sessionMessages.length + 1) * 1000).toISOString(),
    })
  }

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/, '') || '/'
    const method = request.method().toUpperCase()

    try {
      if (method === 'GET' && path === '/settings') {
        return json(route, {
          AGENT_LIBRARY: JSON.stringify(agentLibraryState),
        })
      }
      if (method === 'POST' && path === '/settings') return json(route, { success: true })
      if (method === 'POST' && path === '/coding-tools/lifecycle/startup') {
        return json(route, {
          items: [],
          message: 'ok',
          ok: true,
          repairedAgents: 0,
          settingsChanged: false,
        })
      }
      if (method === 'POST' && path === '/welcome/quick-prompts') {
        return json(route, {
          generatedAt: now,
          items: [],
          seed: 'e2e',
          source: 'unavailable',
        })
      }
      if (method === 'GET' && path === '/skills') return json(route, { items: [] })

      if (method === 'GET' && path === '/sessions') {
        return json(route, { items: listSessions() })
      }
      if (method === 'POST' && path === '/sessions') {
        const body = readJsonBody<Partial<Session>>(request, {})
        const isAgentDirect = body.metadata?.kind === 'agent-direct'
        const session = upsertSession({
          id: isAgentDirect ? 'session-agent' : 'session-main',
          ownerId: 'default-user',
          title: body.title ?? (isAgentDirect ? 'E2E Coder' : 'E2E Session'),
          type: body.type ?? 'direct',
          workspaceId: isAgentDirect ? body.workspaceId : 'workspace-main',
          workspaceAgentId: isAgentDirect ? body.workspaceAgentId : 'workspace-agent-main',
          metadata: body.metadata ?? null,
          createdAt: now,
          updatedAt: now,
          lastMessage: null,
        })
        if (!messages.has(session.id)) messages.set(session.id, [])
        return json(route, session)
      }
      const sessionMatch = path.match(/^\/sessions\/([^/]+)$/)
      if (sessionMatch && method === 'GET') {
        const session = sessions.find((item) => item.id === sessionMatch[1])
        return session ? json(route, session) : json(route, { error: 'not found' }, 404)
      }
      if (sessionMatch && method === 'PATCH') {
        const session = sessions.find((item) => item.id === sessionMatch[1])
        if (!session) return json(route, { error: 'not found' }, 404)
        const body = readJsonBody<Partial<Session>>(request, {})
        Object.assign(session, body, { updatedAt: now })
        return json(route, session)
      }

      const messagesMatch = path.match(/^\/messages\/([^/]+)$/)
      if (messagesMatch && method === 'GET') {
        return json(route, { items: messages.get(messagesMatch[1]) ?? [] })
      }
      if (messagesMatch && method === 'POST') {
        const sessionId = messagesMatch[1]!
        const body = readJsonBody<{
          content?: string
          metadata?: Record<string, unknown> | null
          type?: string
        }>(request, {})
        const userMessage = makeUserMessage(sessionId, body)
        const agentMessage = makeAgentMessage(sessionId, body.content ?? '')
        setTimeout(() => void dispatchCompleted(agentMessage), 30)
        return json(route, userMessage)
      }

      if (method === 'GET' && path === '/workspaces') {
        return json(route, { items: [...workspaces.values()] })
      }
      if (method === 'POST' && path === '/workspaces/auto') {
        const body = readJsonBody<{
          name?: string
          goal?: string
        }>(request, {})
        const workspace = makeWorkspace({
          id: 'workspace-agent',
          name: body.name ?? 'E2E Coder',
          goal: body.goal ?? 'Agent direct workspace',
        })
        workspaces.set(workspace.id, workspace)
        agents.set(workspace.id, [])
        return json(route, { workspace, agents: [], tasks: [], agentRelations: [] })
      }
      if (method === 'POST' && path === '/workspaces') {
        const body = readJsonBody<{
          name?: string
          goal?: string
          projectPath?: string | null
        }>(request, {})
        const workspace = makeWorkspace({
          id: `workspace-${workspaces.size + 1}`,
          name: body.name ?? 'Workspace',
          goal: body.goal ?? '',
          projectPath: body.projectPath,
        })
        workspaces.set(workspace.id, workspace)
        agents.set(workspace.id, [])
        return json(route, { workspace, agents: [], tasks: [], agentRelations: [] })
      }
      const workspaceMatch = path.match(/^\/workspaces\/([^/]+)$/)
      if (workspaceMatch && method === 'GET') {
        const workspace = workspaces.get(workspaceMatch[1]!)
        if (!workspace) return json(route, { error: 'not found' }, 404)
        return json(route, {
          workspace,
          agents: agents.get(workspace.id) ?? [],
          tasks: [],
          agentRelations: [],
        })
      }
      if (workspaceMatch && method === 'PATCH') {
        const workspace = workspaces.get(workspaceMatch[1]!)
        if (!workspace) return json(route, { error: 'not found' }, 404)
        const body = readJsonBody<Partial<Workspace>>(request, {})
        Object.assign(workspace, body, { updatedAt: now })
        return json(route, {
          workspace,
          agents: agents.get(workspace.id) ?? [],
          tasks: [],
          agentRelations: [],
        })
      }

      const workspaceFilesMatch = path.match(/^\/workspaces\/([^/]+)\/files$/)
      if (workspaceFilesMatch && method === 'GET') {
        return json(route, {
          workspaceId: workspaceFilesMatch[1],
          rootName: 'E2E Workspace',
          path: url.searchParams.get('path') ?? '',
          parentPath: null,
          total: 1,
          truncated: false,
          items: [
            {
              name: 'App.tsx',
              path: 'src/App.tsx',
              type: 'file',
              size: 128,
              sizeLabel: '128 B',
              modifiedAt: now,
              extension: 'tsx',
              hidden: false,
            },
          ],
        })
      }
      const workspaceFileContentMatch = path.match(/^\/workspaces\/([^/]+)\/files\/content$/)
      if (workspaceFileContentMatch && method === 'GET') {
        return json(route, {
          workspaceId: workspaceFileContentMatch[1],
          name: 'App.tsx',
          path: url.searchParams.get('path') ?? 'src/App.tsx',
          mimeType: 'text/typescript',
          size: 128,
          sizeLabel: '128 B',
          binary: false,
          content: 'export const title = "AgentHub E2E";\n',
          truncated: false,
        })
      }
      const workspaceAgentMatch = path.match(/^\/workspaces\/([^/]+)\/agents$/)
      if (workspaceAgentMatch && method === 'POST') {
        const workspaceId = workspaceAgentMatch[1]!
        const workspaceAgent = makeWorkspaceAgent({
          id: 'workspace-agent-coder',
          workspaceId,
          orderIdx: agents.get(workspaceId)?.length ?? 0,
        })
        agents.set(workspaceId, [workspaceAgent])
        return json(route, workspaceAgent)
      }
      const updateWorkspaceAgentMatch = path.match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)$/)
      if (updateWorkspaceAgentMatch && method === 'PATCH') {
        const workspaceId = updateWorkspaceAgentMatch[1]!
        const workspaceAgent =
          agents.get(workspaceId)?.find((item) => item.id === updateWorkspaceAgentMatch[2]) ??
          makeWorkspaceAgent({
            id: updateWorkspaceAgentMatch[2]!,
            workspaceId,
            orderIdx: 0,
          })
        agents.set(workspaceId, [workspaceAgent])
        return json(route, workspaceAgent)
      }
      const groupSessionMatch = path.match(/^\/workspaces\/([^/]+)\/group-session$/)
      if (groupSessionMatch && method === 'POST') {
        const workspaceId = groupSessionMatch[1]!
        const session = upsertSession({
          id: 'session-group',
          ownerId: 'default-user',
          title: 'E2E Group',
          type: 'group',
          workspaceId,
          workspaceAgentId: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
          lastMessage: null,
        })
        return json(route, { session })
      }

      if (method === 'POST' && path === '/artifacts/apply-diff') {
        const body = readJsonBody<{
          diff?: string
        }>(request, {})
        appliedDiffs.push(body.diff ?? '')
        return json(route, {
          success: true,
          message: 'Diff staged to Git.',
          stagedFiles: ['src/App.tsx'],
        })
      }
      if (method === 'PUT' && path === '/files') {
        return json(route, { ok: true, lines: 1 })
      }

      return json(route, { error: `Unhandled mock route: ${method} ${path}` }, 404)
    } catch (error) {
      return json(route, { error: String(error) }, 500)
    }
  })

  return { appliedDiffs }
}

function makeWorkspace(input: {
  goal?: string
  id: string
  name: string
  projectPath?: string | null
}): Workspace {
  return {
    id: input.id,
    ownerId: 'default-user',
    name: input.name,
    goal: input.goal ?? '',
    projectPath: input.projectPath ?? 'F:/AgentHub/e2e-workspace',
    createdAt: now,
    updatedAt: now,
  }
}

function makeWorkspaceAgent(input: {
  id: string
  orderIdx: number
  workspaceId: string
}): WorkspaceAgent {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: savedAgent.name,
    role: savedAgent.role,
    roleType: savedAgent.roleType,
    description: savedAgent.description,
    avatar: savedAgent.avatar,
    systemPrompt: savedAgent.systemPrompt,
    roleProfile: savedAgent.roleProfile,
    color: savedAgent.color,
    modelId: savedAgent.modelId,
    runtimeType: savedAgent.runtimeType,
    codeAgentType: savedAgent.codeAgentType,
    capabilityTags: savedAgent.capabilityTags,
    skillIds: savedAgent.skillIds,
    toolPermissions: savedAgent.toolPermissions,
    sandboxPolicy: savedAgent.sandboxPolicy,
    contextPolicy: savedAgent.contextPolicy,
    autoInvoke: savedAgent.autoInvoke,
    approvalRequired: savedAgent.approvalRequired,
    orderIdx: input.orderIdx,
    createdAt: now,
  }
}

function readJsonBody<T>(request: Request, fallback: T): T {
  try {
    return (request.postDataJSON() ?? fallback) as T
  } catch {
    return fallback
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status,
  })
}
