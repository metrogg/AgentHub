import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  PanelLeft,
  RefreshCw,
  Save,
  Terminal,
  XCircle,
} from 'lucide-react'
import CollapsibleSessionSidebar from '../components/chat/CollapsibleSessionSidebar'
import { settingsUpdatedEvent } from '../lib/shortcuts'
import {
  api,
  type CodexAuthStatus,
  type CodingToolStatus,
  type OpencodeModelItem,
} from '../lib/api'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'
import { useChatStore } from '../stores/chatStore'

type CodexTransport = 'http' | 'websocket'

interface ToolConfig {
  id: string
  name: string
  command: string
  description: string
  installCommand: string
  docsUrl: string
  config?: Record<string, unknown>
}

const storageKey = 'CODING_TOOLS_CONFIG'

let cachedToolStatus: Record<string, CodingToolStatus> | null = null
let cachedToolStatusTime = 0
const STATUS_CACHE_TTL = 5 * 60 * 1000

const toolIcons: Record<string, string> = {
  codex: '/codex-color.svg',
  'claude-code': '/claude-color.svg',
  opencode: '/opencode.svg',
  gemini: '/gemini-color.svg',
}

const defaults: ToolConfig[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    description: '本机运行的 OpenAI 编程代理，用于仓库理解、修改和验证。',
    installCommand: 'npm install -g @openai/codex@0.42.0',
    docsUrl: 'https://developers.openai.com/codex',
    config: {
      approvalPolicy: 'never',
      searchEnabled: false,
      jsonOutput: false,
    },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    description: 'Anthropic 终端编程助手，适合长上下文代码协作。',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    config: {
      permissionMode: 'acceptEdits',
      outputFormat: 'stream-json',
      verbose: true,
      includePartialMessages: true,
      maxTurns: '',
      addDirs: '',
    },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    description: '开放式终端编程代理，适合多提供商 OpenAI-compatible 接入。',
    installCommand: 'npm install -g opencode-ai',
    docsUrl: 'https://opencode.ai',
    config: {
      agent: 'build',
      skipPermissions: true,
      provider: '',
    },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    description: 'Google Gemini 终端编程代理，适合使用 Gemini 模型进行仓库协作。',
    installCommand: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
]

