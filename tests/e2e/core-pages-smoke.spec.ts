import { expect, test, type Page, type Route } from '@playwright/test'

const now = '2026-06-04T12:00:00.000Z'

const corePages = [
  { path: '/', text: 'AgentHub' },
  { path: '/chat/session-main', text: 'Smoke Session' },
  { path: '/abilities', text: '能力商店' },
  { path: '/artifacts', text: '产物' },
  { path: '/models', text: '模型管理' },
  { path: '/coding-tools', text: 'Coding Tools' },
  { path: '/agent-config', text: 'Agent 配置' },
  { path: '/profile', text: '个人资料' },
  { path: '/skills', text: 'Skills 市场' },
  { path: '/orchestrator-runs', text: 'Smoke Workspace' },
]

test.describe('core page smoke tests', () => {
  test.beforeEach(async ({ page }) => {
    await installCorePageMock(page)
  })

  for (const pageCase of corePages) {
    test(`renders ${pageCase.path}`, async ({ page }) => {
      await page.goto(pageCase.path)
      await expect(page.getByText(pageCase.text).first()).toBeVisible()
      if (pageCase.path === '/chat/session-main') {
        await expect(page.locator('.agenthub-context-rail')).toBeVisible()
      }
      await expect(page.locator('body')).not.toContainText('Unhandled mock route')
      await expect(page.locator('body')).not.toContainText('页面出现错误')
    })
  }
})

async function installCorePageMock(page: Page) {
  await page.addInitScript((libraryState) => {
    window.localStorage.setItem('agenthub.agentLibrary', JSON.stringify(libraryState))

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 3
      readyState = FakeWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      url: string

      constructor(url: string) {
        super()
        this.url = url
        window.setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN
          const event = new Event('open')
          this.onopen?.(event)
          this.dispatchEvent(event)
        }, 0)
      }

      send() {}

      close() {
        this.readyState = FakeWebSocket.CLOSED
        const event = new Event('close')
        this.onclose?.(event)
        this.dispatchEvent(event)
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: FakeWebSocket,
    })
  }, agentLibraryState)

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/, '') || '/'
    const method = request.method().toUpperCase()

    if (method === 'GET' && path === '/settings') {
      return json(route, {
        AGENT_LIBRARY: JSON.stringify(agentLibraryState),
        MODEL_CATALOG: JSON.stringify(modelCatalog),
        APP_SETTINGS: JSON.stringify({
          accountName: 'Smoke User',
          accountAvatar: null,
          profileMemory: 'Prefer concise smoke checks.',
        }),
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
        seed: 'smoke',
        source: 'unavailable',
      })
    }
    if (method === 'GET' && path === '/sessions') return json(route, { items: sessions })
    if (method === 'GET' && path === '/sessions/session-main') return json(route, sessions[0])
    if (method === 'GET' && path === '/messages/session-main') return json(route, { items: messages })
    if (method === 'GET' && path === '/workspaces') return json(route, { items: [workspace] })
    if (method === 'GET' && path === '/workspaces/workspace-main') {
      return json(route, {
        agentRelations: [],
        agents: workspaceAgents,
        tasks: [],
        workspace,
      })
    }
    if (method === 'GET' && path === '/workspaces/workspace-main/files') {
      return json(route, {
        items: [],
        parentPath: null,
        path: '',
        rootName: 'Smoke Workspace',
        total: 0,
        truncated: false,
        workspaceId: 'workspace-main',
      })
    }
    if (method === 'GET' && path === '/skills') return json(route, { items: skills })
    if (method === 'GET' && path === '/skills/skillhub/search') return json(route, { items: [] })
    if (method === 'GET' && path === '/skills/skill-smoke') {
      return json(route, {
        ...skills[0],
        manifest: {},
        readme: 'Smoke skill',
      })
    }
    if (method === 'GET' && path === '/settings/general-info') return json(route, generalInfo)
    if (method === 'GET' && path === '/settings/console-logs') {
      return json(route, {
        items: [],
        sources: {
          executionTraceCount: 0,
          runEventCount: 0,
          serverLogEnabled: false,
          serverLogExists: false,
          serverLogPath: 'F:/Learning/AgentHub/logs/server.log',
        },
      })
    }
    if (method === 'GET' && path === '/settings/runtime-info') {
      return json(route, {
        git: { message: 'ok', ok: true, path: 'git', runtime: 'git version 2.0.0' },
        python: { message: 'ok', ok: true, path: 'python', runtime: 'Python 3.12' },
      })
    }
    if (method === 'GET' && path === '/mobile/connectivity') {
      return json(route, {
        candidates: [],
        connectedDevices: [],
        firewall: { actionAvailable: false, message: 'ok', port: 3000 },
        host: '127.0.0.1',
        mobileConnected: false,
        port: 3000,
        status: 'ready',
      })
    }
    if (method === 'GET' && path === '/office/status') {
      return json(route, {
        root: 'F:/Learning/AgentHub/office',
        rootExists: true,
        running: false,
        started: false,
        starting: false,
        url: 'http://127.0.0.1:9980',
      })
    }
    if (method === 'GET' && path === '/coding-tools/agent-adapters') {
      return json(route, {
        executionEnabled: true,
        items: adapters,
        localCliProbesEnabled: true,
        platform: 'win32',
      })
    }
    if (method === 'GET' && path === '/coding-tools/status') {
      return json(route, {
        items: adapters.map((adapter) => ({
          command: adapter.command,
          configured: adapter.configured,
          id: adapter.id,
          installed: adapter.installed,
          version: adapter.version,
        })),
        localCliProbesEnabled: true,
        platform: 'win32',
        runtime: 'local',
      })
    }
    if (method === 'GET' && path === '/coding-tools/local-agent-runtimes') {
      return json(route, { items: [], localCliProbesEnabled: true, platform: 'win32' })
    }
    if (method === 'GET' && path === '/coding-tools/opencode/models') {
      return json(route, { items: [] })
    }
    if (method === 'GET' && path === '/coding-tools/codex/config') {
      return json(route, { content: '', exists: false, path: 'config.toml' })
    }
    if (method === 'GET' && path === '/coding-tools/codex/auth-file') {
      return json(route, { content: '', exists: false, path: 'auth.json' })
    }
    if (method === 'GET' && path === '/coding-tools/codex/auth/status') {
      return json(route, { authenticated: false, mode: 'api-key' })
    }
    if (method === 'GET' && path === '/settings/ccswitch-models') {
      return json(route, { models: [] })
    }
    if (method === 'GET' && path === '/orchestrator-runs') return json(route, { items: runs })
    if (method === 'GET' && path === '/orchestrator-runs/run-smoke') return json(route, runs[0])
    if (method === 'GET' && path === '/orchestrator-runs/run-smoke/logs') {
      return json(route, { items: [] })
    }
    if (method === 'GET' && path === '/orchestrator-runs/run-smoke/conflicts') {
      return json(route, { items: [] })
    }
    if (method === 'GET' && path === '/orchestrator-runs/run-smoke/blackboard') {
      return json(route, { items: [] })
    }
    if (method === 'GET' && path === '/protocols/ag-ui/runs/run-smoke/events') {
      return json(route, { items: [] })
    }

    return json(route, { error: `Unhandled mock route: ${method} ${path}` }, 404)
  })
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    body: JSON.stringify(body),
    contentType: 'application/json',
    status,
  })
}

