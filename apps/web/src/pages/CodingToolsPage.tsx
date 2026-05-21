import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Code2,
  Copy,
  ExternalLink,
  KeyRound,
  PanelLeft,
  RefreshCw,
  Shield,
  Terminal,
  XCircle,
} from 'lucide-react'
import SessionList from '../components/chat/SessionList'
import { api, type CodingToolStatus, type ModelCatalogItem } from '../lib/api'
import { cn } from '../lib/utils'

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type Protocol = 'openai-compatible' | 'anthropic-messages' | 'openai-responses'

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

const protocolCopy: Record<Protocol, { label: string; note: string }> = {
  'openai-compatible': {
    label: 'OpenAI Compatible',
    note: '使用 Authorization: Bearer，并请求 /chat/completions 或兼容端点，适合 DeepSeek、Qwen、OpenRouter 等。',
  },
  'anthropic-messages': {
    label: 'Anthropic Messages',
    note: '使用 x-api-key 与 anthropic-version，请求 /v1/messages，Claude Code 原生优先使用该协议。',
  },
  'openai-responses': {
    label: 'OpenAI Responses',
    note: 'OpenAI 新版 Responses/Agents 协议，适合 Codex 类工具和 GPT 系列模型能力。',
  },
}

const sandboxCopy: Record<SandboxMode, string> = {
  'read-only': '只读：允许查看和分析代码，不写入文件。',
  'workspace-write': '工作区写入：允许改当前项目文件，适合日常开发。',
  'danger-full-access': '完全访问：允许越过工作区边界，仅在可信任务中使用。',
}

export default function CodingToolsPage() {
  const [tools, setTools] = useState<ToolConfig[]>(defaults)
  const [statuses, setStatuses] = useState<Record<string, CodingToolStatus>>({})
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [activeToolId, setActiveToolId] = useState(defaults[0].id)
  const [checking, setChecking] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.getSettings().then((settings) => {
      if (settings.MODEL_CATALOG) {
        try {
          setModels((JSON.parse(settings.MODEL_CATALOG) as ModelCatalogItem[]).filter((item) => item.enabled))
        } catch {
          setModels([])
        }
      }
      if (settings[storageKey]) {
        try {
          setTools(mergeTools(JSON.parse(settings[storageKey]) as ToolConfig[]))
        } catch {
          setTools(defaults)
        }
      }
    })
    void refreshStatus()
  }, [])

  const activeTool = tools.find((tool) => tool.id === activeToolId) ?? tools[0]
  const installedCount = useMemo(
    () => tools.filter((tool) => statuses[tool.id]?.installed).length,
    [statuses, tools]
  )
  const configuredCount = useMemo(
    () => tools.filter((tool) => tool.modelId && tool.apiKeyEnv && tool.baseUrl).length,
    [tools]
  )

  async function refreshStatus() {
    setChecking(true)
    try {
      const res = await api.getCodingToolStatus()
      setStatuses(Object.fromEntries(res.items.map((item) => [item.id, item])))
    } finally {
      setChecking(false)
    }
  }

  function patchTool(id: string, patch: Partial<ToolConfig>) {
    setTools((current) => current.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)))
  }

  async function save() {
    await api.saveSettings({ [storageKey]: JSON.stringify(tools) })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
  }

  function copy(text: string) {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
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
            <span className="truncate text-sm text-neutral-500">扣子编程</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={refreshStatus}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50"
            >
              <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
              检测安装
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
              <h1 className="mt-4 text-3xl font-semibold tracking-normal">扣子编程</h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-neutral-500">
                管理 Codex、Claude Code、OpenCode 等终端编程工具的安装状态、沙箱策略、模型绑定和 API 协议差异。
              </p>
            </div>
            <div className="grid w-full gap-3 sm:w-auto sm:grid-cols-3">
              <Stat value={tools.length} label="工具总数" />
              <Stat value={installedCount} label="已安装" />
              <Stat value={configuredCount} label="已配置" />
            </div>
          </section>

          <section className="mt-8 grid gap-4 lg:grid-cols-3">
            {tools.map((tool) => {
              const status = statuses[tool.id]
              const active = activeTool.id === tool.id
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
                      <Code2 className="h-5 w-5" />
                    </div>
                    <StatusBadge installed={Boolean(status?.installed)} version={status?.version} />
                  </div>
                  <div className="mt-5 text-base font-semibold">{tool.name}</div>
                  <p className="mt-2 min-h-12 text-sm leading-6 text-neutral-500">{tool.description}</p>
                  <div className="mt-4 font-mono text-xs text-neutral-400">{tool.command}</div>
                </button>
              )
            })}
          </section>

          <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">{activeTool.name}</h2>
                  <p className="mt-2 text-sm leading-6 text-neutral-500">{activeTool.description}</p>
                </div>
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

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <Field label="命令名" value={activeTool.command} onChange={(command) => patchTool(activeTool.id, { command })} />
                <Field label="API Key 环境变量" value={activeTool.apiKeyEnv} onChange={(apiKeyEnv) => patchTool(activeTool.id, { apiKeyEnv })} />
                <Field label="Base URL" value={activeTool.baseUrl} onChange={(baseUrl) => patchTool(activeTool.id, { baseUrl })} />
                <label className="block text-sm">
                  <span className="mb-2 block text-neutral-600">模型绑定</span>
                  <div className="relative">
                    <select
                      value={activeTool.modelId}
                      onChange={(event) => patchTool(activeTool.id, { modelId: event.target.value })}
                      className="h-10 w-full appearance-none rounded-xl border border-neutral-200 bg-white px-3 pr-8 outline-none transition focus:border-neutral-400"
                    >
                      <option value={activeTool.modelId}>{activeTool.modelId}</option>
                      {models.map((model) => (
                        <option key={model.id} value={model.modelId}>
                          {model.modelId} · {model.provider}
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

            <aside className="space-y-4">
              <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <KeyRound className="h-4 w-4" />
                  安装与检测
                </div>
                <div className="mt-4 rounded-xl bg-neutral-950 p-3 font-mono text-xs text-white">
                  {activeTool.installCommand}
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => copy(activeTool.installCommand)}
                    className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl border border-neutral-200 text-sm hover:bg-neutral-50"
                  >
                    <Copy className="h-4 w-4" />
                    复制安装命令
                  </button>
                </div>
                <div className="mt-4 text-xs leading-5 text-neutral-500">
                  安装后重新点击“检测安装”。检测只读取命令版本，不会执行项目写入操作。
                </div>
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

      {saved && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-neutral-950 px-4 py-2 text-sm text-white shadow-xl">
          已保存配置
        </div>
      )}
    </div>
  )
}

function mergeTools(saved: ToolConfig[]) {
  return defaults.map((item) => saved.find((tool) => tool.id === item.id) ?? item)
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-neutral-400">{label}</div>
    </div>
  )
}

function StatusBadge({ installed, version }: { installed: boolean; version?: string | null }) {
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs',
        installed ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500'
      )}
    >
      {installed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {installed ? version || '已安装' : '未检测到'}
    </span>
  )
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="block text-sm">
      <span className="mb-2 block text-neutral-600">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-full rounded-xl border border-neutral-200 px-3 outline-none transition focus:border-neutral-400"
      />
    </label>
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