export default function CodingToolsPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const currentSession = useChatStore((state) => state.currentSession)
  const currentWorkspace = useChatStore((state) => state.currentWorkspace)
  const currentWorkspaceAgents = useChatStore((state) => state.currentWorkspaceAgents)
  const [tools, setTools] = useState<ToolConfig[]>(defaults)
  const [statuses, setStatuses] = useState<Record<string, CodingToolStatus>>({})
  const [activeToolId, setActiveToolId] = useState(defaults[0]!.id)
  const [checking, setChecking] = useState(false)
  const [saved, setSaved] = useState(false)
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [authSession, setAuthSession] = useState<{
    userCode?: string
    verificationUrl?: string
    expiresAt?: string
  } | null>(null)
  const [codexTransport, setCodexTransport] = useState<CodexTransport>('http')
  const [cliBusy, setCliBusy] = useState(false)
  const [cliMessage, setCliMessage] = useState('')
  const [cliOutput, setCliOutput] = useState('')
  const [opencodeModels, setOpencodeModels] = useState<OpencodeModelItem[]>([])
  const [opencodeDefaultModel, setOpencodeDefaultModel] = useState<string | null>(null)
  const [opencodeModelBusy, setOpencodeModelBusy] = useState(false)
  const [codexConfigPath, setCodexConfigPath] = useState('')
  const [codexConfigContent, setCodexConfigContent] = useState('')
  const [codexConfigBusy, setCodexConfigBusy] = useState(false)
  const [codexConfigDirty, setCodexConfigDirty] = useState(false)
  const [codexConfigMessage, setCodexConfigMessage] = useState('')
  const [codexAuthFilePath, setCodexAuthFilePath] = useState('')
  const [codexAuthFileContent, setCodexAuthFileContent] = useState('')
  const [codexAuthFileBusy, setCodexAuthFileBusy] = useState(false)
  const [codexAuthFileDirty, setCodexAuthFileDirty] = useState(false)
  const [codexAuthFileMessage, setCodexAuthFileMessage] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toolPage, setToolPage] = useState(0)
  const [executionEnabled, setExecutionEnabled] = useState<boolean | null>(null)
  const [executionBusy, setExecutionBusy] = useState(false)
  const [focusedAgentToolKey, setFocusedAgentToolKey] = useState<string | null>(null)

  useEffect(() => {
    api
      .getAgentAdapters()
      .then((res) => setExecutionEnabled(res.executionEnabled))
      .catch(() => setExecutionEnabled(null))

    api.getSettings().then((settings) => {
      let nextTools = defaults

      if (settings[storageKey]) {
        try {
          nextTools = mergeTools(JSON.parse(settings[storageKey]) as ToolConfig[])
          setTools(nextTools)
        } catch {
          setTools(defaults)
        }
      }

      if (settings.CODE_AGENT_ACTIVE_TOOL) {
        setActiveToolId(settings.CODE_AGENT_ACTIVE_TOOL)
        const activeIndex = nextTools.findIndex(
          (tool) => tool.id === settings.CODE_AGENT_ACTIVE_TOOL,
        )
        if (activeIndex >= 0) setToolPage(Math.floor(activeIndex / 3))
      }

      if (settings.CODEX_CHATGPT_TRANSPORT === 'websocket') {
        setCodexTransport('websocket')
      }

      void refreshStatus(nextTools, false)
      void refreshCodexAuth()
      void refreshCodexConfig()
      void refreshCodexAuthFile()
      void refreshOpencodeModels()
    })
  }, [])

  const activeTool = tools.find((tool) => tool.id === activeToolId) ?? tools[0]!
  const currentAgent = currentWorkspaceAgents.find(
    (agent) => agent.id === currentSession?.workspaceAgentId,
  )
  const hasAgentWorkspaceContext = Boolean(
    currentSession?.type === 'direct' &&
      currentSession.workspaceId &&
      currentSession.workspaceAgentId,
  )
  const currentAgentToolName = currentAgent?.codeAgentType
    ? tools.find((tool) => tool.id === currentAgent.codeAgentType)?.name ?? currentAgent.codeAgentType
    : null
  const currentAgentToolKey =
    currentAgent?.runtimeType === 'code-agent' && currentAgent.codeAgentType
      ? `${currentAgent.id}:${currentAgent.codeAgentType}`
      : null
  const installedCount = useMemo(
    () => tools.filter((tool) => statuses[tool.id]?.installed).length,
    [statuses, tools],
  )
  const configuredCount = useMemo(
    () => tools.filter((tool) => statuses[tool.id]?.configured).length,
    [statuses, tools],
  )
  const toolPageSize = 3
  const toolPageCount = Math.max(1, Math.ceil(tools.length / toolPageSize))
  const visibleTools = tools.slice(
    toolPage * toolPageSize,
    toolPage * toolPageSize + toolPageSize,
  )
  const canPageTools = tools.length > toolPageSize

  useEffect(() => {
    if (toolPage >= toolPageCount) setToolPage(toolPageCount - 1)
  }, [toolPage, toolPageCount])

  useEffect(() => {
    if (!currentAgentToolKey || focusedAgentToolKey === currentAgentToolKey) return
    if (!currentAgent?.codeAgentType) return
    setFocusedAgentToolKey(currentAgentToolKey)
    setActiveToolId(currentAgent.codeAgentType)
    const activeIndex = tools.findIndex((tool) => tool.id === currentAgent.codeAgentType)
    if (activeIndex >= 0) setToolPage(Math.floor(activeIndex / toolPageSize))
  }, [currentAgent?.codeAgentType, currentAgentToolKey, focusedAgentToolKey, tools])

  async function refreshStatus(probeTools = tools, force = false) {
    if (!force && cachedToolStatus && Date.now() - cachedToolStatusTime < STATUS_CACHE_TTL) {
      setStatuses(cachedToolStatus)
      return
    }
    setChecking(true)
    try {
      const res = await api.getCodingToolStatus(
        probeTools.map(({ id, command }) => ({ id, command })),
      )
      const statusMap = Object.fromEntries(res.items.map((item) => [item.id, item]))
      setStatuses(statusMap)
      cachedToolStatus = statusMap
      cachedToolStatusTime = Date.now()
    } finally {
      setChecking(false)
    }
  }

  async function refreshOpencodeModels() {
    setOpencodeModelBusy(true)
    try {
      const result = await api.getOpencodeModels()
      setOpencodeModels(result.models)
      setOpencodeDefaultModel(result.defaultModel)
    } catch (error: any) {
      setCliMessage(error?.message || 'Failed to load local OpenCode models.')
    } finally {
      setOpencodeModelBusy(false)
    }
  }

  async function refreshCodexConfig() {
    setCodexConfigBusy(true)
    try {
      const result = await api.getCodexConfig()
      setCodexConfigPath(result.path)
      setCodexConfigContent(result.content)
      setCodexConfigDirty(false)
      setCodexConfigMessage(result.message)
    } catch (error: any) {
      setCodexConfigMessage(error?.message || '读取 Codex config.toml 失败')
    } finally {
      setCodexConfigBusy(false)
    }
  }

  async function refreshCodexAuthFile() {
    setCodexAuthFileBusy(true)
    try {
      const result = await api.getCodexAuthFile()
      setCodexAuthFilePath(result.path)
      setCodexAuthFileContent(result.content)
      setCodexAuthFileDirty(false)
      setCodexAuthFileMessage(result.message)
    } catch (error: any) {
      setCodexAuthFileMessage(error?.message || '读取 Codex auth.json 失败')
    } finally {
      setCodexAuthFileBusy(false)
    }
  }

  async function installAllCliTools() {
    setCliBusy(true)
    setCliMessage('正在检测本机 CLI，只安装缺失的 Codex、Claude Code、OpenCode、Gemini...')
    setCliOutput('')
    try {
      const result = await api.installAllCliTools()
      setCliMessage(result.message)
      setCliOutput(result.output || '')
      if (result.items?.length) {
        const statusMap = Object.fromEntries(result.items.map((item) => [item.id, item]))
        setStatuses(statusMap)
        cachedToolStatus = statusMap
        cachedToolStatusTime = Date.now()
      }
    } catch (error: any) {
      setCliMessage(error?.message || 'CLI 安装失败')
    } finally {
      setCliBusy(false)
    }
  }

  function patchTool(id: string, patch: Partial<ToolConfig>) {
    setTools((current) => current.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)))
  }

  function patchToolConfig(id: string, key: string, value: unknown) {
    setTools((current) =>
      current.map((tool) =>
        tool.id === id
          ? {
              ...tool,
              config: {
                ...(tool.config ?? {}),
                [key]: value,
              },
            }
          : tool,
      ),
    )
  }

  async function refreshCodexAuth() {
    try {
      setCodexAuth(await api.getCodexAuthStatus())
    } catch (error: any) {
      setCodexAuth({
        loggedIn: false,
        authMode: 'none',
        status: 'logged-out',
        message: error?.message || '无法检测 Codex 登录状态',
      })
    }
  }

  async function startChatGptLogin() {
    setAuthBusy(true)
    setAuthMessage('')
    setAuthSession(null)
    try {
      const result = await api.startCodexChatGptLogin()
      if (!result.ok || !result.loginId) {
        setAuthMessage(result.message)
        return
      }

      setAuthSession({
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
        expiresAt: result.expiresAt,
      })
      setAuthMessage(
        result.userCode
          ? `验证码：${result.userCode}。请在浏览器授权后等待自动刷新。`
          : result.message,
      )
      void openCodexAuthPage()

      let interval = Math.max(1, result.interval ?? 5)
      const expiresAtMs = result.expiresAt
        ? new Date(result.expiresAt).getTime()
        : Date.now() + 15 * 60 * 1000

      while (Date.now() < expiresAtMs) {
        await delay(
          Math.min(interval * 1000, Math.max(0, expiresAtMs - Date.now())),
        )
        if (Date.now() >= expiresAtMs) break

        const poll = await withTimeout(
          api.pollCodexChatGptLogin(result.loginId),
          15000,
          '本次轮询超时，仍在等待浏览器授权',
        )
        setAuthMessage(poll.message)
        if (poll.status === 'pending') {
          interval = Math.max(1, poll.interval ?? interval)
          continue
        }
        if (poll.status === 'completed') {
          setAuthSession(null)
          await refreshCodexAuth()
        }
        break
      }

      if (Date.now() >= expiresAtMs) {
        setAuthSession(null)
        setAuthMessage('验证码已过期，请重新开始授权。')
      }
    } catch (error: any) {
      setAuthMessage(error?.message || '启动 ChatGPT 登录失败')
    } finally {
      setAuthBusy(false)
    }
  }

  async function openCodexAuthPage() {
    try {
      const result = await api.openCodexChatGptDevicePage()
      if (!result.ok) setAuthMessage(result.message || '打开授权页失败')
    } catch (error: any) {
      setAuthMessage(error?.message || '打开授权页失败')
    }
  }

  async function retryChatGptAuth() {
    setAuthBusy(true)
    setAuthMessage('')
    try {
      const result = await api.retryCodexChatGptAuth()
      setAuthMessage(result.message)
      await refreshCodexAuth()
    } catch (error: any) {
      setAuthMessage(error?.message || '重试验证失败')
    } finally {
      setAuthBusy(false)
    }
  }

  async function logoutChatGpt() {
    setAuthBusy(true)
    setAuthMessage('')
    try {
      const result = await api.logoutCodexChatGpt()
      setAuthMessage(result.message)
      setAuthSession(null)
      await refreshCodexAuth()
    } catch (error: any) {
      setAuthMessage(error?.message || '登出失败')
    } finally {
      setAuthBusy(false)
    }
  }

  async function patchCodexTransport(next: CodexTransport) {
    setCodexTransport(next)
    await api.saveSettings({ CODEX_CHATGPT_TRANSPORT: next })
    showSaved()
  }

  async function toggleExecutionEnabled() {
    const next = !executionEnabled
    setExecutionBusy(true)
    try {
      await api.saveSettings({
        AGENTHUB_ENABLE_CODE_AGENT_EXECUTION: next ? 'true' : 'false',
      })
      setExecutionEnabled(next)
      showSaved()
      void refreshStatus(tools, true)
    } catch (error: any) {
      setCliMessage(error?.message || '保存失败')
    } finally {
      setExecutionBusy(false)
    }
  }

  async function save() {
    if (activeTool.id === 'codex') {
      const [authOk, configOk] = await Promise.all([
        saveCodexAuthFile(),
        saveCodexConfig(),
      ])
      if (authOk && configOk) showSaved()
      return
    }

    await api.saveSettings({
      [storageKey]: JSON.stringify(tools),
      CODE_AGENT_ACTIVE_TOOL: activeTool.id,
      CODE_AGENT_ACTIVE_COMMAND: activeTool.command,
      CODEX_CHATGPT_TRANSPORT: codexTransport,
    })
    window.dispatchEvent(new Event(settingsUpdatedEvent))
    showSaved()
  }

  async function saveCodexConfig() {
    setCodexConfigBusy(true)
    try {
      const result = await api.saveCodexConfig(codexConfigContent)
      if (!result.ok) {
        setCodexConfigMessage(result.message)
        return false
      }
      setCodexConfigPath(result.path)
      setCodexConfigContent(result.content)
      setCodexConfigDirty(false)
      setCodexConfigMessage(result.message)
      await api.saveSettings({
        [storageKey]: JSON.stringify(tools),
        CODE_AGENT_ACTIVE_TOOL: activeTool.id,
        CODE_AGENT_ACTIVE_COMMAND: activeTool.command,
        CODEX_CHATGPT_TRANSPORT: codexTransport,
      })
      await refreshStatus(tools, true)
      return true
    } catch (error: any) {
      setCodexConfigMessage(error?.message || '保存 Codex config.toml 失败')
      return false
    } finally {
      setCodexConfigBusy(false)
    }
  }

  async function saveCodexAuthFile() {
    setCodexAuthFileBusy(true)
    try {
      const result = await api.saveCodexAuthFile(codexAuthFileContent)
      if (!result.ok) {
        setCodexAuthFileMessage(result.message)
        return false
      }
      setCodexAuthFilePath(result.path)
      setCodexAuthFileContent(result.content)
      setCodexAuthFileDirty(false)
      setCodexAuthFileMessage(result.message)
      return true
    } catch (error: any) {
      setCodexAuthFileMessage(error?.message || '保存 Codex auth.json 失败')
      return false
    } finally {
      setCodexAuthFileBusy(false)
    }
  }

  function showSaved() {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
  }

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f7f5f1] text-neutral-950">
      <CollapsibleSessionSidebar collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100"
              aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            >
              <PanelLeft
                className={cn(
                  'h-4 w-4 transition-transform duration-300',
                  sidebarCollapsed && 'rotate-180',
                )}
              />
            </button>
            <span className="text-sm font-semibold">AgentHub</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">Agent Runtime</span>
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              label="检测"
              onClick={() => refreshStatus(tools, true)}
              disabled={checking}
            >
              <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
            </IconButton>
            <IconButton
              label={cliBusy ? '安装中' : '检测并安装缺失 CLI'}
              onClick={installAllCliTools}
              disabled={cliBusy}
            >
              <Download className={cn('h-4 w-4', cliBusy && 'animate-pulse')} />
            </IconButton>
            <button
              type="button"
              onClick={save}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-neutral-950 px-3 text-sm font-medium text-white transition hover:bg-neutral-800"
            >
              <Save className="h-4 w-4" />
              {t('保存')}
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <section className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="inline-flex h-7 items-center gap-2 rounded-md border border-neutral-300 bg-white px-2.5 text-xs text-neutral-600">
                <Terminal className="h-3.5 w-3.5 text-teal-700" />
                {t('Agent Runtime 基底诊断')}
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-normal">
                Agent Runtime
              </h1>
              {executionEnabled !== null && (
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={toggleExecutionEnabled}
                    disabled={executionBusy}
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out disabled:opacity-50',
                      executionEnabled ? 'bg-emerald-500' : 'bg-neutral-300',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out',
                        executionEnabled ? 'translate-x-5' : 'translate-x-0',
                      )}
                    />
                  </button>
                  <span className="text-sm text-neutral-700">
                    {executionEnabled
                      ? '代码 Agent 自动执行已启用'
                      : '代码 Agent 自动执行已禁用'}
                  </span>
                  {executionBusy && (
                    <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
                  )}
                </div>
              )}
            </div>
            <div className="grid w-full grid-cols-3 gap-2 sm:w-auto">
              <Stat value={tools.length} label="工具" />
              <Stat value={installedCount} label="已安装" />
              <Stat value={configuredCount} label="可运行" />
            </div>
          </section>

          {hasAgentWorkspaceContext && currentSession && (
            <section className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-teal-100 bg-white px-4 py-3 shadow-sm">
              <div className="flex min-w-0 items-center gap-3">
                <div
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-white"
                  style={{ background: currentAgent?.color ?? '#111827' }}
                >
                  <Bot className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-neutral-400">{t('当前 Agent 工作区')}</div>
                  <div className="truncate text-sm font-semibold text-neutral-950">
                    {currentAgent?.name ?? currentWorkspace?.name ?? currentSession.title}
                  </div>
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs text-neutral-500">
                <span className="max-w-[220px] truncate rounded-md bg-neutral-100 px-2.5 py-1">
                  {currentWorkspace?.name ?? t('工作区加载中')}
                </span>
                {currentAgentToolName && (
                  <span className="rounded-md bg-teal-50 px-2.5 py-1 text-teal-700">
                    {currentAgentToolName}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => navigate(`/chat/${currentSession.id}`)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-50"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t('返回对话')}
                </button>
              </div>
            </section>
          )}

          <section className="relative mt-5">
            <div className="grid gap-3 lg:grid-cols-3">
              {visibleTools.map((tool) => {
                const status = statuses[tool.id]
                const configured = Boolean(status?.configured)
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => setActiveToolId(tool.id)}
                    className={cn(
                      'min-h-[138px] rounded-lg border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-neutral-400',
                      activeTool.id === tool.id
                        ? 'border-neutral-950 ring-2 ring-teal-700/10'
                        : 'border-neutral-200',
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-neutral-100">
                          <ToolIcon toolId={tool.id} name={tool.name} />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">
                            {tool.name}
                          </div>
                          <div className="truncate font-mono text-xs text-neutral-400">
                            {tool.command}
                          </div>
                        </div>
                      </div>
                      <StatusBadge
                        configured={configured}
                        installed={Boolean(status?.installed)}
                      />
                    </div>
                    <p className="mt-3 line-clamp-2 text-xs leading-5 text-neutral-600">
                      {t(tool.description)}
                    </p>
                  </button>
                )
              })}
            </div>

            {canPageTools && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setToolPage((page) => (page - 1 + toolPageCount) % toolPageCount)
                  }
                  className="absolute -left-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-neutral-200 bg-white text-neutral-600 shadow-lg transition hover:-translate-x-0.5 hover:border-neutral-300 hover:text-neutral-950 lg:grid"
                  aria-label={t('上一组工具')}
                  title={t('上一组工具')}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setToolPage((page) => (page + 1) % toolPageCount)}
                  className="absolute -right-3 top-1/2 hidden h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-neutral-200 bg-white text-neutral-600 shadow-lg transition hover:translate-x-0.5 hover:border-neutral-300 hover:text-neutral-950 lg:grid"
                  aria-label={t('下一组工具')}
                  title={t('下一组工具')}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <div className="mt-3 flex justify-center gap-1.5">
                  {Array.from({ length: toolPageCount }).map((_, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => setToolPage(index)}
                      className={cn(
                        'h-1.5 rounded-full transition-all',
                        toolPage === index
                          ? 'w-6 bg-neutral-950'
                          : 'w-1.5 bg-neutral-300 hover:bg-neutral-400',
                      )}
                      aria-label={`${t('切换到工具组')} ${index + 1}`}
                    />
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="mt-5 grid items-start gap-5">
            <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{activeTool.name}</h2>
                  <p className="mt-1 text-sm text-neutral-500">
                    {activeTool.id === 'codex'
                      ? t(
                          'Codex 读取官方 auth.json 与 config.toml；AgentHub 不向 Codex 注入通用 OpenAI / Anthropic Base URL。',
                        )
                      : t(
                          '这里只保存 CLI 平台自身参数和原生诊断状态；Agent 使用的模型、Skills 和沙箱由 Agent 配置页决定。',
                        )}
                  </p>
                </div>
                <a
                  href={activeTool.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 px-3 text-sm text-neutral-600 hover:bg-neutral-50"
                >
                  {t('文档')}
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>

              <CodeAgentAdvancedSettings
                tool={activeTool}
                onPatch={(key, value) => patchToolConfig(activeTool.id, key, value)}
              />

              {activeTool.id === 'codex' ? (
                <>
                  <CodexConfigPanel
                    title="auth.json"
                    language="JSON"
                    path={codexAuthFilePath}
                    content={codexAuthFileContent}
                    busy={codexAuthFileBusy}
                    dirty={codexAuthFileDirty}
                    message={codexAuthFileMessage}
                    minHeight="10rem"
                    placeholder={'{\n  "OPENAI_API_KEY": ""\n}'}
                    onChange={(content) => {
                      setCodexAuthFileContent(content)
                      setCodexAuthFileDirty(true)
                    }}
                    onReload={refreshCodexAuthFile}
                    onSave={async () => {
                      if (await saveCodexAuthFile()) showSaved()
                    }}
                  />
                  <CodexConfigPanel
                    title="config.toml"
                    language="TOML"
                    path={codexConfigPath}
                    content={codexConfigContent}
                    busy={codexConfigBusy}
                    dirty={codexConfigDirty}
                    message={codexConfigMessage}
                    minHeight="30rem"
                    placeholder={'model_provider = "openai"'}
                    onChange={(content) => {
                      setCodexConfigContent(content)
                      setCodexConfigDirty(true)
                    }}
                    onReload={refreshCodexConfig}
                    onSave={async () => {
                      if (await saveCodexConfig()) showSaved()
                    }}
                  />
                  <CodexAuthPanel
                    status={codexAuth}
                    busy={authBusy}
                    message={authMessage}
                    session={authSession}
                    transport={codexTransport}
                    onLogin={startChatGptLogin}
                    onLogout={logoutChatGpt}
                    onRefresh={refreshCodexAuth}
                    onRetry={retryChatGptAuth}
                    onOpenAuthPage={openCodexAuthPage}
                    onTransport={patchCodexTransport}
                  />
                </>
              ) : (
                <>
                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <Field
                      label="命令"
                      value={activeTool.command}
                      onChange={(value) =>
                        patchTool(activeTool.id, { command: value })
                      }
                    />
                    <div className="md:col-span-2 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
                      <div className="font-medium text-neutral-800">模型与凭证来源</div>
                      <div className="mt-2 leading-6">
                        模型管理页只维护模型目录、双端点地址和密钥；Agent 配置页才决定某个专家具体使用哪个 Worker 基座和哪条模型。
                      </div>
                      {activeTool.id === 'claude-code' && (
                        <div className="mt-2 text-xs text-neutral-500">
                          Claude Code 运行时会优先读取 Agent 绑定模型的 Anthropic 端点与密钥。
                        </div>
                      )}
                      {activeTool.id === 'opencode' && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                          <span>OpenCode 本机模型仅作为原生配置诊断，不作为 AgentHub 的运行时真相。</span>
                          <button
                            type="button"
                            onClick={refreshOpencodeModels}
                            disabled={opencodeModelBusy}
                            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                          >
                            <RefreshCw className={cn('h-3.5 w-3.5', opencodeModelBusy && 'animate-spin')} />
                            {t('读取本机 OpenCode')}
                          </button>
                          {opencodeDefaultModel && <span>{t('默认')}：{opencodeDefaultModel}</span>}
                          {opencodeModels.length > 0 && <span>{t('已读取 {count} 个本机模型').replace('{count}', String(opencodeModels.length))}</span>}
                        </div>
                      )}
                      {activeTool.id === 'codex' && (
                        <div className="mt-2 text-xs text-neutral-500">
                          Codex 使用官方 auth/config 体系；模型组合仍由 Agent 配置页决定。
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <span className="text-sm text-neutral-500">
                      这里保存的是平台自身参数；模型、沙箱与 Skills 请去模型管理和 Agent 配置页设置。
                    </span>
                  </div>
                </>
              )}
            </div>

            <aside className="space-y-4">
              {(cliMessage || cliOutput) && (
                <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
                  <div className="text-sm font-semibold">{t('安装输出')}</div>
                  {cliMessage && <p className="mt-2 text-sm text-neutral-600">{cliMessage}</p>}
                  {cliOutput && <CodeBlock value={cliOutput} />}
                </div>
              )}
            </aside>
          </section>
        </div>
      </main>

      {saved && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-md bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          {t('已保存配置')}
        </div>
      )}
    </div>
  )
}

function mergeTools(saved: ToolConfig[]) {
  return defaults.map((item) => {
    const persisted = saved.find((tool) => tool.id === item.id)
    return {
      ...item,
      ...persisted,
      config: {
        ...(item.config ?? {}),
        ...(persisted?.config ?? {}),
      },
    }
  })
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function CodeAgentAdvancedSettings({
  tool,
  onPatch,
}: {
  tool: ToolConfig
  onPatch: (key: string, value: unknown) => void
}) {
  const { t } = useI18n()
  const cfg = tool.config ?? {}
  const title =
    tool.id === 'codex'
      ? 'Codex CLI 执行参数'
      : tool.id === 'claude-code'
        ? 'Claude Code 执行参数'
        : tool.id === 'opencode'
          ? 'OpenCode 执行参数'
          : 'Gemini CLI 执行参数'
  const claudePermissionMode = readToolConfigString(cfg, 'permissionMode', 'acceptEdits')
  const claudeSkipPermissions = readToolConfigBoolean(
    cfg,
    'skipPermissions',
    claudePermissionMode === 'bypassPermissions',
  )

  return (
    <div className="mt-5 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
      <div>
        <div className="text-sm font-semibold text-neutral-800">{t(title)}</div>
      </div>

      {tool.id === 'codex' && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ToolSelectField
            label="审批策略"
            value={readToolConfigString(cfg, 'approvalPolicy', 'never')}
            onChange={(value) => onPatch('approvalPolicy', value)}
            options={[
              ['never', 'never / full-auto'],
              ['ask', 'ask'],
            ]}
          />
          <Field
            label="Codex profile"
            value={readToolConfigString(cfg, 'profile', '')}
            onChange={(value) => onPatch('profile', value)}
          />
          <div className="grid gap-2">
            <ToolToggle
              label="启用 Web Search"
              checked={readToolConfigBoolean(cfg, 'searchEnabled', false)}
              onChange={(value) => onPatch('searchEnabled', value)}
            />
            <ToolToggle
              label="JSON 输出模式"
              checked={readToolConfigBoolean(cfg, 'jsonOutput', false)}
              onChange={(value) => onPatch('jsonOutput', value)}
            />
          </div>
        </div>
      )}

      {tool.id === 'claude-code' && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ToolSelectField
            label="权限模式"
            value={readToolConfigString(cfg, 'permissionMode', 'acceptEdits')}
            onChange={(value) => onPatch('permissionMode', value)}
            options={[
              ['default', 'default'],
              ['acceptEdits', 'acceptEdits'],
              ['plan', 'plan'],
              ['bypassPermissions', 'bypassPermissions'],
            ]}
          />
          <ToolSelectField
            label="输出格式"
            value={readToolConfigString(cfg, 'outputFormat', 'stream-json')}
            onChange={(value) => onPatch('outputFormat', value)}
            options={[
              ['stream-json', 'stream-json'],
              ['text', 'text'],
              ['json', 'json'],
            ]}
          />
          <Field
            label="Max turns"
            value={readToolConfigString(cfg, 'maxTurns', '')}
            onChange={(value) => onPatch('maxTurns', value)}
          />
          <Field
            label="Settings 文件路径"
            value={readToolConfigString(cfg, 'settings', '')}
            onChange={(value) => onPatch('settings', value)}
          />
          <Field
            label="额外目录 add-dir"
            value={readToolConfigString(cfg, 'addDirs', '')}
            onChange={(value) => onPatch('addDirs', value)}
          />
          <div className="grid gap-2">
            <ToolToggle
              label="Verbose stream"
              checked={readToolConfigBoolean(cfg, 'verbose', true)}
              onChange={(value) => onPatch('verbose', value)}
            />
            <ToolToggle
              label="包含 partial messages"
              checked={readToolConfigBoolean(cfg, 'includePartialMessages', true)}
              onChange={(value) => onPatch('includePartialMessages', value)}
            />
            <ToolToggle
              label="跳过权限确认"
              checked={claudeSkipPermissions}
              onChange={(value) => {
                onPatch('skipPermissions', value)
                if (value) {
                  onPatch('permissionMode', 'bypassPermissions')
                } else if (claudePermissionMode === 'bypassPermissions') {
                  onPatch('permissionMode', 'acceptEdits')
                }
              }}
            />
          </div>
        </div>
      )}

      {tool.id === 'opencode' && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ToolSelectField
            label="OpenCode 代理模式"
            value={readToolConfigString(cfg, 'agent', 'build')}
            onChange={(value) => onPatch('agent', value)}
            options={[
              ['build', 'build'],
              ['plan', 'plan'],
              ['general', 'general'],
            ]}
          />
          <Field
            label="Provider 覆盖"
            value={readToolConfigString(cfg, 'provider', '')}
            onChange={(value) => onPatch('provider', value)}
          />
          <ToolToggle
            label="跳过权限确认"
            checked={readToolConfigBoolean(cfg, 'skipPermissions', true)}
            onChange={(value) => onPatch('skipPermissions', value)}
          />
        </div>
      )}

      {tool.id === 'gemini' && (
        <div className="mt-4 text-xs leading-5 text-neutral-500">
          {t('Gemini CLI 会跟随 Agent 绑定的模型与沙箱执行。这里仅保留 CLI 平台级参数和健康诊断。')}
        </div>
      )}
    </div>
  )
}

