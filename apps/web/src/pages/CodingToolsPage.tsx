import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  LogOut,
  PanelLeft,
  PlayCircle,
  RefreshCw,
  Save,
  Shield,
  Terminal,
  XCircle,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { api, type CodexAuthStatus, type CodingToolStatus, type ModelCatalogItem, type OpencodeModelItem } from '../lib/api'
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
    description: '本机运行的 OpenAI 编程代理，用于仓库理解、修改和验证。',
    installCommand: 'npm install -g @openai/codex@0.42.0',
    docsUrl: 'https://developers.openai.com/codex',
    protocol: 'openai-responses',
    modelId: 'gpt-5.5',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    sandbox: 'workspace-write',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    description: 'Anthropic 终端编程助手，适合长上下文代码协作。',
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
    description: '开放式终端编程代理，适合多提供商 OpenAI-compatible 接入。',
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
    note: '适合 DeepSeek、Qwen、OpenRouter 等 /chat/completions 兼容服务。',
    endpoint: '/chat/completions',
  },
  'anthropic-messages': {
    label: 'Anthropic Messages',
    note: 'Claude Code 原生协议，使用 x-api-key 和 anthropic-version。',
    endpoint: '/v1/messages',
  },
  'openai-responses': {
    label: 'OpenAI Responses',
    note: 'Codex 优先协议，适合 OpenAI Responses / Agents 能力。',
    endpoint: '/responses',
  },
}