const savedAgent = {
  approvalRequired: false,
  autoInvoke: true,
  avatar: null,
  capabilityTags: ['smoke'],
  codeAgentType: 'codex',
  color: '#2563eb',
  contextPolicy: 'workspace-aware',
  createdAt: now,
  description: 'Smoke test agent',
  id: 'agent-smoke',
  modelId: null,
  name: 'Smoke Agent',
  role: 'Smoke tester',
  roleProfile: null,
  roleType: 'custom',
  sandboxPolicy: 'workspace-write',
  skillIds: ['skill-smoke'],
  systemPrompt: 'Run smoke checks.',
  toolPermissions: ['filesystem'],
  runtimeType: 'code-agent',
  updatedAt: now,
}

const agentLibraryState = {
  agents: [savedAgent],
  relations: [],
  schemaVersion: 2,
}

const workspace = {
  createdAt: now,
  goal: 'Smoke goal',
  id: 'workspace-main',
  name: 'Smoke Workspace',
  ownerId: 'default-user',
  projectPath: 'F:/Learning/AgentHub/workspaces/smoke',
  updatedAt: now,
}

const workspaceAgents = [
  {
    ...savedAgent,
    id: 'workspace-agent-smoke',
    orderIdx: 0,
    workspaceId: workspace.id,
  },
]

const sessions = [
  {
    createdAt: now,
    id: 'session-main',
    lastMessage: { content: 'Smoke reply', senderType: 'agent' },
    metadata: null,
    ownerId: 'default-user',
    title: 'Smoke Session',
    type: 'group',
    updatedAt: now,
    workspaceAgentId: null,
    workspaceId: 'workspace-main',
  },
]

const messages = [
  {
    content: 'Smoke reply',
    createdAt: now,
    id: 'message-smoke',
    metadata: { agentName: 'Smoke Agent' },
    senderId: 'workspace-agent-smoke',
    senderType: 'agent',
    sessionId: 'session-main',
    type: 'text',
  },
]

