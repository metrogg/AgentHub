import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  PanelLeft,
  PlayCircle,
  RefreshCw,
  Save,
  Terminal,
  XCircle,
} from 'lucide-react'
import CollapsibleSessionSidebar from '../components/chat/CollapsibleSessionSidebar'
import { api, type CodingToolStatus } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { cn } from '../lib/utils'

interface ToolConfig {
  id: string
  name: string
  command: string
  description: string
  installCommand: string
  docsUrl: string
  apiKeyEnv: string
  config?: Record<string, string | boolean>
  provider?: string
}

const storageKey = 'CODING_TOOLS_CONFIG'

// Module-level cache for tool status, persists across page navigations within the same session
let cachedToolStatus: Record<string, CodingToolStatus> | null = null
let cachedToolStatusTime = 0
const STATUS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

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
    apiKeyEnv: 'AGENTHUB_MODEL_API_KEY',
    config: { approvalPolicy: 'never', sandbox: 'workspace-write' },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    description: 'Anthropic 终端编程助手，适合长上下文代码协作。',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    apiKeyEnv: 'AGENTHUB_MODEL_API_KEY',
    config: { permissionMode: 'bypassPermissions', outputFormat: 'stream-json' },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    description: '开放式终端编程代理，适合多提供商 OpenAI-compatible 接入。',
    installCommand: 'npm install -g opencode-ai',
    docsUrl: 'https://opencode.ai',
    apiKeyEnv: 'AGENTHUB_MODEL_API_KEY',
    config: { agent: '' },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    description: 'Google Gemini 终端编程代理，适合使用 Gemini 模型进行仓库协作。',
    installCommand: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    apiKeyEnv: 'AGENTHUB_MODEL_API_KEY',
    config: {},
  },
]


