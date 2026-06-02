import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Blocks,
  CheckCircle2,
  ChevronRight,
  Code2,
  FileText,
  Loader2,
  PackageCheck,
  PlugZap,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import SessionList from '../components/chat/SessionList'
import {
  api,
  type AgentAdapterCatalogItem,
  type CodeAgentType,
  type ContextPolicy,
  type SandboxPolicy,
  type SettingsGeneralInfo,
  type SkillSummary,
} from '../lib/api'
import {
  agentLibraryChangeEvent,
  loadAgentLibrary,
  type SavedAgentConfig,
} from '../lib/agentLibrary'
import { cn } from '../lib/utils'

type CapabilityKind = 'skill' | 'mcp' | 'rules' | 'cli' | 'sandbox' | 'context'
type RiskLevel = 'low' | 'medium' | 'high'
type KindFilter = CapabilityKind | 'all'

interface CapabilityCardData {
  id: string
  kind: CapabilityKind
  title: string
  description: string
  permissions: string[]
  risk: RiskLevel
  appliesTo: string[]
  examples: string[]
  source: string
  license: string
  enabled: boolean
  statusText: string
  actionLabel?: string
  actionPath?: string
}

const kindFilters: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'skill', label: 'Skills' },
  { value: 'mcp', label: 'MCP' },
  { value: 'rules', label: 'Rules' },
  { value: 'cli', label: 'CLI' },
  { value: 'sandbox', label: '沙箱' },
  { value: 'context', label: '上下文' },
]

const cliCommands: Record<CodeAgentType, string> = {
  codex: 'codex',
  'claude-code': 'claude',
  opencode: 'opencode',
  gemini: 'gemini',
}