const skills = [
  {
    description: 'Smoke skill for core page coverage',
    id: 'skill-smoke',
    installed: true,
    name: 'Smoke Skill',
    source: 'local',
    tags: ['smoke'],
  },
]

const modelCatalog = [
  {
    anthropicEndpoint: '',
    apiEndpoint: 'https://api.example.com/v1',
    apiKeyEnv: 'SMOKE_API_KEY',
    enabled: true,
    id: 'model-smoke',
    modelId: 'smoke-model',
    name: 'Smoke Model',
    provider: 'smoke',
  },
]

const adapters = [
  {
    command: 'codex',
    configEnv: 'CODEX_HOME',
    configMessage: 'configured',
    configured: true,
    docsHint: 'Codex smoke adapter',
    envKey: 'CODEX_HOME',
    executionEnabled: true,
    id: 'codex',
    installed: true,
    name: 'Codex CLI',
    readiness: 'ready',
    ready: true,
    version: '1.0.0',
  },
]

const generalInfo = {
  debug: {
    dir: 'F:/Learning/AgentHub/debug',
    enabled: false,
    exists: true,
    logLevel: 'info',
    sizeBytes: 0,
    sizeLabel: '0 B',
  },
  git: { message: 'ok', ok: true, path: 'git', runtime: 'git version 2.0.0' },
  python: { message: 'ok', ok: true, path: 'python', runtime: 'Python 3.12' },
  sandbox: {
    cleanupMode: 'manual',
    configuredProvider: 'docker-sandbox',
    daemonReady: true,
    defaultProvider: 'docker-sandbox',
    dockerLoggedIn: true,
    dockerSandbox: {
      agent: 'docker',
      available: true,
      policy: { authenticated: true, configured: true, message: 'ok' },
      probe: { daemonReady: true, exitCode: 0, installed: true, message: 'ok' },
    },
    policyConfigured: true,
    providerConfigured: true,
    sandboxRoot: 'F:/Learning/AgentHub/sandboxes',
    sandboxRunnable: true,
    sbxInstalled: true,
    supportsPerAgentIsolation: true,
  },
  storage: {
    activeDataDir: 'F:/Learning/AgentHub/storage',
    appDataDir: 'F:/Learning/AgentHub/storage',
    configDir: 'F:/Learning/AgentHub/config',
    dataPath: 'F:/Learning/AgentHub/storage',
    databasePath: 'F:/Learning/AgentHub/storage/agenthub.db',
    databaseSizeBytes: 0,
    databaseSizeLabel: '0 B',
    exists: true,
    logDir: 'F:/Learning/AgentHub/logs',
    message: 'ok',
    migrationPending: false,
    scannedFiles: 0,
    sizeBytes: 0,
    sizeLabel: '0 B',
    truncated: false,
    workspaceStorageExists: true,
    workspaceStorageRoot: 'F:/Learning/AgentHub/workspaces',
    workspaceStorageSizeBytes: 0,
    workspaceStorageSizeLabel: '0 B',
  },
}

const runs = [
  {
    conflictReport: [],
    createdAt: now,
    groupSessionId: 'session-main',
    id: 'run-smoke',
    plan: {
      agents: [{ id: 'agent-smoke', name: 'Smoke Agent' }],
      collaborationMode: 'pipeline',
      goal: 'Smoke goal',
      phases: [{ id: 'phase-1', purpose: 'Smoke', taskIds: ['task-smoke'], title: 'Smoke' }],
      progressLedger: {
        blockedTaskIds: [],
        cancelledTaskIds: [],
        completedTaskIds: ['task-smoke'],
        failedTaskIds: [],
        runningTaskIds: [],
        status: 'completed',
      },
      taskLedger: {
        phases: [{ id: 'phase-1', purpose: 'Smoke', taskIds: ['task-smoke'], title: 'Smoke' }],
        tasks: [
          {
            agentId: 'agent-smoke',
            dependencies: [],
            description: 'Smoke task',
            id: 'task-smoke',
            phaseId: 'phase-1',
            status: 'done',
            title: 'Smoke task',
          },
        ],
      },
      tasks: [
        {
          agentId: 'agent-smoke',
          dependencies: [],
          description: 'Smoke task',
          id: 'task-smoke',
          phaseId: 'phase-1',
          title: 'Smoke task',
        },
      ],
      title: 'Smoke Plan',
    },
    planMessageId: null,
    sessionTitle: 'Smoke Session',
    status: 'completed',
    summaryMessageId: null,
    updatedAt: now,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  },
]
