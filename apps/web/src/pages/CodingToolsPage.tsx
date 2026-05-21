import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Box,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  LogOut,
  PanelLeft,
  PlugZap,
  RefreshCw,
  Shield,
  Terminal,
  XCircle,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { api, type CodexAuthStatus, type CodingToolStatus, type DockerRuntimeStatus, type ModelCatalogItem } from '../lib/api'
import { cn } from '../lib/utils'

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type Protocol = 'openai-compatible' | 'anthropic-messages' | 'openai-responses'
type CodexTransport = 'http' | 'websocket'

interface ToolConfig {
  id: string
  name: string
  command: string
  description: string
  installCommand: string
  docsUrl: string
  protocol: Protocol
  modelId: string
  apiKeyEnv: string
  baseUrl: string
  sandbox: SandboxMode
}

const storageKey = 'CODING_TOOLS_CONFIG'

const toolIcons: Record<string, string> = {
  codex: '/codex-color.svg',
  'claude-code': '/claude-color.svg',
  opencode: '/opencode.svg',
}

const defaults: ToolConfig[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    description: '面向本地代码任务的 OpenAI 编程代理，适合仓库理解、补丁和验证。',
    installCommand: 'npm install -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex',
    protocol: 'openai-responses',
    modelId: 'gpt-5.4-codex',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    sandbox: 'workspace-write',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    description: 'Anthropic 的终端编程助手，适合长上下文代码修改和命令行协作。',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    protocol: 'anthropic-messages',
    modelId: 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com',
    sandbox: 'workspace-write',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    description: '开放式终端编码代理，常用于多提供商模型和 OpenAI-compatible 接入。',
    installCommand: 'npm install -g opencode-ai',
    docsUrl: 'https://opencode.ai',
    protocol: 'openai-compatible',
    modelId: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    sandbox: 'workspace-write',
  },
]

const protocolCopy: Record<Protocol, { label: string; note: string; endpoint: string }> = {
  'openai-compatible': {
    label: 'OpenAI Compatible',
    note: '使用 Authorization: Bearer，通常请求 /chat/completions，适合 DeepSeek、Qwen、OpenRouter 等。',
    endpoint: '/chat/completions',
  },
  'anthropic-messages': {
    label: 'Anthropic Messages',
    note: '使用 x-api-key 与 anthropic-version，Claude Code 原生优先使用该协议。',
    endpoint: '/v1/messages',
  },
  'openai-responses': {
    label: 'OpenAI Responses',
    note: 'OpenAI Responses/Agents 协议，适合 Codex 类工具和 GPT/Codex 系列模型能力。',
    endpoint: '/responses',
  },
}

const sandboxCopy: Record<SandboxMode, string> = {
  'read-only': '只读：允许查看和分析代码，不写入文件。',
  'workspace-write': '工作区写入：允许修改当前项目文件，适合日常开发。',
  'danger-full-access': '完全访问：允许越过工作区边界，仅在可信任务中使用。',
}