export default function AbilitiesPage() {
  const navigate = useNavigate()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [adapters, setAdapters] = useState<AgentAdapterCatalogItem[]>([])
  const [settingsInfo, setSettingsInfo] = useState<SettingsGeneralInfo | null>(null)
  const [agents, setAgents] = useState<SavedAgentConfig[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const deferredQuery = useDeferredValue(query)
  const deferredKindFilter = useDeferredValue(kindFilter)

  async function refresh() {
    setLoading(true)
    setMessage('')
    try {
      const [skillResult, adapterResult, settingsResult] = await Promise.all([
        api.listSkills().catch(() => ({ items: [] as SkillSummary[] })),
        api.getAgentAdapters().catch(() => ({ items: [] as AgentAdapterCatalogItem[] })),
        api.getSettingsGeneralInfo().catch(() => null),
      ])
      setSkills(skillResult.items)
      setAdapters(adapterResult.items)
      setSettingsInfo(settingsResult)
      setAgents(loadAgentLibrary())
    } catch (error: any) {
      setMessage(error?.message || '读取能力中心失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const syncAgents = () => setAgents(loadAgentLibrary())
    window.addEventListener(agentLibraryChangeEvent, syncAgents)
    window.addEventListener('storage', syncAgents)
    return () => {
      window.removeEventListener(agentLibraryChangeEvent, syncAgents)
      window.removeEventListener('storage', syncAgents)
    }
  }, [])

  const cards = useMemo(
    () => buildCapabilityCards({ adapters, agents, settingsInfo, skills }),
    [adapters, agents, settingsInfo, skills],
  )

  const filteredCards = useMemo(() => {
    const keyword = deferredQuery.trim().toLowerCase()
    return cards.filter((card) => {
      const matchesKind = deferredKindFilter === 'all' || card.kind === deferredKindFilter
      const matchesQuery =
        !keyword ||
        [
          card.title,
          card.description,
          card.source,
          card.license,
          card.kind,
          card.statusText,
          ...card.permissions,
          ...card.appliesTo,
          ...card.examples,
        ]
          .join(' ')
          .toLowerCase()
          .includes(keyword)
      return matchesKind && matchesQuery
    })
  }, [cards, deferredKindFilter, deferredQuery])

  const enabledCount = useMemo(() => cards.filter((card) => card.enabled).length, [cards])
  const highRiskCount = useMemo(() => cards.filter((card) => card.risk === 'high').length, [cards])
  const filteringPending = deferredKindFilter !== kindFilter || deferredQuery !== query
  const openCapabilityPath = useCallback((path: string) => navigate(path), [navigate])

  return (
    <div className="agenthub-themed-page flex h-screen overflow-hidden bg-[#f7f8f6] text-neutral-950">
      <SessionList />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-neutral-200 bg-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Blocks className="h-4 w-4 text-emerald-700" />
                <h1 className="truncate text-lg font-semibold tracking-normal">能力中心</h1>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">
                <span>{cards.length} 项能力</span>
                <span>{enabledCount} 项已启用</span>
                <span>{highRiskCount} 项高风险</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => navigate('/skills')}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
              >
                <PackageCheck className="h-4 w-4" />
                Skills 市场
              </button>
              <button
                type="button"
                onClick={() => navigate('/coding-tools')}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
              >
                <Terminal className="h-4 w-4" />
                CLI
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                className="grid h-9 w-9 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-600 transition hover:bg-neutral-50"
                aria-label="刷新能力"
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </button>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 px-5 py-5">
            <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
                <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
                  {kindFilters.map((filter) => (
                    <button
                      key={filter.value}
                      type="button"
                      onClick={() => setKindFilter(filter.value)}
                      className={cn(
                        'h-8 shrink-0 rounded-lg px-3 text-sm transition',
                        kindFilter === filter.value
                          ? 'bg-neutral-950 text-white'
                          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200',
                      )}
                    >
                      {filter.label}
                    </button>
                  ))}
                  <span
                    aria-hidden={!filteringPending}
                    className={cn(
                      'grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition-opacity',
                      filteringPending ? 'opacity-100' : 'opacity-0',
                    )}
                  >
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </span>
                </div>
                <label className="flex h-10 min-w-0 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3">
                  <Search className="h-4 w-4 shrink-0 text-neutral-400" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索能力、权限、Agent"
                    className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-400"
                  />
                </label>
              </div>
            </section>

            {message && (
              <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                {message}
              </div>
            )}

            {loading && cards.length === 0 ? (
              <EmptyState icon={<Loader2 className="h-5 w-5 animate-spin" />} text="正在读取能力中心" />
            ) : filteredCards.length === 0 ? (
              <EmptyState icon={<Search className="h-5 w-5" />} text="没有匹配的能力" />
            ) : (
              <section
                aria-busy={filteringPending}
                className={cn('grid gap-3 transition-opacity duration-150', filteringPending && 'opacity-75')}
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(19rem, 1fr))' }}
              >
                {filteredCards.map((card) => (
                  <CapabilityCard key={`${card.kind}:${card.id}`} card={card} onOpen={openCapabilityPath} />
                ))}
              </section>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

const CapabilityCard = memo(function CapabilityCard({
  card,
  onOpen,
}: {
  card: CapabilityCardData
  onOpen: (path: string) => void
}) {
  const Icon = kindIcon(card.kind)
  return (
    <article className="flex min-h-[14rem] flex-col rounded-xl border border-neutral-200 bg-white p-4 shadow-sm transition hover:border-neutral-300">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', kindTone(card.kind))}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-sm font-semibold tracking-normal text-neutral-950">
                {card.title}
              </h2>
              <RiskBadge risk={card.risk} />
            </div>
            <div className="mt-1 text-xs text-neutral-400">{kindLabel(card.kind)}</div>
          </div>
        </div>
        <StatusBadge enabled={card.enabled} text={card.statusText} />
      </div>

      <InfoBlock label="能力说明" value={card.description} />

      <div className="mt-auto space-y-2 pt-3">
        <div className="rounded-lg border border-neutral-100 bg-[#f8f8f5] px-3 py-2 text-xs leading-5">
          <div className="text-neutral-400">许可证 / 来源</div>
          <div className="mt-0.5 line-clamp-2 text-neutral-700">
            {card.license} · {card.source}
          </div>
        </div>
        {card.actionPath && card.actionLabel && (
          <button
            type="button"
            onClick={() => onOpen(card.actionPath!)}
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
          >
            {card.actionLabel}
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </article>
  )
})

function buildCapabilityCards({
  adapters,
  agents,
  settingsInfo,
  skills,
}: {
  adapters: AgentAdapterCatalogItem[]
  agents: SavedAgentConfig[]
  settingsInfo: SettingsGeneralInfo | null
  skills: SkillSummary[]
}): CapabilityCardData[] {
  const cards: CapabilityCardData[] = []

  for (const skill of skills) {
    const boundAgents = agents.filter((agent) => (agent.skillIds ?? []).includes(skill.id))
    cards.push({
      id: skill.id,
      kind: 'skill',
      title: skill.name || skill.id,
      description: skill.description || '本机 Skill 能力包，可被 Agent 绑定后进入执行上下文。',
      permissions: ['读取 SKILL.md', '影响 Agent 提示词和工具选择', '按绑定 Agent 的沙箱策略执行'],
      risk: skillRisk(skill),
      appliesTo: boundAgents.map((agent) => agent.name),
      examples: [`让绑定 Agent 使用 ${skill.name || skill.id} 处理专门任务`, '把领域流程固化为可复用执行步骤'],
      source: skill.source || skill.rootPath || 'local',
      license: '按来源仓库或 SKILL.md 审计',
      enabled: boundAgents.length > 0,
      statusText: boundAgents.length > 0 ? `${boundAgents.length} 个 Agent` : '已安装未绑定',
      actionLabel: '去 Skills 市场',
      actionPath: `/skills?view=installed&skill=${encodeURIComponent(skill.id)}`,
    })
  }

  const adapterItems =
    adapters.length > 0
      ? adapters
      : (Object.entries(cliCommands).map(([id, command]) => ({
          id: id as CodeAgentType,
          name: codeAgentLabel(id as CodeAgentType),
          command,
          envKey: '',
          docsHint: '',
          installed: false,
          configured: false,
          version: null,
          configEnv: '',
          configMessage: '',
          executionEnabled: false,
          ready: false,
          readiness: '未检测',
        })) satisfies AgentAdapterCatalogItem[])

  for (const adapter of adapterItems) {
    const boundAgents = agents.filter(
      (agent) => agent.runtimeType === 'code-agent' && agent.codeAgentType === adapter.id,
    )
    cards.push({
      id: adapter.id,
      kind: 'cli',
      title: adapter.name || codeAgentLabel(adapter.id),
      description: `${adapter.command} 本机 Coding Agent 适配器。用于真实执行任务、生成文件、产出 diff 或预览。`,
      permissions: ['启动本机 CLI 进程', '读取和写入工作区文件', '按 Agent 沙箱策略执行 shell / 网络能力'],
      risk: 'high',
      appliesTo: boundAgents.map((agent) => agent.name),
      examples: ['实现功能并生成代码变更', '运行构建、测试、静态站点预览'],
      source: adapter.docsHint || adapter.command,
      license: '按 CLI 工具自身许可证',
      enabled: adapter.ready,
      statusText: adapter.ready
        ? `可用 · ${adapter.version ?? '已安装'}`
        : adapter.installed
          ? adapter.configured
            ? '已安装待启用'
            : '缺少配置'
          : '未安装',
      actionLabel: '配置 CLI',
      actionPath: '/coding-tools',
    })
  }

  const uniquePermissions = Array.from(new Set(agents.flatMap((agent) => agent.toolPermissions ?? [])))
  cards.push({
    id: 'agent-rules',
    kind: 'rules',
    title: 'Rules / 工具权限策略',
    description: 'Agent 的工具权限、审批要求和执行边界，不作为独立 Agent 类型参与编排。',
    permissions: uniquePermissions.length ? uniquePermissions : ['由 Agent 配置声明权限', '运行时按沙箱和审批策略收束'],
    risk: uniquePermissions.some((item) => item.includes('shell') || item.includes('filesystem')) ? 'medium' : 'low',
    appliesTo: agents.length ? agents.map((agent) => agent.name) : ['未配置 Agent'],
    examples: ['限制某个 Agent 只能读项目文件', '给写入型 Agent 打开人工确认'],
    source: 'Agent 配置库',
    license: '项目内策略，无外部许可证',
    enabled: agents.some((agent) => (agent.toolPermissions ?? []).length > 0 || agent.approvalRequired),
    statusText: `${uniquePermissions.length} 条权限`,
    actionLabel: '配置 Agent',
    actionPath: '/agent-config',
  })

  cards.push({
    id: 'mcp-servers',
    kind: 'mcp',
    title: 'MCP Server 外部工具连接',
    description: 'MCP 是工具能力层，可供 Code Agent 使用；启用前需要逐项审计来源、权限和数据边界。',
    permissions: ['取决于 MCP server 声明', '可能访问网络、文件、浏览器或第三方 API'],
    risk: 'high',
    appliesTo: ['按 Agent 能力绑定'],
    examples: ['连接浏览器自动化工具', '读取外部知识库或企业系统'],
    source: '外部 MCP server',
    license: '按 server 来源审计',
    enabled: false,
    statusText: '待配置',
    actionLabel: '查看能力配置',
    actionPath: '/coding-tools',
  })

  const sandboxPolicies: SandboxPolicy[] = ['workspace-write', 'danger-full-access']
  for (const policy of sandboxPolicies) {
    const boundAgents = agents.filter((agent) => agent.sandboxPolicy === policy)
    cards.push({
      id: `sandbox-${policy}`,
      kind: 'sandbox',
      title: sandboxPolicyLabel(policy),
      description: sandboxPolicyDescription(policy, settingsInfo),
      permissions: sandboxPolicyPermissions(policy),
      risk: policy === 'danger-full-access' ? 'high' : 'medium',
      appliesTo: boundAgents.map((agent) => agent.name),
      examples: sandboxPolicyExamples(policy),
      source: settingsInfo?.sandbox.defaultProvider
        ? `Sandbox Provider: ${settingsInfo.sandbox.defaultProvider}`
        : 'SandboxProvider',
      license: '项目内执行策略',
      enabled: boundAgents.length > 0,
      statusText: boundAgents.length > 0 ? `${boundAgents.length} 个 Agent` : '未使用',
      actionLabel: '配置沙箱',
      actionPath: '/profile',
    })
  }

  const contextPolicies: ContextPolicy[] = ['recent-only', 'pinned-recent', 'workspace-aware']
  for (const policy of contextPolicies) {
    const boundAgents = agents.filter((agent) => agent.contextPolicy === policy)
    cards.push({
      id: `context-${policy}`,
      kind: 'context',
      title: contextPolicyLabel(policy),
      description: contextPolicyDescription(policy),
      permissions: ['读取会话上下文', '读取被选择的工作区摘要', '遵循 Agent 上下文策略'],
      risk: policy === 'workspace-aware' ? 'medium' : 'low',
      appliesTo: boundAgents.map((agent) => agent.name),
      examples: ['让 Agent 只看最近对话', '让代码 Agent 结合工作区状态执行'],
      source: 'Agent 上下文策略',
      license: '项目内策略',
      enabled: boundAgents.length > 0,
      statusText: boundAgents.length > 0 ? `${boundAgents.length} 个 Agent` : '未使用',
      actionLabel: '配置上下文',
      actionPath: '/agent-config',
    })
  }

  return cards.sort((a, b) => {
    if (a.enabled !== b.enabled) return Number(b.enabled) - Number(a.enabled)
    return kindOrder(a.kind) - kindOrder(b.kind)
  })
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-4">
      <div className="text-xs font-medium text-neutral-400">{label}</div>
      <p className="mt-1 line-clamp-3 text-sm leading-6 text-neutral-700">{value}</p>
    </div>
  )
}

function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="grid min-h-[18rem] place-items-center rounded-xl border border-dashed border-neutral-200 bg-white p-8 text-center">
      <div>
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-neutral-100 text-neutral-500">
          {icon}
        </div>
        <div className="mt-3 text-sm font-medium text-neutral-600">{text}</div>
      </div>
    </div>
  )
}

function StatusBadge({ enabled, text }: { enabled: boolean; text: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-neutral-100 text-neutral-500',
      )}
      title={text}
    >
      {enabled ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      <span className="max-w-[7rem] truncate">{text}</span>
    </span>
  )
}

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const cfg: Record<RiskLevel, { label: string; className: string }> = {
    low: { label: '低风险', className: 'bg-emerald-50 text-emerald-700' },
    medium: { label: '中风险', className: 'bg-amber-50 text-amber-700' },
    high: { label: '高风险', className: 'bg-red-50 text-red-700' },
  }
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', cfg[risk].className)}>
      {cfg[risk].label}
    </span>
  )
}