export default function CodingToolsPage() {
  const { t } = useI18n()
  const [tools, setTools] = useState<ToolConfig[]>(defaults)
  const [statuses, setStatuses] = useState<Record<string, CodingToolStatus>>({})
  const [activeToolId, setActiveToolId] = useState(defaults[0].id)
  const [checking, setChecking] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [cliBusy, setCliBusy] = useState(false)
  const [cliMessage, setCliMessage] = useState('')
  const [cliOutput, setCliOutput] = useState('')
  const [toolTestBusy, setToolTestBusy] = useState(false)
  const [toolTestMessage, setToolTestMessage] = useState('')
  const [toolTestOk, setToolTestOk] = useState<boolean | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toolPage, setToolPage] = useState(0)
  const [executionEnabled, setExecutionEnabled] = useState<boolean | null>(null)
  const [executionBusy, setExecutionBusy] = useState(false)

  useEffect(() => {
    api.getAgentAdapters().then((res) => {
      setExecutionEnabled(res.executionEnabled)
    }).catch(() => setExecutionEnabled(null))
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
        const activeIndex = nextTools.findIndex((tool) => tool.id === settings.CODE_AGENT_ACTIVE_TOOL)
        if (activeIndex >= 0) setToolPage(Math.floor(activeIndex / 3))
      }
      void refreshStatus(nextTools, false) // Use cache if available
    })
  }, [])

  const activeTool = tools.find((tool) => tool.id === activeToolId) ?? tools[0]
  const envSnippet = buildEnvSnippet(activeTool)
  const runCommand = buildRunCommand(activeTool)
  const installedCount = useMemo(() => tools.filter((tool) => statuses[tool.id]?.installed).length, [statuses, tools])
  const configuredCount = useMemo(
    () => tools.filter((tool) => statuses[tool.id]?.configured).length,
    [statuses, tools]
  )
  const toolPageSize = 3
  const toolPageCount = Math.max(1, Math.ceil(tools.length / toolPageSize))
  const visibleTools = tools.slice(toolPage * toolPageSize, toolPage * toolPageSize + toolPageSize)
  const canPageTools = tools.length > toolPageSize

  useEffect(() => {
    if (toolPage >= toolPageCount) setToolPage(toolPageCount - 1)
  }, [toolPage, toolPageCount])


  async function refreshStatus(probeTools = tools, force = false) {
    // Use cache if available and not expired (unless forced)
    if (!force && cachedToolStatus && Date.now() - cachedToolStatusTime < STATUS_CACHE_TTL) {
      setStatuses(cachedToolStatus)
      return
    }
    setChecking(true)
    try {
      const res = await api.getCodingToolStatus(probeTools.map(({ apiKeyEnv, id, command }) => ({ apiKeyEnv, id, command })))
      const statusMap = Object.fromEntries(res.items.map((item) => [item.id, item]))
      setStatuses(statusMap)
      cachedToolStatus = statusMap
      cachedToolStatusTime = Date.now()
    } finally {
      setChecking(false)
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

  async function toggleExecutionEnabled() {
    const next = !executionEnabled
    setExecutionBusy(true)
    try {
      await api.saveSettings({ AGENTHUB_ENABLE_CODE_AGENT_EXECUTION: next ? 'true' : 'false' })
      setExecutionEnabled(next)
      showSaved()
      // Refresh adapter statuses to reflect new execution state
      void refreshStatus(tools, true)
    } catch (error: any) {
      setToolTestMessage(error?.message || '保存失败')
      setToolTestOk(false)
    } finally {
      setExecutionBusy(false)
    }
  }

  async function save() {
    await api.saveSettings({
      [storageKey]: JSON.stringify(tools),
      CODE_AGENT_ACTIVE_TOOL: activeTool.id,
      CODE_AGENT_ACTIVE_COMMAND: activeTool.command,
    })
    showSaved()
  }

  async function testActiveToolConnection() {
    setToolTestBusy(true)
    setToolTestMessage('')
    setToolTestOk(null)
    try {
      await refreshStatus(tools, true)
      const status = statuses[activeTool.id]
      if (status?.installed) {
        setToolTestOk(true)
        setToolTestMessage(`${activeTool.name} 已安装${status.version ? ` (v${status.version})` : ''}。模型连接测试请在 Agent 配置页面进行。`)
      } else {
        setToolTestOk(false)
        setToolTestMessage(`${activeTool.name} 未安装，请先运行安装命令。`)
      }
    } catch (error: any) {
      setToolTestOk(false)
      setToolTestMessage(error?.message || '检测失败')
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
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f7f5f1] text-neutral-950">
      <CollapsibleSessionSidebar collapsed={sidebarCollapsed} />
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
              <PanelLeft className={cn('h-4 w-4 transition-transform duration-300', sidebarCollapsed && 'rotate-180')} />
            </button>
            <span className="text-sm font-semibold">AgentHub</span>
            <span className="text-sm text-neutral-300">/</span>
            <span className="truncate text-sm text-neutral-500">Coding Tools</span>
          </div>
          <div className="flex items-center gap-2">
            <IconButton label="检测" onClick={() => refreshStatus(tools, true)} disabled={checking}>
              <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
            </IconButton>
            <IconButton label={cliBusy ? '安装中' : '检测并安装缺失 CLI'} onClick={installAllCliTools} disabled={cliBusy}>
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
                {t('本机 Coding Tools 工具台')}
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-normal">Coding Tools</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
                {t('直接检测和配置 Windows 本机 CLI，不再使用容器路径或远端工作区映射。')}
              </p>
              {executionEnabled !== null && (
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={toggleExecutionEnabled}
                    disabled={executionBusy}
                    className={cn(
                      'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50',
                      executionEnabled ? 'bg-emerald-500' : 'bg-neutral-300'
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                        executionEnabled ? 'translate-x-5' : 'translate-x-0'
                      )}
                    />
                  </button>
                  <span className="text-sm text-neutral-700">
                    {executionEnabled ? '代码 Agent 自动执行已启用' : '代码 Agent 自动执行已禁用'}
                  </span>
                  {executionBusy && <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />}
                </div>
              )}
            </div>
            <div className="grid w-full grid-cols-3 gap-2 sm:w-auto">
              <Stat value={tools.length} label="工具" />
              <Stat value={installedCount} label="已安装" />
              <Stat value={configuredCount} label="可运行" />
            </div>
          </section>

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
                    <StatusBadge configured={configured} installed={Boolean(status?.installed)} />
                  </div>
                  <p className="mt-3 line-clamp-2 text-xs leading-5 text-neutral-600">{t(tool.description)}</p>
                </button>
              )
            })}
            </div>
            {canPageTools && (
              <>
                <button
                  type="button"
                  onClick={() => setToolPage((page) => (page - 1 + toolPageCount) % toolPageCount)}
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
                      className={cn('h-1.5 rounded-full transition-all', toolPage === index ? 'w-6 bg-neutral-950' : 'w-1.5 bg-neutral-300 hover:bg-neutral-400')}
                      aria-label={`${t('切换到工具组')} ${index + 1}`}
                    />
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{activeTool.name}</h2>
                  <p className="mt-1 text-sm text-neutral-500">
                    {activeTool.id === 'codex'
                      ? t('AgentHub 执行时按 Agent 模型档案生成临时 Codex 配置；这里只维护 CLI 参数。')
                      : t('配置会写入 AgentHub 设置，并作为 Coding Tools 的默认运行参数。')}
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

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <Field label="命令" value={activeTool.command} onChange={(value) => patchTool(activeTool.id, { command: value })} />
                <ToolNativeFields tool={activeTool} onPatch={(patch) => patchTool(activeTool.id, patch)} />
              </div>
              <p className="mt-4 text-xs leading-5 text-neutral-500">
                API Key、Base URL、模型 ID 只在「模型管理」维护；这里保存 CLI 命令和各工具自己的运行参数。Agent 执行时会按 Agent 配置选择的模型档案自动注入到 {activeTool.name}。
              </p>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={save}
                  className="inline-flex h-10 items-center gap-2 rounded-md bg-teal-700 px-4 text-sm font-medium text-white hover:bg-teal-800"
                >
                  <Save className="h-4 w-4" />
                  {t('保存')}
                </button>
                <button
                  type="button"
                  onClick={testActiveToolConnection}
                  disabled={toolTestBusy}
                  className="inline-flex h-10 items-center gap-2 rounded-md border border-neutral-200 bg-white px-4 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
                >
                  <PlayCircle className={cn('h-4 w-4', toolTestBusy && 'animate-pulse')} />
                  {t('检测 CLI')}
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
                <div className="text-sm font-semibold">{t('本机运行预览')}</div>
                <p className="mt-2 text-xs leading-5 text-neutral-500">
                  {t('Agent 会在工作区真实路径下启动，不再转换为容器内路径。')}
                </p>
                <div className="mt-4 text-xs font-medium text-neutral-600">{t('环境变量')}</div>
                <CodeBlock value={envSnippet} />
                <button
                  type="button"
                  onClick={() => copy(envSnippet, '环境变量')}
                  className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-neutral-200 text-sm hover:bg-neutral-50"
                >
                  <Copy className="h-4 w-4" />
                  {t('复制环境变量')}
                </button>
                <div className="mt-4 text-xs font-medium text-neutral-600">{t('命令预览')}</div>
                <CodeBlock value={runCommand} />
                <button
                  type="button"
                  onClick={() => copy(runCommand, '运行命令')}
                  className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-neutral-200 text-sm hover:bg-neutral-50"
                >
                  <Copy className="h-4 w-4" />
                  {t('复制命令')}
                </button>
              </div>

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

      {(saved || copied) && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-md bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          {copied ? t('已复制项目').replace('{item}', t(copied)) : t('已保存配置')}
        </div>
      )}
    </div>
  )
}