const sandboxCopy: Record<SandboxMode, string> = {
  'read-only': '只读分析，不写入项目文件。',
  'workspace-write': '允许修改当前项目工作区文件。',
  'danger-full-access': '完全访问本机文件系统，仅用于可信任务。',
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
  const [cliBusy, setCliBusy] = useState(false)
  const [cliMessage, setCliMessage] = useState('')
  const [cliOutput, setCliOutput] = useState('')
  const [toolTestBusy, setToolTestBusy] = useState(false)
  const [toolTestMessage, setToolTestMessage] = useState('')
  const [toolTestOk, setToolTestOk] = useState<boolean | null>(null)
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({})
  const [opencodeModels, setOpencodeModels] = useState<OpencodeModelItem[]>([])
  const [opencodeDefaultModel, setOpencodeDefaultModel] = useState<string | null>(null)
  const [opencodeModelMessage, setOpencodeModelMessage] = useState('')
  const [opencodeModelBusy, setOpencodeModelBusy] = useState(false)

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
      void refreshOpencodeModels()
    })
  }, [])

  const activeTool = tools.find((tool) => tool.id === activeToolId) ?? tools[0]
  const selectedModel = models.find((model) => model.modelId === activeTool.modelId)
  const activeApiKey = apiKeyDrafts[activeTool.modelId] ?? selectedModel?.apiKey ?? ''
  const envSnippet = buildEnvSnippet(activeTool)
  const runCommand = buildRunCommand(activeTool)
  const modelOptions = useMemo(
    () => buildModelOptions(activeTool.id === 'opencode' ? [] : models, activeTool.id === 'opencode' ? opencodeModels : []),
    [activeTool.id, models, opencodeModels]
  )
  const installedCount = useMemo(() => tools.filter((tool) => statuses[tool.id]?.installed).length, [statuses, tools])
  const configuredCount = useMemo(
    () => tools.filter((tool) => statuses[tool.id]?.configured || hasSavedConfigForTool(models, tool)).length,
    [models, statuses, tools]
  )

  async function refreshStatus(probeTools = tools) {
    setChecking(true)
    try {
      const res = await api.getCodingToolStatus(probeTools.map(({ apiKeyEnv, id, command }) => ({ apiKeyEnv, id, command })))
      setStatuses(Object.fromEntries(res.items.map((item) => [item.id, item])))
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
      setOpencodeModelMessage(result.message)
      if (result.defaultModel) {
        setTools((current) =>
          current.map((tool) =>
            tool.id === 'opencode' && (!tool.modelId || tool.modelId === 'deepseek-chat')
              ? { ...tool, modelId: result.defaultModel ?? tool.modelId }
              : tool
          )
        )
      }
    } catch (error: any) {
      setOpencodeModelMessage(error?.message || 'Failed to load local OpenCode models.')
    } finally {
      setOpencodeModelBusy(false)
    }
  }

  async function installAllCliTools() {
    setCliBusy(true)
    setCliMessage('正在本机安装 Codex、Claude Code、OpenCode...')
    setCliOutput('')
    try {
      const result = await api.installAllCliTools()
      setCliMessage(result.message)
      setCliOutput(result.output || '')
      if (result.items?.length) {
        setStatuses(Object.fromEntries(result.items.map((item) => [item.id, item])))
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
      setAuthMessage(result.userCode ? `验证码：${result.userCode}。请在浏览器授权后等待自动刷新。` : result.message)
      void openCodexAuthPage()

      let interval = Math.max(1, result.interval ?? 5)
      const expiresAtMs = result.expiresAt ? new Date(result.expiresAt).getTime() : Date.now() + 15 * 60 * 1000
      while (Date.now() < expiresAtMs) {
        await delay(Math.min(interval * 1000, Math.max(0, expiresAtMs - Date.now())))
        if (Date.now() >= expiresAtMs) break

        const poll = await withTimeout(api.pollCodexChatGptLogin(result.loginId), 15000, '本次轮询超时，仍在等待浏览器授权')
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
      if (activeTool.id === 'opencode') {
        const result = await api.getOpencodeModels()
        setOpencodeModels(result.models)
        setOpencodeDefaultModel(result.defaultModel)
        setOpencodeModelMessage(result.message)
        setToolTestOk(result.ok)
        setToolTestMessage(result.ok ? `已读取 ${result.models.length} 个 OpenCode 本机模型。` : result.message)
        return
      }

      const result = await api.testModel({
        provider: inferProvider(activeTool),
        apiEndpoint: activeTool.baseUrl,
        anthropicEndpoint: activeTool.protocol === 'anthropic-messages' ? activeTool.baseUrl : undefined,
        apiKey: activeApiKey,
        apiKeyEnv: activeTool.apiKeyEnv,
        modelId: activeTool.modelId,
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
    <div className="flex h-screen overflow-hidden bg-[#f7f5f1] text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100" aria-label="侧栏">
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold">AgentHub</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">Coding Tools</span>
          </div>
          <div className="flex items-center gap-2">
            <IconButton label="检测" onClick={() => refreshStatus()} disabled={checking}>
              <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
            </IconButton>
            <IconButton label={cliBusy ? '安装中' : '安装 CLI'} onClick={installAllCliTools} disabled={cliBusy}>
              <Download className={cn('h-4 w-4', cliBusy && 'animate-pulse')} />
            </IconButton>
            <button
              type="button"
              onClick={save}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-neutral-950 px-3 text-sm font-medium text-white transition hover:bg-neutral-800"
            >
              <Save className="h-4 w-4" />
              保存
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <section className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="inline-flex h-7 items-center gap-2 rounded-md border border-neutral-300 bg-white px-2.5 text-xs text-neutral-600">
                <Terminal className="h-3.5 w-3.5 text-teal-700" />
                本机 Code Agent 工具台
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-normal">Coding Tools</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
                直接检测和配置 Windows 本机 CLI，不再使用容器路径或远端工作区映射。
              </p>
            </div>
            <div className="grid w-full grid-cols-3 gap-2 sm:w-auto">
              <Stat value={tools.length} label="工具" />
              <Stat value={installedCount} label="已安装" />
              <Stat value={configuredCount} label="可运行" />
            </div>
          </section>

          <section className="mt-5 grid gap-3 lg:grid-cols-3">
            {tools.map((tool) => {
              const status = statuses[tool.id]
              const savedConfig = hasSavedConfigForTool(models, tool)
              const configured = Boolean(status?.configured || savedConfig)
              return (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => setActiveToolId(tool.id)}
                  className={cn(
                    'min-h-[138px] rounded-lg border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-neutral-400',
                    activeTool.id === tool.id ? 'border-neutral-950 ring-2 ring-teal-700/10' : 'border-neutral-200'
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-neutral-100">
                        <ToolIcon toolId={tool.id} name={tool.name} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{tool.name}</div>
                        <div className="truncate font-mono text-xs text-neutral-400">{tool.command}</div>
                      </div>
                    </div>
                    <StatusBadge configured={configured} installed={Boolean(status?.installed)} savedOnly={savedConfig && !status?.configured} />
                  </div>
                  <p className="mt-3 line-clamp-2 text-xs leading-5 text-neutral-600">{tool.description}</p>
                  <div className={cn('mt-3 truncate text-xs', configured ? 'text-emerald-700' : status?.installed ? 'text-amber-700' : 'text-neutral-400')}>
                    {status?.configMessage || (savedConfig ? '配置已保存。' : '等待检测本机 CLI。')}
                  </div>
                </button>
              )
            })}
          </section>

          <section className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{activeTool.name}</h2>
                  <p className="mt-1 text-sm text-neutral-500">配置会写入 AgentHub 设置，并作为 Code Agent 的默认运行参数。</p>
                </div>
                <a
                  href={activeTool.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 px-3 text-sm text-neutral-600 hover:bg-neutral-50"
                >
                  文档
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <Field label="命令" value={activeTool.command} onChange={(value) => patchTool(activeTool.id, { command: value })} />
                {activeTool.id !== 'opencode' && (
                  <>
                    <Field label="Base URL" value={activeTool.baseUrl} onChange={(value) => patchTool(activeTool.id, { baseUrl: value })} />
                    <Field label="API Key 环境变量" value={activeTool.apiKeyEnv} onChange={(value) => patchTool(activeTool.id, { apiKeyEnv: value })} />
                    <Field label="API Key" type="password" value={activeApiKey} onChange={(value) => setApiKeyDrafts((current) => ({ ...current, [activeTool.modelId]: value }))} />
                  </>
                )}
                <label className="block text-sm md:col-span-2">
                  <span className="mb-2 flex items-center justify-between gap-3 text-neutral-600">
                    <span>模型</span>
                    {activeTool.id === 'opencode' && (
                      <button
                        type="button"
                        onClick={refreshOpencodeModels}
                        disabled={opencodeModelBusy}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                      >
                        <RefreshCw className={cn('h-3.5 w-3.5', opencodeModelBusy && 'animate-spin')} />
                        读取本机 OpenCode
                      </button>
                    )}
                  </span>
                  <div className="relative">
                    {activeTool.id === 'opencode' ? (
                      <select
                        value={activeTool.modelId}
                        onChange={(event) => patchTool(activeTool.id, { modelId: event.target.value })}
                        className="h-10 w-full appearance-none rounded-md border border-neutral-200 bg-white px-3 pr-8 outline-none transition focus:border-teal-700"
                      >
                        {modelOptions.length === 0 && <option value={activeTool.modelId}>{activeTool.modelId || 'OpenCode local default'}</option>}
                        {modelOptions.map((model) => (
                          <option key={model.id} value={model.value}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          list="coding-tool-models"
                          value={activeTool.modelId}
                          onChange={(event) => patchTool(activeTool.id, { modelId: event.target.value })}
                          className="h-10 w-full rounded-md border border-neutral-200 bg-white px-3 pr-8 outline-none transition focus:border-teal-700"
                        />
                        <datalist id="coding-tool-models">
                          {modelOptions.map((model) => (
                            <option key={model.id} value={model.value}>
                              {model.label}
                            </option>
                          ))}
                        </datalist>
                      </>
                    )}
                    <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-neutral-400" />
                  </div>
                  {activeTool.id === 'opencode' && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                      {opencodeDefaultModel && <span>默认：{opencodeDefaultModel}</span>}
                      {opencodeModels.length > 0 && <span>已读取 {opencodeModels.length} 个本机模型</span>}
                      {opencodeModelMessage && <span className="text-neutral-400">{opencodeModelMessage}</span>}
                    </div>
                  )}
                </label>
              </div>

              <div className="mt-5">
                <div className="mb-2 text-sm font-medium text-neutral-700">API 协议</div>
                <div className="grid gap-2 md:grid-cols-3">
                  {(Object.keys(protocolCopy) as Protocol[]).map((protocol) => (
                    <ChoiceButton
                      key={protocol}
                      active={activeTool.protocol === protocol}
                      title={protocolCopy[protocol].label}
                      meta={protocolCopy[protocol].endpoint}
                      text={protocolCopy[protocol].note}
                      onClick={() => patchTool(activeTool.id, { protocol })}
                    />
                  ))}
                </div>
              </div>

              <div className="mt-5">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-neutral-700">
                  <Shield className="h-4 w-4 text-teal-700" />
                  沙箱策略
                </div>
                <div className="grid gap-2 md:grid-cols-3">
                  {(Object.keys(sandboxCopy) as SandboxMode[]).map((sandbox) => (
                    <ChoiceButton
                      key={sandbox}
                      active={activeTool.sandbox === sandbox}
                      title={sandbox}
                      text={sandboxCopy[sandbox]}
                      onClick={() => patchTool(activeTool.id, { sandbox })}
                    />
                  ))}
                </div>
              </div>

              {activeTool.id === 'codex' && (
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
              )}

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={saveActiveToolConfig}
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800"
                >
                  <Save className="h-4 w-4" />
                  同步到模型配置
                </button>
                <button
                  type="button"
                  onClick={testActiveToolConnection}
                  disabled={toolTestBusy}
                  className="inline-flex h-10 items-center gap-2 rounded-md border border-neutral-200 bg-white px-4 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  <PlayCircle className={cn('h-4 w-4', toolTestBusy && 'animate-pulse')} />
                  测试连接
                </button>
                {toolTestMessage && (
                  <span className={cn('text-sm', toolTestOk ? 'text-emerald-700' : toolTestOk === false ? 'text-red-600' : 'text-neutral-500')}>
                    {toolTestMessage}
                  </span>
                )}
              </div>
            </div>

            <aside className="space-y-4">
              <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
                <div className="text-sm font-semibold">本机运行预览</div>
                <p className="mt-2 text-xs leading-5 text-neutral-500">
                  Agent 会在工作区真实路径下启动，不再转换为容器内路径。
                </p>
                <div className="mt-4 text-xs font-medium text-neutral-600">环境变量</div>
                <CodeBlock value={envSnippet} />
                <button
                  type="button"
                  onClick={() => copy(envSnippet, '环境变量')}
                  className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-neutral-200 text-sm hover:bg-neutral-50"
                >
                  <Copy className="h-4 w-4" />
                  复制环境变量
                </button>
                <div className="mt-4 text-xs font-medium text-neutral-600">命令预览</div>
                <CodeBlock value={runCommand} />
                <button
                  type="button"
                  onClick={() => copy(runCommand, '运行命令')}
                  className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-neutral-200 text-sm hover:bg-neutral-50"
                >
                  <Copy className="h-4 w-4" />
                  复制命令
                </button>
              </div>

              {(cliMessage || cliOutput) && (
                <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
                  <div className="text-sm font-semibold">安装输出</div>
                  {cliMessage && <p className="mt-2 text-sm text-neutral-600">{cliMessage}</p>}
                  {cliOutput && <CodeBlock value={cliOutput} />}
                </div>
              )}
            </aside>
          </section>
        </div>
      </main>

      {(saved || copied) && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-md bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          {copied ? `已复制 ${copied}` : '已保存配置'}
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
  const accountLoggedIn = status?.authMode === 'chatgpt'
  const apiKeyMode = status?.authMode === 'api-key'
  const deviceAuthEnabled = Boolean(status?.deviceAuthEnabled)
  const badgeLabel = accountLoggedIn ? 'ChatGPT 已登录' : apiKeyMode ? 'API Key 可用' : '未登录'
  const displayMessage = normalizeCodexAuthMessage(message || status?.message || '')

  return (
    <div className="mt-5 rounded-lg border border-neutral-200 bg-[#fbfbf8] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-neutral-800">
            <KeyRound className="h-4 w-4 text-teal-700" />
            OpenAI 运行认证
          </div>
          <p className="mt-1 text-xs leading-5 text-neutral-500">
            推荐用 OPENAI_API_KEY；开启设备授权时也可以同步 ChatGPT 登录状态。
          </p>
          {status?.accountId && <p className="mt-1 font-mono text-xs text-neutral-400">{status.accountId}</p>}
        </div>
        <span
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium',
            accountLoggedIn ? 'bg-emerald-50 text-emerald-700' : apiKeyMode ? 'bg-sky-50 text-sky-700' : 'bg-neutral-100 text-neutral-600'
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
              className="inline-flex h-9 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-medium text-white hover:bg-teal-800 disabled:bg-neutral-300"
            >
              <KeyRound className={cn('h-4 w-4', busy && 'animate-pulse')} />
              {busy ? '授权中' : '登录 ChatGPT'}
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
          {deviceAuthEnabled && accountLoggedIn && (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
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
              className="inline-flex h-9 items-center gap-2 rounded-md border border-red-100 bg-red-50 px-3 text-sm text-red-600 hover:bg-red-100 disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" />
              登出
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
                transport === item ? 'bg-teal-50 text-teal-800' : 'text-neutral-600 hover:bg-neutral-50'
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
              <div className="text-xs text-teal-700">授权验证码</div>
              <div className="mt-1 font-mono text-lg font-semibold tracking-normal text-teal-950">{session.userCode}</div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(session.userCode || '').catch(() => undefined)}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-teal-200 bg-white px-3 text-sm font-medium text-teal-800 hover:bg-teal-50"
              >
                <Copy className="h-4 w-4" />
                复制验证码
              </button>
              {session.verificationUrl && (
                <button
                  type="button"
                  onClick={onOpenAuthPage}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-teal-700 px-3 text-sm font-medium text-white hover:bg-teal-800"
                >
                  打开授权页
                  <ExternalLink className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {displayMessage && <div className="mt-3 rounded-md bg-white px-3 py-2 font-mono text-xs leading-5 text-neutral-600">{displayMessage}</div>}
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
  return <img src={toolIcons[toolId] ?? '/codex-color.svg'} alt={`${name} icon`} className="h-5 w-5 object-contain" draggable={false} />
}

function buildEnvSnippet(tool: ToolConfig) {
  if (tool.id === 'opencode') {
    return `# OpenCode uses local config\nOPENCODE_MODEL=${tool.modelId || 'local default'}`
  }
  const baseKey = `${tool.id.replace(/-/g, '_').toUpperCase()}_BASE_URL`
  const modelKey = `${tool.id.replace(/-/g, '_').toUpperCase()}_MODEL`
  return `${tool.apiKeyEnv}=your_api_key_here\n${baseKey}=${tool.baseUrl}\n${modelKey}=${tool.modelId}`
}

function buildRunCommand(tool: ToolConfig) {
  if (tool.id === 'codex') return `${tool.command} exec --model ${tool.modelId} --sandbox ${tool.sandbox} "<task>"`
  if (tool.id === 'claude-code') return `${tool.command} --model ${tool.modelId}`
  if (tool.id === 'opencode') return tool.modelId ? `${tool.command} run --model ${tool.modelId} "<task>"` : `${tool.command} run "<task>"`
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

function buildModelOptions(models: ModelCatalogItem[], opencodeModels: OpencodeModelItem[]) {
  const options = [
    ...opencodeModels.map((model) => ({
      id: `opencode:${model.id}`,
      label: `${model.provider} / ${model.model}`,
      value: model.id,
    })),
    ...models.map((model) => ({
      id: `catalog:${model.id}`,
      label: model.provider,
      value: model.modelId,
    })),
  ]
  const seen = new Set<string>()
  return options.filter((option) => {
    if (!option.value || seen.has(option.value)) return false
    seen.add(option.value)
    return true
  })
}

function hasSavedConfigForTool(models: ModelCatalogItem[], tool: ToolConfig) {
  return models.some((model) => {
    if (model.enabled === false) return false
    if (model.modelId !== tool.modelId) return false
    if ((model.apiEndpoint || '').replace(/\/$/, '') !== tool.baseUrl.replace(/\/$/, '')) return false
    return Boolean(model.apiKey || model.apiKeyEnv)
  })
}

function IconButton({ children, disabled, label, onClick }: { children: ReactNode; disabled?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50 disabled:opacity-50"
    >
      {children}
      {label}
    </button>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-lg font-semibold">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{label}</div>
    </div>
  )
}

function StatusBadge({ configured, installed, savedOnly = false }: { configured: boolean; installed: boolean; savedOnly?: boolean }) {
  const ready = installed && configured
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs',
        ready ? 'bg-emerald-50 text-emerald-700' : installed ? 'bg-amber-50 text-amber-700' : 'bg-neutral-100 text-neutral-500'
      )}
    >
      {ready ? <CheckCircle2 className="h-3 w-3" /> : installed ? <AlertCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {ready ? (savedOnly ? '已保存' : '可运行') : installed ? '未配置' : '未安装'}
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
        className="h-10 w-full rounded-md border border-neutral-200 px-3 outline-none transition focus:border-teal-700"
      />
    </label>
  )
}

function ChoiceButton({
  active,
  meta,
  text,
  title,
  onClick,
}: {
  active: boolean
  meta?: string
  text: string
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('rounded-md border p-3 text-left transition hover:border-neutral-400', active ? 'border-teal-700 bg-teal-50/60' : 'border-neutral-200 bg-white')}
    >
      <div className="text-sm font-medium">{title}</div>
      {meta && <div className="mt-1 font-mono text-xs text-neutral-400">{meta}</div>}
      <div className="mt-2 text-xs leading-5 text-neutral-500">{text}</div>
    </button>
  )
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-neutral-950 p-3 font-mono text-xs leading-5 text-neutral-50">
      <code>{value}</code>
    </pre>
  )
}