function kindIcon(kind: CapabilityKind) {
  const map = {
    skill: PackageCheck,
    mcp: PlugZap,
    rules: FileText,
    cli: Code2,
    sandbox: ShieldCheck,
    context: SlidersHorizontal,
  } satisfies Record<CapabilityKind, typeof Blocks>
  return map[kind]
}

function kindTone(kind: CapabilityKind) {
  const map: Record<CapabilityKind, string> = {
    skill: 'bg-emerald-50 text-emerald-700',
    mcp: 'bg-blue-50 text-blue-700',
    rules: 'bg-neutral-100 text-neutral-700',
    cli: 'bg-indigo-50 text-indigo-700',
    sandbox: 'bg-amber-50 text-amber-700',
    context: 'bg-cyan-50 text-cyan-700',
  }
  return map[kind]
}

function kindLabel(kind: CapabilityKind) {
  const map: Record<CapabilityKind, string> = {
    skill: 'Skill 能力包',
    mcp: 'MCP 外部工具',
    rules: 'Rules / 权限',
    cli: 'CLI Adapter',
    sandbox: '沙箱策略',
    context: '上下文策略',
  }
  return map[kind]
}

function kindOrder(kind: CapabilityKind) {
  const order: Record<CapabilityKind, number> = {
    skill: 1,
    cli: 2,
    mcp: 3,
    rules: 4,
    sandbox: 5,
    context: 6,
  }
  return order[kind]
}