function mergeTools(saved: ToolConfig[]) {
  return defaults.map((item) => ({ ...item, ...saved.find((tool) => tool.id === item.id) }))
}

function ToolNativeFields({
  tool,
  onPatch,
}: {
  tool: ToolConfig
  onPatch: (patch: Partial<ToolConfig>) => void
}) {
  const config = tool.config ?? {}
  const patchConfig = (key: string, value: string | boolean) => {
    onPatch({ config: { ...config, [key]: value } })
  }

  if (tool.id === 'codex') {
    return (
      <>
        <Field label="Codex approvalPolicy" value={String(config.approvalPolicy ?? 'never')} onChange={(value) => patchConfig('approvalPolicy', value)} />
        <Field label="Codex sandbox" value={String(config.sandbox ?? 'workspace-write')} onChange={(value) => patchConfig('sandbox', value)} />
        <Field label="Codex profile（可选）" value={String(config.profile ?? '')} onChange={(value) => patchConfig('profile', value)} />
      </>
    )
  }

  if (tool.id === 'claude-code') {
    return (
      <>
        <Field label="Claude permissionMode" value={String(config.permissionMode ?? 'bypassPermissions')} onChange={(value) => patchConfig('permissionMode', value)} />
        <Field label="Claude outputFormat" value={String(config.outputFormat ?? 'stream-json')} onChange={(value) => patchConfig('outputFormat', value)} />
        <Field label="Claude maxTurns（可选）" value={String(config.maxTurns ?? '')} onChange={(value) => patchConfig('maxTurns', value)} />
      </>
    )
  }

  if (tool.id === 'opencode') {
    return <Field label="OpenCode agent（可选）" value={String(config.agent ?? '')} onChange={(value) => patchConfig('agent', value)} />
  }

  return <div className="text-sm text-neutral-400">此工具暂无额外原生参数。</div>
}

function ToolIcon({ toolId, name }: { toolId: string; name: string }) {
  return <img src={toolIcons[toolId] ?? '/codex-color.svg'} alt={`${name} icon`} className="h-5 w-5 object-contain" draggable={false} />
}

function buildEnvSnippet(tool: ToolConfig) {
  return [
    '# Runtime env is generated per Agent run.',
    '# Configure API Key, Base URL, and model ID in Model Management.',
    `${tool.apiKeyEnv}=<injected-from-selected-model>`,
  ].join('\n')
}

function buildRunCommand(tool: ToolConfig) {
  if (tool.id === 'codex') return `${tool.command} exec "<task>"`
  if (tool.id === 'claude-code') return `${tool.command} "<task>"`
  if (tool.id === 'opencode') return `${tool.command} run "<task>"`
  if (tool.id === 'gemini') return `${tool.command} -p "<task>"`
  return `${tool.command} "<task>"`
}


function IconButton({ children, disabled, label, onClick }: { children: ReactNode; disabled?: boolean; label: string; onClick: () => void }) {
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

function StatusBadge({ configured, installed }: { configured: boolean; installed: boolean }) {
  const { t } = useI18n()
  const ready = installed && configured
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs',
        ready ? 'bg-emerald-50 text-emerald-700' : installed ? 'bg-amber-50 text-amber-700' : 'bg-neutral-100 text-neutral-500'
      )}
    >
      {ready ? <CheckCircle2 className="h-3 w-3" /> : installed ? <AlertCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {ready ? t('可运行') : installed ? t('未配置') : t('未安装')}
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

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-neutral-950 p-3 font-mono text-xs leading-5 text-neutral-50">
      <code>{value}</code>
    </pre>
  )
}