export default function CodingToolsPage() {
  const [tools, setTools] = useState<ToolConfig[]>(defaults)
  const [statuses, setStatuses] = useState<Record<string, CodingToolStatus>>({})
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [activeToolId, setActiveToolId] = useState(defaults[0].id)
  const [checking, setChecking] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authMessage, setAuthMessage] = useState('')
  const [authSession, setAuthSession] = useState<{ userCode?: string; verificationUrl?: string; expiresAt?: string } | null>(null)
  const [codexTransport, setCodexTransport] = useState<CodexTransport>('http')
  const [dockerStatus, setDockerStatus] = useState<DockerRuntimeStatus | null>(null)
  const [dockerBusy, setDockerBusy] = useState(false)
  const [dockerMessage, setDockerMessage] = useState('')
  const [dockerOutput, setDockerOutput] = useState('')
  const [cliBusy, setCliBusy] = useState(false)
  const [cliMessage, setCliMessage] = useState('')
  const [cliOutput, setCliOutput] = useState('')
  const [toolTestBusy, setToolTestBusy] = useState(false)
  const [toolTestMessage, setToolTestMessage] = useState('')
  const [toolTestOk, setToolTestOk] = useState<boolean | null>(null)
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({})

  useEffect(() => {
    api.getSettings().then((settings) => {
      let nextTools = defaults
      if (settings.MODEL_CATALOG) {
        try {
          const catalog = (JSON.parse(settings.MODEL_CATALOG) as ModelCatalogItem[]).filter((item) => item.enabled)
          setModels(catalog)
          setApiKeyDrafts(Object.fromEntries(catalog.map((item) => [item.modelId, item.apiKey || ''])))
        } catch {
          setModels([])
        }
      }
      if (settings[storageKey]) {
        try {
          nextTools = mergeTools(JSON.parse(settings[storageKey]) as ToolConfig[])
          setTools(nextTools)
        } catch {
          setTools(defaults)
        }
      }
      if (settings.CODE_AGENT_ACTIVE_TOOL) setActiveToolId(settings.CODE_AGENT_ACTIVE_TOOL)
      if (settings.CODEX_CHATGPT_TRANSPORT === 'websocket') setCodexTransport('websocket')
      void refreshStatus(nextTools)
      void refreshCodexAuth()
      void refreshDockerStatus()
    })
  }, [])

  const activeTool = tools.find((tool) => tool.id === activeToolId) ?? tools[0]
  const hasSavedConfig = (tool: ToolConfig) => models.some((model) => hasModelConfigForTool(model, tool))
  const installedCount = useMemo(
    () => tools.filter((tool) => statuses[tool.id]?.installed).length,
    [statuses, tools]
  )
  const configuredCount = useMemo(
    () => tools.filter((tool) => statuses[tool.id]?.installed && (statuses[tool.id]?.configured || hasSavedConfig(tool))).length,
    [models, statuses, tools]
  )
  const envSnippet = buildEnvSnippet(activeTool)
  const runCommand = buildRunCommand(activeTool)
  const selectedModel = models.find((model) => model.modelId === activeTool.modelId)
  const activeApiKey = apiKeyDrafts[activeTool.modelId] ?? selectedModel?.apiKey ?? ''

  async function refreshStatus(probeTools = tools) {
    setChecking(true)
    try {
      const res = await api.getCodingToolStatus(probeTools.map(({ apiKeyEnv, id, command }) => ({ apiKeyEnv, id, command })))
      setStatuses(Object.fromEntries(res.items.map((item) => [item.id, item])))
    } finally {
      setChecking(false)
    }
  }

  async function refreshDockerStatus() {
    setDockerBusy(true)
    setDockerMessage('')
    try {
      const status = await api.getDockerRuntimeStatus()
      setDockerStatus(status)
      setDockerMessage(status.message)
    } catch (error: any) {
      setDockerMessage(error?.message || 'Docker 检测失败')
    } finally {
      setDockerBusy(false)
    }
  }

  async function installDockerRuntime() {
    setDockerBusy(true)
    setDockerMessage('正在构建容器镜像...')
    setDockerOutput('')
    try {
      const result = await api.installDockerRuntime()
      setDockerMessage(result.message)
      setDockerOutput(result.output || '')
      await refreshDockerStatus()
    } catch (error: any) {
      setDockerMessage(error?.message || '容器安装/启动失败')
    } finally {
      setDockerBusy(false)
    }
  }

  async function installAllCliTools() {
    setCliBusy(true)
    setCliMessage('正在安装 Codex、Claude Code、OpenCode...')
    setCliOutput('')
    try {
      const result = await api.installAllCliTools()
      setCliMessage(result.message)
      setCliOutput(result.output || '')
      if (result.items?.length) {
        setStatuses(Object.fromEntries(result.items.map((item) => [item.id, item])))
      }
      void refreshDockerStatus()
    } catch (error: any) {
      setCliMessage(error?.message || 'CLI 安装失败')
    } finally {
      setCliBusy(false)
    }
  }

  function patchTool(id: string, patch: Partial<ToolConfig>) {
    setTools((current) => current.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)))
  }

  async function refreshCodexAuth() {
    try {
      const status = await api.getCodexAuthStatus()
      setCodexAuth(status)
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
          ? `验证码：${result.userCode}。请在已登录 ChatGPT 的浏览器中打开授权页。`
          : result.message
      )

      void openCodexAuthPage()

      let interval = Math.max(1, result.interval ?? 5)
      const expiresAtMs = result.expiresAt ? new Date(result.expiresAt).getTime() : Date.now() + 15 * 60 * 1000
      while (Date.now() < expiresAtMs) {
        await delay(Math.min(interval * 1000, Math.max(0, expiresAtMs - Date.now())))
        if (Date.now() >= expiresAtMs) break

        const poll = await withTimeout(
          api.pollCodexChatGptLogin(result.loginId),
          15000,
          '本次轮询超时，仍在等待浏览器授权'
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
        setAuthMessage('验证码已过期，请重新点击登录生成新的验证码。')
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
      if (!result.ok) setAuthMessage(result.message || 'Failed to open authorization page')
    } catch (error: any) {
      setAuthMessage(error?.message || 'Failed to open authorization page')
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

  async function save() {
    await api.saveSettings({
      [storageKey]: JSON.stringify(tools),
      CODE_AGENT_ACTIVE_TOOL: activeTool.id,
      CODE_AGENT_ACTIVE_COMMAND: activeTool.command,
      CODE_AGENT_ACTIVE_PROTOCOL: activeTool.protocol,
      CODE_AGENT_ACTIVE_MODEL: activeTool.modelId,
      CODE_AGENT_ACTIVE_BASE_URL: activeTool.baseUrl,
      CODE_AGENT_ACTIVE_API_KEY_ENV: activeTool.apiKeyEnv,
      CODE_AGENT_ACTIVE_SANDBOX: activeTool.sandbox,
      CODEX_CHATGPT_TRANSPORT: codexTransport,
    })
    showSaved()
  }

  async function saveActiveToolConfig() {
    const item: ModelCatalogItem = {
      id: `code-agent-${activeTool.id}`,
      enabled: true,
      name: `${activeTool.name} 配置`,
      provider: inferProvider(activeTool),
      modelId: activeTool.modelId,
      apiEndpoint: activeTool.baseUrl,
      anthropicEndpoint: activeTool.protocol === 'anthropic-messages' ? activeTool.baseUrl : '',
      apiKeyEnv: activeTool.apiKeyEnv,
      apiKey: activeApiKey,
    }
    const next = [...models.filter((model) => model.id !== item.id), item]
    setModels(next)
    await api.saveSettings({
      MODEL_CATALOG: JSON.stringify(next),
      ACTIVE_MODEL_ID: item.id,
      [storageKey]: JSON.stringify(tools),
      CODE_AGENT_ACTIVE_TOOL: activeTool.id,
      CODE_AGENT_ACTIVE_COMMAND: activeTool.command,
      CODE_AGENT_ACTIVE_PROTOCOL: activeTool.protocol,
      CODE_AGENT_ACTIVE_MODEL: activeTool.modelId,
      CODE_AGENT_ACTIVE_BASE_URL: activeTool.baseUrl,
      CODE_AGENT_ACTIVE_API_KEY_ENV: activeTool.apiKeyEnv,
      CODE_AGENT_ACTIVE_SANDBOX: activeTool.sandbox,
    })
    showSaved()
  }

  async function testActiveToolConnection() {
    setToolTestBusy(true)
    setToolTestMessage('')
    setToolTestOk(null)
    try {
      const result = await api.testModel({
        provider: inferProvider(activeTool),
        apiEndpoint: activeTool.baseUrl,
        anthropicEndpoint: activeTool.protocol === 'anthropic-messages' ? activeTool.baseUrl : undefined,
        apiKey: activeApiKey,
        apiKeyEnv: activeTool.apiKeyEnv,
      })
      setToolTestOk(result.ok)
      setToolTestMessage(result.message)
    } catch (error: any) {
      setToolTestOk(false)
      setToolTestMessage(error?.message || '测试连接失败')
    } finally {
      setToolTestBusy(false)
    }
  }

  function copy(text: string, label: string) {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
    setCopied(label)
    window.setTimeout(() => setCopied(null), 1400)
  }

  function showSaved() {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100" aria-label="侧栏">
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold">AgentHub</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">Code Agent</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => refreshStatus()}
              disabled={checking}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50"
            >
              <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
              检测安装
            </button>
            <button
              type="button"
              onClick={installAllCliTools}
              disabled={cliBusy}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50 disabled:opacity-50"
            >
              <Download className={cn('h-4 w-4', cliBusy && 'animate-pulse')} />
              {cliBusy ? '安装中' : '一键安装 CLI'}
            </button>
            <button
              type="button"
              onClick={save}
              className="h-9 rounded-xl bg-neutral-950 px-4 text-sm font-medium text-white transition hover:bg-neutral-800"
            >
              保存配置
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
          <section className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="inline-flex h-7 items-center gap-2 rounded-full border border-neutral-200 px-3 text-xs text-neutral-500">
                <Terminal className="h-3.5 w-3.5" />
                CLI 编程工具集中管理
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-normal">Code Agent</h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-neutral-500">
                管理 Codex、Claude Code、OpenCode 等终端编程工具的安装状态、沙箱策略、模型绑定和 API 协议差异。
              </p>
            </div>
            <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-3">
              <Stat value={tools.length} label="工具总数" />
              <Stat value={installedCount} label="已安装" />
              <Stat value={configuredCount} label="可运行" />
            </div>
          </section>

          <DockerRuntimePanel
            busy={dockerBusy}
            cliBusy={cliBusy}
            cliMessage={cliMessage}
            cliOutput={cliOutput}
            message={dockerMessage}
            output={dockerOutput}
            status={dockerStatus}
            onInstallCli={installAllCliTools}
            onInstall={installDockerRuntime}
            onRefresh={refreshDockerStatus}
          />

          <section className="mt-8 grid gap-4 lg:grid-cols-3">
            {tools.map((tool) => {
              const status = statuses[tool.id]
              const active = activeTool.id === tool.id
              const savedConfig = hasSavedConfig(tool)
              const configured = Boolean(status?.configured || savedConfig)
              const configMessage = status?.configured
                ? status.configMessage
                : savedConfig
                  ? '配置已保存；容器运行需重启或注入环境变量。'
                  : status?.configMessage
              return (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => setActiveToolId(tool.id)}
                  className={cn(
                    'rounded-2xl border bg-white p-5 text-left shadow-sm transition hover:border-neutral-300',
                    active ? 'border-neutral-950' : 'border-neutral-200'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="grid h-11 w-11 place-items-center rounded-xl bg-neutral-100 text-neutral-800">
                      <ToolIcon toolId={tool.id} name={tool.name} />
                    </div>
                    <StatusBadge configured={configured} installed={Boolean(status?.installed)} savedOnly={savedConfig && !status?.configured} version={status?.version} />
                  </div>
                  <div className="mt-5 text-base font-semibold">{tool.name}</div>
                  <p className="mt-2 min-h-12 text-sm leading-6 text-neutral-500">{tool.description}</p>
                  {configMessage && (
                    <div
                      className={cn(
                        'mt-3 min-h-5 truncate text-xs',
                        configured ? 'text-emerald-600' : status?.installed ? 'text-amber-600' : 'text-neutral-400'
                      )}
                      title={configMessage}
                    >
                      {configMessage}
                    </div>
                  )}
                  <div className="mt-4 font-mono text-xs text-neutral-400">{tool.command}</div>
                </button>
              )
            })}
          </section>

          <section className="mt-8 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">{activeTool.name}</h2>
                  <p className="mt-2 text-sm leading-6 text-neutral-500">{activeTool.description}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={testActiveToolConnection}
                    disabled={toolTestBusy}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                  >
                    <PlugZap className={cn('h-4 w-4', toolTestBusy && 'animate-pulse')} />
                    {toolTestBusy ? '测试中' : '测试连接'}
                  </button>
                    <button
                      type="button"
                    onClick={saveActiveToolConfig}
                    className="inline-flex h-9 items-center rounded-xl bg-neutral-950 px-3 text-sm font-medium text-white hover:bg-neutral-800"
                  >
                    保存当前配置
                  </button>
                  <a
                    href={activeTool.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 px-3 text-sm text-neutral-600 hover:bg-neutral-50"
                  >
                    文档
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              </div>

              {toolTestMessage && (
                <div
                  className={cn(
                    'mt-4 rounded-xl px-3 py-2 text-xs leading-5',
                    toolTestOk ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                  )}
                >
                  {toolTestMessage}
                </div>
              )}

              {activeTool.id === 'codex' && (
                <CodexChatGptAuthCard
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
              )}

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <Field label="命令名" value={activeTool.command} onChange={(command) => patchTool(activeTool.id, { command })} />
                <Field label="API Key 环境变量" value={activeTool.apiKeyEnv} onChange={(apiKeyEnv) => patchTool(activeTool.id, { apiKeyEnv })} />
                <Field label="Base URL" value={activeTool.baseUrl} onChange={(baseUrl) => patchTool(activeTool.id, { baseUrl })} />
                <Field
                  label="API Key（可选，保存到模型管理）"
                  type="password"
                  value={activeApiKey}
                  onChange={(apiKey) => setApiKeyDrafts((current) => ({ ...current, [activeTool.modelId]: apiKey }))}
                />
                <label className="block text-sm">
                  <span className="mb-2 block text-neutral-600">模型绑定</span>
                  <div className="relative">
                    <select
                      value={activeTool.modelId}
                      onChange={(event) => patchTool(activeTool.id, { modelId: event.target.value })}
                      className="h-10 w-full appearance-none rounded-xl border border-neutral-200 bg-white px-3 pr-8 outline-none transition focus:border-neutral-400"
                    >
                      <option value={activeTool.modelId}>{activeTool.modelId}</option>
                      {models
                        .filter((model) => model.modelId !== activeTool.modelId)
                        .map((model) => (
                          <option key={model.id} value={model.modelId}>
                            {model.modelId} / {model.provider}
                          </option>
                        ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-neutral-400" />
                  </div>
                </label>
              </div>

              <div className="mt-6">
                <div className="mb-2 text-sm text-neutral-600">API 协议</div>
                <div className="grid gap-2 md:grid-cols-3">
                  {(Object.keys(protocolCopy) as Protocol[]).map((protocol) => (
                    <button
                      key={protocol}
                      type="button"
                      onClick={() => patchTool(activeTool.id, { protocol })}
                      className={cn(
                        'rounded-xl border p-3 text-left transition hover:border-neutral-300',
                        activeTool.protocol === protocol ? 'border-neutral-950 bg-neutral-50' : 'border-neutral-200'
                      )}
                    >
                      <div className="text-sm font-medium">{protocolCopy[protocol].label}</div>
                      <div className="mt-1 font-mono text-xs text-neutral-400">{protocolCopy[protocol].endpoint}</div>
                      <div className="mt-2 text-xs leading-5 text-neutral-500">{protocolCopy[protocol].note}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-6">
                <div className="mb-2 flex items-center gap-2 text-sm text-neutral-600">
                  <Shield className="h-4 w-4" />
                  沙箱策略
                </div>
                <div className="grid gap-2 md:grid-cols-3">
                  {(Object.keys(sandboxCopy) as SandboxMode[]).map((sandbox) => (
                    <button
                      key={sandbox}
                      type="button"
                      onClick={() => patchTool(activeTool.id, { sandbox })}
                      className={cn(
                        'rounded-xl border p-3 text-left transition hover:border-neutral-300',
                        activeTool.sandbox === sandbox ? 'border-neutral-950 bg-neutral-50' : 'border-neutral-200'
                      )}
                    >
                      <div className="font-mono text-xs font-semibold">{sandbox}</div>
                      <div className="mt-2 text-xs leading-5 text-neutral-500">{sandboxCopy[sandbox]}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <aside className="max-h-[calc(100vh-16rem)] space-y-4 overflow-y-auto overscroll-contain pr-2 [scrollbar-gutter:stable]">
              <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <div className="text-sm font-semibold">配置预览</div>
                <div className="mt-3 text-xs text-neutral-500">
                  {selectedModel ? `已匹配模型管理：${selectedModel.name}` : '尚未匹配模型管理，可一键同步当前配置。'}
                </div>
                <div className="mt-4 text-xs font-medium text-neutral-600">环境变量</div>
                <CodeBlock value={envSnippet} />
                <button
                  type="button"
                  onClick={() => copy(envSnippet, '环境变量')}
                  className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-neutral-200 text-sm hover:bg-neutral-50"
                >
                  <Copy className="h-4 w-4" />
                  复制环境变量
                </button>
                <div className="mt-4 text-xs font-medium text-neutral-600">运行命令</div>
                <CodeBlock value={runCommand} />
                <button
                  type="button"
                  onClick={() => copy(runCommand, '运行命令')}
                  className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-neutral-200 text-sm hover:bg-neutral-50"
                >
                  <Copy className="h-4 w-4" />
                  复制运行命令
                </button>
              </div>

              <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <div className="text-sm font-semibold">协议差异提醒</div>
                <div className="mt-4 space-y-3 text-xs leading-5 text-neutral-500">
                  <ProtocolLine title="Codex" text="优先 OpenAI Responses，使用 OPENAI_API_KEY，可绑定 GPT/Codex 系列模型。" />
                  <ProtocolLine title="Claude Code" text="原生 Anthropic Messages，使用 ANTHROPIC_API_KEY 与 anthropic-version。" />
                  <ProtocolLine title="OpenCode" text="常见为 OpenAI-compatible，多供应商时重点检查 Base URL 与模型名。" />
                </div>
              </div>
            </aside>
          </section>
        </div>
      </main>

      {(saved || copied) && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          {copied ? `已复制${copied}` : '已保存配置'}
        </div>
      )}
    </div>
  )
}

function mergeTools(saved: ToolConfig[]) {
  return defaults.map((item) => ({ ...item, ...saved.find((tool) => tool.id === item.id) }))
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
      }
    )
  })
}

function DockerRuntimePanel({
  busy,
  cliBusy,
  cliMessage,
  cliOutput,
  message,
  output,
  status,
  onInstall,
  onInstallCli,
  onRefresh,
}: {
  busy: boolean
  cliBusy: boolean
  cliMessage: string
  cliOutput: string
  message: string
  output: string
  status: DockerRuntimeStatus | null
  onInstall: () => void
  onInstallCli: () => void
  onRefresh: () => void
}) {
  const canInstall = Boolean(status?.ready && status.installEnabled)
  const visibleOutput = cliOutput || output
  const checks = [
    { label: 'Docker CLI', ok: status?.dockerInstalled, detail: status?.dockerVersion },
    { label: 'Compose', ok: status?.composeInstalled, detail: status?.composeVersion },
    { label: 'Daemon', ok: status?.daemonRunning, detail: status?.serverVersion ? `Server ${status.serverVersion}` : null },
    { label: 'Compose file', ok: status?.composeFilePresent, detail: status?.projectRoot },
  ]

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-950 text-white shadow-sm">
      <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/10">
              <Box className="h-5 w-5 text-cyan-200" />
            </div>
            <div>
              <h2 className="text-base font-semibold">容器运行环境</h2>
              <p className="mt-1 text-sm leading-6 text-neutral-300">
                检测本机 Docker，并构建内置 Codex、Claude Code、OpenCode 的 AgentHub 容器镜像。
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-2 md:grid-cols-4">
            {checks.map((item) => (
              <DockerCheck key={item.label} label={item.label} ok={item.ok} detail={item.detail} />
            ))}
          </div>

          {(message || status?.message) && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs leading-5 text-neutral-200">
              {message || status?.message}
            </div>
          )}

          {cliMessage && (
            <div className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-xs leading-5 text-emerald-50">
              {cliMessage}
            </div>
          )}

          {visibleOutput && (
            <pre className="mt-4 max-h-40 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-xs leading-5 text-neutral-200">
              <code>{visibleOutput}</code>
            </pre>
          )}
        </div>

        <div className="flex flex-col justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.06] p-4">
          <div>
            <div className="text-sm font-medium">容器操作</div>
            <p className="mt-2 text-xs leading-5 text-neutral-300">
              安装会在后端固定执行 docker compose build，不读取任意命令输入。
            </p>
          </div>
          <div className="grid gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/10 text-sm font-medium transition hover:bg-white/15 disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
              检测 Docker
            </button>
            <button
              type="button"
              onClick={onInstall}
              disabled={busy || !canInstall}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-cyan-300 text-sm font-semibold text-neutral-950 transition hover:bg-cyan-200 disabled:bg-neutral-700 disabled:text-neutral-400"
            >
              <Download className="h-4 w-4" />
              安装容器
            </button>
            <button
              type="button"
              onClick={onInstallCli}
              disabled={busy || cliBusy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-emerald-300 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-200 disabled:bg-neutral-700 disabled:text-neutral-400"
            >
              <Download className={cn('h-4 w-4', cliBusy && 'animate-pulse')} />
              {cliBusy ? '正在安装 CLI' : '一键安装全部 CLI'}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

function DockerCheck({ label, ok, detail }: { label: string; ok?: boolean; detail?: string | null }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.06] p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <XCircle className="h-4 w-4 text-neutral-500" />}
        <span>{label}</span>
      </div>
      <div className="mt-2 truncate font-mono text-xs text-neutral-400" title={detail || undefined}>
        {detail || 'not detected'}
      </div>
    </div>
  )
}

function CodexChatGptAuthCard({
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
  const accountLoggedIn = status?.authMode === 'chatgpt'
  const apiKeyMode = status?.authMode === 'api-key'
  const deviceAuthEnabled = Boolean(status?.deviceAuthEnabled)
  const badgeLabel = accountLoggedIn ? 'ChatGPT 已登录' : apiKeyMode ? 'API Key 可用' : '未登录'
  const displayMessage = normalizeCodexAuthMessage(message || status?.message || '')

  return (
    <div className="mt-6 rounded-2xl border border-neutral-200 bg-[#fbfbfd] p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-neutral-500">
        OpenAI 运行认证
      </div>
      <div className="rounded-xl border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 pb-3">
          <div>
            <div className="flex items-center gap-2 text-base font-semibold text-neutral-800">
              <KeyRound className="h-4 w-4 text-indigo-500" />
              OpenAI Codex
            </div>
            <p className="mt-1 text-sm text-neutral-500">
              {apiKeyMode
                ? '当前通过环境变量 API Key 调用 OpenAI-compatible API。'
                : '可选使用 ChatGPT Pro / Plus 设备授权。'}
            </p>
            {status?.accountId && <p className="mt-1 font-mono text-xs text-neutral-400">{status.accountId}</p>}
          </div>
          <span
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium',
              accountLoggedIn
                ? 'bg-emerald-50 text-emerald-700'
                : status?.authMode === 'api-key'
                  ? 'bg-blue-50 text-blue-700'
                  : 'bg-neutral-100 text-neutral-600'
            )}
          >
            {badgeLabel}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {deviceAuthEnabled && !accountLoggedIn && (
              <button
                type="button"
                onClick={onLogin}
                disabled={busy}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-500 disabled:bg-neutral-300"
              >
                <KeyRound className={cn('h-4 w-4', busy && 'animate-pulse')} />
                {busy ? '正在启动授权' : '使用 ChatGPT 账户登录'}
              </button>
            )}
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              刷新状态
            </button>
            {deviceAuthEnabled && accountLoggedIn && (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                重试验证
              </button>
            )}
            {deviceAuthEnabled && accountLoggedIn && (
              <button
                type="button"
                onClick={onLogout}
                disabled={busy}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 text-sm text-red-600 hover:bg-red-100 disabled:opacity-50"
              >
                <LogOut className="h-4 w-4" />
                登出
              </button>
            )}
            {!deviceAuthEnabled && (
              <span className="inline-flex h-9 items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 text-sm text-blue-700">
                <Shield className="h-4 w-4" />
                设备授权已关闭
              </span>
            )}
          </div>
          <div className="text-xs text-neutral-500">
            {apiKeyMode ? '运行时只读取显式环境变量' : '兼容 ChatGPT Pro / Plus 订阅'}
          </div>
        </div>

        {deviceAuthEnabled && session?.userCode && (
          <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-indigo-600">授权验证码</div>
              <div className="mt-1 font-mono text-lg font-semibold tracking-normal text-indigo-950">{session.userCode}</div>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(session.userCode || '').catch(() => undefined)
                }}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
              >
                <Copy className="h-4 w-4" />
                复制验证码
              </button>
              {session.verificationUrl && (
                <button
                  type="button"
                  onClick={onOpenAuthPage}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  打开授权页
                  <ExternalLink className="h-4 w-4" />
                </button>
              )}
              {session.verificationUrl && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(session.verificationUrl || '').catch(() => undefined)
                  }}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-indigo-200 bg-white px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
                >
                  <Copy className="h-4 w-4" />
                  复制链接
                </button>
              )}
            </div>
            </div>
            <div className="mt-3 text-xs leading-5 text-indigo-700">
              如果授权页显示 Route Error，请在普通浏览器或无痕窗口打开授权链接，先登录 ChatGPT，再输入新的验证码。
            </div>
          </div>
        )}

        {displayMessage && (
          <div className="mt-3 rounded-xl bg-neutral-50 px-3 py-2 font-mono text-xs leading-5 text-neutral-600">
            {displayMessage}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-neutral-700">传输路径</div>
            <p className="mt-1 text-xs text-neutral-500">
              HTTP 使用当前 ChatGPT Codex 路径，WebSocket 使用 OpenAI Responses websocket。
            </p>
          </div>
          <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-1">
            {(['http', 'websocket'] as CodexTransport[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onTransport(item)}
                className={cn(
                  'h-7 rounded-md px-3 text-xs font-medium transition',
                  transport === item ? 'bg-indigo-50 text-indigo-700' : 'text-neutral-600 hover:bg-neutral-50'
                )}
              >
                {item === 'http' ? 'HTTP' : 'WebSocket'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function normalizeCodexAuthMessage(message: string) {
  if (/ChatGPT device auth is disabled/i.test(message)) {
    return 'ChatGPT 设备授权已在运行时禁用；后端只读取 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL 等显式环境变量。'
  }
  if (/Route Error/i.test(message) && /Invalid content type:\s*text\/html/i.test(message)) {
    return 'OpenAI 授权页返回 Route Error（HTML 内容类型不匹配）。请复制授权链接，在普通浏览器或无痕窗口打开，并确认 ChatGPT 已登录后输入新的验证码。'
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

function buildEnvSnippet(tool: ToolConfig) {
  const baseKey = `${tool.id.replace(/-/g, '_').toUpperCase()}_BASE_URL`
  const modelKey = `${tool.id.replace(/-/g, '_').toUpperCase()}_MODEL`
  return `${tool.apiKeyEnv}=your_api_key_here\n${baseKey}=${tool.baseUrl}\n${modelKey}=${tool.modelId}`
}

function buildRunCommand(tool: ToolConfig) {
  if (tool.id === 'codex') {
    return `${tool.command} --model ${tool.modelId} --sandbox ${tool.sandbox}`
  }
  if (tool.id === 'claude-code') {
    return `${tool.command} --model ${tool.modelId}`
  }
  return `${tool.command} --model ${tool.modelId} --provider ${inferProvider(tool)}`
}

function inferProvider(tool: ToolConfig) {
  if (tool.protocol === 'anthropic-messages') return 'anthropic'
  if (tool.protocol === 'openai-responses') return 'openai'
  if (tool.baseUrl.includes('deepseek')) return 'deepseek'
  if (tool.baseUrl.includes('dashscope') || tool.baseUrl.includes('aliyuncs')) return 'dashscope'
  if (tool.baseUrl.includes('openrouter')) return 'openrouter'
  return 'openai-compatible'
}

function hasModelConfigForTool(model: ModelCatalogItem, tool: ToolConfig) {
  if (model.enabled === false) return false
  if (model.modelId !== tool.modelId) return false
  if ((model.apiEndpoint || '').replace(/\/$/, '') !== tool.baseUrl.replace(/\/$/, '')) return false
  return Boolean(model.apiKey || model.apiKeyEnv)
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{label}</div>
    </div>
  )
}

function StatusBadge({
  configured,
  installed,
  savedOnly = false,
  version,
}: {
  configured: boolean
  installed: boolean
  savedOnly?: boolean
  version?: string | null
}) {
  const ready = installed && configured
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs',
        ready
          ? 'bg-emerald-50 text-emerald-700'
          : installed
            ? 'bg-amber-50 text-amber-700'
            : 'bg-neutral-100 text-neutral-500'
      )}
      title={version || undefined}
    >
      {ready ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : installed ? (
        <AlertCircle className="h-3.5 w-3.5" />
      ) : (
        <XCircle className="h-3.5 w-3.5" />
      )}
      {ready ? (savedOnly ? '已保存配置' : '可运行') : installed ? '已安装，未配置' : '未检测到'}
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
  return (
    <label className="block text-sm">
      <span className="mb-2 block text-neutral-600">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-xl border border-neutral-200 px-3 outline-none transition focus:border-neutral-400"
      />
    </label>
  )
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-xl bg-neutral-950 p-3 font-mono text-xs leading-5 text-white">
      <code>{value}</code>
    </pre>
  )
}

function ProtocolLine({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl bg-neutral-50 p-3">
      <div className="font-semibold text-neutral-800">{title}</div>
      <div className="mt-1">{text}</div>
    </div>
  )
}