function skillRisk(skill: SkillSummary): RiskLevel {
  const value = `${skill.source} ${skill.rootPath}`.toLowerCase()
  if (value.includes('github') || value.includes('http') || value.includes('external')) return 'medium'
  return 'low'
}

function codeAgentLabel(type: CodeAgentType) {
  const map: Record<CodeAgentType, string> = {
    codex: 'Codex CLI',
    'claude-code': 'Claude Code',
    opencode: 'OpenCode',
    gemini: 'Gemini CLI',
  }
  return map[type]
}

function sandboxPolicyLabel(policy: SandboxPolicy) {
  const map: Record<SandboxPolicy, string> = {
    'workspace-write': 'Workspace Write 沙箱',
    'danger-full-access': 'Danger Full Access 沙箱',
  }
  return map[policy]
}

function sandboxPolicyDescription(policy: SandboxPolicy, settingsInfo: SettingsGeneralInfo | null) {
  const provider = settingsInfo?.sandbox.configuredProvider || settingsInfo?.sandbox.defaultProvider || 'local'
  if (policy === 'workspace-write') return `允许写入工作区内任务目录，当前 Provider：${provider}。适合实现和交付产物。`
  return `最高权限执行策略，当前 Provider：${provider}。仅适合明确可信的本机任务。`
}

function sandboxPolicyPermissions(policy: SandboxPolicy) {
  if (policy === 'workspace-write') return ['读取工作区', '写入任务工作目录', '生成 handoff / artifacts']
  return ['完整文件系统访问', 'shell 执行', '网络访问', '本机环境变量']
}

function sandboxPolicyExamples(policy: SandboxPolicy) {
  if (policy === 'workspace-write') return ['实现功能并保存产物', '运行构建并生成报告']
  return ['修复本机 CLI 配置', '执行需要完整本机权限的维护任务']
}

function contextPolicyLabel(policy: ContextPolicy) {
  const map: Record<ContextPolicy, string> = {
    'recent-only': 'Recent Only 上下文',
    'pinned-recent': 'Pinned Recent 上下文',
    'workspace-aware': 'Workspace Aware 上下文',
  }
  return map[policy]
}

function contextPolicyDescription(policy: ContextPolicy) {
  if (policy === 'recent-only') return '只使用最近会话上下文，适合轻量问答和短任务。'
  if (policy === 'pinned-recent') return '优先使用置顶内容和最近上下文，适合需要少量记忆的协作。'
  return '结合工作区、任务、黑板和最近上下文，适合复杂多 Agent 协作。'
}