function CodexConfigPanel({
  title,
  language,
  path,
  content,
  busy,
  dirty,
  message,
  minHeight,
  placeholder,
  onChange,
  onReload,
  onSave,
}: {
  title: string
  language: string
  path: string
  content: string
  busy: boolean
  dirty: boolean
  message: string
  minHeight: string
  placeholder: string
  onChange: (content: string) => void
  onReload: () => void
  onSave: () => void | Promise<void>
}) {
  const { t } = useI18n()
  return (
    <div className="mt-5 rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-neutral-800">
            <Terminal className="h-4 w-4 text-teal-700" />
            {title} <span className="font-normal text-neutral-400">({language})</span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-neutral-400">
            {path || `~/.codex/${title}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty && (
            <span className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700">
              {t('未保存')}
            </span>
          )}
          <button
            type="button"
            onClick={onReload}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
            {t('重新读取')}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-teal-700 px-2.5 text-xs font-medium text-white hover:bg-teal-800 disabled:bg-neutral-300"
          >
            <Save className="h-3.5 w-3.5" />
            {t('保存')}
          </button>
        </div>
      </div>
      <textarea
        value={content}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className="mt-3 w-full resize-y rounded-md border border-neutral-200 bg-white px-4 py-3 font-mono text-xs leading-6 text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-teal-700"
        style={{ minHeight }}
        placeholder={placeholder}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
        <span>{message || t('Codex CLI 会直接读取这个文件。')}</span>
        <span>{content.length.toLocaleString()} chars</span>
      </div>
    </div>
  )
}

function CodexAuthPanel({
  status,
  busy,
  message,
  session,
  transport,
  onLogin,
  onLogout,
  onRefresh,
  onRetry,
  onOpenAuthPage,
  onTransport,
}: {
  status: CodexAuthStatus | null
  busy: boolean
  message: string
  session: { userCode?: string; verificationUrl?: string; expiresAt?: string } | null
  transport: CodexTransport
  onLogin: () => void
  onLogout: () => void
  onRefresh: () => void
  onRetry: () => void
  onOpenAuthPage: () => void
  onTransport: (transport: CodexTransport) => void
}) {
  const { t } = useI18n()
  const accountLoggedIn = status?.authMode === 'chatgpt'
  const apiKeyMode = status?.authMode === 'api-key'
  const deviceAuthEnabled = Boolean(status?.deviceAuthEnabled)
  const badgeLabel = accountLoggedIn
    ? 'ChatGPT 已登录'
    : apiKeyMode
      ? 'API Key 可用'
      : '未登录'
  const displayMessage = normalizeCodexAuthMessage(message || status?.message || '')

  return (
    <div className="mt-5 rounded-lg border border-neutral-200 bg-[#fbfbf8] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-neutral-800">
            <KeyRound className="h-4 w-4 text-teal-700" />
            {t('OpenAI 运行认证')}
          </div>
          <p className="mt-1 text-xs leading-5 text-neutral-500">
            {t('推荐用 OPENAI_API_KEY；开启设备授权时也可以同步 ChatGPT 登录状态。')}
          </p>
          {status?.accountId && (
            <p className="mt-1 font-mono text-xs text-neutral-400">{status.accountId}</p>
          )}
        </div>
        <span
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium',
            accountLoggedIn
              ? 'bg-emerald-50 text-emerald-700'
              : apiKeyMode
                ? 'bg-sky-50 text-sky-700'
                : 'bg-neutral-100 text-neutral-600',
          )}
        >
          {t(badgeLabel)}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {deviceAuthEnabled && !accountLoggedIn && (
            <button
              type="button"
              onClick={onLogin}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-medium text-white hover:bg-teal-800 disabled:bg-neutral-300"
            >
              <KeyRound className={cn('h-4 w-4', busy && 'animate-pulse')} />
              {busy ? t('授权中') : t('登录 ChatGPT')}
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
            {t('刷新')}
          </button>
          {deviceAuthEnabled && accountLoggedIn && (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              {t('重试验证')}
            </button>
          )}
          {deviceAuthEnabled && accountLoggedIn && (
            <button
              type="button"
              onClick={onLogout}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-red-100 bg-red-50 px-3 text-sm text-red-600 hover:bg-red-100 disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" />
              {t('登出')}
            </button>
          )}
        </div>
        <div className="inline-flex rounded-md border border-neutral-200 bg-white p-1">
          {(['http', 'websocket'] as CodexTransport[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onTransport(item)}
              className={cn(
                'h-7 rounded px-3 text-xs font-medium transition',
                transport === item
                  ? 'bg-teal-50 text-teal-800'
                  : 'text-neutral-600 hover:bg-neutral-50',
              )}
            >
              {item === 'http' ? 'HTTP' : 'WebSocket'}
            </button>
          ))}
        </div>
      </div>

      {deviceAuthEnabled && session?.userCode && (
        <div className="mt-3 rounded-md border border-teal-100 bg-teal-50 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-teal-700">{t('授权验证码')}</div>
              <div className="mt-1 font-mono text-lg font-semibold text-teal-950">
                {session.userCode}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(session.userCode || '').catch(() => undefined)
                }
                className="inline-flex h-9 items-center gap-2 rounded-md border border-teal-200 bg-white px-3 text-sm font-medium text-teal-800 hover:bg-teal-50"
              >
                <Copy className="h-4 w-4" />
                {t('复制验证码')}
              </button>
              {session.verificationUrl && (
                <button
                  type="button"
                  onClick={onOpenAuthPage}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-medium text-white hover:bg-teal-800"
                >
                  {t('打开授权页')}
                  <ExternalLink className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {displayMessage && (
        <div className="mt-3 rounded-md bg-white px-3 py-2 font-mono text-xs leading-5 text-neutral-600">
          {displayMessage}
        </div>
      )}
    </div>
  )
}

function normalizeCodexAuthMessage(message: string) {
  if (/ChatGPT device auth is disabled/i.test(message)) {
    return 'ChatGPT 设备授权已关闭；后端只读取 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL 等显式环境变量。'
  }
  if (/Route Error/i.test(message) && /Invalid content type:\s*text\/html/i.test(message)) {
    return '授权页返回 Route Error。请复制授权链接，在普通浏览器或无痕窗口打开，并确认 ChatGPT 已登录。'
  }
  return message
}

function ToolIcon({ toolId, name }: { toolId: string; name: string }) {
  return (
    <img
      src={toolIcons[toolId] ?? '/codex-color.svg'}
      alt={`${name} icon`}
      className="h-5 w-5 object-contain"
      draggable={false}
    />
  )
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50 disabled:opacity-50"
    >
      {children}
      {t(label)}
    </button>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  const { t } = useI18n()
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-lg font-semibold">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{t(label)}</div>
    </div>
  )
}

function StatusBadge({
  configured,
  installed,
}: {
  configured: boolean
  installed: boolean
}) {
  const { t } = useI18n()
  const ready = installed && configured
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs',
        ready
          ? 'bg-emerald-50 text-emerald-700'
          : installed
            ? 'bg-amber-50 text-amber-700'
            : 'bg-neutral-100 text-neutral-500',
      )}
    >
      {ready ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : installed ? (
        <AlertCircle className="h-3 w-3" />
      ) : (
        <XCircle className="h-3 w-3" />
      )}
      {ready ? t('可运行') : installed ? t('待完成认证') : t('未安装')}
    </span>
  )
}

function Field({
  label,
  type = 'text',
  value,
  onChange,
}: {
  label: string
  type?: string
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  return (
    <label className="block text-sm">
      <span className="mb-2 block text-neutral-600">{t(label)}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-neutral-200 px-3 outline-none transition focus:border-teal-700"
      />
    </label>
  )
}

function ToolSelectField({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<[string, string]>
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useI18n()
  return (
    <label className="block text-sm">
      <span className="mb-2 block text-neutral-600">{t(label)}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-md border border-neutral-200 bg-white px-3 outline-none transition focus:border-teal-700"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}

function ToolToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (value: boolean) => void
}) {
  const { t } = useI18n()
  return (
    <label className="flex h-10 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-600">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {t(label)}
    </label>
  )
}

function readToolConfigString(cfg: Record<string, unknown>, key: string, fallback: string) {
  const value = cfg[key]
  return typeof value === 'string' ? value : fallback
}

function readToolConfigBoolean(cfg: Record<string, unknown>, key: string, fallback: boolean) {
  const value = cfg[key]
  return typeof value === 'boolean' ? value : fallback
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-neutral-950 p-3 font-mono text-xs leading-5 text-neutral-50">
      <code>{value}</code>
    </pre>
  )
}
